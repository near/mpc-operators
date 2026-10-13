// Refreshes data/node-locations.json from the live v1.signer participant set.
//
//   node scripts/locate-nodes.mjs
//
// Run it when operators join or leave; test/live checks for drift.
// Lookups are sequential to stay well inside ipwho.is's free-tier limits.

import { writeFileSync } from "node:fs";

import { locateHost } from "../src/api/geoip.js";
import { fetchSignerState } from "../src/api/near.js";
import { hostOf } from "../src/lib/geo.js";
import { serializeNodeLocations } from "../src/lib/locations.js";

const OUT = new URL("../data/node-locations.json", import.meta.url);

const state = await fetchSignerState({ apiKey: process.env.FASTNEAR_API_KEY || undefined });
const nodes = new Map();
const failures = [];

for (const p of state.participants) {
  const host = hostOf(p.url);
  try {
    if (!host) throw new Error(`unusable url ${p.url}`);
    const where = await locateHost(host);
    nodes.set(p.account, where);
    console.log(`${p.account.padEnd(34)} ${where.city}, ${where.countryCode}  (${where.provider})`);
  } catch (error) {
    failures.push(p.account);
    console.error(`${p.account.padEnd(34)} FAILED: ${error instanceof Error ? error.message : error}`);
  }
}

writeFileSync(OUT, `${JSON.stringify(serializeNodeLocations({ generatedAt: new Date().toISOString(), nodes }), null, 2)}\n`);
console.log(`\nWrote ${nodes.size}/${state.participants.length} locations to ${OUT.pathname}`);
if (failures.length > 0) process.exitCode = 1;
