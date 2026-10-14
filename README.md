# NEAR MPC Info

A small static site about the [NEAR MPC](https://docs.near.org/chain-abstraction/chain-signatures)
signing network (Chain Signatures). Every number on it is read live from the
chain in the browser.

Live at **[mpc.nearone.org](https://mpc.nearone.org)**.

| Page | File | What it shows |
| --- | --- | --- |
| Live map (front page) | [`index.html`](index.html) | Signature requests and the nodes answering them, on a world map. Mainnet only. Its code and data live in [`map/`](map/); see [`map/README.md`](map/README.md). |
| Operators | [`operators.html`](operators.html) | The live operator set of the signer contract, the signing quorum (threshold / total) and each node's TEE status. Mainnet and testnet. |
| Security | [`overview.html`](overview.html) | How the network is structured and secured, with live counts. |

[`site.css`](site.css) and [`site.js`](site.js) hold what the pages share: the
palette, the nav and the optional API keys (FastNear, NearBlocks), which are
entered once under **API keys** and used by every page.

There is no build step. GitHub Pages serves the repository as is (`.nojekyll`
turns off Jekyll processing).

## How the Operators page works

The page makes a JSON-RPC `query` call to a public NEAR RPC endpoint,
invoking the `state` method on the MPC signer contract (`v1.signer` on
mainnet, `v1.signer-prod.testnet` on testnet). It then decodes the contract
state and renders each participant's name, account ID, and node URL.

- **Network toggle** — switch between mainnet and testnet.
- **RPC selector** — pick a public endpoint (FastNear, NEAR.org, Lava, dRPC) or
  enter a custom one. A FastNear API key, if set, is sent to FastNear only.
- **Quorum badge** — shows how many operators must sign (threshold / total).

## Running locally

Serve the repository root (the pages use ES modules, so `file://` won't work):

```sh
python3 -m http.server
```

Then visit http://localhost:8000.

## Node locations

The live map places nodes using [`map/data/node-locations.json`](map/data/node-locations.json).
A daily GitHub Action ([`update-node-locations.yml`](.github/workflows/update-node-locations.yml))
regenerates it and opens (or updates) a PR when a node was added, removed or
moved. It can also be run from the Actions tab. An optional `FASTNEAR_API_KEY` repository
secret raises its RPC rate limit.

## Editing operator names

Account IDs are mapped to human-friendly names in the `OPERATORS` object inside
`operators.html`. Edit that map to add or rename operators.

## License

[MIT](LICENSE)
