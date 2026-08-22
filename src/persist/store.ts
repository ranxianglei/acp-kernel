import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** Logger callback. Downstream routes it wherever it wants (file, stderr). */
export type PersistLogger = (level: "info" | "warn" | "error", msg: string) => void;

/**
 * On-disk record shape. The store owns the envelope (version stamp, save
 * time, id) so atomicity and discovery can rely on it; the payload schema
 * is entirely downstream-owned. `payload` must be JSON-serializable.
 */
export interface PersistedEnvelope<T> {
    version: number;
    savedAt: number;
    id: string;
    payload: T;
}

export interface StateStoreOptions<T> {
    /**
     * Storage root. The kernel deliberately has NO default location: the
     * downstream decides where state lives (CLI dir, XDG data dir, plugin
     * dir, temp dir in tests). All records live under this directory.
     */
    dir: string;
    /**
     * Schema version stamped into every envelope. Owned by the downstream;
     * bump it when the payload shape changes. The store itself never
     * rejects a record over its version — migration policy belongs to the
     * reader.
     */
    version: number;
    /** Debounce window for scheduleSave, ms. Default 500. */
    debounceMs?: number;
    /** Default true. When false, all writes are silent no-ops and loads
     *  return empty results. */
    enabled?: boolean;
    log?: PersistLogger;
    /**
     * Relative path (under `dir`) for a record, possibly namespaced into
     * subdirectories (e.g. `openai/host-hash.json`). Default: flat
     * `<sha256(id)[:24]>.json`.
     *
     * Because the path may depend on payload fields the store only learns
     * at write time, single-record loads resolve namespaced files only
     * after loadAll() has discovered them (or the store itself wrote
     * them). The flat default name is always checked as a fallback, so
     * downstreams using a custom relPath should call loadAll() at boot.
     */
    relPath?: (id: string, payload: T) => string;
    /**
     * Payload validation on load. Return false to skip a record (foreign
     * schema, corrupt content). Default: envelope-shape check only
     * (string id, non-null payload).
     */
    validate?: (envelope: PersistedEnvelope<T>) => boolean;
}

/**
 * Crash-safe, debounce-coalescing JSON state store. Mechanism only — lifted
 * from billion-context's proxy SessionStore and generalized:
 *
 * - atomic writes: temp file + rename, so a crash mid-write never leaves a
 *   truncated record (readers see either the old or the new file)
 * - rename retries on Windows transient locks (EPERM/EBUSY/EACCES)
 * - per-id serialization so concurrent writeNow calls never interleave
 *   temp-file names or reorders writes
 * - debounced scheduleSave coalesces bursts into one write; the record is
 *   built at WRITE time from a builder, so late mutations are picked up
 * - loadAll skips `.tmp-*` orphans, corrupt JSON, and records whose
 *   filename does not match their id — one bad file never blocks boot
 *
 * The store never deletes files. Session cleanup is a downstream policy
 * decision (kernel position: persisted state should not be deleted
 * opportunistically).
 */
export class StateStore<T> {
    readonly enabled: boolean;
    private readonly dir: string;
    private readonly version: number;
    private readonly debounceMs: number;
    private readonly log: PersistLogger;
    private readonly relPathFn?: (id: string, payload: T) => string;
    private readonly validateFn: (envelope: PersistedEnvelope<T>) => boolean;
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly pending = new Map<string, () => T>();
    private readonly writeChains = new Map<string, Promise<void>>();
    /** id → absolute path, populated by writes and loadAll. */
    private readonly discovered = new Map<string, string>();
    /** Monotonic counter for unique temp filenames within a process. */
    private tmpSeq = 0;

    constructor(opts: StateStoreOptions<T>) {
        this.dir = opts.dir;
        this.version = opts.version;
        this.debounceMs = opts.debounceMs ?? 500;
        this.enabled = opts.enabled ?? true;
        this.log = opts.log ?? ((_level, _msg) => {});
        this.relPathFn = opts.relPath;
        this.validateFn = opts.validate ?? defaultValidate;
    }

    /** Debounced save. Coalesces bursts; the builder runs at write time, so
     *  the freshest state is always persisted. Never throws. */
    scheduleSave(id: string, build: () => T): void {
        if (!this.enabled) return;
        this.pending.set(id, build);
        const existing = this.timers.get(id);
        if (existing) return;
        const timer = setTimeout(() => {
            this.timers.delete(id);
            const builder = this.pending.get(id);
            this.pending.delete(id);
            if (!builder) return;
            // Errors are logged inside writeInner; swallowing here keeps a
            // failed timer write from becoming an unhandledRejection.
            void this.writeNow(id, builder).catch(() => {});
        }, this.debounceMs);
        timer.unref?.();
        this.timers.set(id, timer);
    }

