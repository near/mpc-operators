// @ts-check
//
// Turns raw `v1.signer` transactions into signature requests and pairs each
// request with the MPC node that delivered it.
//
//   requester ──sign()──▶ v1.signer  (yields, request pending)
//                             │
//             MPC nodes see the request on-chain, run the threshold protocol
//             off-chain, and one of them (the leader) submits the result:
//                             │
//   mpc node ──respond()──▶ v1.signer ──resume──▶ return_*_on_success(request)
//
// The request tx and the respond tx are separate transactions. They share one
// thing byte for byte: the `request` struct. The node passes it to
// `respond(request, response)` and the contract hands the same struct to the
// `return_*` callback inside the requester's tx. That struct, canonicalized,
// is the join key.

import { isRecord } from "./guards.js";

export const SIGNER_CONTRACT = "v1.signer";

/** Public entry points of the signer contract that start a request. */
const REQUEST_METHODS = new Set(["sign", "request_app_private_key", "verify_foreign_transaction"]);

/**
 * @typedef {{ FunctionCall?: { method_name: string, args: string } } | string} FastnearAction
 * @typedef {{ Failure?: unknown, SuccessValue?: string, SuccessReceiptId?: string }} OutcomeStatus
 * @typedef {{
 *   receipt: {
 *     receipt_id: string,
 *     predecessor_id: string,
 *     receiver_id: string,
 *     receipt: { Action?: { actions: FastnearAction[] } },
 *   },
 *   execution_outcome: {
 *     block_height: number,
 *     block_timestamp: number,
 *     outcome: { receipt_ids: string[], status: OutcomeStatus },
 *   },
 * }} FastnearReceipt
 * @typedef {{
 *   transaction: { hash: string, signer_id: string, receiver_id: string },
 *   receipts: FastnearReceipt[],
 * }} FastnearTransaction
 *
 * @typedef {{ chain: string, address: string, txn: string }} Destination
 * @typedef {{
 *   receipt_id: string,
 *   dest_chain: string,
 *   dest_address: string,
 *   dest_txn: string,
 * }} NearblocksSignatureRow
 *
 * @typedef {{
 *   key: string,
 *   node: string,
 *   txHash: string,
 *   method: string,
 *   timestampMs: number,
 *   blockHeight: number,
 * }} SignResponse
 *
 * @typedef {"pending" | "signed" | "failed"} RequestStatus
 * @typedef {{
 *   receiptId: string,
 *   txHash: string,
 *   txSigner: string,
 *   requester: string,
 *   method: string,
 *   domainId: number | null,
 *   path: string | null,
 *   foreignChain: string | null,
 *   timestampMs: number,
 *   blockHeight: number,
 *   key: string | null,
 *   status: RequestStatus,
 *   response: SignResponse | null,
 *   destination: Destination | null,
 * }} SignRequest
 *
 * @typedef {{ added: SignRequest[], resolved: SignRequest[], changed: SignRequest[] }} IngestResult
 */

/**
 * JSON with object keys sorted at every depth, so two structurally equal
 * values always produce the same string regardless of key order.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Decodes base64 function-call args as JSON. Returns `undefined` for args that
 * are not UTF-8 JSON (some internal callbacks use Borsh).
 * @param {string} b64
 * @returns {unknown}
 */
