import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fnv1a, pickPeers } from "../../src/lib/cohort.js";
import * as fmt from "../../src/lib/format.js";
import { hostOf, isIPv4, spreadOverlapping } from "../../src/lib/geo.js";

const ACCOUNTS = Array.from({ length: 17 }, (_, i) => `node-${i}.near`);

describe("fnv1a", () => {
  it("matches the reference vectors", () => {
    assert.equal(fnv1a(""), 0x811c9dc5);
    assert.equal(fnv1a("a"), 0xe40c292c);
    assert.equal(fnv1a("foobar"), 0xbf9cf968);
  });
});

describe("pickPeers", () => {
  it("returns threshold-1 distinct peers, never the leader", () => {
    const peers = pickPeers("receipt-1", "node-3.near", ACCOUNTS, 11);
    assert.equal(peers.length, 10);
    assert.equal(new Set(peers).size, 10);
    assert.ok(!peers.includes("node-3.near"));
    for (const p of peers) assert.ok(ACCOUNTS.includes(p));
  });

  it("is deterministic per seed and does not depend on input order", () => {
    const a = pickPeers("receipt-1", "node-3.near", ACCOUNTS, 11);
    const b = pickPeers("receipt-1", "node-3.near", [...ACCOUNTS].reverse(), 11);
    assert.deepEqual(a, b);
  });

  it("varies across seeds and spreads load evenly", () => {
    const counts = new Map(ACCOUNTS.map((a) => [a, 0]));
    const runs = 4000;
    const sets = new Set();
    for (let i = 0; i < runs; i++) {
      const peers = pickPeers(`seed-${i}`, "node-0.near", ACCOUNTS, 11);
      sets.add(peers.slice().sort().join());
      for (const p of peers) counts.set(p, counts.get(p) + 1);
    }
    assert.ok(sets.size > 100, "many different peer sets");
    assert.equal(counts.get("node-0.near"), 0);
    const expected = runs * (10 / 16);
    for (const [account, n] of counts) {
      if (account === "node-0.near") continue;
      assert.ok(Math.abs(n - expected) / expected < 0.08, `${account} picked ${n} times, expected ~${expected}`);
    }
  });

  it("copes with fewer accounts than the threshold, and threshold 0", () => {
    assert.deepEqual(pickPeers("s", "a", ["a", "b"], 5), ["b"]);
    assert.deepEqual(pickPeers("s", "a", ["a", "b"], 0), []);
  });
});

describe("hostOf / isIPv4", () => {
  it("extracts hostnames from the URL shapes operators register", () => {
    assert.equal(hostOf("https://multichain-mainnet-0.near.blksnd.xyz"), "multichain-mainnet-0.near.blksnd.xyz");
    assert.equal(hostOf("https://57.129.86.53:80"), "57.129.86.53");
    assert.equal(hostOf("http://nearmpc-mainnet-tdx.everstake.com:80"), "nearmpc-mainnet-tdx.everstake.com");
  });

  it("returns null for unusable URLs", () => {
    assert.equal(hostOf("not a url"), null);
    assert.equal(hostOf(""), null);
  });

  it("tells IPv4 literals from hostnames", () => {
    assert.ok(isIPv4("57.129.86.53"));
    assert.ok(!isIPv4("256.1.1.1"));
    assert.ok(!isIPv4("1.2.3"));
    assert.ok(!isIPv4("near.node.monster"));
  });
});

