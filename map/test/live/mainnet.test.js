// End-to-end against real mainnet services. Needs network access.
// Optional keys: FASTNEAR_API_KEY, NEARBLOCKS_API_KEY.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { fetchAccountTxs, fetchTransactions } from "../../src/api/fastnear.js";
import { locateHost } from "../../src/api/geoip.js";
import { HttpError } from "../../src/api/http.js";
import { fetchAttestation, fetchSignerState } from "../../src/api/near.js";
import { fetchDecodedSignatures } from "../../src/api/nearblocks.js";
import { hostOf } from "../../src/lib/geo.js";
import { Ledger, SIGNER_CONTRACT } from "../../src/lib/ledger.js";
import { parseNodeLocations } from "../../src/lib/locations.js";

const fastnear = { apiKey: process.env.FASTNEAR_API_KEY || undefined };
const nearblocks = { apiKey: process.env.NEARBLOCKS_API_KEY || undefined };

describe("mainnet", { timeout: 60_000 }, () => {
  it("reads v1.signer state and a node attestation over RPC", async () => {
    const state = await fetchSignerState(fastnear);
    assert.ok(state.participants.length >= state.threshold);
    assert.ok(state.threshold > 1);
    const attestation = await fetchAttestation(state.participants[0].tlsPublicKey, fastnear);
    assert.ok(["tdx", "mock", "none"].includes(attestation.kind));
  });

  it("pairs live requests with the current participants that answered them", async () => {
    const [state, recent] = await Promise.all([fetchSignerState(fastnear), fetchAccountTxs(SIGNER_CONTRACT, fastnear)]);
    assert.ok(recent.length > 0);
    const txs = await fetchTransactions(recent.slice(0, 60).map((t) => t.transaction_hash), fastnear);
    assert.ok(txs.length > 0);

    const ledger = new Ledger();
    const { resolved } = ledger.ingestTransactions(txs);
    assert.ok(resolved.length > 0, "at least one request in the latest 60 txs was answered");
    const participants = new Set(state.participants.map((p) => p.account));
    for (const r of resolved) {
      assert.ok(r.response && participants.has(r.response.node), `${r.response?.node} is a participant`);
      assert.ok(r.response.timestampMs >= r.timestampMs);
    }
  });

  it("geolocates a participant host", async () => {
    const state = await fetchSignerState(fastnear);
    const host = hostOf(state.participants[0].url);
    assert.ok(host);
    const where = await locateHost(host);
    assert.ok(Math.abs(where.lat) <= 90 && Math.abs(where.lon) <= 180);
  });

  it("has a location on file for every current participant", async () => {
    const state = await fetchSignerState(fastnear);
    const { nodes } = parseNodeLocations(JSON.parse(readFileSync(new URL("../../data/node-locations.json", import.meta.url), "utf8")));
    const missing = state.participants.map((p) => p.account).filter((a) => !nodes.has(a));
    assert.deepEqual(missing, [], "operators changed: run `node scripts/locate-nodes.mjs`");
  });

  it("decodes destinations on NearBlocks", async (t) => {
    try {
      const rows = await fetchDecodedSignatures(nearblocks);
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.equal(typeof row.receipt_id, "string");
        assert.equal(typeof row.dest_chain, "string");
      }
    } catch (error) {
      if (error instanceof HttpError && error.rateLimited && !nearblocks.apiKey) {
        t.skip("NearBlocks free tier is rate limited from this IP; set NEARBLOCKS_API_KEY");
        return;
      }
      throw error;
    }
  });
});