export function decodeArgs(b64) {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Block timestamps are nanoseconds. FastNear serializes some of them as JSON
 * numbers past 2^53, which lose sub-microsecond precision; milliseconds are
 * all we need anyway.
 * @param {number | string} ns
 */
export function nsToMs(ns) {
  return typeof ns === "string" ? Number(BigInt(ns) / 1_000_000n) : Math.round(ns / 1e6);
}

/**
 * Pulls the parts of a request's args that are useful to display.
 * Handles the legacy `sign` shape (`key_version`), the current one
 * (`domain_id` + `payload_v2`), CKD, and foreign-tx verification.
 * @param {unknown} args
 */
export function describeRequestArgs(args) {
  const request = isRecord(args) && isRecord(args.request) ? args.request : {};
  const domain = request.domain_id ?? request.key_version;
  const inner = request.request;
  return {
    domainId: typeof domain === "number" ? domain : null,
    path: typeof request.path === "string" ? request.path : null,
    foreignChain: isRecord(inner) ? (Object.keys(inner)[0] ?? null) : null,
  };
}

/**
 * @param {FastnearReceipt} receipt
 * @returns {{ method: string, args: unknown }[]}
 */
function functionCalls(receipt) {
  const actions = receipt.receipt.receipt.Action?.actions ?? [];
  return actions.flatMap((action) =>
    typeof action === "object" && action.FunctionCall
      ? [{ method: action.FunctionCall.method_name, args: decodeArgs(action.FunctionCall.args) }]
      : [],
  );
}

/** Everything the ledger can learn from one transaction. */
export class TransactionFacts {
  /** @type {Omit<SignRequest, "key" | "status" | "response" | "destination">[]} */
  requests = [];
  /** Keyed by request receipt id. @type {Map<string, { key: string, status: RequestStatus }>} */
  callbacks = new Map();
  /** @type {SignResponse[]} */
  responses = [];
}

/**
 * @param {FastnearTransaction} tx
 * @param {string} contract
 * @returns {TransactionFacts}
 */
export function extractFacts(tx, contract = SIGNER_CONTRACT) {
  const facts = new TransactionFacts();
  // The callback receipt is spawned by the request receipt, so walk parents.
  /** @type {Map<string, string>} child receipt id -> parent receipt id */
  const parentOf = new Map();
  for (const r of tx.receipts) {
    for (const child of r.execution_outcome.outcome.receipt_ids) parentOf.set(child, r.receipt.receipt_id);
  }

  for (const r of tx.receipts) {
    const { receipt_id: receiptId, predecessor_id: predecessor, receiver_id: receiver } = r.receipt;
    if (receiver !== contract) continue;
    const timestampMs = nsToMs(r.execution_outcome.block_timestamp);
    const blockHeight = r.execution_outcome.block_height;

    for (const { method, args } of functionCalls(r)) {
      if (predecessor === contract && method.startsWith("return_") && Array.isArray(args) && args.length > 0) {
        const requestReceipt = parentOf.get(receiptId);
        if (requestReceipt === undefined) continue;
        const failed = r.execution_outcome.outcome.status.Failure !== undefined;
        facts.callbacks.set(requestReceipt, { key: canonicalJson(args[0]), status: failed ? "failed" : "signed" });
      } else if (method.startsWith("respond") && isRecord(args) && args.request !== undefined) {
        facts.responses.push({
          key: canonicalJson(args.request),
          node: predecessor,
          txHash: tx.transaction.hash,
          method,
          timestampMs,
          blockHeight,
        });
      } else if (REQUEST_METHODS.has(method) && predecessor !== contract) {
        facts.requests.push({
          receiptId,
          txHash: tx.transaction.hash,
          txSigner: tx.transaction.signer_id,
          requester: predecessor,
          method,
          ...describeRequestArgs(args),
          timestampMs,
          blockHeight,
        });
      }
    }
  }
  return facts;
}

/**
 * In-memory index of recent requests and responses. Pure: no I/O, no timers.
 * Feed it transactions in any order; it pairs whatever it can.
 */
export class Ledger {
  /** @type {Map<string, SignRequest>} receipt id -> request */
  #requests = new Map();
  /** @type {Map<string, string>} join key -> request receipt id */
  #receiptByKey = new Map();
  /** Responses seen before their request resolved. @type {Map<string, SignResponse>} */
  #orphanResponses = new Map();
  /** NearBlocks rows seen before their request. @type {Map<string, Destination>} */
  #orphanDestinations = new Map();
  #capacity;
  #contract;

  /** @param {{ capacity?: number, contract?: string }} [options] */
  constructor({ capacity = 600, contract = SIGNER_CONTRACT } = {}) {
    this.#capacity = capacity;
    this.#contract = contract;
  }

  get size() {
    return this.#requests.size;
  }

  /** @param {string} receiptId */
  get(receiptId) {
    return this.#requests.get(receiptId);
  }

  /** Newest first. */
  list() {
    return [...this.#requests.values()].sort((a, b) => b.timestampMs - a.timestampMs || b.blockHeight - a.blockHeight);
  }

  /**
   * Transactions holding requests that have not been resolved yet, oldest
   * first. Their callback lands in the same tx later, so they need a re-fetch.
   * @param {number} nowMs
   * @param {number} maxAgeMs requests older than this are given up on
   */
  pendingTxHashes(nowMs, maxAgeMs) {
    const hashes = new Set(
      this.list()
        .reverse()
        .filter((r) => r.status === "pending" && nowMs - r.timestampMs <= maxAgeMs)
        .map((r) => r.txHash),
    );
    return [...hashes];
  }

  /**
   * @param {FastnearTransaction[]} transactions
   * @returns {IngestResult}
   */
  ingestTransactions(transactions) {
    /** @type {Set<SignRequest>} */ const added = new Set();
    /** @type {Set<SignRequest>} */ const changed = new Set();
    /** @type {Set<SignRequest>} */ const resolved = new Set();

    const allFacts = transactions.map((tx) => extractFacts(tx, this.#contract));

    for (const facts of allFacts) {
      for (const base of facts.requests) {
        if (this.#requests.has(base.receiptId)) continue;
        /** @type {SignRequest} */
        const request = { ...base, key: null, status: "pending", response: null, destination: null };
        const destination = this.#orphanDestinations.get(base.receiptId);
        if (destination) {
          request.destination = destination;
          this.#orphanDestinations.delete(base.receiptId);
        }
        this.#requests.set(base.receiptId, request);
        added.add(request);
      }
    }

    for (const facts of allFacts) {
      for (const [receiptId, { key, status }] of facts.callbacks) {
        const request = this.#requests.get(receiptId);
        if (!request || (request.key === key && request.status === status)) continue;
        request.key = key;
        request.status = status;
        this.#receiptByKey.set(key, receiptId);
        changed.add(request);
      }
      for (const response of facts.responses) this.#orphanResponses.set(response.key, response);
    }

    for (const [key, response] of this.#orphanResponses) {
      const receiptId = this.#receiptByKey.get(key);
      const request = receiptId === undefined ? undefined : this.#requests.get(receiptId);
      if (!request) continue;
      this.#orphanResponses.delete(key);
      if (request.response?.txHash === response.txHash) continue;
      request.response = response;
      request.status = "signed";
      resolved.add(request);
      changed.add(request);
    }

    this.#evict();
    const alive = (/** @type {SignRequest} */ r) => this.#requests.get(r.receiptId) === r;
    return {
      added: [...added].filter(alive),
      resolved: [...resolved].filter(alive),
      changed: [...changed].filter((r) => alive(r) && !added.has(r)),
    };
  }

  /**
   * Attaches NearBlocks' decoded destination (chain, address, tx) to requests.
   * NearBlocks keys rows by the `sign` receipt id.
   * @param {NearblocksSignatureRow[]} rows
   * @returns {SignRequest[]} requests whose destination changed
   */
  ingestDestinations(rows) {
    /** @type {SignRequest[]} */
    const changed = [];
    for (const row of rows) {
      const destination = { chain: row.dest_chain, address: row.dest_address, txn: row.dest_txn };
      const request = this.#requests.get(row.receipt_id);
      if (!request) {
        this.#orphanDestinations.set(row.receipt_id, destination);
        continue;
      }
      if (request.destination?.txn === destination.txn && request.destination.chain === destination.chain) continue;
      request.destination = destination;
      changed.push(request);
    }
    this.#trimMap(this.#orphanDestinations);
    return changed;
  }

  #evict() {
    const overflow = this.#requests.size - this.#capacity;
    if (overflow > 0) {
      const oldest = [...this.#requests.values()].sort((a, b) => a.timestampMs - b.timestampMs).slice(0, overflow);
      for (const r of oldest) {
        this.#requests.delete(r.receiptId);
        if (r.key !== null) this.#receiptByKey.delete(r.key);
      }
    }
    this.#trimMap(this.#orphanResponses);
  }

  /** Map iteration order is insertion order, so the first entries are the oldest. @param {Map<string, unknown>} map */
  #trimMap(map) {
    for (const k of map.keys()) {
      if (map.size <= this.#capacity) break;
      map.delete(k);
    }
  }
}
