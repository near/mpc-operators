// @ts-check

import { Feed } from "./feed.js";
import { pickPeers } from "./lib/cohort.js";
import { parseNodeLocations } from "./lib/locations.js";
import { NetworkMap } from "./map.js";
import { loadKeys, saveKeys } from "./settings.js";
import { Panels, roundCaption } from "./ui.js";

/**
 * @typedef {import("./lib/ledger.js").SignRequest} SignRequest
 * @typedef {import("./lib/ledger.js").IngestResult} IngestResult
 * @typedef {import("./api/geoip.js").GeoLocation} GeoLocation
 */

/** Gap between queued rounds so bursts read as separate signatures. */
const ROUND_SPACING_MS = 900;
/** On first load, replay only the latest few instead of the whole backfill. */
const BACKFILL_REPLAY = 3;
const MAX_QUEUE = 10;

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

const feed = new Feed(loadKeys());
const panels = new Panels(document);
const map = new NetworkMap(byId("map"));

/** @type {Map<string, GeoLocation | null>} account -> location (null: not in the data file) */
const locations = new Map();
/** @type {Map<string, GeoLocation> | null} null until data/node-locations.json loads */
let knownLocations = null;

/** Fills `locations` for the current participants from the data file. */
function resolveLocations() {
  if (!feed.network || !knownLocations) return;
  locations.clear();
  for (const p of feed.network.participants) locations.set(p.account, knownLocations.get(p.account) ?? null);
}

/** @returns {Map<string, number>} */
function deliveredCounts() {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const r of feed.ledger.list()) {
    if (r.response) counts.set(r.response.node, (counts.get(r.response.node) ?? 0) + 1);
  }
  return counts;
}

/** Node positions changed: rebuild the map. Cheap updates go through renderActivity. */
function renderNetwork() {
  const network = feed.network;
  if (!network) return;
  const delivered = deliveredCounts();
  map.setNodes(
    network.participants.flatMap((p) => {
      const where = locations.get(p.account);
      if (!where) return [];
      return [{
        account: p.account,
        lat: where.lat,
        lon: where.lon,
        label: [where.city, where.country].filter(Boolean).join(", "),
        tee: feed.attestations.get(p.tlsPublicKey)?.kind ?? "none",
        delivered: delivered.get(p.account) ?? 0,
      }];
    }),
  );
}

function renderActivity() {
  const requests = feed.ledger.list();
  panels.renderLogs(requests, feed.network, locations);
  panels.renderStats(feed.network, feed.attestations, requests);
  if (feed.network) {
    const delivered = deliveredCounts();
    panels.renderRoster(feed.network, feed.attestations, locations, delivered);
    map.setDelivered(delivered);
  }
}

// ── Signing-round playback ────────────────────────────────────────────────

/** @type {SignRequest[]} */
const queue = [];
let draining = false;

/** @param {SignRequest} r */
function playRound(r) {
  const network = feed.network;
  if (!network || !r.response) return;
  const leader = r.response.node;
  map.play({
    id: r.receiptId,
    leader,
    peers: pickPeers(r.receiptId, leader, network.participants.map((p) => p.account), network.threshold),
    caption: roundCaption(r, network),
  });
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const next = queue.shift();
    if (next) playRound(next);
    await new Promise((resolve) => setTimeout(resolve, ROUND_SPACING_MS));
  }
  draining = false;
}

/** @param {SignRequest[]} resolved */
function enqueue(resolved) {
  const ordered = [...resolved].sort((a, b) => (a.response?.timestampMs ?? 0) - (b.response?.timestampMs ?? 0));
  queue.push(...ordered);
  // Falling behind real time helps nobody; keep the newest.
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  void drain();
}

// ── Feed events ───────────────────────────────────────────────────────────

feed.addEventListener("network", () => {
  resolveLocations();
  renderNetwork();
  renderActivity();
});

fetch("data/node-locations.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((raw) => {
    knownLocations = parseNodeLocations(raw).nodes;
  })
  .catch(() => {
    knownLocations = new Map();
  })
  .finally(() => {
    resolveLocations();
    renderNetwork();
    renderActivity();
  });

let backfillReplayed = false;

feed.addEventListener("requests", (event) => {
  if (!(event instanceof CustomEvent)) return;
  /** @type {{ result: IngestResult, backfill: boolean }} */
  const { result, backfill } = event.detail;
  if (!backfill) panels.markFresh([...result.added, ...result.resolved].map((r) => r.receiptId));
  renderActivity();
  if (!backfill) enqueue(result.resolved);
  else if (!backfillReplayed && result.resolved.length > 0) {
    // The first backfill slice holds the newest txs; replay a few of those so
    // the map isn't idle until the next live signature.
    backfillReplayed = true;
    enqueue(result.resolved.sort((a, b) => b.timestampMs - a.timestampMs).slice(0, BACKFILL_REPLAY));
  }
});

feed.addEventListener("status", () => panels.renderSources(feed.status));

// ── Interaction ───────────────────────────────────────────────────────────

panels.onSelect = (r) => {
  panels.select(r.receiptId);
  if (r.response) playRound(r);
};

/** @param {string | null} account */
function hoverNode(account) {
  map.highlight(account);
  panels.highlightNode(account);
}
panels.onHoverNode = hoverNode;
map.onHover(hoverNode);

// ── Settings dialog ───────────────────────────────────────────────────────

const dialog = byId("settings");
const form = byId("settings-form");
const fastnearInput = byId("key-fastnear");
const nearblocksInput = byId("key-nearblocks");

byId("open-settings").addEventListener("click", () => {
  const keys = loadKeys();
  if (fastnearInput instanceof HTMLInputElement) fastnearInput.value = keys.fastnear;
  if (nearblocksInput instanceof HTMLInputElement) nearblocksInput.value = keys.nearblocks;
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!(fastnearInput instanceof HTMLInputElement) || !(nearblocksInput instanceof HTMLInputElement)) return;
  feed.setKeys(saveKeys({ fastnear: fastnearInput.value, nearblocks: nearblocksInput.value }));
  if (dialog instanceof HTMLDialogElement) dialog.close();
});

byId("close-settings").addEventListener("click", () => {
  if (dialog instanceof HTMLDialogElement) dialog.close();
});

panels.renderSources(feed.status);
panels.renderStats(null, feed.attestations, []);
panels.renderLogs([], null, locations);
feed.start();
