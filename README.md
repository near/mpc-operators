# NEAR MPC Operators

A single-file, dependency-free web page that lists the live operator set of the
[NEAR MPC](https://docs.near.org/chain-abstraction/chain-signatures) signer
contract, along with the signing quorum (threshold / total).

Live at **[mpc-operators.nearone.org](https://mpc-operators.nearone.org)**.

## How it works

Everything lives in [`index.html`](index.html) — no build step, no frameworks,
no external scripts. The page makes a single JSON-RPC `query` call to a public
NEAR RPC endpoint, invoking the `state` method on the MPC signer contract
(`v1.signer` on mainnet, `v1.signer-prod.testnet` on testnet). It then decodes
the contract state and renders each participant's name, account ID, and node URL.

- **Network toggle** — switch between mainnet and testnet.
- **RPC selector** — pick a public endpoint (FastNear, NEAR.org, Lava, dRPC) or
  enter a custom one.
- **Quorum badge** — shows how many operators must sign (threshold / total).

## Running locally

Open `index.html` in a browser, or serve the directory:

```sh
python3 -m http.server
```

Then visit http://localhost:8000.

## Editing operator names

Account IDs are mapped to human-friendly names in the `OPERATORS` object inside
`index.html`. Edit that map to add or rename operators.

## License

[MIT](LICENSE)
