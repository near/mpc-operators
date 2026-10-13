// @ts-check

/**
 * "4s", "3m", "2h" style age.
 * @param {number} thenMs
 * @param {number} nowMs
 */
export function ago(thenMs, nowMs) {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * @param {number} ms
 */
export function seconds(ms) {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/**
 * Shortens the middle of long identifiers, keeping both ends readable.
 * @param {string} text
 * @param {number} [keep] characters kept on each side
 */
export function middle(text, keep = 6) {
  return text.length <= keep * 2 + 1 ? text : `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

/**
 * Implicit accounts are 64 hex chars (or 0x + 40 for eth-implicit); named
 * accounts are short enough to show as-is up to a point.
 * @param {string} account
 */
export function account(account) {
  if (/^[0-9a-f]{64}$/.test(account)) return middle(account, 5);
  if (/^0x[0-9a-f]{40}$/.test(account)) return middle(account, 6);
  return account.length > 30 ? middle(account, 13) : account;
}

/** @type {Record<string, { name: string, tx: (hash: string) => string | null }>} */
const CHAINS = {
  ETHEREUM: { name: "Ethereum", tx: (h) => `https://etherscan.io/tx/${h}` },
  BASE: { name: "Base", tx: (h) => `https://basescan.org/tx/${h}` },
  ARBITRUM: { name: "Arbitrum", tx: (h) => `https://arbiscan.io/tx/${h}` },
  OPTIMISM: { name: "Optimism", tx: (h) => `https://optimistic.etherscan.io/tx/${h}` },
  POLYGON: { name: "Polygon", tx: (h) => `https://polygonscan.com/tx/${h}` },
  BSC: { name: "BNB Chain", tx: (h) => `https://bscscan.com/tx/${h}` },
  GNOSIS: { name: "Gnosis", tx: (h) => `https://gnosisscan.io/tx/${h}` },
  BITCOIN: { name: "Bitcoin", tx: (h) => `https://mempool.space/tx/${h}` },
  SOLANA: { name: "Solana", tx: (h) => `https://solscan.io/tx/${h}` },
  ZCASH: { name: "Zcash", tx: (h) => `https://blockchair.com/zcash/transaction/${h}` },
};

/**
 * Display name and explorer tx link for a NearBlocks `dest_chain` value.
 * Unknown chains still get a readable name, just no links.
 * @param {string} chain
 */
export function chainInfo(chain) {
  const known = CHAINS[chain.toUpperCase()];
  if (known) return known;
  const name = chain.charAt(0).toUpperCase() + chain.slice(1).toLowerCase();
  return { name, tx: () => null };
}

/** @param {string} hash */
export const nearTxUrl = (hash) => `https://nearblocks.io/txns/${hash}`;