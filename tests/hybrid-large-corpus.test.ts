import test from "node:test";
import assert from "node:assert";
import { hybridAlgorithm } from "../src/search/algorithms/hybrid.js";
import type { SearchDoc } from "../src/search/types.js";

// 130K docs exceeds the V8 spread argument limit (~125K–130K on Node 22):
// the old `Math.max(...scores)` normalization threw `RangeError: Maximum call
// stack size exceeded` before returning any result (#227).
const N = 130_000;

function makeDocs(n: number): SearchDoc[] {
    const docs: SearchDoc[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
        docs[i] = {
            kind: "message",
            ref: `m${String(i).padStart(5, "0")}`,
            text: `ledger entry ${i} alpha`,
            title: `entry ${i}`,
            role: "tool",
        };
    }
    // one distinctive doc — scoring must still rank it first, not just not crash
    docs[42] = {
        kind: "message",
        ref: "m00042",
        text: "the zephyr marker document",
        title: "entry 42",
        role: "tool",
    };
    return docs;
}

test("hybridAlgorithm.score handles 130K docs without the spread RangeError (#227)", () => {
    const docs = makeDocs(N);
    const results = hybridAlgorithm.score(docs, "zephyr");
    assert.equal(results.length, N);
    const top = results.reduce((best, r) => (r.score > best.score ? r : best), results[0]!);
    assert.equal(top.ref, "m00042");
});
