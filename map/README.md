# NEAR MPC Signing Map

A live map of the NEAR Protocol MPC network signing chain signatures on
`v1.signer`. Incoming requests on the left, the operators on a world map in
the middle, delivered signatures on the right.

```sh
python3 -m http.server 8000   # or: npm run serve
open http://localhost:8000
```

No build step and no dependencies. It's plain ES modules; `d3-geo`,
`topojson-client` and the world atlas load from jsDelivr. The page needs to be
served over HTTP (not `file://`) because of the modules.

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
stable stand-in peer set per request (`src/lib/cohort.js`), and the legend says
so.

## API keys

Click **API keys**. Keys stay in the browser's localStorage, and each is sent
only to its own service as `Authorization: Bearer`. Without keys, everything
except destination decoding works fine. NearBlocks' free tier is 6 calls/min
and 333/day per IP, so the page backs off to one call every 90 s, then every
5 min once it hits a 429.

## Node locations

Operators rarely move, and ipwho.is's free tier rejects browser-origin
requests, so locations ship as data. When operators join or leave:

```sh
node scripts/locate-nodes.mjs   # or: npm run locate
```

It resolves each participant's host over DNS-over-HTTPS and geolocates the IP.
A new operator that isn't in the file still appears in the roster, just not
on the map. `test/live` fails when the file drifts from the chain.

## Tests

```sh
node --test "test/unit/*.test.js"   # fixtures are real captured mainnet data
node --test "test/live/*.test.js"   # hits mainnet; FASTNEAR_API_KEY / NEARBLOCKS_API_KEY optional
```

## Layout

```
index.html, styles.css
src/main.js          wiring: feed → panels + map, round playback queue
src/feed.js          polling loops, back-off, pause when the tab is hidden
src/map.js           canvas + SVG map and signing-round animation
src/ui.js            logs, roster, stats, source status
src/api/*            NEAR RPC, FastNear, NearBlocks, geo lookup (script only)
src/lib/*            pure logic, unit tested (ledger, contract, cohort, geo, format)
scripts/locate-nodes.mjs
data/node-locations.json
```

## License

[MIT](LICENSE)
