// @ts-check
//
// Optional API keys. They stay in this browser and are only ever sent to the
// service they belong to.

import { isRecord, stringOr } from "./lib/guards.js";
import { load, save } from "./storage.js";

const KEY = "mpc-map:keys:v1";

/** @typedef {{ fastnear: string, nearblocks: string }} ApiKeys */

/** @returns {ApiKeys} */
export function loadKeys() {
  const stored = load(KEY);
  if (!isRecord(stored)) return { fastnear: "", nearblocks: "" };
  return { fastnear: stringOr(stored.fastnear), nearblocks: stringOr(stored.nearblocks) };
}

/** @param {ApiKeys} keys */
export function saveKeys(keys) {
  const trimmed = { fastnear: keys.fastnear.trim(), nearblocks: keys.nearblocks.trim() };
  save(KEY, trimmed.fastnear || trimmed.nearblocks ? trimmed : undefined);
  return trimmed;
}
