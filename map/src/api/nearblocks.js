// @ts-check
//
// NearBlocks decodes what each signature was for: destination chain, address
// and transaction. Nothing else on the page depends on it.

import { fetchJson } from "./http.js";

export const NEARBLOCKS_API = "https://api.nearblocks.io/v3";

/**
 * @typedef {import("../lib/ledger.js").NearblocksSignatureRow} NearblocksSignatureRow
 */

/**
 * Latest decoded chain signatures, newest first.
 * @param {{ apiKey?: string, limit?: number }} [options] each 25 rows cost one API credit
 * @returns {Promise<NearblocksSignatureRow[]>}
 */
export async function fetchDecodedSignatures({ apiKey, limit = 25 } = {}) {
  const data = await fetchJson("NearBlocks", `${NEARBLOCKS_API}/multichain/signatures?limit=${limit}`, { apiKey });
  if (typeof data !== "object" || data === null || !("data" in data) || !Array.isArray(data.data)) {
    throw new Error("NearBlocks: unexpected /multichain/signatures response");
  }
  return data.data;
}
