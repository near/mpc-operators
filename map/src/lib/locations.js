// @ts-check
//
// Reads data/node-locations.json, written by scripts/locate-nodes.mjs.

import { isRecord, stringOr } from "./guards.js";

/**
 * @typedef {import("../api/geoip.js").GeoLocation} GeoLocation
 * @typedef {{ generatedAt: string, nodes: Map<string, GeoLocation> }} NodeLocations
 */

/**
 * Validates the file's shape, keeping every well-formed entry and dropping
 * the rest rather than failing the whole map over one bad row.
 * @param {unknown} raw
 * @returns {NodeLocations}
 */
export function parseNodeLocations(raw) {
  /** @type {Map<string, GeoLocation>} */
  const nodes = new Map();
  if (!isRecord(raw)) return { generatedAt: "", nodes };
  const entries = isRecord(raw.nodes) ? Object.entries(raw.nodes) : [];
  for (const [account, v] of entries) {
    if (!isRecord(v) || typeof v.lat !== "number" || typeof v.lon !== "number") continue;
    if (Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) continue;
    nodes.set(account, {
      host: stringOr(v.host),
      ip: stringOr(v.ip),
      lat: v.lat,
      lon: v.lon,
      city: stringOr(v.city),
      country: stringOr(v.country),
      countryCode: stringOr(v.countryCode),
      provider: stringOr(v.provider),
    });
  }
  return { generatedAt: stringOr(raw.generatedAt), nodes };
}

/**
 * @param {NodeLocations} locations
 * @returns {unknown} JSON-ready value that parseNodeLocations reads back
 */
export function serializeNodeLocations(locations) {
  const sorted = [...locations.nodes.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { generatedAt: locations.generatedAt, nodes: Object.fromEntries(sorted) };
}
