// @ts-check
//
// Which nodes took part in a signature?
//
// The leader is known: it is the node that submitted `respond`. The other
// threshold-1 participants exchange shares with it over the nodes' private TLS
// mesh, which never touches the chain. So for the animation we draw a stable,
// deterministic stand-in: the same request always gets the same peers.

/**
 * 32-bit FNV-1a. Tiny, stable, and good enough to shuffle a list of accounts.
 * @param {string} text
 */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * @param {string} seed unique per request, e.g. its receipt id
 * @param {string} leader account that submitted the response
 * @param {string[]} accounts all current participants
 * @param {number} threshold participants needed to sign, leader included
 * @returns {string[]} peers, excluding the leader, at most threshold-1 of them
 */
export function pickPeers(seed, leader, accounts, threshold) {
  return accounts
    .filter((a) => a !== leader)
    .map((account) => ({ account, rank: fnv1a(`${seed}:${account}`) }))
    .sort((a, b) => a.rank - b.rank || (a.account < b.account ? -1 : 1))
    .slice(0, Math.max(0, threshold - 1))
    .map((p) => p.account);
}
