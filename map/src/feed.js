// @ts-check
//
// Keeps the page fed. Three independent loops, each with its own cadence and
// back-off, all paused while the tab is hidden so nobody burns API credits on
// a background tab:
//
//   network   NEAR RPC   v1.signer state + node attestations    every 5 min
//   requests  FastNear   new v1.signer txs, pending re-checks   every 3-6 s
//   decode    NearBlocks destination chain / address / tx      every 15-90 s

import { fetchAccountTxs, fetchTransactions } from "./api/fastnear.js";
import { HttpError } from "./api/http.js";
import { fetchAttestation, fetchSignerState } from "./api/near.js";
import { fetchDecodedSignatures } from "./api/nearblocks.js";
import { Ledger, SIGNER_CONTRACT } from "./lib/ledger.js";

/**
 * @typedef {import("./settings.js").ApiKeys} ApiKeys
 * @typedef {import("./lib/contract.js").SignerState} SignerState
 * @typedef {import("./lib/contract.js").Attestation} Attestation
 * @typedef {import("./lib/ledger.js").IngestResult} IngestResult
 *
 * @typedef {"idle" | "ok" | "limited" | "error"} SourceState
 * @typedef {{ state: SourceState, message: string, updatedAt: number | null }} SourceStatus
 * @typedef {"network" | "requests" | "decode"} SourceName
 */

/** How long to keep re-checking a request that has no response yet. */
const PENDING_WINDOW_MS = 5 * 60_000;
const SEEN_CAPACITY = 5000;
/** Transactions per FastNear round-trip group; two API batches. */
const BACKFILL_SLICE = 40;

/** @type {Record<SourceName, { withKey: number, withoutKey: number, limited: number }>} */
const CADENCE_MS = {
  network: { withKey: 5 * 60_000, withoutKey: 5 * 60_000, limited: 10 * 60_000 },
  requests: { withKey: 3_000, withoutKey: 6_000, limited: 60_000 },
  // NearBlocks' free tier allows 6 calls/min and 333/day.
  decode: { withKey: 15_000, withoutKey: 90_000, limited: 5 * 60_000 },
};

export class Feed extends EventTarget {
  ledger = new Ledger();
  /** @type {SignerState | null} */
  network = null;
  /** @type {Map<string, Attestation>} tls public key -> attestation */
  attestations = new Map();
  /** @type {Record<SourceName, SourceStatus>} */
  status = {
    network: { state: "idle", message: "Connecting to NEAR RPC", updatedAt: null },
    requests: { state: "idle", message: "Connecting to FastNear", updatedAt: null },
    decode: { state: "idle", message: "Connecting to NearBlocks", updatedAt: null },
  };

  /** @type {Set<string>} */
  #seenTx = new Set();
  /** @type {Map<SourceName, ReturnType<typeof setTimeout>>} */
  #timers = new Map();
  #keys;
  #backfilled = false;
  #generation = 0;

