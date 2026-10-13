// @ts-check
//
// NEAR JSON-RPC view calls against the signer contract (via FastNear's RPC).

import { SIGNER_CONTRACT } from "../lib/ledger.js";
import { parseAttestation, parseSignerState } from "../lib/contract.js";
import { fetchJson } from "./http.js";

export const RPC_URL = "https://rpc.mainnet.fastnear.com";

/**
 * @param {string} method
 * @param {unknown} args
 * @param {{ apiKey?: string, contract?: string }} [options]
 * @returns {Promise<unknown>}
 */
export async function viewCall(method, args, { apiKey, contract = SIGNER_CONTRACT } = {}) {
  const response = await fetchJson("NEAR RPC", RPC_URL, {
    apiKey,
    body: {
      jsonrpc: "2.0",
      id: "mpc-map",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    },
  });
  if (typeof response !== "object" || response === null) throw new Error(`NEAR RPC: empty response to ${method}`);
  if ("error" in response) throw new Error(`NEAR RPC ${method}: ${JSON.stringify(response.error).slice(0, 200)}`);
  const result = "result" in response ? response.result : undefined;
  if (typeof result !== "object" || result === null) throw new Error(`NEAR RPC ${method}: missing result`);
  if ("error" in result) throw new Error(`NEAR RPC ${method}: ${String(result.error).slice(0, 200)}`);
  if (!("result" in result) || !Array.isArray(result.result)) throw new Error(`NEAR RPC ${method}: missing bytes`);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
}

/** @param {{ apiKey?: string }} [options] */
export async function fetchSignerState(options) {
  return parseSignerState(await viewCall("state", {}, options));
}

/**
 * @param {string} tlsPublicKey
 * @param {{ apiKey?: string }} [options]
 */
export async function fetchAttestation(tlsPublicKey, options) {
  return parseAttestation(await viewCall("get_attestation", { tls_public_key: tlsPublicKey }, options));
}
