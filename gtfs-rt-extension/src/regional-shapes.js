import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { eachRow, integer, listEntries, number, openZip } from "./estimated-static.js";
import { resolveRegionStaticUrl } from "./regions.js";
import { fetchStaticToFile } from "./static-cache.js";

const REGIONAL_ENTRY_LIMITS = Object.freeze({
  "routes.txt": 128 * 1024 * 1024,
  "trips.txt": 512 * 1024 * 1024,
  "stops.txt": 512 * 1024 * 1024,
  "stop_times.txt": 2 * 1024 * 1024 * 1024,
  "shapes.txt": 2 * 1024 * 1024 * 1024,
});
const REQUIRED_ENTRIES = ["routes.txt", "trips.txt", "stops.txt", "stop_times.txt", "shapes.txt"];
const REGION_RETRY_MS = 5 * 60_000;
const EARTH_RADIUS_METERS = 6_371_000;
const GRID_CELL_DEGREES = 0.01;

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function insideBbox(bbox, lat, lon) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function intersects(first, second) {
  return first[0] <= second[2] && first[2] >= second[0]
    && first[1] <= second[3] && first[3] >= second[1];
}

function haversineMeters(a, b) {
  const radians = Math.PI / 180;
  const deltaLat = (b.lat - a.lat) * radians;
  const deltaLon = (b.lon - a.lon) * radians;
  const lat1 = a.lat * radians;
  const lat2 = b.lat * radians;
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(value)));
}

function normalizedRouteName(value) {
  return String(value || "").trim().toLowerCase();
}

function gridKey(lat, lon) {
  return `${Math.floor(lat / GRID_CELL_DEGREES)}:${Math.floor(lon / GRID_CELL_DEGREES)}`;
}

function buildStopGrid(stops) {
  const grid = new Map();
  for (const stop of stops.values()) {
    const key = gridKey(stop.lat, stop.lon);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(stop);
  }
  return grid;
}

