import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { domainLabel, parseAttestation, parseSignerState } from "../../src/lib/contract.js";

// Real `v1.signer` view results captured from mainnet.
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const STATE = fixture("signer-state.json");

describe("parseSignerState", () => {
  it("parses the running mainnet state", () => {
    const state = parseSignerState(STATE);
    assert.equal(state.phase, "running");
    assert.equal(state.threshold, 11);
    assert.equal(state.epochId, 13);
    assert.equal(state.participants.length, 17);
    assert.deepEqual(state.participants[0], {
      account: "blacksandtech.near",
      id: 0,
      url: "https://multichain-mainnet-0.near.blksnd.xyz",
      tlsPublicKey: "ed25519:2XPuwqhg71RXRiTUMKGapd8FYWgXnxVvydYBK9tS1ex2",
    });
    assert.equal(new Set(state.participants.map((p) => p.account)).size, 17, "accounts are unique");
    assert.deepEqual(
      state.domains.map((d) => [d.id, d.protocol, d.purpose, d.threshold]),
      [
        [0, "CaitSith", "Sign", 11],
        [1, "Frost", "Sign", 11],
        [2, "ConfidentialKeyDerivation", "CKD", 11],
        [3, "CaitSith", "ForeignTx", 11],
      ],
    );
  });

  it("uses the previous running state while resharing", () => {
    const resharing = { Resharing: { previous_running_state: STATE.Running, resharing_key: {} } };
    const state = parseSignerState(resharing);
    assert.equal(state.phase, "resharing");
    assert.equal(state.participants.length, 17);
  });

  it("explains when the contract is not signing", () => {
    assert.throws(() => parseSignerState("NotInitialized"), /expected state to be an object/);
    assert.throws(() => parseSignerState({ Initializing: {} }), /not signing right now \(state: Initializing\)/);
  });

  it("rejects malformed participants with a pointed message", () => {
    const broken = structuredClone(STATE);
    broken.Running.parameters.participants.participants[2] = ["x.near", 2];
    assert.throws(() => parseSignerState(broken), /malformed participant #2/);

    const badUrl = structuredClone(STATE);
    badUrl.Running.parameters.participants.participants[0][2].url = 42;
    assert.throws(() => parseSignerState(badUrl), /participant #0 url/);
  });
});

describe("parseAttestation", () => {
  it("recognizes a TDX (Dstack) attestation", () => {
    assert.deepEqual(parseAttestation(fixture("attestation-dstack.json")), {
      kind: "tdx",
      expiresAtMs: 1791403011000,
      imageHash: "a6beae87e398f5b16d923193753a57b0985098be04d06e82b3fdad78fe41ed2d",
    });
  });

  it("recognizes a mock attestation with constraints", () => {
    assert.deepEqual(parseAttestation(fixture("attestation-mock.json")), {
      kind: "mock",
      expiresAtMs: 1791401557000,
      imageHash: null,
    });
  });

  it("recognizes the bare Mock variant", () => {
    assert.deepEqual(parseAttestation({ Mock: "Valid" }), { kind: "mock", expiresAtMs: null, imageHash: null });
  });

  it("treats null and unknown shapes as no attestation", () => {
    const none = { kind: "none", expiresAtMs: null, imageHash: null };
    assert.deepEqual(parseAttestation(null), none);
    assert.deepEqual(parseAttestation({ SomethingNew: {} }), none);
  });
});

describe("domainLabel", () => {
  it("names each mainnet domain", () => {
    const labels = parseSignerState(STATE).domains.map(domainLabel);
    assert.deepEqual(labels, ["ECDSA secp256k1", "EdDSA ed25519", "Confidential key", "Foreign tx proof"]);
  });

  it("falls back for unknown protocols and missing domains", () => {
    assert.equal(domainLabel({ id: 9, protocol: "Lattice", purpose: "Sign", threshold: 3 }), "Lattice");
    assert.equal(domainLabel(undefined), "Unknown domain");
  });
});
