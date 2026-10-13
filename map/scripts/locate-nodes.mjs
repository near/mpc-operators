// Refreshes data/node-locations.json from the live v1.signer participant set.
//
//   node scripts/locate-nodes.mjs
//
// Run it when operators join or leave; test/live checks for drift. A daily
// GitHub Action (.github/workflows/update-node-locations.yml) runs it too.
// Lookups are sequential to stay well inside ipwho.is's free-tier limits.
// A node whose host still resolves to the same IP keeps its previous entry, so
// geolocation jitter doesn't churn the file. When a lookup fails, the node
// also keeps its previous entry, so one flaky lookup doesn't drop it off the
// map.

import { readFileSync, writeFileSync } from "node:fs";

import { locateIP, resolveIPv4 } from "../src/api/geoip.js";
import { fetchSignerState } from "../src/api/near.js";
import { hostOf } from "../src/lib/geo.js";
import { parseNodeLocations, serializeNodeLocations } from "../src/lib/locations.js";

const OUT = new URL("../data/node-locations.json", import.meta.url);

/** @returns {Map<string, import("../src/api/geoip.js").GeoLocation>} */
function previousLocations() {
  try {
    return parseNodeLocations(JSON.parse(readFileSync(OUT, "utf8"))).nodes;
  } catch {
    return new Map();
  }
}

const previous = previousLocations();
const state = await fetchSignerState({ apiKey: process.env.FASTNEAR_API_KEY || undefined });
const nodes = new Map();
const failures = [];

for (const p of state.participants) {
  const host = hostOf(p.url);
  try {
    if (!host) throw new Error(`unusable url ${p.url}`);
    const ip = await resolveIPv4(host);
    const known = previous.get(p.account);
    const unchanged = known?.host === host && known.ip === ip;
    const where = unchanged ? known : await locateIP(host, ip);
    nodes.set(p.account, where);
    console.log(`${p.account.padEnd(34)} ${where.city}, ${where.countryCode}  (${where.provider})${unchanged ? "  unchanged" : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : error;
    const kept = previous.get(p.account);
    if (kept) {
      nodes.set(p.account, kept);
      console.error(`${p.account.padEnd(34)} lookup failed, kept previous location: ${message}`);
    } else {
      failures.push(p.account);
      console.error(`${p.account.padEnd(34)} FAILED: ${message}`);
    }
  }
}

writeFileSync(OUT, `${JSON.stringify(serializeNodeLocations({ generatedAt: new Date().toISOString(), nodes }), null, 2)}\n`);
console.log(`\nWrote ${nodes.size}/${state.participants.length} locations to ${OUT.pathname}`);
if (failures.length > 0) process.exitCode = 1;
