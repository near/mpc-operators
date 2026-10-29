// @ts-check
//
// DOM rendering for everything around the map. All text from the network goes
// through textContent; nothing untrusted is ever parsed as HTML.

import { domainLabel } from "./lib/contract.js";
import * as fmt from "./lib/format.js";
import { healthUrl } from "./lib/geo.js";

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
 * @param {string} [title]
 */
function link(href, text, className, title) {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer", class: className, title }, text);
}

/**
 * A label and its value in a dropdown's facts list.
 * @param {string} label
 * @param {(Node | string | null | false)[]} value
 */
function field(label, ...value) {
  return [h("dt", {}, label), h("dd", {}, ...value)];
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

/**
 * The curve alone, for a row; the scheme it implies ("ECDSA", "EdDSA") stays
 * in the tooltip.
 * @param {string} kind
 */
function shortKind(kind) {
  return kind.replace(/^(ECDSA|EdDSA)\s+/, "");
}

/** @param {SignRequest} r */
export function latencyMs(r) {
  return r.response ? Math.max(0, r.response.timestampMs - r.timestampMs) : null;
}

/**
 * @typedef {{ count: number, latencies: number[], lastMs: number }} NodeStats
 * What each node delivered in the tracked window.
 * @param {SignRequest[]} requests
 * @returns {Map<string, NodeStats>}
 */
function nodeStats(requests) {
  /** @type {Map<string, NodeStats>} */
  const byNode = new Map();
  for (const r of requests) {
    if (!r.response) continue;
    const s = byNode.get(r.response.node) ?? { count: 0, latencies: [], lastMs: 0 };
    s.count += 1;
    const latency = latencyMs(r);
    if (latency !== null) s.latencies.push(latency);
    s.lastMs = Math.max(s.lastMs, r.response.timestampMs);
    byNode.set(r.response.node, s);
  }
  for (const s of byNode.values()) s.latencies.sort((a, b) => a - b);
  return byNode;
}

/** @param {number[]} sorted */
function median(sorted) {
  return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null;
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
  const text = { pending: "Signing…", signed: "Signed", failed: "Failed" }[status];
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
  /** Receipt ids of requests that just arrived. @type {Set<string>} */
  #fresh = new Set();
  /** Receipt ids whose response just landed. @type {Set<string>} */
  #freshResponse = new Set();
  /** The signature whose dropdown is open, if any. @type {string | null} */
  #selected = null;
  /** The last renderLogs arguments, re-rendered when a dropdown toggles. @type {{ requests: SignRequest[], network: SignerState | null, locations: Map<string, GeoLocation | null> } | null} */
  #logArgs = null;
  /** Rounds playing on the map: receipt id → palette index. @type {Map<string, number>} */
  #live = new Map();
  /** The node whose details are open in the roster, if any. @type {string | null} */
  #openNode = null;

  /** @param {Document} doc */
  constructor(doc) {
    /** @param {string} id */
    const byId = (id) => {
      const el = doc.getElementById(id);
      if (!el) throw new Error(`Missing #${id}`);
      return el;
    };
    this.signatureList = byId("signature-log");
    this.roster = byId("roster");
    this.stats = byId("stats");
    this.sources = byId("sources");
    this.notice = byId("notice");

    setInterval(() => this.#tickAges(), 1000);
  }

  /**
   * @param {Iterable<string>} added receipt ids of new requests
   * @param {Iterable<string>} resolved receipt ids whose response just landed
   */
  markFresh(added, resolved) {
    for (const id of added) this.#fresh.add(id);
    for (const id of resolved) this.#freshResponse.add(id);
  }

  /**
   * Colors the rows of the signatures playing on the map; the rest settle
   * back to green.
   * @param {Map<string, number>} live receipt id → palette index
   */
  setLiveRounds(live) {
    this.#live = live;
    for (const row of document.querySelectorAll(".log-row[data-receipt]")) {
      if (row instanceof HTMLElement) this.#applyLive(row, row.getAttribute("data-receipt"));
    }
  }

  /**
   * @param {HTMLElement} row
   * @param {string | null} receiptId
   */
  #applyLive(row, receiptId) {
    const color = receiptId === null ? undefined : this.#live.get(receiptId);
    row.classList.toggle("is-live", color !== undefined);
    if (color === undefined) row.style.removeProperty("--round");
    else row.style.setProperty("--round", `var(--round-${color + 1})`);
  }

  /**
   * @param {SignRequest[]} requests newest first
   * @param {SignerState | null} network
   * @param {Map<string, GeoLocation | null>} locations by account
   */
  renderLogs(requests, network, locations) {
    this.#logArgs = { requests, network, locations };
    const now = Date.now();
    const rows = requests.slice(0, LOG_ROWS).map((r) => this.#signatureRow(r, network, locations, now));
    this.signatureList.replaceChildren(...rows);
    this.#fresh.clear();
    this.#freshResponse.clear();
    if (rows.length === 0) this.signatureList.append(h("li", { class: "log-empty" }, "Waiting for the first request from FastNear…"));
  }

  /**
   * One row per signature: the requester and, once it has answered, the node
   * with its country; then what was asked and how long it took. A pending
   * request shows "Signing…" where the node will go, a request whose respond
   * tx was never seen keeps a "Signed" pill there, and a failed request is
   * marked red. Clicking a row drops its details down.
   * @param {SignRequest} r
   * @param {SignerState | null} network
   * @param {Map<string, GeoLocation | null>} locations
   * @param {number} now
   */
  #signatureRow(r, network, locations, now) {
    const response = r.response;
    const chain = r.destination ? fmt.chainInfo(r.destination.chain) : null;
    const latency = latencyMs(r);
    const where = response ? locations.get(response.node) : undefined;
    const kind = requestKind(r, network);
    const open = this.#selected === r.receiptId;
    const classes = ["log-row"];
    if (r.status === "failed") classes.push("is-failed");
    if (this.#fresh.has(r.receiptId)) classes.push("is-fresh");
    if (this.#freshResponse.has(r.receiptId)) classes.push("is-fresh", "is-fresh-response");
    if (open) classes.push("is-open");
    const row = h(
      "li",
      { class: classes.join(" "), "data-receipt": r.receiptId, "data-node": response?.node, tabindex: "0", "aria-expanded": open ? "true" : "false" },
      h("div", { class: "row-top" },
        h("span", { class: "who", title: r.requester }, fmt.account(r.requester)),
        h("span", { class: "arrow", "aria-hidden": "true" }, "→"),
        response ? h("span", { class: "who node-name", title: response.node }, fmt.account(response.node)) : statusPill(r.status),
        where ? h("span", { class: "flag", title: `${where.city}, ${where.country}` }, flag(where.countryCode)) : null,
        h("time", { class: "ago", "data-ts": String(r.timestampMs), datetime: new Date(r.timestampMs).toISOString() }, fmt.ago(r.timestampMs, now)),
        h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
      ),
      h("div", { class: "row-mid" },
        h("span", { class: "kind", title: kind }, shortKind(kind)),
        r.path ? h("span", { class: "path", title: `Derivation path: ${r.path}` }, fmt.middle(r.path, 8)) : null,
        chain ? h("span", { class: "chain" }, chain.name) : null,
        r.status === "failed" && response ? statusPill("failed") : null,
        latency !== null ? h("span", { class: "latency", title: "Request block to response block" }, fmt.seconds(latency)) : null,
      ),
      open ? h("div", { class: "log-detail" }, this.#signatureFacts(r, kind, locations)) : null,
    );
    this.#wireRow(row, r);
    if (response) {
      row.addEventListener("pointerenter", () => this.onHoverNode(response.node));
      row.addEventListener("pointerleave", () => this.onHoverNode(null));
    }
    return row;
  }

  /**
   * The dropdown under a signature: both transactions with their exact times,
   * the full accounts, the path and the destination.
   * @param {SignRequest} r
   * @param {string} kind
   * @param {Map<string, GeoLocation | null>} locations
   */
  #signatureFacts(r, kind, locations) {
    const response = r.response;
    const dest = r.destination;
    const chain = dest ? fmt.chainInfo(dest.chain) : null;
    // Chains without a known explorer get the bare hash.
    const destTx = dest && chain ? chain.tx(dest.txn) : null;
    const where = response ? locations.get(response.node) : undefined;
    const latency = latencyMs(r);
    const when = (/** @type {number} */ ms) => new Date(ms).toLocaleString();
    const status = {
      pending: "Signing, waiting for a node to respond",
      signed: response ? "Signed" : "Signed; the respond tx was not seen in the feed",
      failed: "Failed: the requester's callback failed",
    }[r.status];
    return h("dl", { class: "facts" },
      ...field("Status", status),
      ...field("Requester", link(fmt.nearAccountUrl(r.requester), r.requester)),
      ...(r.txSigner !== r.requester ? field("Sent by", link(fmt.nearAccountUrl(r.txSigner), r.txSigner)) : []),
      ...field("Request", link(fmt.nearTxUrl(r.txHash), fmt.middle(r.txHash, 8), undefined, r.txHash), ` · ${when(r.timestampMs)} · block ${r.blockHeight}`),
      ...field("Key", kind),
      ...(r.method !== "sign" ? field("Method", h("code", {}, r.method)) : []),
      ...(r.path ? field("Path", h("code", {}, r.path)) : []),
      ...(response ? field("Node", link(fmt.nearAccountUrl(response.node), response.node), where ? ` · ${where.city}, ${where.country}` : "") : []),
      ...(response
        ? field("Respond", link(fmt.nearTxUrl(response.txHash), fmt.middle(response.txHash, 8), undefined, response.txHash), ` · ${when(response.timestampMs)}`, latency !== null ? ` · ${fmt.seconds(latency)} after the request` : "")
        : []),
      ...(dest && chain
        ? field("Destination", `${chain.name} · `, h("span", { title: dest.address }, fmt.middle(dest.address, 8)), " · ", destTx ? link(destTx, "tx ↗", undefined, dest.txn) : h("span", { title: dest.txn }, fmt.middle(dest.txn, 8)))
        : []),
    );
  }

  /**
   * @param {HTMLElement} row
   * @param {SignRequest} r
   */
  #wireRow(row, r) {
    this.#applyLive(row, r.receiptId);
    const choose = (/** @type {Event} */ e) => {
      if (e.target instanceof HTMLElement && e.target.closest("a, .log-detail")) return;
      if (this.toggleSignature(r.receiptId)) this.onSelect(r);
    };
    row.addEventListener("click", choose);
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return; // a link inside the dropdown keeps its own Enter
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose(e);
      }
    });
  }

  /**
   * Opens one signature's dropdown and closes any other; the same one again
   * closes it. The rows re-render, so the choice survives the feed's
   * refreshes, and focus returns to the row for keyboard users.
   * @param {string} receiptId
   * @returns {boolean} whether the dropdown is now open
   */
  toggleSignature(receiptId) {
    const open = this.#selected !== receiptId;
    this.#selected = open ? receiptId : null;
    const hadFocus = document.activeElement?.closest(".log-row")?.getAttribute("data-receipt") === receiptId;
    const args = this.#logArgs;
    if (args) this.renderLogs(args.requests, args.network, args.locations);
    if (hadFocus) {
      const row = this.signatureList.querySelector(`.log-row[data-receipt="${CSS.escape(receiptId)}"]`);
      if (row instanceof HTMLElement) row.focus();
    }
    return open;
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
   * @param {SignRequest[]} requests the tracked window, for each node's figures
   */
  renderRoster(network, attestations, locations, requests) {
    const now = Date.now();
    const stats = nodeStats(requests);
    const counts = [...stats.values()].map((s) => s.count);
    const max = Math.max(1, ...counts);
    const total = counts.reduce((sum, c) => sum + c, 0);
    const rows = [...network.participants]
      .sort((a, b) => (stats.get(b.account)?.count ?? 0) - (stats.get(a.account)?.count ?? 0) || a.account.localeCompare(b.account))
      .map((p) => {
        const attestation = attestations.get(p.tlsPublicKey);
        const tee = attestation?.kind ?? "none";
        const where = locations.get(p.account);
        const s = stats.get(p.account);
        const count = s?.count ?? 0;
        const open = this.#openNode === p.account;
        const detailId = `node-detail-${p.id}`;
        const teeText = { tdx: "TDX", mock: "Mock", none: "None" }[tee];
        const teeTitle = {
          tdx: "Intel TDX attestation verified on-chain",
          mock: "Mock attestation: not running in a TEE",
          none: "No attestation on record",
        }[tee];
        const row = h("div", {
          class: `roster-row${open ? " is-open" : ""}`,
          "data-account": p.account,
          role: "button",
          tabindex: "0",
          "aria-expanded": open ? "true" : "false",
          "aria-controls": detailId,
        },
          h("span", { class: "roster-name", title: p.account }, fmt.account(p.account)),
          h("span", { class: "flag", title: where ? `${where.city}, ${where.country}` : where === null ? "Not located yet" : "Locating…" }, where ? flag(where.countryCode) : "–"),
          h("span", { class: `tee tee-${tee}`, title: teeTitle }, teeText),
          h("span", { class: "roster-count", title: "Signatures this node delivered in the tracked window" }, String(count)),
          h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
          h("span", { class: "roster-bar", "aria-hidden": "true" }, h("span", { style: `inline-size:${(count / max) * 100}%` })),
        );
        const detail = h("div", { class: "roster-detail", id: detailId, hidden: !open }, this.#nodeFacts(p, attestation, where, s, total, now));
        row.addEventListener("pointerenter", () => this.onHoverNode(p.account));
        row.addEventListener("pointerleave", () => this.onHoverNode(null));
        row.addEventListener("focus", () => this.onHoverNode(p.account));
        row.addEventListener("blur", () => this.onHoverNode(null));
        row.addEventListener("click", () => this.toggleNode(p.account));
        row.addEventListener("keydown", (e) => {
          if (e.target !== row) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.toggleNode(p.account);
          }
        });
        return h("li", { class: "roster-item" }, row, detail);
      });
    this.roster.replaceChildren(...rows);
  }

  /**
   * The dropdown under a node: everything the row only hints at.
   * @param {import("./lib/contract.js").Participant} p
   * @param {Attestation | undefined} attestation
   * @param {GeoLocation | null | undefined} where
   * @param {NodeStats | undefined} s
   * @param {number} total signatures delivered by all nodes in the window
   * @param {number} now
   */
  #nodeFacts(p, attestation, where, s, total, now) {
    const tee = attestation?.kind ?? "none";
    const teeLine = {
      tdx: "Intel TDX, attestation verified on-chain",
      mock: "Mock attestation, not running in a TEE",
      none: "No attestation on record",
    }[tee];
    const expires = attestation?.expiresAtMs ? `, valid until ${new Date(attestation.expiresAtMs).toLocaleDateString()}` : "";
    const count = s?.count ?? 0;
    const share = total > 0 ? ` (${Math.round((count / total) * 100)}% of the window)` : "";
    const med = s ? median(s.latencies) : null;
    const health = healthUrl(p.url);
    return h("dl", { class: "facts" },
      ...field("Account", link(fmt.nearAccountUrl(p.account), p.account)),
      ...field("Node URL", health ? link(health, p.url, undefined, `Health page: ${health}`) : p.url || "—"),
      ...field("Location", where ? `${where.city}, ${where.country}` : where === null ? "Not in the data file yet" : "Locating…"),
      ...field("Hosting", where ? `${where.provider} · ${where.ip}` : "—"),
      ...field("TEE", `${teeLine}${expires}`),
      ...field("Delivered", `${count} signature${count === 1 ? "" : "s"}${share}`),
      ...field("Median time", med === null ? "—" : `${fmt.seconds(med)} request → response`),
      ...field("Last delivered", s ? h("time", { class: "ago", "data-ts": String(s.lastMs), datetime: new Date(s.lastMs).toISOString() }, fmt.ago(s.lastMs, now)) : "—"),
    );
  }

  /**
   * Opens one node's dropdown and closes any other; the same node again
   * closes it. The choice survives re-renders.
   * @param {string | null} account
   */
  toggleNode(account) {
    this.#openNode = this.#openNode === account ? null : account;
    for (const item of this.roster.querySelectorAll(".roster-item")) {
      const row = item.querySelector(".roster-row");
      const detail = item.querySelector(".roster-detail");
      const open = row?.getAttribute("data-account") === this.#openNode;
      row?.classList.toggle("is-open", open);
      row?.setAttribute("aria-expanded", String(open));
      if (detail instanceof HTMLElement) detail.hidden = !open;
    }
  }

  /**
   * Opens a node's dropdown and scrolls it into view (a click on the map).
   * @param {string} account
   */
  openNode(account) {
    if (this.#openNode !== account) this.toggleNode(account);
    this.roster.querySelector(`.roster-row[data-account="${CSS.escape(account)}"]`)?.scrollIntoView({ block: "nearest" });
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
    const signed = requests.filter((r) => r.status === "signed").length;
    const failed = requests.filter((r) => r.status === "failed").length;
    const latencies = resolved.map((r) => latencyMs(r) ?? 0).sort((a, b) => a - b);
    const median = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : null;
    const oldest = requests.at(-1)?.timestampMs;
    const windowMin = oldest ? Math.max(1, Math.round((Date.now() - oldest) / 60_000)) : null;
    const tdx = network ? network.participants.filter((p) => attestations.get(p.tlsPublicKey)?.kind === "tdx").length : null;

    /**
     * @param {string} label
     * @param {string} value
     * @param {(Node | string | null | false)[]} [note]
     */
    const stat = (label, value, note) =>
      h("div", { class: "stat" }, h("dt", {}, label), h("dd", {}, value, note ? h("small", {}, ...note) : null));

    this.stats.replaceChildren(
      stat("Threshold", network ? `${network.threshold} of ${network.participants.length}` : "…", ["nodes must sign"]),
      stat("In TEE", tdx === null ? "…" : `${tdx}`, ["Intel TDX"]),
      stat("Signed", String(signed), requests.length === 0 ? undefined : [
        `of ${requests.length} requests`,
        failed > 0 && h("span", { class: "stat-failed" }, `, ${failed} failed`),
        windowMin ? `, last ${windowMin} min` : "",
      ]),
      stat("Median time", median === null ? "…" : fmt.seconds(median), ["request → response"]),
      stat("Epoch", network ? String(network.epochId) : "…", network?.phase === "resharing" ? ["resharing"] : undefined),
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
