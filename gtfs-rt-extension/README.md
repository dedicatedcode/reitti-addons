# GTFS-RT extension for Reitti

A standalone Node.js service that provides vehicle positions for [Reitti](https://reitti.dev/) as an HTTP polling
extension. It needs no Reitti source code, database, or internal API.

The included **Germany** configuration combines:

- **Nationwide estimates** from the public GTFS.de TripUpdates feed and static schedule, and
- **Live vehicle positions** in Berlin (VBB `transport.rest`) and Münster (Busradar), activated on demand.

All of it is exposed through one extension manifest and one `/vehicles` endpoint. Estimated and live vehicles use the
same payload format, so Reitti needs to know nothing about the individual upstream feeds.

## What Reitti gets

Register the manifest `Germany Transit`. It contains two toggleable layers:

- **Buses, trams and trains** — neutral vehicle models.
- **Buses, trams and trains (line colours)** — the same entities with line-coloured paint.

Enable only one of the two layers at a time.

The manifest uses meter-scale bus, tram, subway, and train GLB models through deck.gl `ScenegraphLayer`. Vehicle
coordinates are longitude/latitude and bearings are clockwise degrees from north.

The vehicle layers use `placement: "behind-buildings"`, so 3D vehicles are occluded by buildings in map styles that
provide 3D building extrusions. In styles without 3D buildings they fall back to a normal lower layer. When terrain is
enabled, the vehicles are draped onto the terrain surface instead of being hidden underneath it.

When a previous position is available, vehicles also include generic previous-position fields. Reitti uses them to
interpolate a vehicle immediately when it first appears in a new viewport, instead of leaving it stationary until the
next poll.

## Quick start with Docker

Build the image:

```bash
docker build -t reitti-gtfs-rt-extension .
```

Run it with a persistent cache volume:

```bash
docker run -d \
  --name reitti-gtfs-rt-extension \
  --restart unless-stopped \
  -p 8090:8090 \
  -v gtfs-rt-cache:/app/data/gtfs-static \
  reitti-gtfs-rt-extension
```

Check it:

```bash
curl http://localhost:8090/health
curl http://localhost:8090/reitti-extension.json
```

The image runs as the unprivileged `node` user and contains a health check.

The first start downloads the GTFS.de archive, which is roughly 300 MB. Indexing it takes tens of seconds and the full
Germany profile needs roughly **2–3 GB of RAM**. Later starts reuse the ZIP from the mounted volume, but the in-memory
index is still rebuilt on every start.

## Add the extension to a Reitti Docker Compose setup

Reitti must be able to reach the extension by a container name on the same Compose network. Add the extension service
and allow its hostname:

```yaml
services:
  reitti:
    image: dedicatedcode/reitti:5
    ports:
      - "8080:8080"
    environment:
      # ... your existing Reitti settings ...
      # Comma-separated list of hostnames Reitti may fetch extensions from.
      REITTI_EXTENSIONS_ALLOWED_HOSTS: gtfs-rt-extension

  gtfs-rt-extension:
    image: reitti-gtfs-rt-extension
    # Or build it in place:
    # build: ./gtfs-rt-extension
    restart: unless-stopped
    volumes:
      - gtfs-rt-cache:/app/data/gtfs-static
    # Only needed if you also want to reach it from the host:
    # ports:
    #   - "8090:8090"

volumes:
  gtfs-rt-cache:
```

Register this manifest URL in Reitti:

```text
http://gtfs-rt-extension:8090/reitti-extension.json
```

Do **not** use `localhost` for this URL in Compose: inside the Reitti container, `localhost` is Reitti itself. The
service name `gtfs-rt-extension` must be present in `REITTI_EXTENSIONS_ALLOWED_HOSTS` (or
`reitti.extensions.allowed-hosts` outside Docker).

## Mountable paths

| Container path            | Purpose                                                                                                 |
|---------------------------|---------------------------------------------------------------------------------------------------------|
| `/app/data/gtfs-static`   | Static GTFS ZIP cache, including regional shape feeds. Mount a named volume or host directory here.       |
| `/app/.env`               | Optional complete custom configuration. Replaces the baked-in default file.                             |
| `/app/regions.json`       | Optional custom regional shapes registry. Replaces the baked-in `regions.json`.                          |

Mounting the cache only avoids the download. The parsed index still lives in memory and is rebuilt after every restart.

The image creates `/app/data/gtfs-static` with ownership for the unprivileged `node` user (UID 1000). New named
volumes therefore inherit writable permissions. If you bind-mount a host directory instead, make sure it is writable
by UID 1000, for example:

```bash
mkdir -p ./gtfs-cache
sudo chown 1000:1000 ./gtfs-cache
```

If you used an older image whose cache volume was mounted at `/tmp/reitti-gtfs-static`, remove that stale volume once:

```bash
docker volume rm reitti-gtfs-cache
```

To use a custom configuration file instead of the baked defaults:

```bash
docker run -d \
  --name reitti-gtfs-rt-extension \
  -p 8090:8090 \
  -v gtfs-rt-cache:/app/data/gtfs-static \
  -v "$PWD/.env.germany.example:/app/.env:ro" \
  reitti-gtfs-rt-extension
```

A mounted `/app/.env` replaces the default file entirely, so copy `.env.germany.example` and edit the copy rather than
creating a file with only a few keys.

The baked `regions.json` defines the regional GTFS feeds used for real route shapes. Mount a custom file at
`/app/regions.json` to add or replace regions without rebuilding the image.

For individual changes, prefer environment variables. They take precedence over the baked `/app/.env`:

```bash
docker run -d \
  --name reitti-gtfs-rt-extension \
  -p 8090:8090 \
  -v gtfs-rt-cache:/app/data/gtfs-static \
  -e PUBLIC_BASE_URL=http://192.168.1.20:8090 \
  -e EXTENSION_API_KEY=change-me \
  reitti-gtfs-rt-extension
```

## Configuration

The image copies [`.env.germany.example`](.env.germany.example) to `/app/.env` and starts the server with
`node --env-file=.env`. The table below describes every setting in that file and the built-in fallback where it
differs.

| Variable                                | Default in image | Description |
|-----------------------------------------|------------------|-------------|
| `FEED_TYPE`                             | `germany`        | `germany` runs the unified estimated-plus-live extension. Other supported modes are `gtfs-rt`, `gtfs-rt-estimated`, `busradar`, and `transport-rest`. |
| `PORT`                                  | `8090`           | HTTP listen port. |
| `PUBLIC_BASE_URL`                       | unset            | Optional absolute base URL, including any reverse-proxy path prefix. When unset, the manifest emits relative URLs and Reitti resolves them against the registered manifest URL. |
| `GTFS_RT_URL`                           | GTFS.de realtime | GTFS-RT TripUpdates protobuf URL. Required unless `FEED_TYPE` is `busradar` or `transport-rest`. |
| `GTFS_STATIC_URL`                       | GTFS.de Germany  | Static GTFS ZIP URL. Required unless `FEED_TYPE` is `busradar` or `transport-rest`. |
| `BBOX`                                  | all of Germany   | `west,south,east,north` area used to restrict the static index and estimated vehicles. |
| `BERLIN_BBOX`                           | Berlin box       | Bounding box for the live VBB feed. |
| `MUNSTER_BBOX`                          | Münster box      | Bounding box for the live Busradar feed. |
| `LIVE_CITY_MIN_ZOOM`                    | `10`             | Minimum zoom that activates a live city feed. Below it, that city uses estimates only. |
| `LIVE_CITY_IDLE_TIMEOUT_MS`             | `600000`         | Stop a live city feed after this many milliseconds without an intersecting `/vehicles` request. |
| `TRANSPORT_REST_RESULTS`                | `10000`          | Movements requested from the VBB radar. VBB caps a single response at 1,000 regardless of this value. |
| `AGENCY_ID`                             | unset            | Optional comma-separated GTFS agency IDs. When set, vehicles without a matching indexed route agency are omitted. |
| `STALE_AFTER_SECONDS`                   | `180`            | Maximum vehicle age, from 1 to 86400 seconds. Future timestamps are not considered stale. |
| `REFRESH_INTERVAL_MS`                   | `15000`          | Live upstream refresh interval, and the manifest's polling interval. |
| `ESTIMATED_REFRESH_INTERVAL_MS`         | `15000`          | GTFS.de TripUpdates refresh interval. Conditional requests avoid re-downloading an unchanged feed. |
| `ESTIMATED_POSITION_REFRESH_INTERVAL_MS`| `15000`          | Background interval for recalculating estimated positions from the cached TripUpdates. |
| `STATIC_REFRESH_INTERVAL_MS`            | `300000`         | Static GTFS ZIP refresh interval for the Germany profile. Re-downloads are revalidated against the cached ZIP. |
| `STATIC_CACHE_DIR`                      | `data/gtfs-static` | Static ZIP cache directory, resolved against the working directory (`/app/data/gtfs-static` in the image). Mount this path to keep the archive between container recreations. |
| `REGIONS_FILE`                          | `regions.json`   | Optional regional shapes registry. Relative paths resolve against the working directory. The image bakes `/app/regions.json`. |
| `REGION_SHAPES_MIN_ZOOM`                | `10`             | Minimum zoom that activates a regional shapes feed. Regions may override this with their own `minZoom`. |
| `REGION_SHAPES_IDLE_TIMEOUT_MS`         | `600000`         | Unload regional shapes after this many milliseconds without an intersecting `/vehicles` request. |
| `REGION_SHAPES_REFRESH_INTERVAL_MS`     | `86400000`       | Maximum age of a cached regional ZIP before it is revalidated on the next activation. |
| `EXTENSION_API_KEY`                     | unset            | When set, manifest and vehicle requests require `Authorization: Bearer <key>`. Health, the SVG, and the GLB models stay public. |

Settings not listed in `.env.germany.example` still have built-in defaults: `MIN_ZOOM=10` (endpoint and render zoom
floor), `BUS_RADAR_URL`, `TRANSPORT_REST_URL`, and `STATIC_REFRESH_INTERVAL_MS=21600000` for the non-Germany feed
modes.

### How the Germany profile behaves

- Only the nationwide GTFS.de estimated service starts at startup.
- Berlin and Münster stay **idle** until a `/vehicles` request has a bbox intersecting the city and
  `zoom >= LIVE_CITY_MIN_ZOOM`.
- A request without a bbox activates both live feeds.
- After `LIVE_CITY_IDLE_TIMEOUT_MS` without demand, an activated live feed is stopped and released.
- Estimated vehicles inside a live city are hidden only once that live feed has successfully produced data. If a live
  feed is starting or failing, estimates remain visible instead of leaving the city empty.
- Static indexing is restricted to trips present in the current realtime feed, not every German trip.
- GTFS.de's free archive has no `shapes.txt`, so ordered stop geometry is used as a straight-line fallback between
  stops. Estimated positions are **predictions, not measured GPS**. Live city vehicles do not use estimates once their
  feed is active.
- The realtime feed is polled every 15 seconds using `ETag` / `Last-Modified` conditional requests, so an unchanged
  feed costs only headers. The all-Germany estimate processes around 20k vehicles per cycle; narrowing `BBOX` to the
  region you actually view reduces CPU and improves update latency.
- Regional feeds with `shapes.txt` are loaded on demand. Until a region is ready, vehicles keep the straight-line
  fallback. Once ready, matched trips switch to real route geometry.

`/health` always reports idle cities as `"status": "idle", "active": false` and does not activate them. The overall
status ignores idle sources.

### Regional route shapes

The GTFS.de free feed does not contain `shapes.txt`, but several regional feeds do. The extension can load those
feeds only when the map viewport intersects their region and `zoom >= REGION_SHAPES_MIN_ZOOM`. Nothing waits for the
regional feed:

1. `/vehicles` keeps returning the current estimated snapshot.
2. The region is downloaded and indexed in the background.
3. National GTFS.de trips are matched to regional trips by route name, stop location, and stop sequence.
4. Matched trips switch to the regional shape on the next position refresh.
5. Unmatched trips keep the straight-line fallback.

Regional feeds require a concrete `bbox` and `zoom`; a request without a viewport never loads every region. Shapes
are unloaded after `REGION_SHAPES_IDLE_TIMEOUT_MS` without demand. The downloaded ZIP stays in the static cache and is
reused on the next visit.

The baked `regions.json` starts with the NAH.SH feed for Schleswig-Holstein and Hamburg, which covers Lübeck. Add more
regions by editing or mounting `/app/regions.json`:

```json
{
  "regions": [
    {
      "id": "nahsh",
      "name": "Schleswig-Holstein / Hamburg",
      "bbox": [7.8, 53.3, 11.4, 55.1],
      "staticUrl": "https://opendata.schleswig-holstein.de/dataset/.../download/fahrplandaten",
      "minZoom": 10,
      "priority": 10
    }
  ]
}
```

Each region supports:

- `id`, `name`, `bbox`, `staticUrl`
- `minZoom` (overrides `REGION_SHAPES_MIN_ZOOM`)
- `priority` for overlapping regions
- `maxStopDistanceMeters` (default 150)
- `minCoverage` (default 0.7)
- `minSimilarity` (default 0.6)
- `cacheFile`

The first load parses the regional stops, trips, stop times, and shapes, then matches only trips present in the
current realtime feed. It can take up to about a minute and temporarily adds memory. The full Germany profile still
fits within roughly 2–3 GB of RAM.

`/health` reports each regional feed under `regions`, including `status`, matched/total trips, shape points, and the
last error. Regional failures do not make the national feed unhealthy; unmatched trips keep the fallback geometry.

Regional route data is attributed in the region registry and remains under the source feed's license. The default
NAH.SH data is published under CC BY 4.0 by NAH.SH.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/reitti-extension.json` | Main extension manifest. |
| `GET` | `/reitti-extension-colored.json` | Colored-only manifest variant. |
| `GET` | `/reitti-extensions.json` | All manifests in one object. |
| `GET` | `/vehicles` | Vehicle payload with optional `bbox`, `zoom`, and `date` query parameters. |
| `GET` | `/health` | Feed, cache, live-city, and regional-shape health; no authentication required. |
| `GET` | `/assets/bus.svg` | Icon referenced by the manifest. |
| `GET` | `/assets/*.glb` | Neutral and tintable vehicle models. |
| `GET` | `/assets/ATTRIBUTION.txt` | Model licence and source attribution. Also available as `/attribution`. |

The vehicle endpoint accepts:

- `bbox=west,south,east,north` — filters the cached snapshot without another upstream request.
- `zoom` — filters entities below the manifest's per-model zoom floors. IC/ICE use zoom 5, other vehicles use
  `MIN_ZOOM`.
- `date=YYYY-MM-DD` — returns an empty array for a non-current date.

The manifest uses `pollTrigger: "both"`, so Reitti sends its viewport and selected date on map movement and during
interval refreshes.

The payload contains only `timestamp` and `vehicles`:

```json
{
  "timestamp": "2026-11-23T08:20:30.000Z",
  "vehicles": [
    {
      "vehicleId": "trip-456",
      "tripId": "trip-456",
      "routeId": "route-1",
      "line": "M4",
      "lineColor": [213, 94, 0, 255],
      "headsign": "Hauptbahnhof",
      "lon": 13.405,
      "lat": 52.518,
      "bearing": 87,
      "speedKmh": 24.3,
      "updatedAt": "2026-11-23T08:20:15.000Z",
      "positionSource": "live",
      "displayText": "M4",
      "vehicleType": "tram",
      "model": "tram",
      "labelColor": [213, 94, 0, 255],
      "previousLon": 13.401,
      "previousLat": 52.517,
      "previousBearing": 84,
      "previousUpdatedAt": "2026-11-23T08:20:00.000Z"
    }
  ]
}
```

`positionSource` is `live` or `estimated`. Estimated vehicles add `previousStopName`, `previousDeparture`,
`nextStopName`, `nextStopId`, `nextArrival`, `delaySeconds`, `delayText`, `operator`, and `routeType`. Their
`displayText` starts with `≈`.

The previous-position fields are omitted when no earlier position exists. They only seed Reitti's animation; they do
not change normalization or stale pruning.

## Register in Reitti

Enter the manifest URL in Reitti's extension settings:

```text
http://localhost:8090/reitti-extension.json
```

When Reitti runs in another container, use the container-reachable URL instead, for example
`http://gtfs-rt-extension:8090/reitti-extension.json`.

Private or local hostnames must be listed in Reitti's `reitti.extensions.allowed-hosts`. In Docker Compose this is
usually easier as an environment variable:

```yaml
environment:
  REITTI_EXTENSIONS_ALLOWED_HOSTS: gtfs-rt-extension
```

If `EXTENSION_API_KEY` is configured on the extension, enter the same key as the Bearer token when registering it in
Reitti.

## Run locally without Docker

Node.js 22 or newer is required.

```bash
npm ci
node --env-file=.env.germany.example src/server.js
```

Alternatively, export the variables in your shell and run `npm start`. The service listens on
`http://localhost:8090`.

To use a custom file locally, copy `.env.germany.example` to `.env` and edit it:

```bash
cp .env.germany.example .env
node --env-file=.env src/server.js
```

If `STATIC_CACHE_DIR` is a relative path, it resolves against the directory you start the server from. The default
`data/gtfs-static` therefore creates `./data/gtfs-static` in this repository, and that directory is created
automatically.

## Model attribution

The checked-in vehicle models are derived from [Grab3D](https://grab3d.com/) CC0 1.0 models. See
[`ATTRIBUTION.md`](ATTRIBUTION.md) for per-model source links and modifications. The plain-text copy is served as
`/assets/ATTRIBUTION.txt`.

## Tests

```bash
npm test
```

The tests use Node's built-in test runner, generated protobuf/ZIP/GeoJSON fixtures, and loopback HTTP servers only.
They cover regional shape parsing, matching, activation, idle unload, and fallback behaviour. They never contact a real
transit feed.
