// @ts-check

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
