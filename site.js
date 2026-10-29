// @ts-check
//
// Shared by every page: the optional API keys and the dialog behind the nav's
// "API keys" button. Keys stay in this browser and are only ever sent to the
// service they belong to.

const STORAGE_KEY = "mpc:api-keys:v1";
const CHANGE_EVENT = "mpc:api-keys-change";

/** @typedef {{ fastnear: string, nearblocks: string }} ApiKeys */

/** Hosts each key may be sent to. */
const KEY_HOSTS = {
  fastnear: "fastnear.com",
  nearblocks: "nearblocks.io",
};

/**
 * Keys saved while storage was unavailable, so they still apply until the
 * page closes.
 * @type {ApiKeys}
 */
let unsaved = { fastnear: "", nearblocks: "" };

/**
 * @param {unknown} v
 * @returns {string}
 */
const stringOr = (v) => (typeof v === "string" ? v : "");

/** @returns {ApiKeys} */
export function loadKeys() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof stored === "object" && stored !== null) {
      return { fastnear: stringOr(stored.fastnear), nearblocks: stringOr(stored.nearblocks) };
    }
  } catch {
    // Private windows and blocked site data make storage unavailable.
    return { ...unsaved };
  }
  return { fastnear: "", nearblocks: "" };
}

/**
 * @param {ApiKeys} keys
 * @returns {ApiKeys}
 */
export function saveKeys(keys) {
  const trimmed = { fastnear: keys.fastnear.trim(), nearblocks: keys.nearblocks.trim() };
  try {
    if (trimmed.fastnear || trimmed.nearblocks) localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    unsaved = trimmed;
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: trimmed }));
  return trimmed;
}

/**
 * Runs `listener` whenever the keys change, here or in another tab.
 * @param {(keys: ApiKeys) => void} listener
 */
export function onKeysChange(listener) {
  window.addEventListener(CHANGE_EVENT, () => listener(loadKeys()));
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) listener(loadKeys());
  });
}

/**
 * `fetch`, with the user's key attached if they have one for the URL's service.
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchWithKey(url, init = {}) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return fetch(url, init);
  }
  const keys = loadKeys();
  const service = /** @type {[keyof ApiKeys, string][]} */ (Object.entries(KEY_HOSTS))
    .find(([s, domain]) => keys[s] && (host === domain || host.endsWith(`.${domain}`)))?.[0];
  if (!service) return fetch(url, init);

  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${keys[service]}`);
  try {
    return await fetch(url, { ...init, headers });
  } catch (error) {
    // A service that rejects the key may answer without CORS headers, which
    // the browser reports as a bare network error.
    throw new Error(`${error instanceof Error ? error.message : error}. If this keeps happening, check your API key under API keys.`);
  }
}

// ── Dialog ────────────────────────────────────────────────────────────────

const DIALOG_HTML = `
  <dialog id="api-keys-dialog" class="dialog" aria-labelledby="api-keys-title">
    <form method="dialog">
      <h2 id="api-keys-title">API keys</h2>
      <p>Optional. Keys raise rate limits, apply to every page of this site, and stay in this browser. Each is sent only to its own service.</p>
      <label for="key-fastnear">FastNear <span>RPC on every page; the map's request feed</span></label>
      <input id="key-fastnear" name="fastnear" type="password" autocomplete="off" spellcheck="false">
      <label for="key-nearblocks">NearBlocks <span>the map's destination chain decoding</span></label>
      <input id="key-nearblocks" name="nearblocks" type="password" autocomplete="off" spellcheck="false">
      <p class="hint">Without a key, NearBlocks allows 6 calls a minute and 333 a day, so the map refreshes destinations every 90 s.</p>
      <div class="dialog-actions">
        <button class="button" type="button" data-close>Cancel</button>
        <button class="button button-primary" type="submit">Save keys</button>
      </div>
    </form>
  </dialog>`;

const openButton = document.getElementById("api-keys");
if (openButton) {
  document.body.insertAdjacentHTML("beforeend", DIALOG_HTML);
  const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("api-keys-dialog"));
  const form = /** @type {HTMLFormElement} */ (dialog.querySelector("form"));
  const fastnear = /** @type {HTMLInputElement} */ (form.elements.namedItem("fastnear"));
  const nearblocks = /** @type {HTMLInputElement} */ (form.elements.namedItem("nearblocks"));

  // The button shows a green dot while keys are saved (see site.css).
  const reflect = (/** @type {ApiKeys} */ keys) => {
    const hasKeys = Boolean(keys.fastnear || keys.nearblocks);
    openButton.classList.toggle("has-keys", hasKeys);
    openButton.title = hasKeys ? "API keys are set" : "";
  };
  reflect(loadKeys());
  onKeysChange(reflect);

  openButton.addEventListener("click", () => {
    const keys = loadKeys();
    fastnear.value = keys.fastnear;
    nearblocks.value = keys.nearblocks;
    dialog.showModal();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveKeys({ fastnear: fastnear.value, nearblocks: nearblocks.value });
    dialog.close();
  });
  dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
}