    /** Immediate save, serialized per id. Rejects on write failure; a
     *  failing write never breaks the chain for the next one. */
    async writeNow(id: string, build: () => T): Promise<void> {
        if (!this.enabled) return;
        // The previous promise may reject (disk full, EPERM) — catch so our
        // chain doesn't break, then run our own write.
        const prev = this.writeChains.get(id) ?? Promise.resolve();
        const next = prev.catch(() => {}).then(() => this.writeInner(id, build));
        this.writeChains.set(id, next);
        // Clean up the chain entry once settled so the Map doesn't grow. The
        // .catch() is load-bearing: .finally() returns a derived promise that
        // nobody else holds — when the chain rejects it would surface as an
        // unhandledRejection and crash the host on default Node settings.
        next
            .finally(() => {
                if (this.writeChains.get(id) === next) this.writeChains.delete(id);
            })
            .catch(() => {});
        return next;
    }

    /** Synchronous flush for one id. Used where the caller cannot await
     *  (memory eviction, sync shutdown paths). Cancels any pending debounce
     *  timer. Returns true on success, false on failure — callers that use
     *  the result to drop in-memory state must NOT drop it on failure. */
    flushSync(id: string, build: () => T): boolean {
        if (!this.enabled) return true;
        const timer = this.timers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(id);
            this.pending.delete(id);
        }
        let payload: T;
        try {
            payload = build();
        } catch (e) {
            this.log("error", `[persist] builder failed for ${id}: ${errText(e)}`);
            return false;
        }
        const file = this.resolvePath(id, payload);
        const data = JSON.stringify(this.envelope(id, payload));
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
        } catch (e) {
            this.log("warn", `[persist] could not create dir ${path.dirname(file)}: ${errText(e)}`);
        }
        const tmp = this.tempPath(file);
        try {
            fs.writeFileSync(tmp, data, "utf8");
            // renameSync can throw EPERM/EBUSY on Windows when the dest is
            // briefly held (AV scanner, indexer, SMB). Retry briefly —
            // transient locks usually release within ms.
            let lastErr: unknown;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    fs.renameSync(tmp, file);
                    lastErr = undefined;
                    break;
                } catch (e) {
                    lastErr = e;
                    const code = (e as NodeJS.ErrnoException).code;
                    if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
                    // brief sync backoff (Atomics.wait is the sync sleep)
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
                }
            }
            if (lastErr) throw lastErr;
            this.discovered.set(id, file);
            return true;
        } catch (e) {
            this.log("error", `[persist] flushSync failed for ${id}: ${errText(e)}`);
            try {
                fs.unlinkSync(tmp);
            } catch {
                // best-effort cleanup of the orphan temp
            }
            return false;
        }
    }

    /** Load one record. Checks the discovered path (from a prior
     *  write/loadAll) and the flat default name. Returns null when absent,
     *  disabled, corrupt, or rejected by validate. */
    loadSync(id: string): PersistedEnvelope<T> | null {
        if (!this.enabled) return null;
        const candidates = [this.discovered.get(id), path.join(this.dir, flatFileNameFor(id))];
        for (const file of candidates) {
            if (!file) continue;
            const envelope = this.readEnvelope(file);
            if (envelope && envelope.id === id) return envelope;
        }
        return null;
    }

    /** Load every record under dir. Populates the discovery map (enables
     *  loadSync for namespaced relPaths). Skips corrupt files, `.tmp-*`
     *  orphans, and records whose filename does not match their id — one
     *  bad file never blocks boot. Never throws. */
    async loadAll(): Promise<Map<string, PersistedEnvelope<T>>> {
        const out = new Map<string, PersistedEnvelope<T>>();
        if (!this.enabled) return out;
        const files = await this.walkJsonFiles(this.dir);
        for (const file of files) {
            const envelope = this.readEnvelope(file);
            if (!envelope) continue;
            const expected =
                path.basename(this.relPathOf(envelope.id, envelope.payload)) === path.basename(file) ||
                flatFileNameFor(envelope.id) === path.basename(file);
            if (!expected) {
                this.log("warn", `[persist] skipping ${rel(file, this.dir)}: filename does not match record id`);
                continue;
            }
            this.discovered.set(envelope.id, file);
            out.set(envelope.id, envelope);
        }
        return out;
    }

    /** Whether a debounced write is pending for an id. */
    hasPending(id: string): boolean {
        return this.timers.has(id);
    }

    /** Ids with a pending debounced write. */
    pendingIds(): string[] {
        return [...this.timers.keys()];
    }

    /** Flush every pending debounced write immediately, then drain in-flight
     *  writes. For graceful shutdown (SIGTERM/SIGINT). Never rejects. */
    async flushAll(): Promise<void> {
        const ids = this.pendingIds();
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        const builders = new Map<string, () => T>();
        for (const id of ids) {
            const build = this.pending.get(id);
            if (build) builders.set(id, build);
            this.pending.delete(id);
        }
        await Promise.all(
            [...builders.entries()].map(([id, build]) =>
                this.writeNow(id, build).catch((e) => {
                    this.log("error", `[persist] shutdown flush failed for ${id}: ${errText(e)}`);
                }),
            ),
        );
        // Drain writes whose timer fired earlier but are still mid-flight.
        await Promise.allSettled([...this.writeChains.values()]);
    }

    /** Cancel all pending debounced writes without flushing (tests). */
    cancelAll(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.pending.clear();
    }

    private async writeInner(id: string, build: () => T): Promise<void> {
        let payload: T;
        try {
            payload = build();
        } catch (e) {
            this.log("error", `[persist] builder failed for ${id}: ${errText(e)}`);
            throw e;
        }
        const file = this.resolvePath(id, payload);
        try {
            await fsp.mkdir(path.dirname(file), { recursive: true });
        } catch (e) {
            this.log("warn", `[persist] could not create dir ${path.dirname(file)}: ${errText(e)}`);
        }
        const tmp = this.tempPath(file);
        try {
            await fsp.writeFile(tmp, JSON.stringify(this.envelope(id, payload)), "utf8");
            await renameWithRetry(tmp, file);
            this.discovered.set(id, file);
        } catch (e) {
            // Wrap so a failure cleans up the .tmp orphan instead of leaving
            // it for the next write to collide with.
            await fsp.unlink(tmp).catch(() => {});
            this.log("error", `[persist] write failed for ${id}: ${errText(e)}`);
            throw e;
        }
    }

    private envelope(id: string, payload: T): PersistedEnvelope<T> {
        return { version: this.version, savedAt: Date.now(), id, payload };
    }

    /** Absolute path for a record: custom relPath (guarded against path
     *  escape) or the flat hash default. */
    private resolvePath(id: string, payload: T): string {
        return path.join(this.dir, this.relPathOf(id, payload));
    }

    private relPathOf(id: string, payload: T): string {
        const custom = this.relPathFn?.(id, payload);
        if (!custom) return flatFileNameFor(id);
        const rel = path.normalize(custom);
        if (path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
            this.log("warn", `[persist] relPath for ${id} escapes dir; using flat name`);
            return flatFileNameFor(id);
        }
        return rel;
    }

    /** Unique temp file next to the destination (same dir ⇒ same volume ⇒
     *  rename is atomic). Prefixed `.tmp-` so loadAll skips orphans. */
    private tempPath(dest: string): string {
        const seq = this.tmpSeq++;
        return path.join(path.dirname(dest), `.tmp-${path.basename(dest, ".json")}-${process.pid}-${seq}`);
    }

    /** Parse + validate one file. Corrupt or invalid records return null
     *  (logged) instead of throwing — load paths must never block boot. */
    private readEnvelope(file: string): PersistedEnvelope<T> | null {
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (e) {
            // A missing candidate path is an expected miss (loadSync probes);
            // only genuinely unreadable/corrupt files get logged.
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                this.log("warn", `[persist] skipping corrupt file ${rel(file, this.dir)}: ${errText(e)}`);
            }
            return null;
        }
        if (!isEnvelopeLike(parsed) || !this.validateFn(parsed as PersistedEnvelope<T>)) {
            this.log("warn", `[persist] skipping invalid record ${rel(file, this.dir)}`);
            return null;
        }
        return parsed as PersistedEnvelope<T>;
    }

    /** Iterative recursive walk (no readdir-recursive dependency), skipping
     *  `.tmp-*` names and non-.json files. */
    private async walkJsonFiles(root: string): Promise<string[]> {
        const out: string[] = [];
        const queue: string[] = [root];
        while (queue.length > 0) {
            const dir = queue.pop()!;
            let dirents: fs.Dirent[];
            try {
                dirents = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                continue; // missing dir → no records yet
            }
            for (const d of dirents) {
                if (d.name.startsWith(".tmp-")) continue;
                const full = path.join(dir, d.name);
                if (d.isDirectory()) queue.push(full);
                else if (d.isFile() && d.name.endsWith(".json")) out.push(full);
            }
        }
        return out;
    }
}

