// @ts-check
//
// Where is a node? hostname ──DNS-over-HTTPS──▶ IPv4 ──ipwho.is──▶ city + lat/lon
//
// Runs from scripts/locate-nodes.mjs, not the browser: ipwho.is's free tier
// refuses requests that carry a browser Origin, and node locations change
// rarely enough to ship as data (data/node-locations.json).

import { isIPv4 } from "../lib/geo.js";
import { isRecord, stringOr } from "../lib/guards.js";
import { fetchJson } from "./http.js";

/**
 * @typedef {{ host: string, ip: string, lat: number, lon: number, city: string, country: string, countryCode: string, provider: string }} GeoLocation
 */

/**
 * @param {string} host
 * @returns {Promise<string>}
 */
export async function resolveIPv4(host) {
  if (isIPv4(host)) return host;
  const data = await fetchJson("DNS", `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: "application/dns-json" },
  });
  const answers = isRecord(data) && Array.isArray(data.Answer) ? data.Answer : [];
  // CNAME chains come first; type 1 is the A record at the end of the chain.
  const a = answers.find((r) => isRecord(r) && r.type === 1 && typeof r.data === "string");
  if (!a) throw new Error(`No A record for ${host}`);
  return a.data;
}

/**
 * @param {string} host
 * @returns {Promise<GeoLocation>}
 */
export async function locateHost(host) {
  const ip = await resolveIPv4(host);
  const r = await fetchJson("ipwho.is", `https://ipwho.is/${ip}`);
  if (!isRecord(r) || r.success !== true) throw new Error(`ipwho.is could not locate ${ip}: ${isRecord(r) ? stringOr(r.message) : ""}`);
  if (typeof r.latitude !== "number" || typeof r.longitude !== "number") throw new Error(`ipwho.is has no coordinates for ${ip}`);
  const connection = isRecord(r.connection) ? r.connection : {};
  return {
    host,
    ip,
    lat: r.latitude,
    lon: r.longitude,
    city: stringOr(r.city),
    country: stringOr(r.country),
    countryCode: stringOr(r.country_code),
    provider: stringOr(connection.org, stringOr(connection.isp)),
  };
}
