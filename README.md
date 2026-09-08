# hz.ms

The site of the Solana validator hz.ms, drawn as an oscilloscope. The page opens one WebSocket to the public RPC and
draws what arrives: `slotsUpdatesSubscribe` pushes every pipeline stage of every slot with a millisecond timestamp
from the RPC node, `accountSubscribe` on the vote account pushes every landed vote. Nothing polls; the only HTTP calls
are `getEpochInfo` and the SIMD-0525 slot-time gates once per epoch, `getSlotLeaders` one 4000-slot chunk at a time,
and the vote account and balance once a minute for the strip.

One view: **Roll** — the length of each slot in lane 1, this validator's vote landing in lane 2, who led each slot
underneath. Lines take the colour of the leader's client: Firedancer family orange, Agave family yellow, other grey;
the validator's votes are cyan. (This is the single-view fork of the hz.ms site: no Turns, no Phase, no channel
choice.)

## Files
- `index.tpl.html` → `index.html` (built). The summary strip is static HTML; the instrument (`js/hz.js`, the bundle of
  the modules below, one versioned URL so a deploy can never mix old and new files) loads after first paint.
- `css/site.css` — one viewport (scrolls only when it cannot fit). Palette and type follow the codex mock: warm olive
  body, lime accent, DM Sans (the wordmark) and IBM Plex Mono bundled in `assets/` (no third-party font requests).
- `js/palette.js` colours and channels · `js/signal.js` the engine (slot store, clock, measurements) · `js/roll.js`
  the view · `js/feed.js` the probe (WebSocket, reconnect, leaders, epoch) · `js/scope.js` the shell (controls, pages,
  readouts).
- `data/config.json` — clusters, identities, vote account, RPC endpoints (`rpc` and `ws` may be lists; the next one is
  tried when one fails), refresh interval, default source. `data/snapshot.json` — slow facts for the strip.
  `data/clients-<cluster>.json` — client family (a Agave, f Firedancer, o other) → space-separated 8-character node
  pubkey prefixes, for the leader colours.
- `tools/snapshot.py` — facts and client maps (four RPC calls per cluster). `tools/build.py` — builds `index.html` and
  `js/hz.js`. `tools/livetest.mjs` — drive headless Chromium against a page for N seconds, screenshots plus one JSON
  line of engine state per mark.

## Build
```
python3 tools/snapshot.py
python3 tools/build.py
```
Outputs: `index.html` and `js/hz.js`.

## On the screen
Hover reads a slot; click locks it (the box stays and links the block and the leader on the Solana explorer); click
again, × or Escape unlocks. Space stops and resumes: while stopped nothing new is drawn, events are held and applied
on resume. Arrows move over the panel keys (the zoom knob is the last key of the source row), Enter presses, digits
1–5 press a page's side keys. Every scale is fixed in slot times, like a scope's volts per division: the roll window
is the knob's slot count times the cluster's slot time, lane 1 spans two slot times, lane 2 three; nothing rescales on
its own. The slot time comes from the SIMD-0525 feature gates once per epoch (the configured protocol value until
then). The dashed lines are cutoffs: lane 1 at the slot time, lane 2 at the two-slot vote credit grace.

## URL switches
`?src=mainnet|testnet` · `?page=stake|tech` · `?theme=dark|light` · `?ws=ws://localhost:8900` (probe your own node's
pubsub port, e.g. through an SSH tunnel) · `?rpc=https://…` (HTTP calls to another RPC).

## Deploy
Static: push to GitHub and set Pages to **Deploy from a branch** (main, root). `.nojekyll` keeps Jekyll out of the
way. For the custom domain, add it in the Pages settings and keep `CNAME`; apex A records 185.199.108.153,
185.199.109.153, 185.199.110.153, 185.199.111.153; `www` CNAME to `<user>.github.io`. The page is live on its own;
only the client colour map and the node's client/version line come from the snapshot, so after a validator upgrade (or
now and then) run `python3 tools/snapshot.py && python3 tools/build.py` and push.

Every visitor holds one WebSocket to the configured public RPC. If that endpoint throttles, the page shows
"reconnecting" and keeps retrying with backoff (0.25 s, then 2 s, 4 s … 15 s); it never shows made-up data.

Mainnet caveat: `api.mainnet-beta.solana.com` refuses browsers (HTTP 403 and no WebSocket upgrade from a real origin),
so mainnet depends on third-party public endpoints (PublicNode first). A keyed provider restricted to the hz.ms origin
in `data/config.json` makes mainnet reliable; testnet's public endpoint accepts browsers as is.
