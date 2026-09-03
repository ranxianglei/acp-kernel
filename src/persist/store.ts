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

/** A legacy (pre-envelope) record adopted on load. `version`/`savedAt`
 * preserve the source record's own stamps when present. */
export interface LegacyAdoption<T> {
    id: string;
    payload: T;
    version?: number;
    savedAt?: number;
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
     * Adopt records written by an older, pre-envelope schema. Receives the
     * parsed JSON of any file that failed the envelope-shape check; return
     * an adoption to load it as an envelope, or null to skip it. Adopted
     * records are re-persisted in the current envelope format on the next
     * dirty write — files migrate organically, and old files keep loading
     * (same policy billion-context's proxy used for its v1→v3 migration).
     */
    legacy?: (parsed: unknown) => LegacyAdoption<T> | null;
    /**
     * Payload validation on load. Return false to skip a record (foreign
     * schema, corrupt content). Default: envelope-shape check only
     * (string id, non-null payload).
     */
    validate?: (envelope: PersistedEnvelope<T>) => boolean;
    /**
     * Rename-retry policy for Windows transient locks (EPERM/EBUSY/EACCES
     * from AV scan, search indexer, SMB). Exponential backoff: the delay
     * after attempt i is min(retryBaseMs * 2^i, retryMaxMs). Defaults
     * (6 attempts, 50ms base, 1600ms cap) give a ~1.5s window — long enough
     * for most AV locks to release, short enough not to stall a sync flush.
     * When the window is exhausted the write spills to a side file (see
     * spillPath) instead of dropping the data.
     */
    retryAttempts?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
}

/** Options for {@link StateStore.loadAll}. */
export interface LoadAllOptions {
    /**
     * Cap on the total bytes of record files loadAll will read and parse.
     * When set, loadAll does a stat-only pass first (readdir + stat, no
     * content reads), groups each canonical file with its `.fb.json` spill
     * variant (same id ⇒ all-or-nothing, so the pair's freshest-wins
     * reconciliation always sees both sides), then includes groups
     * newest-mtime-first while the running total stays within the budget.
     * Excluded groups are left on disk untouched (the store never deletes)
     * and stay individually reachable via loadSync(id, hint). If no group
     * fits, the result is an empty map (a warning is logged) — the budget
     * is a hard cap, so one oversized record can never blow past it. Group
     * freshness uses file mtime as a stat-level proxy for the in-envelope
     * savedAt; ordering among parsed records still comes from savedAt
     * reconciliation. Omitted ⇒ parse every record (default, unchanged).
     */
    maxParseBytes?: number;
}

/**
 * Crash-safe, debounce-coalescing JSON state store. Mechanism only — lifted
 * from billion-context's proxy SessionStore and generalized:
 *
 * - atomic writes: temp file + rename, so a crash mid-write never leaves a
 *   truncated record (readers see either the old or the new file)
 * - rename retries with exponential backoff on Windows transient locks
 *   (EPERM/EBUSY/EACCES); when the window is exhausted the record spills to
 *   a side file (`<name>.fb.json`) instead of being dropped, so a lock held
 *   by AV/indexer/SMB never silently loses session data
 * - per-id serialization so concurrent writeNow calls never interleave
 *   temp-file names or reorders writes
 * - debounced scheduleSave coalesces bursts into one write; the record is
 *   built at WRITE time from a builder, so late mutations are picked up
 * - loadAll skips `.tmp-*` orphans, corrupt JSON, and records whose
 *   filename does not match their id — one bad file never blocks boot; it
 *   reconciles a canonical record against its spill by savedAt (freshest wins)
 *
 * The store never deletes a record's data. On a successful canonical write it
 * removes a now-stale spill of the SAME id (a duplicate, not distinct data).
 * Session cleanup is a downstream policy decision (kernel position: persisted
 * state should not be deleted opportunistically).
 */
export class StateStore<T> {
    readonly enabled: boolean;
    private readonly dir: string;
    private readonly version: number;
    private readonly debounceMs: number;
    private readonly log: PersistLogger;
    private readonly legacyFn?: (parsed: unknown) => LegacyAdoption<T> | null;
    private readonly relPathFn?: (id: string, payload: T) => string;
    private readonly validateFn: (envelope: PersistedEnvelope<T>) => boolean;
    private readonly retryAttempts: number;
    private readonly retryBaseMs: number;
    private readonly retryMaxMs: number;
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly pending = new Map<string, () => T>();
    private readonly writeChains = new Map<string, Promise<void>>();
    /** id → absolute path, populated by writes and loadAll. */
    private readonly discovered = new Map<string, string>();
    /** id → cumulative write-failure count, for rate-limited alerting. */
    private readonly failCounts = new Map<string, number>();
    /** Monotonic counter for unique temp filenames within a process. */
    private tmpSeq = 0;

