# Reitti Overlay extension

A standalone service that shows **time-windowed GPX and GeoJSON overlays** on
[Reitti](https://reitti.dev/)'s map. Upload a track or plan, give it a validity window, and it
appears over the map while it is valid — for example an event map, a festival layout, a race course,
or a park plan.

It is also a normal web app: import files, preview them on a map, and edit names, colours, widths,
time zones and validity. Everything is stored as JSON files; there is **no database**.

## Features

- GPX (tracks, segments, routes) and GeoJSON (lines, multi-lines, polygons, geometry collections).
- Three validity modes, evaluated to the minute:
  - **Always**
  - **Date & time range** (either end may be open; “Today” preset)
  - **Daily time window** (recurring, overnight windows supported, optional date range)
- Per-overlay **IANA time zone**, so an event in Los Angeles and a plan in Paris can coexist.
- **Per-feature colours and widths** in Reitti: each stored overlay keeps its own colour and line
  width.
- **One stable Reitti layer.** The layer must be enabled once per browser.
- Bbox and date filtering: Reitti sends the current viewport and selected day; the endpoint returns
  only the overlays that are valid and intersect the viewport.
- Polygon features are drawn as coloured outlines (the single layer is a `PathLayer`). The admin
  preview shows fills.
- File-based storage, atomic writes, in-memory index. Backup = copy the `data/` directory.
- Small admin UI with a MapLibre preview, styled after Reitti's GPX tool.
- Docker image and bare-metal operation (Node 22+).

## Requirements

- A running Reitti instance.

## Quick start with Docker

```bash
docker build -t reitti-overlay-extension .
docker run -d \
  --name overlay-extension \
  --restart unless-stopped \
  -p 8090:8090 \
  -v overlay-data:/app/data \
  -e DEFAULT_TIMEZONE=Europe/Berlin \
  reitti-overlay-extension
```

Open <http://localhost:8090/> and import a file.

Then in Reitti:

1. **Settings → Map Extensions** → add `http://<host-reachable-from-reitti>:8090`.
2. Open the map → **Extension Layers** → enable **Overlays** once.

If Reitti runs bare metal and the extension is on the same host, add `localhost` (or the LAN
hostname you use) to `reitti.extensions.allowed-hosts`. In Docker, add the service name, as shown
below.

Check the service:

```bash
curl http://localhost:8090/health
curl http://localhost:8090/reitti-extension.json
```

## Docker Compose with Reitti

Reitti must be able to resolve the extension by a container name:

```yaml
services:
  reitti:
    image: dedicatedcode/reitti:develop   # requires a build with map extensions
    environment:
      # Comma-separated hostnames Reitti may fetch extensions from.
      REITTI_EXTENSIONS_ALLOWED_HOSTS: overlay-extension

  overlay-extension:
    image: reitti-overlay-extension
    # Or build it in place:
    # build: ./overlay-extension
    restart: unless-stopped
    ports:
      - "8090:8090"          # the admin UI; remove if you only need Reitti's proxy
    volumes:
      - overlay-data:/app/data
    environment:
      DEFAULT_TIMEZONE: Europe/Berlin

volumes:
  overlay-data:
```

Register this URL in Reitti:

```text
http://overlay-extension:8090
```

Do **not** use `localhost` in that URL: inside the Reitti container, `localhost` is Reitti itself.
The service name must also be in `REITTI_EXTENSIONS_ALLOWED_HOSTS`.

The published port is only for the admin UI. The extension's data endpoints are fetched by Reitti
server-side; if you remove the port mapping, the UI is only reachable from inside the Docker network.

## Run bare metal

Node.js 22 or newer.

```bash
npm ci --omit=dev
DATA_DIR=./data \
DEFAULT_TIMEZONE=Europe/Berlin \
node src/server.js
```

Or with an env file:

```bash
cp .env.example .env
node --env-file=.env src/server.js
```

Example systemd unit (`/etc/systemd/system/reitti-overlay.service`):

```ini
[Unit]
Description=Reitti Overlay extension
After=network.target

[Service]
Type=simple
User=reitti
WorkingDirectory=/opt/reitti-overlay-extension
Environment=DATA_DIR=/var/lib/reitti-overlay
Environment=DEFAULT_TIMEZONE=Europe/Berlin
ExecStart=/usr/bin/node src/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Validity model

All times are wall-clock times in the overlay's time zone. Minute precision is inclusive.

| Mode | Meaning |
|------|---------|
| Always | Active on every day at every time. |
| Range | Active from `startDate startTime` to `endDate endTime`. Either side can be left blank (open-ended). “Today” fills in the current day in the selected time zone. |
| Daily | Active every day between `dailyStart` and `dailyEnd`, optionally limited to a date range. If `dailyStart > dailyEnd`, the window crosses midnight (e.g. `22:00–02:00`). `00:00–00:00` means all day. |

When Reitti sends the **current day**, the exact minute is used. When the map shows **another day**
(past or future), an overlay is shown if its validity overlaps that day at all. This makes it easy to
browse an event plan for a different date.

Activation latency is bounded by the poll interval (default 15 s) plus Reitti's proxy cache
(`min(pollIntervalMs, 30 s)`). Keep the host clock in sync (NTP) for reliable minute boundaries.

## Per-feature colours in Reitti

`PathLayer` and `PolygonLayer` read optional values from each GeoJSON feature's `properties`:

| Property | Renderer | Accepted |
|----------|----------|----------|
| `lineColor` | `PathLayer`, `PolygonLayer` | `[r,g,b]`, `[r,g,b,a]`, `#rrggbb`, `#rrggbbaa` |
| `fillColor` | `PolygonLayer` | same |
| `lineWidth` | `PathLayer`, `PolygonLayer` | 0–64 px |

The layer's `assets` remain the fallback. This extension always sets `lineColor` and `lineWidth` per
feature, so tracks keep their individual colours.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8090` | HTTP port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DATA_DIR` | `./data` | Storage directory; overlays live in `<DATA_DIR>/overlays`. |
| `PUBLIC_BASE_URL` | unset | Optional absolute base URL, including any reverse-proxy path prefix. When unset, the manifest uses relative URLs. || `EXTENSION_ID` | `reitti-overlays` | Must be unique across registrations. |
| `EXTENSION_NAME` | `Reitti Overlays` | Name shown in Reitti's extension settings. |
| `LAYER_ID` | `overlays` | Stable layer ID; changing it resets per-browser enable state. |
| `LAYER_NAME` | `Overlays` | Name shown in the map layer control. |
| `LAYER_DESCRIPTION` | … | Manifest layer description. |
| `DEFAULT_TIMEZONE` | `UTC` | Default IANA time zone for new overlays. |
| `POLL_INTERVAL_MS` | `15000` | Poll interval. Reitti caches for `min(interval, 30 s)`. |
| `MIN_ZOOM` | `0` | Hide and short-circuit the layer below this zoom. |
| `Z_INDEX` | `0` | Layer ordering inside the placement. |
| `PLACEMENT` | `below-paths` | `behind-buildings`, `above-buildings`, `below-paths`, or `top`. |
| `LINE_COLOR` | `#d9a441` | Fallback colour in the manifest. |
| `LINE_WIDTH` | `3` | Fallback line width in the manifest. |
| `MAP_STYLE_URL` | CARTO positron | Basemap for the admin preview only. |
| `MAP_TILE_ORIGINS` | `https://tiles.basemaps.cartocdn.com` | Comma-separated extra origins allowed by the UI CSP for tiles, glyphs and sprites. The style origin is always allowed. |
| `MAX_UPLOAD_BYTES` | 20 MiB | Upload limit. |
| `MAX_RESPONSE_BYTES` | 5 MiB | Matches Reitti's default data limit. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

Changing `PUBLIC_BASE_URL`, the host/port, `LINE_*`, `PLACEMENT`, `MIN_ZOOM`, `Z_INDEX`, `LAYER_ID`,
`LAYER_NAME`, or `POLL_INTERVAL_MS` changes the manifest. Press **Refresh** in Reitti's Map
Extensions settings once after such a change. Imports and validity edits never do.

Path-prefix deployments: serve the UI at a URL ending in `/` and let the reverse proxy strip the
prefix before forwarding. The UI uses relative URLs; `PUBLIC_BASE_URL` only affects the manifest's
absolute URLs.

## Storage and backup

```text
data/
  overlays/
    <id>.json     # metadata, validity, style and normalised geometry
```

Each file is written atomically. Copy `data/` to back up everything; restore it while the service is
stopped. Corrupt files are skipped and listed in `/health`; they are never deleted. The service is
single-process; do not run multiple replicas against the same data directory.

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Admin UI. |
| `GET` | `/reitti-extension.json` | Reitti manifest (one `PathLayer`). |
| `GET` | `/overlays.geojson?date=&bbox=&zoom=` | Data used by Reitti. |
| `GET` | `/api/config` | UI configuration. |
| `GET` | `/api/overlays` | List overlays with stats and active state. |
| `POST` | `/api/overlays` | Create from `{name, filename, format, content, timezone?, validity?, style?}`. |
| `PUT` | `/api/overlays/:id` | Update metadata, style, validity or enabled state. |
| `POST` | `/api/overlays/:id/geometry` | Replace the file content. |
| `DELETE` | `/api/overlays/:id` | Delete an overlay. |
| `GET` | `/api/preview.geojson` | Preview all overlays in the admin UI. |
| `GET` | `/api/overlays/:id/export.geojson` | Download normalised GeoJSON. |
| `GET` | `/health` | Health, counts, load errors, clock. |

## Security

The admin UI and API have **no authentication**, by design. Run it on a trusted network, put it
behind a VPN or reverse proxy, or only publish the port to your LAN. Mutating requests require
`Content-Type: application/json` and are not CORS-enabled, which blocks simple cross-site form
posts — but it is not a substitute for network protection.

The extension is fetched by Reitti server-side; the browser never calls it directly for map data.
Private hostnames must be added to Reitti's `reitti.extensions.allowed-hosts` (or
`REITTI_EXTENSIONS_ALLOWED_HOSTS`).