function nearestStop(grid, lat, lon, maxDistanceMeters) {
  const cellLat = Math.floor(lat / GRID_CELL_DEGREES);
  const cellLon = Math.floor(lon / GRID_CELL_DEGREES);
  let best = null;
  let bestDistance = Infinity;
  for (let latOffset = -1; latOffset <= 1; latOffset += 1) {
    for (let lonOffset = -1; lonOffset <= 1; lonOffset += 1) {
      const candidates = grid.get(`${cellLat + latOffset}:${cellLon + lonOffset}`);
      if (!candidates) continue;
      for (const candidate of candidates) {
        const distance = haversineMeters({ lat, lon }, candidate);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
    }
  }
  return bestDistance <= maxDistanceMeters ? best : null;
}

function lcsLength(first, second) {
  if (first.length === 0 || second.length === 0) return 0;
  let previous = new Uint16Array(second.length + 1);
  let current = new Uint16Array(second.length + 1);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      current[secondIndex] = first[firstIndex - 1] === second[secondIndex - 1]
        ? previous[secondIndex - 1] + 1
        : Math.max(previous[secondIndex], current[secondIndex - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[second.length];
}

function sequenceScore(mapped, candidate) {
  return lcsLength(mapped, candidate) / Math.max(mapped.length, candidate.length);
}

function exactKey(routeName, stopIds) {
  return `${routeName}\u0000${stopIds.join("\u0001")}`;
}

export async function buildRegionalShapeIndex(zipPath, { bbox }) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error("A region BBOX is required to build a regional shapes index");
  }
  const zip = await openZip(zipPath);
  try {
    const entries = await listEntries(zip);
    const missing = REQUIRED_ENTRIES.filter((name) => !entries.has(name));
    if (missing.length > 0) {
      throw new Error(`Regional GTFS feed is missing ${missing.join(", ")}`);
    }

    const routes = new Map();
    await eachRow(zip, entries.get("routes.txt"), REGIONAL_ENTRY_LIMITS["routes.txt"], async (row) => {
      if (!row.route_id) return;
      routes.set(row.route_id, {
        routeId: row.route_id,
        shortName: row.route_short_name || "",
        agencyId: row.agency_id || null,
      });
    });

    const trips = new Map();
    await eachRow(zip, entries.get("trips.txt"), REGIONAL_ENTRY_LIMITS["trips.txt"], async (row) => {
      if (!row.trip_id || !row.route_id || !routes.has(row.route_id)) return;
      trips.set(row.trip_id, {
        tripId: row.trip_id,
        routeId: row.route_id,
        headsign: row.trip_headsign || "",
        shapeId: row.shape_id || null,
        stopIds: [],
      });
    });

    let stopTimeRows = 0;
    await eachRow(zip, entries.get("stop_times.txt"), REGIONAL_ENTRY_LIMITS["stop_times.txt"], async (row) => {
      const trip = trips.get(row.trip_id);
      const stopSequence = integer(row.stop_sequence);
      if (trip && row.stop_id && stopSequence !== null) {
        trip.stopIds.push({ stopId: row.stop_id, stopSequence });
      }
      if (++stopTimeRows % 5000 === 0) await yieldToEventLoop();
    });
    for (const trip of trips.values()) {
      trip.stopIds.sort((first, second) => first.stopSequence - second.stopSequence);
      trip.stopIds = trip.stopIds.map((entry) => entry.stopId);
    }

    const neededStopIds = new Set();
    for (const trip of trips.values()) {
      for (const stopId of trip.stopIds) neededStopIds.add(stopId);
    }
    const stops = new Map();
    let stopRows = 0;
    await eachRow(zip, entries.get("stops.txt"), REGIONAL_ENTRY_LIMITS["stops.txt"], async (row) => {
      if (row.stop_id && neededStopIds.has(row.stop_id)) {
        const lat = number(row.stop_lat);
        const lon = number(row.stop_lon);
        if (Number.isFinite(lat) && Number.isFinite(lon) && insideBbox(bbox, lat, lon)) {
          stops.set(row.stop_id, {
            stopId: row.stop_id,
            name: row.stop_name || "",
            lat,
            lon,
          });
        }
      }
      if (++stopRows % 5000 === 0) await yieldToEventLoop();
    });

    for (const [tripId, trip] of trips) {
      trip.stopIds = trip.stopIds.filter((stopId) => stops.has(stopId));
      if (trip.stopIds.length < 2 || !trip.shapeId) trips.delete(tripId);
    }

    const selectedShapeIds = new Set([...trips.values()].map((trip) => trip.shapeId));
    const shapes = new Map();
    let shapeRows = 0;
    await eachRow(zip, entries.get("shapes.txt"), REGIONAL_ENTRY_LIMITS["shapes.txt"], async (row) => {
      if (selectedShapeIds.has(row.shape_id)) {
        const lat = number(row.shape_pt_lat);
        const lon = number(row.shape_pt_lon);
        const sequence = integer(row.shape_pt_sequence);
        if (Number.isFinite(lat) && Number.isFinite(lon) && sequence !== null
          && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
          if (!shapes.has(row.shape_id)) shapes.set(row.shape_id, []);
          shapes.get(row.shape_id).push({
            lat,
            lon,
            sequence,
            distTraveled: number(row.shape_dist_traveled),
          });
        }
      }
      if (++shapeRows % 20000 === 0) await yieldToEventLoop();
    });
    for (const points of shapes.values()) points.sort((first, second) => first.sequence - second.sequence);

    let shapePoints = 0;
    for (const [tripId, trip] of trips) {
      const points = shapes.get(trip.shapeId);
      if (!Array.isArray(points) || points.length < 2) {
        trips.delete(tripId);
        continue;
      }
      shapePoints += points.length;
    }

    return {
      routes,
      trips,
      stops,
      shapes,
      stats: {
        trips: trips.size,
        stops: stops.size,
        routes: routes.size,
        shapePoints,
      },
    };
  } finally {
    zip.close();
  }
}

export async function matchRegionalShapes(nationalIndex, regionalIndex, {
  regionId,
  bbox,
  maxStopDistanceMeters = 150,
  minCoverage = 0.7,
  minSimilarity = 0.6,
} = {}) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error("A region BBOX is required to match regional shapes");
  }
  const grid = buildStopGrid(regionalIndex.stops);
  const byRoute = new Map();
  const exact = new Map();
  const allRegionalTrips = Array.from(regionalIndex.trips.values());
  for (const trip of allRegionalTrips) {
    const routeName = normalizedRouteName(regionalIndex.routes.get(trip.routeId)?.shortName);
    if (routeName) {
      if (!byRoute.has(routeName)) byRoute.set(routeName, []);
      byRoute.get(routeName).push(trip);
    }
    if (trip.stopIds.length > 1) {
      exact.set(exactKey(routeName, trip.stopIds), trip);
      exact.set(exactKey(routeName, [...trip.stopIds].reverse()), trip);
    }
  }

  const matches = new Map();
  let consideredTrips = 0;
  let processedTrips = 0;
  for (const nationalTrip of nationalIndex.trips.values()) {
    if (++processedTrips % 200 === 0) await yieldToEventLoop();
    const routeName = normalizedRouteName(nationalIndex.routes.get(nationalTrip.routeId)?.shortName);
    const nationalStops = [];
    for (const stopTime of nationalTrip.stopTimes || []) {
      const stop = nationalIndex.stops.get(stopTime.stopId);
      if (stop) nationalStops.push(stop);
    }
    const considered = nationalStops.filter((stop) => insideBbox(bbox, stop.lat, stop.lon));
    if (considered.length < 2) continue;
    consideredTrips += 1;

    const mappedIds = [];
    for (const stop of considered) {
      const match = nearestStop(grid, stop.lat, stop.lon, maxStopDistanceMeters);
      if (match) mappedIds.push(match.stopId);
    }
    if (mappedIds.length < 2 || mappedIds.length / considered.length < minCoverage) continue;

    let best = exact.get(exactKey(routeName, mappedIds))
      || exact.get(exactKey(routeName, [...mappedIds].reverse()));
    if (!best) {
      const candidates = routeName ? (byRoute.get(routeName) || []) : allRegionalTrips;
      let bestScore = 0;
      for (const candidate of candidates) {
        if (candidate.stopIds.length < 2) continue;
        const forward = sequenceScore(mappedIds, candidate.stopIds);
        const reverse = sequenceScore(mappedIds, [...candidate.stopIds].reverse());
        let score = Math.max(forward, reverse);
        if (mappedIds[0] === candidate.stopIds[0]
          && mappedIds.at(-1) === candidate.stopIds.at(-1)) {
          score = Math.min(1, score + 0.1);
        } else if (mappedIds[0] === candidate.stopIds.at(-1)
          && mappedIds.at(-1) === candidate.stopIds[0]) {
          score = Math.min(1, score + 0.05);
        }
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      if (bestScore < minSimilarity) best = null;
    }
    if (!best) continue;
    const points = regionalIndex.shapes.get(best.shapeId);
    if (!Array.isArray(points) || points.length < 2) continue;
    matches.set(nationalTrip.tripId, {
      regionId,
      shapeId: best.shapeId,
      points,
    });
  }

  return {
    matches,
    stats: {
      consideredTrips,
      matchedTrips: matches.size,
      shapePoints: regionalIndex.stats?.shapePoints || 0,
    },
  };
}