    constructor(opts: StateStoreOptions<T>) {
        this.dir = opts.dir;
        this.version = opts.version;
        this.debounceMs = opts.debounceMs ?? 500;
        this.enabled = opts.enabled ?? true;
        this.log = opts.log ?? ((_level, _msg) => {});
        this.relPathFn = opts.relPath;
        this.legacyFn = opts.legacy;
        this.validateFn = opts.validate ?? defaultValidate;
        this.retryAttempts = Math.max(1, opts.retryAttempts ?? 6);
        this.retryBaseMs = Math.max(1, opts.retryBaseMs ?? 50);
        this.retryMaxMs = Math.max(this.retryBaseMs, opts.retryMaxMs ?? 1600);
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
        let lastErr: unknown;
        for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
            // Fresh temp name per attempt: on Windows a failed cleanup can
            // leave the previous name delete-pending, and creating over a
            // tombstoned name fails immediately — reusing it would burn every
            // remaining attempt before the write even happens.
            const tmp = this.tempPath(file);
            try {
                fs.writeFileSync(tmp, data, "utf8");
                fs.renameSync(tmp, file);
                lastErr = undefined;
                break;
            } catch (e) {
                lastErr = e;
                try {
                    fs.unlinkSync(tmp);
                } catch {
                    // temp never created or already gone
                }
                const code = (e as NodeJS.ErrnoException).code;
                if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
                if (attempt === this.retryAttempts - 1) break;
                // sync sleep (Atomics.wait) — backoff grows per attempt
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.backoffMs(attempt));
            }
        }
        if (!lastErr) {
            this.discovered.set(id, file);
            this.clearFailure(id);
            this.removeSpillSync(file);
            return true;
        }
        // The canonical rename outlived the retry window (Windows lock held by
        // AV/indexer/SMB). Spill to a side file so the data still lands on
        // disk instead of being dropped — loadAll picks the freshest of the
        // canonical and the spill.
        let spillPath: string | null = null;
        try {
            const spill = this.spillPathFor(file);
            fs.writeFileSync(spill, data, "utf8");
            spillPath = spill;
            this.discovered.set(id, spill);
        } catch {
            // spillover also failed (dir read-only / disk full) — data at risk
        }
        this.recordFailure(id, lastErr, spillPath);
        return spillPath !== null;
    }

    /** Load one record. Checks the discovered path (from a prior
     *  write/loadAll), an optional relative-path hint, and the flat default
     *  name. Returns null when absent, disabled, corrupt, or rejected by
     *  validate. The hint covers namespaced records the store has not
     *  discovered (e.g. an evicted session re-requested with its meta,
     *  where the path depends on data the store cannot reconstruct from
     *  the id alone). */
    loadSync(id: string, hint?: string): PersistedEnvelope<T> | null {
        if (!this.enabled) return null;
        const candidates = [
            this.discovered.get(id),
            hint ? path.join(this.dir, hint) : undefined,
            path.join(this.dir, flatFileNameFor(id)),
        ];
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
     *  bad file never blocks boot. Never throws.
     *
     * With `options.maxParseBytes`, parsing is budget-limited via a stat-only
     * preselection pass (see {@link LoadAllOptions.maxParseBytes}); skipped
     * records are not deleted and remain loadable via loadSync(id, hint). */
    async loadAll(options?: LoadAllOptions): Promise<Map<string, PersistedEnvelope<T>>> {
        const out = new Map<string, PersistedEnvelope<T>>();
        if (!this.enabled) return out;
        const files =
            options?.maxParseBytes == null
                ? await this.walkJsonFiles(this.dir)
                : await this.selectWithinBudget(options.maxParseBytes);
        for (const file of files) {
            const envelope = this.readEnvelope(file);
            if (!envelope) continue;
            const base = path.basename(file);
            const relBase = path.basename(this.relPathOf(envelope.id, envelope.payload));
            const flatBase = flatFileNameFor(envelope.id);
            // A file is a valid record for its envelope id when its name is the
            // canonical name OR a spill (`.fb`) of the canonical name. This lets
            // a spilled record (written while the canonical was locked) be
            // discovered and reconciled against the canonical by savedAt.
            let owner: string | null = null;
            if (base === relBase || base === flatBase) {
                owner = envelope.id;
            } else if (base.endsWith(".fb.json")) {
                const canonicalBase = `${base.slice(0, -".fb.json".length)}.json`;
                if (canonicalBase === relBase || canonicalBase === flatBase) {
                    owner = envelope.id;
                }
            }
            if (owner === null) {
                this.log("warn", `[persist] skipping ${rel(file, this.dir)}: filename does not match record id`);
                continue;
            }
            const existing = out.get(owner);
            if (!existing || envelope.savedAt >= existing.savedAt) {
                out.set(owner, envelope);
                this.discovered.set(owner, file);
            }
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
        const env = this.envelope(id, payload);
        try {
            await fsp.writeFile(tmp, JSON.stringify(env), "utf8");
            await this.renameWithRetry(tmp, file);
            this.discovered.set(id, file);
            this.clearFailure(id);
            await this.removeSpill(file);
        } catch (e) {
            // Clean up the .tmp orphan so the next write doesn't collide with it.
            await fsp.unlink(tmp).catch(() => {});
            // The canonical rename outlived the retry window (Windows lock held
            // by AV/indexer/SMB). Spill to a side file so the data still lands
            // on disk instead of being dropped — loadAll picks the freshest of
            // the canonical and the spill.
            let spillPath: string | null = null;
            try {
                const spill = this.spillPathFor(file);
                await fsp.writeFile(spill, JSON.stringify(env), "utf8");
                spillPath = spill;
                this.discovered.set(id, spill);
            } catch {
                // spillover also failed (dir read-only / disk full) — data at risk
            }
            this.recordFailure(id, e, spillPath);
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

    private backoffMs(attempt: number): number {
        return Math.min(this.retryBaseMs * 2 ** attempt, this.retryMaxMs);
    }

    /** Side file for a record whose canonical write keeps failing: the
     *  canonical name with a `.fb` (fallback) infix, e.g. `a.json` →
     *  `a.fb.json`. One slot per id, overwritten on each spill, so a stuck
     *  lock never accumulates files. Ends in `.json` so loadAll discovers it. */
    private spillPathFor(file: string): string {
        const base = path.basename(file);
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : ".json";
        return path.join(path.dirname(file), `${stem}.fb${ext}`);
    }

    /** Remove a stale spill after a successful canonical write (best-effort). */
    private async removeSpill(file: string): Promise<void> {
        await fsp.unlink(this.spillPathFor(file)).catch(() => {});
    }

    private removeSpillSync(file: string): void {
        try {
            fs.unlinkSync(this.spillPathFor(file));
        } catch {
            // no spill or still locked — loadAll reconciles by savedAt
        }
    }

    /** Rate-limited failure alerting: log on the first failure and at each
     *  power-of-two count (1,2,4,8,…), so a long lock yields ~log2(N) lines
     *  instead of one per write. Includes the spill path so the operator can
     *  see where the data landed. */
    private recordFailure(id: string, err: unknown, spillPath: string | null): void {
        const count = (this.failCounts.get(id) ?? 0) + 1;
        this.failCounts.set(id, count);
        const alertAt = count === 1 || (count >= 2 && (count & (count - 1)) === 0);
        if (!alertAt) return;
        const where = spillPath
            ? `; data spilled to ${rel(spillPath, this.dir)}`
            : "; SPILLOVER ALSO FAILED — data at risk";
        this.log(count === 1 ? "error" : "warn", `[persist] write failed for ${id} (total ${count}x): ${errText(err)}${where}`);
    }

    private clearFailure(id: string): void {
        this.failCounts.delete(id);
    }

    /** fs.rename with exponential-backoff retries on Windows transient locks
     *  (EPERM/EBUSY/EACCES from AV scan, search indexer, SMB). Other errors
     *  are real and rethrown immediately. */
    private async renameWithRetry(src: string, dest: string): Promise<void> {
        let lastErr: unknown;
        for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
            try {
                await fsp.rename(src, dest);
                return;
            } catch (e) {
                lastErr = e;
                const code = (e as NodeJS.ErrnoException).code;
                if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw e;
                if (attempt === this.retryAttempts - 1) throw e;
                const { promise, resolve } = Promise.withResolvers<void>();
                setTimeout(resolve, this.backoffMs(attempt));
                await promise;
            }
        }
        throw lastErr;
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
        if (isEnvelopeLike(parsed)) {
            if (!this.validateFn(parsed as PersistedEnvelope<T>)) {
                this.log("warn", `[persist] skipping invalid record ${rel(file, this.dir)}`);
                return null;
            }
            return parsed as PersistedEnvelope<T>;
        }
        const adopted = this.adoptLegacy(parsed);
        if (adopted) return adopted;
        this.log("warn", `[persist] skipping invalid record ${rel(file, this.dir)}`);
        return null;
    }

    /** Wrap a legacy (pre-envelope) record as an envelope via the `legacy`
     *  hook, then validate the adopted payload like any other. */
    private adoptLegacy(parsed: unknown): PersistedEnvelope<T> | null {
        const adoption = this.legacyFn ? this.legacyFn(parsed) : null;
        if (!adoption || typeof adoption.id !== "string" || adoption.id.length === 0 || adoption.payload == null) {
            return null;
        }
        const source = parsed as Partial<PersistedEnvelope<T>>;
        const envelope: PersistedEnvelope<T> = {
            version: adoption.version ?? source.version ?? this.version,
            savedAt: adoption.savedAt ?? source.savedAt ?? 0,
            id: adoption.id,
            payload: adoption.payload,
        };
        if (!this.validateFn(envelope)) return null;
        return envelope;
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

    /** Stat-only preselection for budgeted loadAll: pairs each canonical
     *  file with its `.fb.json` spill under a dir+stem key (identical stems
     *  in different directories are different records), sums group sizes,
     *  and fills the budget newest-mtime-first. Never reads file content. */
    private async selectWithinBudget(budget: number): Promise<string[]> {
        if (!Number.isFinite(budget) || budget < 0) {
            throw new TypeError(
                `maxParseBytes must be a finite non-negative number, got ${String(budget)}`,
            );
        }
        const entries = await Promise.all(
            (await this.walkJsonFiles(this.dir)).map(async (file) => {
                try {
                    const st = await fsp.stat(file);
                    return { file, size: st.size, mtimeMs: st.mtimeMs };
                } catch {
                    return null; // vanished or unreadable between walk and stat
                }
            }),
        );
        const groups = new Map<string, { key: string; files: string[]; size: number; mtimeMs: number }>();
        for (const e of entries) {
            if (!e) continue;
            const base = path.basename(e.file);
            const stem = base.endsWith(".fb.json")
                ? base.slice(0, -".fb.json".length)
                : base.slice(0, -".json".length);
            const key = `${path.dirname(e.file)}\u0000${stem}`;
            const g = groups.get(key) ?? { key, files: [], size: 0, mtimeMs: 0 };
            g.files.push(e.file);
            g.size += e.size;
            g.mtimeMs = Math.max(g.mtimeMs, e.mtimeMs);
            groups.set(key, g);
        }
        const ordered = [...groups.values()].sort(
            (a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
        );
        const selected: string[] = [];
        let used = 0;
        let skipped = 0;
        for (const g of ordered) {
            if (used + g.size > budget) {
                skipped++;
                continue;
            }
            selected.push(...g.files);
            used += g.size;
        }
        if (skipped > 0) {
            this.log(
                "warn",
                `[persist] loadAll budget ${budget} bytes: parsed ${ordered.length - skipped}/${ordered.length} record groups (skipped ${skipped})`,
            );
        }
        return selected;
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

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}


function rel(p: string, base: string): string {
    const r = path.relative(base, p);
    return r && !r.startsWith("..") ? r : p;
}