## Limitations

- Reitti has no labels or click popups for path/polygon layers, so overlay names and validity are
  visible only in the admin UI.
- One manifest layer means one placement and one renderer. Polygon fills are not drawn in Reitti
  (outlines only); the admin preview shows fills. Adding a second stable `PolygonLayer` is possible.
- Reitti sends only the selected **date** and the browser's local day — not a time or time zone.
  Minute accuracy therefore depends on this service's clock and the overlay time zone.
- A response over Reitti's 5 MiB limit is rejected. Use viewport filtering, `MIN_ZOOM`, smaller
  files, or split overlays.
- The admin preview and basemap need internet access for the default CARTO style; the data endpoints
  do not.

## Tests

```bash
npm test
```

Uses Node's built-in test runner with temp directories and loopback HTTP. No Docker, database, or
network access is needed. Coverage:

- validity boundaries, overnight windows, time zones, DST, other-day overlap
- GPX/GeoJSON normalisation and rejection cases
- file store CRUD, atomic persistence, corrupt files
- manifest contract and per-feature colour output
- HTTP endpoints, `date`/`bbox` filtering, preview, export, error statuses

For a general guide to building a new Reitti map extension, download
[llm.txt](https://github.com/dedicatedcode/reitti-documentation/blob/main/llm.txt).