export class RegionalShapesService {
  constructor(config, estimatedService, {
    fetchImpl = globalThis.fetch,
    now = Date.now,
    logger = console,
    downloadStatic = fetchStaticToFile,
    resolveStaticUrl = (region, signal) => resolveRegionStaticUrl(fetchImpl, region, signal),
    buildIndex = buildRegionalShapeIndex,
    matcher = matchRegionalShapes,
  } = {}) {
    this.config = config;
    this.estimated = estimatedService;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.downloadStatic = downloadStatic;
    this.resolveStaticUrl = resolveStaticUrl;
    this.buildIndex = buildIndex;
    this.matcher = matcher;
    this.regions = (config.regions || []).filter((region) => region.enabled !== false);
    this.states = new Map(this.regions.map((region) => [region.id, {
      status: "idle",
      active: false,
      matchedTrips: 0,
      totalTrips: 0,
      shapePoints: 0,
      lastAttemptAt: null,
      lastLoadedAt: null,
      lastError: null,
      nextRetryAt: 0,
    }]));
    this.lastDemand = new Map();
    this.controllers = new Map();
    this.idleTimer = null;
    this.started = false;
  }

  start() {
    if (this.started || this.regions.length === 0) return;
    this.started = true;
    const interval = Math.min(60_000, Math.max(1_000, this.config.regionShapesIdleTimeoutMs));
    this.idleTimer = setInterval(() => this.deactivateIdleRegions(), interval);
    this.idleTimer.unref();
  }

