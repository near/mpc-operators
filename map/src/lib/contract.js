// @ts-check
//
// Parses the `v1.signer` contract's `state` and `get_attestation` views.

import { isRecord } from "./guards.js";

/**
 * @typedef {{ account: string, id: number, url: string, tlsPublicKey: string }} Participant
 * @typedef {{ id: number, protocol: string, purpose: string, threshold: number }} Domain
 * @typedef {{
 *   phase: "running" | "resharing",
 *   epochId: number,
 *   threshold: number,
 *   participants: Participant[],
 *   domains: Domain[],
 * }} SignerState
 *
 * @typedef {"tdx" | "mock" | "none"} TeeKind
 * @typedef {{ kind: TeeKind, expiresAtMs: number | null, imageHash: string | null }} Attestation
 */

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {Record<string, unknown>}
 */
function record(value, what) {
  if (!isRecord(value)) throw new Error(`v1.signer state: expected ${what} to be an object`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} what
 */
function num(value, what) {
  if (typeof value !== "number") throw new Error(`v1.signer state: expected ${what} to be a number`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} what
 */
function str(value, what) {
  if (typeof value !== "string") throw new Error(`v1.signer state: expected ${what} to be a string`);
  return value;
}

/**
 * The contract is an enum: NotInitialized | Initializing | Running | Resharing.
 * While resharing, the network keeps signing with the previous running state,
 * so that's the one to show.
 * @param {unknown} raw
 * @returns {SignerState}
 */
export function parseSignerState(raw) {
  const state = record(raw, "state");
  const phase = "Running" in state ? "running" : "Resharing" in state ? "resharing" : null;
  if (phase === null) {
    const variant = typeof raw === "string" ? raw : Object.keys(state)[0];
    throw new Error(`v1.signer is not signing right now (state: ${variant})`);
  }
  const running = phase === "running"
    ? record(state.Running, "Running")
    : record(record(state.Resharing, "Resharing").previous_running_state, "previous_running_state");

  const parameters = record(running.parameters, "parameters");
  const participantsField = record(parameters.participants, "participants");
  const list = participantsField.participants;
  if (!Array.isArray(list)) throw new Error("v1.signer state: expected participants list");

  const participants = list.map((entry, i) => {
    if (!Array.isArray(entry) || entry.length !== 3) throw new Error(`v1.signer state: malformed participant #${i}`);
    const [account, id, info] = entry;
    const details = record(info, `participant #${i} info`);
    return {
      account: str(account, `participant #${i} account`),
      id: num(id, `participant #${i} id`),
      url: str(details.url, `participant #${i} url`),
      tlsPublicKey: str(details.tls_public_key, `participant #${i} tls_public_key`),
    };
  });

  const domainsField = record(running.domains, "domains");
  const domainList = Array.isArray(domainsField.domains) ? domainsField.domains : [];
  const domains = domainList.map((d, i) => {
    const domain = record(d, `domain #${i}`);
    return {
      id: num(domain.id, `domain #${i} id`),
      protocol: str(domain.protocol, `domain #${i} protocol`),
      purpose: str(domain.purpose, `domain #${i} purpose`),
      threshold: num(domain.reconstruction_threshold, `domain #${i} threshold`),
    };
  });

  const keyset = record(running.keyset, "keyset");
  return {
    phase,
    epochId: num(keyset.epoch_id, "keyset.epoch_id"),
    threshold: num(parameters.threshold, "threshold"),
    participants,
    domains,
  };
}

/**
 * `get_attestation` returns null, `{ Dstack: {...} }` for a node running in an
 * Intel TDX enclave, or `{ Mock: ... }` for a node that is not.
 * @param {unknown} raw
 * @returns {Attestation}
 */
export function parseAttestation(raw) {
  if (!isRecord(raw)) return { kind: "none", expiresAtMs: null, imageHash: null };
  if (isRecord(raw.Dstack)) {
    const d = raw.Dstack;
    return {
      kind: "tdx",
      expiresAtMs: typeof d.expiry_timestamp_seconds === "number" ? d.expiry_timestamp_seconds * 1000 : null,
      imageHash: typeof d.mpc_image_hash === "string" ? d.mpc_image_hash : null,
    };
  }
  if ("Mock" in raw) {
    const inner = isRecord(raw.Mock) && isRecord(raw.Mock.WithConstraints) ? raw.Mock.WithConstraints : {};
    const expiry = inner.expiry_timestamp_seconds;
    return { kind: "mock", expiresAtMs: typeof expiry === "number" ? expiry * 1000 : null, imageHash: null };
  }
  return { kind: "none", expiresAtMs: null, imageHash: null };
}

/**
 * Human label for a signing domain, e.g. "ECDSA secp256k1".
 * @param {Domain | undefined} domain
 */
export function domainLabel(domain) {
  if (!domain) return "Unknown domain";
  /** @type {Record<string, string>} */
  const byProtocol = {
    CaitSith: "ECDSA secp256k1",
    Frost: "EdDSA ed25519",
    ConfidentialKeyDerivation: "Confidential key",
  };
  const base = byProtocol[domain.protocol] ?? domain.protocol;
  return domain.purpose === "ForeignTx" ? "Foreign tx proof" : base;
}