function defaultValidate<T>(envelope: PersistedEnvelope<T>): boolean {
    return typeof envelope.id === "string" && envelope.id.length > 0 && envelope.payload != null;
}

function isEnvelopeLike(value: unknown): value is PersistedEnvelope<unknown> {
    if (!value || typeof value !== "object") return false;
    const v = value as Partial<PersistedEnvelope<unknown>>;
    return typeof v.id === "string" && "payload" in v;
}

/** Deterministic flat filename: `<sha256(id)[:24]>.json`. Truncated hash —
 *  96 bits keeps collisions unreachable for realistic id counts, and short
 *  names stay greppable. */
export function flatFileNameFor(id: string): string {
    return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24) + ".json";
}

/** fs.rename with brief retries on Windows transient locks (EPERM/EBUSY/
 *  EACCES from AV scan, search indexer, SMB). A short delay + retry almost
 *  always succeeds; other errors are real and rethrown immediately. */
async function renameWithRetry(src: string, dest: string): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await fsp.rename(src, dest);
            return;
        } catch (e) {
            lastErr = e;
            const code = (e as NodeJS.ErrnoException).code;
            if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw e;
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, 20 * (attempt + 1));
            await promise;
        }
    }
    throw lastErr;
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}


function rel(p: string, base: string): string {
    const r = path.relative(base, p);
    return r && !r.startsWith("..") ? r : p;
}
