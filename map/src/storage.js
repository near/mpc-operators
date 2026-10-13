// @ts-check
//
// localStorage that never throws: private windows and blocked site data make
// it unavailable, and the page must work regardless.

/**
 * @param {string} key
 * @returns {unknown}
 */
export function load(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} key
 * @param {unknown} value `undefined` removes the key
 */
export function save(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is a convenience here; nothing depends on it succeeding.
  }
}
