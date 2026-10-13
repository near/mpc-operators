// @ts-check
//
// DOM rendering for everything around the map. All text from the network goes
// through textContent; nothing untrusted is ever parsed as HTML.

import { domainLabel } from "./lib/contract.js";
import * as fmt from "./lib/format.js";

/**
 * @typedef {import("./lib/ledger.js").SignRequest} SignRequest
 * @typedef {import("./lib/contract.js").SignerState} SignerState
 * @typedef {import("./lib/contract.js").Attestation} Attestation
 * @typedef {import("./api/geoip.js").GeoLocation} GeoLocation
 * @typedef {import("./feed.js").SourceStatus} SourceStatus
 * @typedef {import("./feed.js").SourceName} SourceName
 */

const LOG_ROWS = 80;

/**
 * Tiny element builder.
 * @param {string} tag
 * @param {Record<string, string | boolean | undefined>} [attrs]
 * @param {(Node | string | null | undefined | false)[]} children
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/**
 * @param {string} href
 * @param {string} text
 * @param {string} [className]
 */
function link(href, text, className) {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer", class: className }, text);
}

/**
 * What a request asked for, in words.
 * @param {SignRequest} r
 * @param {SignerState | null} network
 */
export function requestKind(r, network) {
  if (r.method === "verify_foreign_transaction") return `Verify ${r.foreignChain ?? "foreign"} tx`;
  if (r.method === "request_app_private_key") return "Confidential key";
  const domain = network?.domains.find((d) => d.id === r.domainId);
  return domainLabel(domain);
}

/** @param {SignRequest} r */
export function latencyMs(r) {
  return r.response ? Math.max(0, r.response.timestampMs - r.timestampMs) : null;
}

/**
 * @param {SignRequest} r
 * @param {SignerState | null} network
 */
export function roundCaption(r, network) {
  const target = r.destination ? `→ ${fmt.chainInfo(r.destination.chain).name}` : requestKind(r, network);
  const latency = latencyMs(r);
  return latency === null ? target : `${target} · ${fmt.seconds(latency)}`;
}

/** @param {SignRequest["status"]} status */
function statusPill(status) {
  const text = { pending: "Signing", signed: "Signed", failed: "Failed" }[status];
  return h("span", { class: `pill pill-${status}` }, text);
}

/**
 * @param {string | undefined} code
 */
