// @ts-check
//
// FastNear transactions API: an index of every tx touching an account.

import { fetchJson } from "./http.js";

export const TX_API = "https://tx.main.fastnear.com/v0";
/** The API refuses more hashes than this per request. */
export const MAX_TX_BATCH = 20;

/**
 * @typedef {{ transaction_hash: string, tx_block_height: number, tx_block_timestamp: string }} AccountTx
 * @typedef {import("../lib/ledger.js").FastnearTransaction} FastnearTransaction
 */

/**
 * Latest transactions involving `accountId`, newest first (up to 200).
 * @param {string} accountId
 * @param {{ apiKey?: string }} [options]
 * @returns {Promise<AccountTx[]>}
 */
export async function fetchAccountTxs(accountId, { apiKey } = {}) {
  const data = await fetchJson("FastNear", `${TX_API}/account`, { apiKey, body: { account_id: accountId } });
  if (typeof data !== "object" || data === null || !("account_txs" in data) || !Array.isArray(data.account_txs)) {
    throw new Error("FastNear: unexpected /account response");
  }
  return data.account_txs;
}

/**
 * Full transactions with all receipts and outcomes, fetched in API-sized batches.
 * @param {string[]} hashes
 * @param {{ apiKey?: string }} [options]
 * @returns {Promise<FastnearTransaction[]>}
 */
export async function fetchTransactions(hashes, { apiKey } = {}) {
  /** @type {Promise<FastnearTransaction[]>[]} */
  const batches = [];
  for (let i = 0; i < hashes.length; i += MAX_TX_BATCH) {
    const batch = hashes.slice(i, i + MAX_TX_BATCH);
    batches.push(
      fetchJson("FastNear", `${TX_API}/transactions`, { apiKey, body: { tx_hashes: batch } }).then((data) => {
        if (typeof data !== "object" || data === null || !("transactions" in data) || !Array.isArray(data.transactions)) {
          throw new Error("FastNear: unexpected /transactions response");
        }
        // Unknown hashes are simply left out of the result.
        return data.transactions;
      }),
    );
  }
  return (await Promise.all(batches)).flat();
}
