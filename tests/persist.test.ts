import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StateStore, flatFileNameFor } from "../src/persist/store.js";
import { mergeCompressionState } from "../src/persist/state-merge.js";
import { createInitialState } from "../src/state.js";
import type { CompressionState } from "../src/types.js";

interface Payload {
    label: string;
    count: number;
}

function tmpDir(): string {
    return mkdtempSync(path.join(tmpdir(), "acp-kernel-persist-"));
}

function store(dir: string, opts: Partial<ConstructorParameters<typeof StateStore<Payload>>[0]> = {}): StateStore<Payload> {
    return new StateStore<Payload>({ dir, version: 1, ...opts });
}

/**
 * Poll until `cond` holds. Debounce timing is real platform behavior (the
 * timer fires via the event loop), so the tests await the observable signal
 * — the settled disk state — instead of a guessed fixed duration. The sleep
 * step is only the poll cadence, never the assertion.
 */
async function until(cond: () => boolean, what: string, deadlineMs = 4000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > deadlineMs) {
            assert.fail(`timed out waiting for: ${what}`);
        }
        await new Promise((r) => setTimeout(r, 5));
    }
}

test("writeNow persists a round-trippable envelope", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir);
        await s.writeNow("sid-1", () => ({ label: "hello", count: 42 }));
        const loaded = s.loadSync("sid-1");
        assert.ok(loaded);
        assert.equal(loaded.id, "sid-1");
        assert.equal(loaded.version, 1);
        assert.equal(typeof loaded.savedAt, "number");
        assert.deepEqual(loaded.payload, { label: "hello", count: 42 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("writeNow builds the payload at write time, not call time", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir);
        const live = { label: "before", count: 0 };
        const pending = s.writeNow("sid-live", () => live);
        live.label = "after";
        live.count = 7;
        await pending;
        const loaded = s.loadSync("sid-live");
        assert.ok(loaded);
        assert.deepEqual(loaded.payload, { label: "after", count: 7 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loadSync returns null for unknown ids and when disabled", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir);
        assert.equal(s.loadSync("missing"), null);
        const off = store(dir, { enabled: false });
        await off.writeNow("sid-off", () => ({ label: "x", count: 0 }));
        assert.equal(off.loadSync("sid-off"), null);
        assert.equal((await off.loadAll()).size, 0);
        // disabled flushSync reports success (nothing was at risk)
        assert.equal(off.flushSync("sid-off", () => ({ label: "x", count: 0 })), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("scheduleSave coalesces bursts into one freshest write", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir, { debounceMs: 20 });
        let builds = 0;
        const live = { label: "v1", count: 1 };
        const build = (): Payload => {
            builds += 1;
            return live;
        };
        s.scheduleSave("sid-d", build);
        live.label = "v2";
        live.count = 2;
        s.scheduleSave("sid-d", build);
        assert.equal(s.hasPending("sid-d"), true);
        assert.deepEqual(s.pendingIds(), ["sid-d"]);
        // await the settled disk state: the debounced timer fired, the write
        // landed, and it carries the freshest payload
        await until(() => s.loadSync("sid-d")?.payload.label === "v2", "debounced write to settle");
        assert.equal(s.hasPending("sid-d"), false);
        // builder ran exactly once — the second scheduleSave only replaced it
        assert.equal(builds, 1);
        assert.deepEqual(s.loadSync("sid-d")?.payload, { label: "v2", count: 2 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("scheduleSave builder failures are contained, not unhandled rejections", async () => {
    const dir = tmpDir();
    try {
        const errors: string[] = [];
        const s = store(dir, {
            debounceMs: 10,
            log: (level, msg) => {
                if (level === "error") errors.push(msg);
            },
        });
        s.scheduleSave("sid-bad", () => {
            throw new Error("boom");
        });
        await until(() => !s.hasPending("sid-bad") && errors.length > 0, "failed builder to be logged");
        assert.equal(errors.length, 1);
        assert.match(errors[0] ?? "", /boom/);
        // store still usable afterwards
        await s.writeNow("sid-ok", () => ({ label: "ok", count: 0 }));
        assert.ok(s.loadSync("sid-ok"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("flushSync writes immediately and cancels the debounce", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir, { debounceMs: 30 });
        let builds = 0;
        s.scheduleSave("sid-f", () => {
            builds += 1;
            return { label: "debounced", count: 0 };
        });
        assert.equal(s.flushSync("sid-f", () => ({ label: "flushed", count: 3 })), true);
        assert.equal(s.hasPending("sid-f"), false);
        const loaded = s.loadSync("sid-f");
        assert.ok(loaded);
        assert.deepEqual(loaded.payload, { label: "flushed", count: 3 });
        // Proving the cancelled timer never fires is a negative over time.
        // Deterministic clock control can't cover it: node:test mock timers
        // don't support the unref() the store's debounce relies on, so this
        // one assertion deliberately outruns the real 30ms window.
        const start = Date.now();
        while (Date.now() - start < 60) {
            await new Promise((r) => setTimeout(r, 5));
        }
        assert.equal(builds, 0); // timer cancelled before it could fire
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("flushAll flushes pending builders and drains in-flight writes", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir, { debounceMs: 5000 });
        s.scheduleSave("sid-a", () => ({ label: "a", count: 0 }));
        s.scheduleSave("sid-b", () => ({ label: "b", count: 0 }));
        assert.equal(s.pendingIds().length, 2);
        await s.flushAll();
        assert.equal(s.pendingIds().length, 0);
        assert.ok(s.loadSync("sid-a"));
        assert.ok(s.loadSync("sid-b"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("concurrent writeNow calls on one id serialize and leave a valid file", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir);
        const writes = Array.from({ length: 12 }, (_, i) =>
            s.writeNow("sid-race", () => ({ label: `w${i}`, count: i })).then(() => i),
        );
        const settled = await Promise.all(writes);
        assert.deepEqual(settled, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        const loaded = s.loadSync("sid-race");
        assert.ok(loaded);
        assert.equal(loaded.payload.count, 11); // last write wins
        // no orphan temp files left behind
        const leftovers = readdirSync(dir).filter((f) => f.startsWith(".tmp-"));
        assert.deepEqual(leftovers, []);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loadAll skips corrupt files, tmp orphans, and id/filename mismatches", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir);
        await s.writeNow("good-1", () => ({ label: "good", count: 1 }));
        writeFileSync(path.join(dir, flatFileNameFor("corrupt-1")), "{ not json", "utf8");
        writeFileSync(path.join(dir, ".tmp-orphan-123"), JSON.stringify({ version: 1, savedAt: 0, id: "orph", payload: {} }), "utf8");
        // envelope with a valid shape but a filename from a different id
        writeFileSync(path.join(dir, flatFileNameFor("other-id")), JSON.stringify({ version: 1, savedAt: 0, id: "impostor", payload: { label: "x", count: 0 } }), "utf8");
        const all = await s.loadAll();
        assert.deepEqual([...all.keys()], ["good-1"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loadAll rejects records failing the downstream validate hook", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir, { validate: (env) => typeof env.payload.count === "number" && env.payload.count > 0 });
        await s.writeNow("pos", () => ({ label: "p", count: 5 }));
        await s.writeNow("zero", () => ({ label: "z", count: 0 }));
        const all = await s.loadAll();
        assert.deepEqual([...all.keys()], ["pos"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("custom relPath namespaces into subdirectories and loadAll discovers them", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir, {
            relPath: (id, payload) => path.join(payload.label, `${id}.json`),
        });
        await s.writeNow("ns-1", () => ({ label: "openai", count: 1 }));
        // namespaced layout on disk
        const nested = readdirSync(dir).filter((f) => f === "openai");
        assert.equal(nested.length, 1);
        // same process: the write populated the discovery map
        assert.ok(s.loadSync("ns-1"));
        // a fresh store (next process) cannot know the namespaced path
        // before discovery — loadSync probes only the flat default name
        const next = store(dir, {
            relPath: (id, payload) => path.join(payload.label, `${id}.json`),
        });
        assert.equal(next.loadSync("ns-1"), null);
        // …but loadAll discovers it and subsequent loadSync resolves it
        const all = await next.loadAll();
        assert.deepEqual([...all.keys()], ["ns-1"]);
        assert.ok(next.loadSync("ns-1"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("flat legacy name is tolerated in loadAll alongside namespaced relPath", async () => {
    const dir = tmpDir();
    try {
        // a record written flat by an older version of the downstream
        writeFileSync(
            path.join(dir, flatFileNameFor("legacy-1")),
            JSON.stringify({ version: 1, savedAt: 0, id: "legacy-1", payload: { label: "old", count: 9 } }),
            "utf8",
        );
        const s = store(dir, {
            relPath: (id, payload) => path.join(payload.label, `${id}.json`),
        });
        const all = await s.loadAll();
        assert.deepEqual([...all.keys()], ["legacy-1"]);
        assert.deepEqual(all.get("legacy-1")?.payload, { label: "old", count: 9 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("relPath escaping the dir is rejected to the safe flat name", async () => {
    const dir = tmpDir();
    try {
        const warned: string[] = [];
        const s = store(dir, {
            log: (level, msg) => {
                if (level === "warn") warned.push(msg);
            },
            relPath: () => "../../escape.json",
        });
        await s.writeNow("esc-1", () => ({ label: "x", count: 0 }));
        // landed flat inside dir, not outside
        assert.ok(s.loadSync("esc-1"));
        const outsideExists = readdirSync(path.dirname(dir)).includes(flatFileNameFor("esc-1"));
        assert.equal(outsideExists, false);
        assert.ok(warned.some((w) => w.includes("escapes dir")));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loadAll walks nested namespaces recursively", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir, {
            relPath: (id, payload) => path.join("proto", payload.label, `${id}.json`),
        });
        await s.writeNow("deep-1", () => ({ label: "hostA", count: 1 }));
        await s.writeNow("deep-2", () => ({ label: "hostB", count: 2 }));
        mkdirSync(path.join(dir, "proto", "hostC"), { recursive: true });
        writeFileSync(
            path.join(dir, "proto", "hostC", "deep-3.json"),
            JSON.stringify({ version: 1, savedAt: 0, id: "deep-3", payload: { label: "hostC", count: 3 } }),
            "utf8",
        );
        const all = await s.loadAll();
        assert.deepEqual([...all.keys()].sort(), ["deep-1", "deep-2", "deep-3"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("cancelAll drops pending writes without flushing", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir, { debounceMs: 5000 });
        s.scheduleSave("sid-c", () => ({ label: "gone", count: 0 }));
        s.cancelAll();
        assert.equal(s.hasPending("sid-c"), false);
        // deterministic: the debounce timer was the only write path, and it
        // was cleared before firing — no file exists
        assert.equal(s.loadSync("sid-c"), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a store on a missing dir loads empty and creates the dir on first write", async () => {
    const dir = path.join(tmpDir(), "not-created-yet");
    try {
        const s = store(dir);
        assert.equal((await s.loadAll()).size, 0);
        await s.writeNow("sid-m", () => ({ label: "m", count: 0 }));
        assert.ok(s.loadSync("sid-m"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("mergeCompressionState fills missing fields from a fresh state", () => {
    const fresh = createInitialState();
    const partial = { blocks: [] } as CompressionState;
    const merged = mergeCompressionState(partial);
    assert.deepEqual(merged.messageRefs, fresh.messageRefs);
    assert.deepEqual(merged.nudge, fresh.nudge);
    assert.deepEqual(merged.stats, fresh.stats);
    assert.equal(merged.nextBlockId, fresh.nextBlockId);
    assert.equal(merged.nextRunId, fresh.nextRunId);
    assert.deepEqual(merged.tokenSnapshot, fresh.tokenSnapshot);
});

test("mergeCompressionState keeps parsed values over defaults", () => {
    const parsed: CompressionState = {
        ...createInitialState(),
        nextBlockId: 41,
        stats: { tokensCompressed: 1234, compressionCount: 7 },
    };
    const merged = mergeCompressionState(parsed);
    assert.equal(merged.nextBlockId, 41);
    assert.deepEqual(merged.stats, { tokensCompressed: 1234, compressionCount: 7 });
});

test("legacy hook adopts pre-envelope records on loadAll and loadSync", async () => {
    const dir = tmpDir();
    try {
        // A proxy-style flat record: no `payload` wrapper, id at top level.
        const flat = {
            version: 3,
            savedAt: 12345,
            id: "flat-1",
            label: "adopted",
            count: 9,
        };
        const flatFile = path.join(dir, flatFileNameFor("flat-1"));
        writeFileSync(flatFile, JSON.stringify(flat), "utf8");
        const s = store(dir, {
            legacy: (parsed) => {
                const p = parsed as { id?: unknown; label?: unknown; count?: unknown };
                if (typeof p.id !== "string" || typeof p.label !== "string" || typeof p.count !== "number") return null;
                return { id: p.id, payload: { label: p.label, count: p.count } };
            },
        });
        const all = await s.loadAll();
        assert.equal(all.size, 1);
        const env = all.get("flat-1");
        assert.ok(env);
        assert.equal(env.id, "flat-1");
        assert.deepEqual(env.payload, { label: "adopted", count: 9 });
        // The source record's own stamps are preserved, not stamped fresh.
        assert.equal(env.version, 3);
        assert.equal(env.savedAt, 12345);
        // loadSync finds it too (discovered by loadAll).
        const direct = s.loadSync("flat-1");
        assert.ok(direct);
        assert.deepEqual(direct.payload, { label: "adopted", count: 9 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("legacy adoption is skipped when the hook returns null", async () => {
    const dir = tmpDir();
    try {
        writeFileSync(
            path.join(dir, flatFileNameFor("foreign-1")),
            JSON.stringify({ totally: "unrelated", shape: true }),
            "utf8",
        );
        const s = store(dir, { legacy: () => null });
        assert.equal((await s.loadAll()).size, 0);
        assert.equal(s.loadSync("foreign-1"), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("adopted legacy record re-persists as an envelope on the next write", async () => {
    const dir = tmpDir();
    try {
        writeFileSync(
            path.join(dir, flatFileNameFor("migrate-1")),
            JSON.stringify({ version: 3, savedAt: 1, id: "migrate-1", label: "old", count: 0 }),
            "utf8",
        );
        const s = store(dir, {
            version: 4,
            legacy: (parsed) => {
                const p = parsed as { id?: string; label?: string; count?: number };
                if (typeof p.id !== "string" || typeof p.label !== "string" || typeof p.count !== "number") return null;
                return { id: p.id, payload: { label: p.label, count: p.count } };
            },
        });
        await s.loadAll();
        // Dirty write after adoption: the file on disk becomes an envelope
        // stamped with the store's current version.
        await s.writeNow("migrate-1", () => ({ label: "new", count: 5 }));
        const raw = JSON.parse(readFileSync(path.join(dir, flatFileNameFor("migrate-1")), "utf8")) as {
            version: number;
            payload: { label: string };
        };
        assert.equal(raw.version, 4);
        assert.deepEqual(raw.payload, { label: "new", count: 5 });
        // And a FRESH store (no legacy hook) can read it — migration done.
        const plain = store(dir);
        assert.deepEqual(plain.loadSync("migrate-1")?.payload, { label: "new", count: 5 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loadSync hint probes a namespaced path without loadAll", async () => {
    const dir = tmpDir();
    try {
        const s = store(dir, { relPath: (id, payload) => path.join("proto", payload.label, `${id}.json`) });
        await s.writeNow("hint-1", () => ({ label: "hostA", count: 1 }));
        // A second store instance has NOT discovered the namespaced file —
        // without the hint, loadSync misses (flat fallback only).
        const s2 = store(dir, { relPath: (id, payload) => path.join("proto", payload.label, `${id}.json`) });
        assert.equal(s2.loadSync("hint-1"), null);
        // With the relative-path hint, the namespaced file resolves.
        const hit = s2.loadSync("hint-1", path.join("proto", "hostA", "hint-1.json"));
        assert.ok(hit);
        assert.deepEqual(hit.payload, { label: "hostA", count: 1 });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