  stop() {
    this.started = false;
    clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const region of this.regions) {
      this.estimated.removeRegionalShapes?.(region.id, { refresh: false });
    }
  }

  observeViewport(bbox, zoom) {
    if (!this.started || !Array.isArray(bbox) || !Number.isFinite(zoom)) return;
    for (const region of this.regions) {
      const minZoom = region.minZoom ?? this.config.regionShapesMinZoom;
      if (zoom < minZoom || !intersects(bbox, region.bbox)) continue;
      this.lastDemand.set(region.id, this.now());
      this.ensureRegion(region);
    }
  }

  ensureRegion(region) {
    const state = this.states.get(region.id);
    if (!state || state.status === "loading" || state.status === "ready") return;
    if (state.status === "error" && this.now() < state.nextRetryAt) return;
    void this.loadRegion(region);
  }

  async loadRegion(region) {
    const state = this.states.get(region.id);
    if (!state || state.status === "loading") return;
    state.status = "loading";
    state.active = true;
    state.lastError = null;
    state.lastAttemptAt = new Date(this.now()).toISOString();
    const controller = new AbortController();
    const startedAt = this.now();
    this.controllers.set(region.id, controller);
    this.logger.info?.(`Regional shapes ${region.id} loading`);
    let download = null;
    try {
      const cachePath = this.regionCachePath(region);
      download = await this.downloadRegion(region, cachePath, controller.signal);
      if (controller.signal.aborted || !this.started) return;
      const regionalIndex = await this.buildIndex(download.path, { bbox: region.bbox });
      if (controller.signal.aborted || !this.started) return;
      const nationalIndex = this.estimated.getStaticIndex?.();
      if (!nationalIndex || !nationalIndex.trips?.size) {
        throw new Error("National static GTFS index is not ready");
      }
      const result = await this.matcher(nationalIndex, regionalIndex, {
        regionId: region.id,
        bbox: region.bbox,
        maxStopDistanceMeters: region.maxStopDistanceMeters,
        minCoverage: region.minCoverage,
        minSimilarity: region.minSimilarity,
      });
      if (result.matches.size === 0) {
        throw new Error("No national trips matched the regional shapes feed");
      }
      if (controller.signal.aborted || !this.started) return;
      const appliedTrips = this.estimated.applyRegionalShapes(region.id, result.matches, { priority: region.priority });
      state.status = "ready";
      state.active = true;
      state.matchedTrips = appliedTrips;
      state.totalTrips = result.stats.consideredTrips;
      state.shapePoints = result.stats.shapePoints;
      state.lastLoadedAt = new Date(this.now()).toISOString();
      this.logger.info?.(
        `Regional shapes ${region.id} ready: matched ${appliedTrips}/${result.stats.consideredTrips} trips, ` +
        `${result.stats.shapePoints} shape points in ${this.now() - startedAt} ms`,
      );
    } catch (error) {
      if (controller.signal.aborted || !this.started) {
        state.status = "idle";
        state.active = false;
        return;
      }
      state.status = "error";
      state.active = false;
      state.lastError = errorMessage(error);
      state.nextRetryAt = this.now() + REGION_RETRY_MS;
      this.logger.error?.(`Regional shapes ${region.id} failed: ${state.lastError}`);
    } finally {
      this.controllers.delete(region.id);
      if (download?.directory) await rm(download.directory, { recursive: true, force: true });
    }
  }

  async downloadRegion(region, cachePath, signal) {
    const maxAge = this.config.regionShapesRefreshIntervalMs;
    if (cachePath && existsSync(cachePath)) {
      try {
        const age = this.now() - statSync(cachePath).mtimeMs;
        if (age >= 0 && age < maxAge) {
          this.logger.info?.(`Regional shapes ${region.id} reused from cache`);
          return { path: cachePath, cached: true, directory: null };
        }
      } catch {
        // Fall through to the normal download path.
      }
    }
    try {
      const staticUrl = await this.resolveStaticUrl(region, signal);
      const download = await this.downloadStatic(
        this.fetchImpl,
        staticUrl,
        signal,
        cachePath,
      );
      this.logger.info?.(`Regional shapes ${region.id} archive ${download.cached ? "reused" : "downloaded"}`);
      return download;
    } catch (error) {
      if (cachePath && existsSync(cachePath)) {
        this.logger.error?.(`Regional shapes ${region.id} download failed, using cached archive: ${errorMessage(error)}`);
        return { path: cachePath, cached: true, directory: null };
      }
      throw error;
    }
  }

  regionCachePath(region) {
    if (!this.config.staticCacheDir) return null;
    return join(this.config.staticCacheDir, "shapes", region.cacheFile || `${region.id}.zip`);
  }

  deactivateIdleRegions() {
    const now = this.now();
    for (const region of this.regions) {
      const state = this.states.get(region.id);
      if (!state || !state.active) continue;
      const lastDemand = this.lastDemand.get(region.id) ?? 0;
      if (now - lastDemand < this.config.regionShapesIdleTimeoutMs) continue;
      const controller = this.controllers.get(region.id);
      const wasLoading = state.status === "loading";
      controller?.abort();
      this.estimated.removeRegionalShapes?.(region.id);
      state.status = "idle";
      state.active = false;
      state.matchedTrips = 0;
      state.totalTrips = 0;
      state.shapePoints = 0;
      this.lastDemand.delete(region.id);
      this.logger.info?.(
        `Regional shapes ${region.id} ${wasLoading ? "cancelled" : "unloaded"} after idle timeout`,
      );
    }
  }

  getHealth() {
    const regions = {};
    for (const region of this.regions) {
      const state = this.states.get(region.id);
      regions[region.id] = {
        status: state.status,
        active: state.active,
        matchedTrips: state.matchedTrips,
        totalTrips: state.totalTrips,
        shapePoints: state.shapePoints,
        lastAttemptAt: state.lastAttemptAt,
        lastLoadedAt: state.lastLoadedAt,
        lastError: state.lastError,
      };
    }
    return regions;
  }
}
