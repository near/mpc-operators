import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseSignerState } from "../../src/lib/contract.js";
import { parseNodeLocations, serializeNodeLocations } from "../../src/lib/locations.js";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("parseNodeLocations", () => {
  it("round-trips through serializeNodeLocations", () => {
    const parsed = parseNodeLocations(read("../../data/node-locations.json"));
    assert.deepEqual(parseNodeLocations(serializeNodeLocations(parsed)), parsed);
  });

  it("drops malformed and out-of-range entries but keeps the good ones", () => {
    const { nodes, generatedAt } = parseNodeLocations({
      generatedAt: "2026-09-30T00:00:00Z",
      nodes: {
        "good.near": { lat: 50, lon: 8, city: "Limburg", countryCode: "DE" },
        "no-coords.near": { city: "Nowhere" },
        "off-planet.near": { lat: 91, lon: 0 },
        "string-lat.near": { lat: "50", lon: 8 },
        "not-an-object.near": 42,
      },
    });
    assert.equal(generatedAt, "2026-09-30T00:00:00Z");
    assert.deepEqual([...nodes.keys()], ["good.near"]);
    assert.equal(nodes.get("good.near")?.provider, "", "missing strings default to empty");
  });

  it("returns an empty set for garbage", () => {
    assert.equal(parseNodeLocations(null).nodes.size, 0);
    assert.equal(parseNodeLocations({ nodes: [] }).nodes.size, 0);
  });
});

describe("data/node-locations.json", () => {
  const file = read("../../data/node-locations.json");
  const { nodes } = parseNodeLocations(file);

  it("has no entries the parser has to drop", () => {
    assert.equal(nodes.size, Object.keys(file.nodes).length);
  });

  it("covers every participant in the captured contract state", () => {
    const state = parseSignerState(read("../fixtures/signer-state.json"));
    const missing = state.participants.map((p) => p.account).filter((a) => !nodes.has(a));
    assert.deepEqual(missing, []);
  });
});
