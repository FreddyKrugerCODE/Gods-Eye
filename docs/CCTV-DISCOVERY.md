# CCTV Area Discovery (discover → place → view)

Point the map at an area, have the app **find the public cameras already
published for that area**, register them at their real locations, and watch
through them. This is a thin, additive feature on top of God's Eye View's
existing CCTV layer — it reuses that layer's placement, projection, and viewing
controls and only adds the "find + register" step.

## What it does and does not do

- **Does:** take the area currently in view, select the already-public cameras
  inside it (from the open-data packs / any configured source file), optionally
  clean and rank them with your AAIOS backend, drop them on the map, and focus
  the nearest one.
- **Does not:** scan networks, guess camera URLs, or access anything private or
  unsecured. It never adds face recognition, motion alerts, or analytics. It
  only ever surfaces cameras that a public provider already published.

## How the pieces connect

```
Browser  ── discover_cctv (AI tool / voice) ──►  /api/cctv/discover (dev server)
   ▲                                                     │
   │                                     1. getCctvSources()  → public candidates
   │                                        filtered to the viewed area box
   │                                     2. AAIOS (optional): clean + rank
   │                                        task_class=extract, quality=standard
   │                                     3. reconcile → register (in-memory)
   │                                                     │
   └──── cameras placed + focused ◄── addDiscoveredCameras() / /api/cctv/sources
```

- **God's Eye View** is the app and the viewer. Runs locally (Pinokio → Vite on
  `127.0.0.1`).
- **AAIOS** is your own LLM/Codex backend, called **server-side only** for one
  step: turning the raw public candidates into clean, ranked records. It is
  **optional** — without it, discovery falls back to a deterministic
  distance-ranked list and still works.

## Files

| File | Role |
| --- | --- |
| `src/data/cctvDiscovery.js` | Pure logic: area normalization, in-area filtering, record shaping, AAIOS-output reconciliation. Unit-tested in `cctvDiscovery.test.mjs`. |
| `src/server/aaios.js` | The **only** place the AAIOS wire format lives. Builds the request, parses the reply, pins the enums. |
| `vite.config.js` | `/api/cctv/discover` route (`cctvDiscoveryProxy`), the discovered-source overlay (`mergeDiscoveredSources` / `addDiscoveredCctvSources`), and the `discover_cctv` tool schema. |
| `src/data/cctv.js` | `addDiscoveredCameras()` — additively injects discovered cameras into the live layer without a reload. |
| `src/voice/gevActions.js` | `discoverCctv()` — derives the view box, calls the route, injects + focuses. |

## AAIOS request contract (IMPORTANT: assumed — verify against your server)

`src/server/aaios.js` sends a POST to `${AAIOS_BASE_URL}${AAIOS_API_PATH}` with:

```json
{
  "task_class": "extract",
  "quality": "standard",
  "input": "<instruction + candidate cameras as JSON>",
  "response_format": "json"
}
```

- `task_class` and `quality` are **pinned** to AAIOS's allow-list values
  (`extract` / `standard`) and asserted by the unit tests. Do not change them to
  values outside AAIOS's enums — anything else returns HTTP 422.
- `AAIOS_API_KEY`, when set, is sent as `Authorization: Bearer <key>` and never
  reaches the browser.

**If your AAIOS expects a different body or returns a different envelope,** edit
the two functions `buildAaiosRequest` and `parseAaiosCameras` in
`src/server/aaios.js`. Nothing else needs to change — the response parser already
tolerates a bare array, `{cameras|records|results|data: [...]}`, or a text field
containing a JSON array.

## Configuration

Set these in `pinokio/ENVIRONMENT` (under Pinokio) or `.env` (bare `npm run dev`):

| Var | Default | Meaning |
| --- | --- | --- |
| `AAIOS_BASE_URL` | *(empty → AAIOS off, fallback used)* | Your AAIOS server base URL |
| `AAIOS_API_PATH` | `/v1/run` | Endpoint path |
| `AAIOS_API_KEY` | *(empty)* | Bearer token, server-side only |
| `AAIOS_TIMEOUT_MS` | `20000` | Per-call timeout |

## Try it

1. Start the app (Pinokio **Start**, or `npm run dev`).
2. Turn on the **CCTV** layer and fly to a city the open-data packs cover
   (Austin, London, or California), or point at your own area if you configured
   `CCTV_SOURCES_FILE`.
3. Trigger discovery — say/ask the assistant to *"find cameras here"* (calls the
   `discover_cctv` tool), or hit the route directly to check the backend:

   ```
   GET /api/cctv/discover?south=30.20&west=-97.80&north=30.32&east=-97.68&label=Austin
   ```

   Response: `{ ok, area, count, source: "aaios"|"fallback"|"none", cameras: [...] }`.
4. The discovered cameras appear on the map; use **NEAREST / NEXT / SELECT** in
   the CCTV panel (or `control_cctv`) to watch through them.

## Notes / limits (v1)

- Discovered cameras live in memory for the running session. Restarting the app
  clears them (they are re-discoverable). Cross-restart persistence is a
  deliberate later add.
- The candidate pool is whatever `/api/cctv/sources` serves. Areas with no
  published public cameras return `count: 0` with an explanatory note.
- Area = the current view box. A place-name geocoder is a later nicety.
