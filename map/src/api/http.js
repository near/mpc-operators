// @ts-check

export class HttpError extends Error {
  /**
   * @param {string} service
   * @param {number} status
   * @param {string} detail
   */
  constructor(service, status, detail) {
    super(`${service} returned ${status}${detail ? `: ${detail}` : ""}`);
    this.service = service;
    this.status = status;
  }

  get rateLimited() {
    return this.status === 429;
  }

  get unauthorized() {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * @param {string} service used in error messages
 * @param {string} url
 * @param {{ body?: unknown, apiKey?: string, headers?: Record<string, string>, timeoutMs?: number }} [options]
 * @returns {Promise<unknown>}
 */
export async function fetchJson(service, url, { body, apiKey, headers = {}, timeoutMs = 15_000 } = {}) {
  /** @type {Record<string, string>} */
  const allHeaders = { accept: "application/json", ...headers };
  if (body !== undefined) allHeaders["content-type"] = "application/json";
  if (apiKey) allHeaders.authorization = `Bearer ${apiKey}`;

  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: allHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HttpError(service, response.status, text.slice(0, 200));
  }
  return response.json();
}
