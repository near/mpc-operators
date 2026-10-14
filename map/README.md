# NEAR MPC Signing Map

A live map of the NEAR Protocol MPC network signing chain signatures on
`v1.signer` (mainnet only). Signatures on the left, one row per request with
the node that answered it, the operators on a world map in the middle, the
nodes on the right.

It is the front page of the MPC info site: the page itself is `../index.html`
at the repository root, and it shares the site's nav, palette and API-keys
dialog (`../site.css`, `../site.js`), so serve the repository root, not this
directory:

```sh
python3 -m http.server 8000   # from the repository root
open http://localhost:8000/
```

`index.html` in this directory only redirects old `/map/` links to the root.

No build step and no dependencies. It's plain ES modules; `d3-geo`,
`topojson-client` and the world atlas load from jsDelivr. The page needs to be
served over HTTP (not `file://`) because of the modules. Node is only needed
for the tests and the location script below.

## Where the data comes from

| What | Source | Notes |
| --- | --- | --- |
| Participants, threshold, epoch, domains | `v1.signer` `state` view via FastNear RPC | every 5 min |
| TEE status per node | `v1.signer` `get_attestation` | `Dstack` = Intel TDX, `Mock` = not in a TEE |
| Requests and which node answered | FastNear tx API (`/v0/account`, `/v0/transactions`) | every 3 s with a key, 6 s without |
| Destination chain, address, tx | NearBlocks `/v3/multichain/signatures` | 15 s with a key, 90 s without |
| Node locations | `data/node-locations.json` | generated, see below |

### How a request is paired with its node

The request tx and the node's `respond` tx are separate transactions. Both
carry the same `request` struct: the node passes it to
`respond(request, response)`, and the contract hands it to the
`return_*_and_clean_state_on_success` callback inside the requester's tx.
`src/lib/ledger.js` canonicalizes that struct and joins on it. The node shown
as "delivered" is the account that signed the `respond` tx, straight from the
chain.

### What is illustrative

The other threshold−1 participants exchange shares with the leader over the
nodes' private TLS mesh, which never touches the chain. The animation picks a
stable stand-in peer set per request (`src/lib/cohort.js`).

Each signature in flight plays in its own color (`--round-N` in `site.css`),
with the leader ringed and tagged, so parallel rounds can be told apart. The
matching row in the Signatures panel takes that color until the round ends,
then settles back to green. The leader itself is real: it is the
node that signed the `respond` tx.

## API keys

Click **API keys** in the site nav. The keys are shared by every page of the
site, stay in the browser's localStorage, and each is sent only to its own
service as `Authorization: Bearer`. Without keys, everything
except destination decoding works fine. NearBlocks' free tier is 6 calls/min
and 333/day per IP, so the page backs off to one call every 90 s, then every
5 min once it hits a 429.

## Node locations

Operators rarely move, and ipwho.is's free tier rejects browser-origin
requests, so locations ship as data. A daily GitHub Action
(`.github/workflows/update-node-locations.yml` at the repository root)
refreshes the file and opens a PR when a node was added, removed or moved. To
run it by hand:

```sh
node scripts/locate-nodes.mjs   # or: npm run locate
```

It resolves each participant's host over DNS-over-HTTPS and geolocates the IP.
A node whose lookup fails keeps its previous location.
A new operator that isn't in the file still appears in the roster, just not
on the map. `test/live` fails when the file drifts from the chain.

## Tests

```sh
node --test "test/unit/*.test.js"   # fixtures are real captured mainnet data
node --test "test/live/*.test.js"   # hits mainnet; FASTNEAR_API_KEY / NEARBLOCKS_API_KEY optional
```

## Layout

```
../index.html        the page, at the repository root (the site's front page)
styles.css
src/main.js          wiring: feed → panels + map, round playback queue
src/feed.js          polling loops, back-off, pause when the tab is hidden
../site.js           API keys and the site-wide dialog (shared with the other pages)
src/map.js           canvas + SVG map, zoom/pan, and signing-round animation
src/ui.js            logs, roster, stats, source status
src/api/*            NEAR RPC, FastNear, NearBlocks, geo lookup (script only)
src/lib/*            pure logic, unit tested (ledger, contract, cohort, geo, format)
scripts/locate-nodes.mjs
data/node-locations.json
```

## License

[MIT](LICENSE)