function flag(code) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export class Panels {
  /** @type {(r: SignRequest) => void} */
  onSelect = () => {};
  /** @type {(account: string | null) => void} */
  onHoverNode = () => {};
  /** @type {Set<string>} */
  #fresh = new Set();
  /** @type {string | null} */
  #selected = null;

  /** @param {Document} doc */
  constructor(doc) {
    /** @param {string} id */
    const byId = (id) => {
      const el = doc.getElementById(id);
      if (!el) throw new Error(`Missing #${id}`);
      return el;
    };
    this.requestList = byId("request-log");
    this.deliveredList = byId("delivered-log");
    this.roster = byId("roster");
    this.stats = byId("stats");
    this.sources = byId("sources");
    this.notice = byId("notice");
    this.requestCount = byId("request-count");
    this.deliveredCount = byId("delivered-count");

    setInterval(() => this.#tickAges(), 1000);
  }

  /** @param {Iterable<string>} receiptIds */
  markFresh(receiptIds) {
    for (const id of receiptIds) this.#fresh.add(id);
  }

  /** @param {string | null} receiptId */
  select(receiptId) {
    this.#selected = receiptId;
    for (const row of document.querySelectorAll(".log-row")) {
      row.classList.toggle("is-selected", row.getAttribute("data-receipt") === receiptId);
    }
  }

  /**
   * @param {SignRequest[]} requests newest first
   * @param {SignerState | null} network
   * @param {Map<string, GeoLocation | null>} locations by account
   */
  renderLogs(requests, network, locations) {
    const now = Date.now();
    const incoming = requests.slice(0, LOG_ROWS);
    this.requestList.replaceChildren(...incoming.map((r) => this.#requestRow(r, network, now)));
    this.requestCount.textContent = String(requests.length);

    const delivered = requests
      .filter((r) => r.response !== null)
      .sort((a, b) => (b.response?.timestampMs ?? 0) - (a.response?.timestampMs ?? 0));
    this.deliveredList.replaceChildren(...delivered.slice(0, LOG_ROWS).map((r) => this.#deliveredRow(r, network, locations, now)));
    this.deliveredCount.textContent = String(delivered.length);
    this.#fresh.clear();

    if (incoming.length === 0) this.requestList.append(h("li", { class: "log-empty" }, "Waiting for the first request from FastNear…"));
    if (delivered.length === 0) this.deliveredList.append(h("li", { class: "log-empty" }, "Signatures appear here once a node responds."));
  }

  /**
   * @param {SignRequest} r
   * @param {SignerState | null} network
   * @param {number} now
   */
  #requestRow(r, network, now) {
    const dest = r.destination;
    const chain = dest ? fmt.chainInfo(dest.chain) : null;
    const destTx = dest && chain ? chain.tx(dest.txn) : null;
    const row = h(
      "li",
      {
        class: `log-row${this.#fresh.has(r.receiptId) ? " is-fresh" : ""}${this.#selected === r.receiptId ? " is-selected" : ""}`,
        "data-receipt": r.receiptId,
        tabindex: "0",
      },
      h("div", { class: "row-top" },
        h("span", { class: "who", title: r.requester }, fmt.account(r.requester)),
        h("time", { class: "ago", "data-ts": String(r.timestampMs), datetime: new Date(r.timestampMs).toISOString() }, fmt.ago(r.timestampMs, now)),
      ),
      h("div", { class: "row-mid" },
        h("span", { class: "kind" }, requestKind(r, network)),
        r.path ? h("span", { class: "path", title: `Derivation path: ${r.path}` }, fmt.middle(r.path, 10)) : null,
        chain ? h("span", { class: "chain" }, chain.name) : null,
      ),
      h("div", { class: "row-bottom" },
        statusPill(r.status),
        link(fmt.nearTxUrl(r.txHash), fmt.middle(r.txHash, 5), "hash"),
        destTx && chain ? link(destTx, `${chain.name} tx ↗`, "hash") : null,
      ),
    );
    this.#wireRow(row, r);
    return row;
  }

  /**
   * @param {SignRequest} r
   * @param {SignerState | null} network
   * @param {Map<string, GeoLocation | null>} locations
   * @param {number} now
   */
  #deliveredRow(r, network, locations, now) {
    const response = r.response;
    if (!response) throw new Error("delivered row without response");
    const where = locations.get(response.node);
    const latency = latencyMs(r);
    const row = h(
      "li",
      {
        class: `log-row${this.#fresh.has(r.receiptId) ? " is-fresh" : ""}${this.#selected === r.receiptId ? " is-selected" : ""}`,
        "data-receipt": r.receiptId,
        "data-node": response.node,
        tabindex: "0",
      },
      h("div", { class: "row-top" },
        h("span", { class: "who node-name", title: response.node }, fmt.account(response.node)),
        h("time", { class: "ago", "data-ts": String(response.timestampMs), datetime: new Date(response.timestampMs).toISOString() }, fmt.ago(response.timestampMs, now)),
      ),
      h("div", { class: "row-mid" },
        where ? h("span", { class: "place" }, `${flag(where.countryCode)} ${where.city || where.country}`) : null,
        latency !== null ? h("span", { class: "latency", title: "Request block to response block" }, fmt.seconds(latency)) : null,
        h("span", { class: "kind" }, r.destination ? fmt.chainInfo(r.destination.chain).name : requestKind(r, network)),
      ),
      h("div", { class: "row-bottom" },
        h("span", { class: "for" }, "for ", h("span", { title: r.requester }, fmt.account(r.requester))),
        link(fmt.nearTxUrl(response.txHash), fmt.middle(response.txHash, 5), "hash"),
      ),
    );
    this.#wireRow(row, r);
    row.addEventListener("pointerenter", () => this.onHoverNode(response.node));
    row.addEventListener("pointerleave", () => this.onHoverNode(null));
    return row;
  }

  /**
   * @param {HTMLElement} row
   * @param {SignRequest} r
   */
  #wireRow(row, r) {
    const choose = (/** @type {Event} */ e) => {
      if (e.target instanceof HTMLElement && e.target.closest("a")) return;
      this.onSelect(r);
    };
    row.addEventListener("click", choose);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose(e);
      }
    });
  }

  #tickAges() {
    const now = Date.now();
    for (const el of document.querySelectorAll("time.ago")) {
      const ts = Number(el.getAttribute("data-ts"));
      if (Number.isFinite(ts)) el.textContent = fmt.ago(ts, now);
    }
  }

  /**
   * @param {SignerState} network
   * @param {Map<string, Attestation>} attestations by TLS key
   * @param {Map<string, GeoLocation | null>} locations by account
   * @param {Map<string, number>} delivered by account
   */
  renderRoster(network, attestations, locations, delivered) {
    const max = Math.max(1, ...delivered.values());
    const rows = [...network.participants]
      .sort((a, b) => (delivered.get(b.account) ?? 0) - (delivered.get(a.account) ?? 0) || a.account.localeCompare(b.account))
      .map((p) => {
        const tee = attestations.get(p.tlsPublicKey)?.kind ?? "none";
        const where = locations.get(p.account);
        const count = delivered.get(p.account) ?? 0;
        const place = where === undefined ? "Locating…" : where === null ? "Not located yet" : `${flag(where.countryCode)} ${where.city}, ${where.countryCode}`;
        const teeText = { tdx: "TDX", mock: "No TEE", none: "No attestation" }[tee];
        const teeTitle = {
          tdx: "Intel TDX attestation verified on-chain",
          mock: "Mock attestation: not running in a TEE",
          none: "No attestation on record",
        }[tee];
        const row = h("li", { class: "roster-row", "data-account": p.account, tabindex: "0" },
          h("span", { class: "roster-name", title: p.account }, fmt.account(p.account)),
          h("span", {
            class: "roster-place",
            title: where ? `${where.provider} · ${where.ip}` : where === null ? "New operator: run scripts/locate-nodes.mjs to place it on the map" : undefined,
          }, place),
          h("span", { class: `tee tee-${tee}`, title: teeTitle }, teeText),
          h("span", { class: "roster-bar", "aria-hidden": "true" }, h("span", { style: `inline-size:${(count / max) * 100}%` })),
          h("span", { class: "roster-count", title: "Signatures this node delivered in the tracked window" }, String(count)),
        );
        row.addEventListener("pointerenter", () => this.onHoverNode(p.account));
        row.addEventListener("pointerleave", () => this.onHoverNode(null));
        row.addEventListener("focus", () => this.onHoverNode(p.account));
        row.addEventListener("blur", () => this.onHoverNode(null));
        return row;
      });
    this.roster.replaceChildren(...rows);
  }

  /** @param {string | null} account */
  highlightNode(account) {
    for (const el of document.querySelectorAll("[data-account], .log-row[data-node]")) {
      const match = account !== null && (el.getAttribute("data-account") === account || el.getAttribute("data-node") === account);
      el.classList.toggle("is-node-highlighted", match);
    }
  }

  /**
   * @param {SignerState | null} network
   * @param {Map<string, Attestation>} attestations
   * @param {SignRequest[]} requests
   */
  renderStats(network, attestations, requests) {
    const resolved = requests.filter((r) => r.response !== null);
    const latencies = resolved.map((r) => latencyMs(r) ?? 0).sort((a, b) => a - b);
    const median = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : null;
    const oldest = requests.at(-1)?.timestampMs;
    const windowMin = oldest ? Math.max(1, Math.round((Date.now() - oldest) / 60_000)) : null;
    const tdx = network ? network.participants.filter((p) => attestations.get(p.tlsPublicKey)?.kind === "tdx").length : null;

    /**
     * @param {string} label
     * @param {string} value
     * @param {string} [note]
     */
    const stat = (label, value, note) =>
      h("div", { class: "stat" }, h("dt", {}, label), h("dd", {}, value, note ? h("small", {}, note) : null));

    this.stats.replaceChildren(
      stat("Threshold", network ? `${network.threshold} of ${network.participants.length}` : "…", "nodes must sign"),
      stat("In TEE", tdx === null ? "…" : `${tdx}`, "Intel TDX"),
      stat("Signed", String(resolved.length), windowMin ? `last ${windowMin} min` : undefined),
      stat("Median time", median === null ? "…" : fmt.seconds(median), "request → response"),
      stat("Epoch", network ? String(network.epochId) : "…", network?.phase === "resharing" ? "resharing" : undefined),
    );
  }

  /** @param {Record<SourceName, SourceStatus>} status */
  renderSources(status) {
    /** @type {[SourceName, string][]} */
    const names = [["requests", "FastNear"], ["decode", "NearBlocks"], ["network", "NEAR RPC"]];
    this.sources.replaceChildren(
      ...names.map(([key, label]) =>
        h("li", { class: `source source-${status[key].state}`, title: status[key].message }, h("span", { class: "dot", "aria-hidden": "true" }), label),
      ),
    );
    const problem = names.map(([key]) => status[key]).find((s) => s.state === "limited" || s.state === "error");
    this.notice.hidden = !problem;
    this.notice.textContent = problem ? problem.message : "";
  }
}
