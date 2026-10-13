import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  Ledger,
  canonicalJson,
  decodeArgs,
  describeRequestArgs,
  extractFacts,
  nsToMs,
} from "../../src/lib/ledger.js";

// Real mainnet transactions captured from FastNear's /v0/transactions.
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const TXS = fixture("fastnear-transactions.json").transactions;
const NEARBLOCKS = fixture("nearblocks-signatures.json").data;
const tx = (hash) => {
  const found = TXS.find((t) => t.transaction.hash === hash);
  assert.ok(found, `fixture tx ${hash}`);
  return structuredClone(found);
};

// Request tx -> respond tx -> node that submitted respond, verified by hand
// against nearblocks.io.
const PAIRS = [
  { request: "GrqJKiGJUmQW4xVPNqE2YnSXjrFWoD7PBh58qP26y6vU", respond: "4mtQb4Tno5czHYWPV69vMuBazy7nxf2FPqxvZmXPA2pk", node: "nodemonster.near" },
  { request: "2SVF1JhtRFWvrvFdZ232rbgXWaJkcd7W6ENbJsDwYzMH", respond: "Gm7XD8Er7iRwJqbba2jm9EzgVxtrUKYBNMTwif17Kxtd", node: "klever-nearmpc-01.near" },
  { request: "EQK1ybp3WdhoAY12UBCpa49GcbGPsb6LNQYcASMPGfjf", respond: "DwT4CpriwLK5WKcpVPiTg3HdNzFWhYnqfPkqqDwyHQQS", node: "everstake-mpc-1.near" },
  { request: "2QcHKEPk8GFihbS98vMUiF9SYT5zfGcYqBpAkNcFrddo", respond: "FSteU2u4Qxt7HkszooEYEtEgTwupvXNzfaaQvXy5HVmw", node: "nansen-ai-mpc.near" },
];
const PARTICIPANT_INFO_TX = "6jzTPPqMQkLR429kP9f6NVDsWvH7cWqp2qRpF6n4PGvF";
const ZCASH_SIGN_RECEIPT = "6fLWgNE2dYUL1uZvSb2TNi4f6VPrETzt3v7vEtUQde2M";

/** The same tx as seen before the contract's callback ran. */
function beforeCallback(txObject) {
  const copy = structuredClone(txObject);
  copy.receipts = copy.receipts.filter(
    (r) => !(r.receipt.predecessor_id === "v1.signer" && r.receipt.receiver_id === "v1.signer"),
  );
  return copy;
}

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");