describe("spreadOverlapping", () => {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  it("leaves well-separated points alone", () => {
    const out = spreadOverlapping([{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 0 }], 15);
    assert.deepEqual(out.map(({ id, x, y, cx, cy }) => [id, x, y, cx, cy]), [[1, 0, 0, 0, 0], [2, 100, 0, 100, 0]]);
  });

  const minPairDistance = (pts) => {
    let min = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) min = Math.min(min, dist(pts[i], pts[j]));
    return min;
  };

  it("separates co-located points and remembers their true spot", () => {
    const points = [0, 1, 2].map((id) => ({ id, x: 50, y: 50 }));
    const out = spreadOverlapping(points, 15);
    assert.equal(out.length, 3);
    assert.ok(minPairDistance(out) >= 15 * 0.97, `min distance ${minPairDistance(out)}`);
    for (const p of out) {
      assert.equal(p.cx, 50);
      assert.equal(p.cy, 50);
      assert.ok(dist(p, { x: 50, y: 50 }) < 20, "stays near its true spot");
    }
  });

  it("untangles a dense real-world cluster without scattering it", () => {
    // Twelve markers within ~60px, like Western Europe on a 1000px-wide map.
    const cluster = [
      [610, 210], [612, 212], [611, 209], [640, 230], [641, 231], [600, 240],
      [620, 250], [650, 220], [655, 205], [630, 215], [615, 225], [645, 245],
    ].map(([x, y], id) => ({ id, x, y }));
    const out = spreadOverlapping(cluster, 15);
    assert.ok(minPairDistance(out) >= 15 * 0.97, `min distance ${minPairDistance(out)}`);
    for (const p of out) assert.ok(dist(p, { x: p.cx, y: p.cy }) < 35, `marker ${p.id} drifted ${dist(p, { x: p.cx, y: p.cy })}px`);
  });

  it("is deterministic", () => {
    const points = [0, 1, 2, 3].map((id) => ({ id, x: 10, y: 10 }));
    assert.deepEqual(spreadOverlapping(points, 15), spreadOverlapping(points, 15));
  });

  it("keeps every input and its extra fields", () => {
    const points = [{ id: "a", x: 0, y: 0 }, { id: "b", x: 3, y: 0 }, { id: "c", x: 300, y: 0 }];
    const out = spreadOverlapping(points, 15);
    assert.deepEqual(out.map((p) => p.id).sort(), ["a", "b", "c"]);
  });
});

describe("format", () => {
  it("ago", () => {
    assert.equal(fmt.ago(0, 4_400), "4s");
    assert.equal(fmt.ago(0, 3 * 60_000), "3m");
    assert.equal(fmt.ago(0, 5 * 3_600_000), "5h");
    assert.equal(fmt.ago(0, 72 * 3_600_000), "3d");
    assert.equal(fmt.ago(10_000, 0), "0s", "clock skew never goes negative");
  });

  it("seconds", () => {
    assert.equal(fmt.seconds(2_345), "2.3s");
    assert.equal(fmt.seconds(12_600), "13s");
  });

  it("middle", () => {
    assert.equal(fmt.middle("abcdefghijklmnop", 3), "abc…nop");
    assert.equal(fmt.middle("short", 3), "short");
  });

  it("account shortens implicit accounts but keeps named ones", () => {
    const implicit = "d5a1b344a608bbd56f8d6daac2c21fec5bf22ffb59e48841fe78e1153000476a";
    assert.equal(fmt.account(implicit), "d5a1b…0476a");
    assert.equal(fmt.account("0x88424e5ae2cea108e6c9365e26bc55218f7e783f"), "0x8842…7e783f");
    assert.equal(fmt.account("omni.bridge.near"), "omni.bridge.near");
    assert.equal(fmt.account("mpc-prover-0_4_12.bridge.near"), "mpc-prover-0_4_12.bridge.near");
  });

  it("chainInfo links every NearBlocks chain's explorer and degrades for new ones", () => {
    for (const chain of ["ARBITRUM", "BASE", "BITCOIN", "BSC", "ETHEREUM", "GNOSIS", "OPTIMISM", "POLYGON", "SOLANA", "ZCASH"]) {
      const info = fmt.chainInfo(chain);
      assert.match(info.tx("abc") ?? "", /^https:\/\/.+abc$/, chain);
    }
    const unknown = fmt.chainInfo("APTOS");
    assert.equal(unknown.name, "Aptos");
    assert.equal(unknown.tx("abc"), null);
  });
});