  /** @param {ApiKeys} keys */
  constructor(keys) {
    super();
    this.#keys = keys;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.#stopAll();
      else this.start();
    });
  }

  /** @param {ApiKeys} keys */
  setKeys(keys) {
    this.#keys = keys;
    this.start();
  }

  start() {
    this.#stopAll();
    const generation = ++this.#generation;
    this.#loop("network", generation, () => this.#pollNetwork());
    this.#loop("requests", generation, () => this.#pollRequests());
    this.#loop("decode", generation, () => this.#pollDecoded());
  }

  #stopAll() {
    this.#generation++;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  /**
   * @param {SourceName} source
   * @param {number} generation
   * @param {() => Promise<string>} tick resolves to a status message
   */
  async #loop(source, generation, tick) {
    if (generation !== this.#generation) return;
    const cadence = CADENCE_MS[source];
    const hasKey = source === "decode" ? Boolean(this.#keys.nearblocks) : Boolean(this.#keys.fastnear);
    let delay = hasKey ? cadence.withKey : cadence.withoutKey;
    try {
      const message = await tick();
      this.#setStatus(source, "ok", message);
    } catch (error) {
      if (error instanceof HttpError && error.rateLimited) {
        delay = cadence.limited;
        this.#setStatus(source, "limited", `${error.service} rate limit hit. Retrying in ${Math.round(delay / 60_000)} min${hasKey ? "" : ". Add an API key in Settings for more headroom"}.`);
      } else if (error instanceof HttpError && error.unauthorized) {
        delay = cadence.limited;
        this.#setStatus(source, "error", `${error.service} rejected the API key. Check it in Settings.`);
      } else {
        delay = Math.min(delay * 4, 60_000);
        this.#setStatus(source, "error", error instanceof Error ? error.message : String(error));
      }
    }
    if (generation !== this.#generation) return;
    this.#timers.set(source, setTimeout(() => this.#loop(source, generation, tick), delay));
  }

  /**
   * @param {SourceName} source
   * @param {SourceState} state
   * @param {string} message
   */
  #setStatus(source, state, message) {
    this.status[source] = { state, message, updatedAt: Date.now() };
    this.dispatchEvent(new CustomEvent("status", { detail: source }));
  }

  async #pollNetwork() {
    const apiKey = this.#keys.fastnear || undefined;
    const network = await fetchSignerState({ apiKey });
    const missing = network.participants.filter((p) => !this.attestations.has(p.tlsPublicKey));
    const results = await Promise.allSettled(missing.map((p) => fetchAttestation(p.tlsPublicKey, { apiKey })));
    results.forEach((result, i) => {
      if (result.status === "fulfilled") this.attestations.set(missing[i].tlsPublicKey, result.value);
    });
    this.network = network;
    this.dispatchEvent(new CustomEvent("network"));
    const failed = results.filter((r) => r.status === "rejected").length;
    const note = failed > 0 ? ` (${failed} attestation lookups failed)` : "";
    return `${network.participants.length} nodes, threshold ${network.threshold}, epoch ${network.epochId}${note}`;
  }

  async #pollRequests() {
    const apiKey = this.#keys.fastnear || undefined;
    const recent = await fetchAccountTxs(SIGNER_CONTRACT, { apiKey });
    const fresh = recent.map((t) => t.transaction_hash).filter((h) => !this.#seenTx.has(h));
    const pending = this.ledger.pendingTxHashes(Date.now(), PENDING_WINDOW_MS).filter((h) => !fresh.includes(h));
    // Newest first, in slices, so the first paint doesn't wait for the whole
    // 200-tx backfill. The ledger pairs requests and responses across slices.
    const toFetch = [...fresh, ...pending];
    const backfill = !this.#backfilled;
    for (let i = 0; i < toFetch.length; i += BACKFILL_SLICE) {
      const slice = toFetch.slice(i, i + BACKFILL_SLICE);
      const txs = await fetchTransactions(slice, { apiKey });
      for (const h of slice) this.#seenTx.add(h);
      const result = this.ledger.ingestTransactions(txs);
      this.dispatchEvent(new CustomEvent("requests", { detail: { result, backfill } }));
    }
    this.#backfilled = true;
    this.#trimSeen();
    return `${this.ledger.size} recent requests tracked`;
  }

  async #pollDecoded() {
    const rows = await fetchDecodedSignatures({ apiKey: this.#keys.nearblocks || undefined });
    const changed = this.ledger.ingestDestinations(rows);
    if (changed.length > 0) {
      /** @type {IngestResult} */
      const result = { added: [], resolved: [], changed };
      this.dispatchEvent(new CustomEvent("requests", { detail: { result, backfill: false } }));
    }
    return this.#keys.nearblocks ? "Decoding destinations" : "Decoding destinations (free tier, every 90 s)";
  }

  #trimSeen() {
    for (const h of this.#seenTx) {
      if (this.#seenTx.size <= SEEN_CAPACITY) break;
      this.#seenTx.delete(h);
    }
  }
}