describe("canonicalJson", () => {
  it("ignores object key order at every depth", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } }),
      canonicalJson({ a: { c: "x", d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
  });

  it("keeps array order significant", () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  it("drops undefined fields like JSON.stringify does", () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  it("encodes scalars exactly like JSON", () => {
    assert.equal(canonicalJson("é\"x"), JSON.stringify("é\"x"));
    assert.equal(canonicalJson(null), "null");
    assert.equal(canonicalJson(12.5), "12.5");
  });
});

describe("decodeArgs", () => {
  it("decodes base64 JSON, including non-ASCII", () => {
    assert.deepEqual(decodeArgs(b64({ path: "ñ-0" })), { path: "ñ-0" });
  });

  it("returns undefined for Borsh-encoded args", () => {
    const borsh = Buffer.from([0x16, 0, 0, 0, 0xff, 0xfe, 0x01]).toString("base64");
    assert.equal(decodeArgs(borsh), undefined);
  });

  it("returns undefined for garbage base64", () => {
    assert.equal(decodeArgs("%%%"), undefined);
  });
});

describe("nsToMs", () => {
  it("converts string nanoseconds without float error", () => {
    assert.equal(nsToMs("1790798536280949218"), 1790798536280);
  });

  it("converts numeric nanoseconds", () => {
    assert.equal(nsToMs(1790798536280949218), 1790798536281);
  });
});

describe("describeRequestArgs", () => {
  it("reads the legacy sign shape (key_version is the domain)", () => {
    assert.deepEqual(describeRequestArgs({ request: { payload: [1], path: "bridge-1", key_version: 0 } }), {
      domainId: 0,
      path: "bridge-1",
      foreignChain: null,
    });
  });

  it("reads the current sign shape", () => {
    assert.deepEqual(describeRequestArgs({ request: { payload_v2: { Eddsa: "ab" }, path: "sol-1", domain_id: 1 } }), {
      domainId: 1,
      path: "sol-1",
      foreignChain: null,
    });
  });

  it("reads foreign transaction verification", () => {
    const args = { request: { request: { Aptos: { tx_id: "ab" } }, domain_id: 3, payload_version: 1 } };
    assert.deepEqual(describeRequestArgs(args), { domainId: 3, path: null, foreignChain: "Aptos" });
  });

  it("tolerates missing or malformed args", () => {
    const empty = { domainId: null, path: null, foreignChain: null };
    assert.deepEqual(describeRequestArgs(undefined), empty);
    assert.deepEqual(describeRequestArgs({ request: "nope" }), empty);
    assert.deepEqual(describeRequestArgs({ request: { domain_id: "0", path: 7 } }), empty);
  });
});

describe("extractFacts", () => {
  it("finds the sign request inside a bridge tx, attributed to the calling contract", () => {
    const facts = extractFacts(tx(PAIRS[0].request));
    assert.equal(facts.requests.length, 1);
    const [request] = facts.requests;
    assert.equal(request.receiptId, ZCASH_SIGN_RECEIPT);
    assert.equal(request.requester, "zcash-connector.bridge.near");
    assert.equal(request.txSigner, "omni-relayer.bridge.near");
    assert.equal(request.method, "sign");
    assert.equal(request.domainId, 0);
    assert.equal(request.txHash, PAIRS[0].request);
    assert.ok(request.timestampMs > 1.7e12 && request.timestampMs < 2e12);
    assert.equal(facts.responses.length, 0);
  });

  it("links the callback to the request receipt that spawned it", () => {
    const facts = extractFacts(tx(PAIRS[0].request));
    const callback = facts.callbacks.get(ZCASH_SIGN_RECEIPT);
    assert.ok(callback);
    assert.equal(callback.status, "signed");
    assert.match(callback.key, /"domain_id":0/);
  });

  it("reads the responding node and the same join key from the respond tx", () => {
    const request = extractFacts(tx(PAIRS[0].request));
    const respond = extractFacts(tx(PAIRS[0].respond));
    assert.equal(respond.requests.length, 0);
    assert.equal(respond.responses.length, 1);
    assert.equal(respond.responses[0].node, "nodemonster.near");
    assert.equal(respond.responses[0].method, "respond");
    assert.equal(respond.responses[0].key, request.callbacks.get(ZCASH_SIGN_RECEIPT)?.key);
  });

  it("ignores contract housekeeping like submit_participant_info", () => {
    const facts = extractFacts(tx(PARTICIPANT_INFO_TX));
    assert.equal(facts.requests.length, 0);
    assert.equal(facts.responses.length, 0);
    assert.equal(facts.callbacks.size, 0);
  });

  it("marks a failed callback as failed", () => {
    const failed = tx(PAIRS[0].request);
    for (const r of failed.receipts) {
      if (r.receipt.predecessor_id === "v1.signer" && r.receipt.receiver_id === "v1.signer") {
        r.execution_outcome.outcome.status = { Failure: { ActionError: { index: 0, kind: "timeout" } } };
      }
    }
    assert.equal(extractFacts(failed).callbacks.get(ZCASH_SIGN_RECEIPT)?.status, "failed");
  });

  it("respects a custom contract id", () => {
    assert.equal(extractFacts(tx(PAIRS[0].request), "v2.signer").requests.length, 0);
  });
});

describe("Ledger", () => {
  it("pairs every captured request with the node that responded", () => {
    const ledger = new Ledger();
    const { added, resolved, changed } = ledger.ingestTransactions(TXS);
    assert.equal(added.length, PAIRS.length);
    assert.equal(resolved.length, PAIRS.length);
    assert.equal(changed.length, 0, "fresh requests are reported as added, not changed");
    for (const pair of PAIRS) {
      const request = ledger.list().find((r) => r.txHash === pair.request);
      assert.ok(request, pair.request);
      assert.equal(request.status, "signed");
      assert.equal(request.response?.node, pair.node);
      assert.equal(request.response?.txHash, pair.respond);
      assert.ok(request.response.timestampMs >= request.timestampMs, "response comes after the request");
    }
  });

  it("covers the legacy, v2 and foreign-tx request shapes in the fixture", () => {
    const ledger = new Ledger();
    ledger.ingestTransactions(TXS);
    const methods = new Set(ledger.list().map((r) => r.method));
    assert.deepEqual([...methods].sort(), ["sign", "verify_foreign_transaction"]);
    assert.ok(ledger.list().some((r) => r.foreignChain === "Aptos"));
    assert.ok(ledger.list().some((r) => r.domainId === 3));
  });

  it("pairs regardless of which transaction arrives first", () => {
    const ledger = new Ledger();
    const first = ledger.ingestTransactions(PAIRS.map((p) => tx(p.respond)));
    assert.equal(first.added.length, 0);
    assert.equal(first.resolved.length, 0);
    const second = ledger.ingestTransactions(PAIRS.map((p) => tx(p.request)));
    assert.equal(second.resolved.length, PAIRS.length);
  });

  it("tracks a request as pending until its callback shows up, then resolves it", () => {
    const ledger = new Ledger();
    const pair = PAIRS[1];
    const early = ledger.ingestTransactions([beforeCallback(tx(pair.request)), tx(pair.respond)]);
    assert.equal(early.added.length, 1);
    assert.equal(early.resolved.length, 0);
    const [pending] = early.added;
    assert.equal(pending.status, "pending");
    assert.equal(pending.key, null);

    const now = pending.timestampMs + 10_000;
    assert.deepEqual(ledger.pendingTxHashes(now, 60_000), [pair.request]);
    assert.deepEqual(ledger.pendingTxHashes(pending.timestampMs + 120_000, 60_000), [], "too old to keep checking");

    const late = ledger.ingestTransactions([tx(pair.request)]);
    assert.equal(late.added.length, 0);
    assert.deepEqual(late.resolved.map((r) => r.txHash), [pair.request]);
    assert.deepEqual(late.changed.map((r) => r.txHash), [pair.request]);
    assert.equal(ledger.get(pending.receiptId)?.response?.node, pair.node);
    assert.deepEqual(ledger.pendingTxHashes(now, 60_000), []);
  });

  it("marks a request signed from its callback even before the respond tx is seen", () => {
    const ledger = new Ledger();
    const { added } = ledger.ingestTransactions([tx(PAIRS[2].request)]);
    assert.equal(added[0].status, "signed");
    assert.equal(added[0].response, null);
  });

  it("is idempotent", () => {
    const ledger = new Ledger();
    ledger.ingestTransactions(TXS);
    const again = ledger.ingestTransactions(TXS);
    assert.deepEqual(again, { added: [], resolved: [], changed: [] });
    assert.equal(ledger.size, PAIRS.length);
  });

  it("lists newest first", () => {
    const ledger = new Ledger();
    ledger.ingestTransactions(TXS);
    const times = ledger.list().map((r) => r.timestampMs);
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  it("evicts the oldest requests past capacity", () => {
    const ledger = new Ledger({ capacity: 2 });
    ledger.ingestTransactions(TXS);
    assert.equal(ledger.size, 2);
    const all = new Ledger();
    all.ingestTransactions(TXS);
    const newestTwo = all.list().slice(0, 2).map((r) => r.receiptId);
    assert.deepEqual(ledger.list().map((r) => r.receiptId), newestTwo);
  });

  it("attaches NearBlocks destinations whether they arrive before or after the request", () => {
    const after = new Ledger();
    after.ingestTransactions(TXS);
    const changed = after.ingestDestinations(NEARBLOCKS);
    assert.deepEqual(changed.map((r) => r.receiptId), [ZCASH_SIGN_RECEIPT]);
    assert.equal(after.get(ZCASH_SIGN_RECEIPT)?.destination?.chain, "ZCASH");
    assert.equal(after.get(ZCASH_SIGN_RECEIPT)?.destination?.txn, "ca935c57a7eb6e19089379c300cbc03dd75e96667cc7b849e4b4c2c1b9916178");
    assert.deepEqual(after.ingestDestinations(NEARBLOCKS), [], "unchanged rows are not re-reported");

    const before = new Ledger();
    assert.deepEqual(before.ingestDestinations(NEARBLOCKS), []);
    before.ingestTransactions(TXS);
    assert.equal(before.get(ZCASH_SIGN_RECEIPT)?.destination?.chain, "ZCASH");
  });
});
