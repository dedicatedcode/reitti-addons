import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { normalizeFeed } from "./normalize.js";
import { normalizeBusradarFeed } from "./normalize-busradar.js";
import { normalizeTransportRestFeed } from "./normalize-transport-rest.js";
import { emptyStaticFeed, parseStaticFeed } from "./static-feed.js";
import { buildEstimatedStaticIndex, emptyEstimatedStaticIndex } from "./estimated-static.js";
import { estimateTripUpdatesAsync } from "./estimated-vehicles.js";
import { fetchStaticToFile } from "./static-cache.js";
import { RegionalShapesService } from "./regional-shapes.js";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const MAX_REALTIME_BYTES = 32 * 1024 * 1024;
const MAX_STATIC_BYTES = 128 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;

async function readResponseBuffer(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Upstream response exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) throw new Error("Upstream returned an empty response");

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`Upstream response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  if (size === 0) throw new Error("Upstream returned an empty response");
  return Buffer.concat(chunks, size);
}

async function fetchBuffer(fetchImpl, url, { accept, maxBytes, signal, timeoutMs = UPSTREAM_TIMEOUT_MS }) {
  const response = await fetchImpl(url, {
    headers: { accept, "user-agent": "reitti-gtfs-rt-extension/1.0" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Upstream returned HTTP ${response.status}`);
  }
  return readResponseBuffer(response, maxBytes);
}

async function fetchConditionalBuffer(fetchImpl, url, {
  accept,
  maxBytes,
  signal,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  etag = null,
  lastModified = null,
}) {
  const headers = { accept, "user-agent": "reitti-gtfs-rt-extension/1.0" };
  if (etag) headers["if-none-match"] = etag;
  if (lastModified) headers["if-modified-since"] = lastModified;
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (response.status === 304) {
    await response.body?.cancel();
    return { notModified: true, etag, lastModified };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Upstream returned HTTP ${response.status}`);
  }
  return {
    notModified: false,
    buffer: await readResponseBuffer(response, maxBytes),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

function feedHealth() {
  return {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
  };
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function transportRestRadarUrl(config) {
  const url = new URL(config.transportRestUrl);
  const [west, south, east, north] = config.bbox;
  const parameters = {
    north, west, south, east,
    results: config.transportRestResults,
    duration: 30,
    frames: 0,
    polylines: false,
  };
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, String(value));
  return url.toString();
}

export class FeedService {
  constructor(config, { fetchImpl = globalThis.fetch, now = Date.now, logger = console } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("A Fetch API implementation is required");
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.busradar = config.feedType === "busradar";
    this.transportRest = config.feedType === "transport-rest";
    this.estimated = config.feedType === "gtfs-rt-estimated";
    this.abortController = new AbortController();
    this.staticFeed = this.estimated ? emptyEstimatedStaticIndex() : emptyStaticFeed();
    this.busRadarTracks = new Map();
    this.transportRestTracks = new Map();
    this.estimatedTracks = new Map();
    this.realtimeBuffer = null;
    this.realtimeFeed = null;
    this.realtimeReceivedAt = null;
    this.lastEstimateAt = null;
    this.lastEstimateDurationMs = null;
    this.snapshot = { timestamp: new Date(now()).toISOString(), vehicles: [] };
    this.realtimeHealth = feedHealth();
    this.staticHealth = feedHealth();
    this.startedAt = new Date(now()).toISOString();
    this.started = false;
    this.realtimeTimer = null;
    this.staticTimer = null;
    this.estimateTimer = null;
    this.realtimeRefresh = null;
    this.staticRefresh = null;
    this.estimateRefresh = null;
    this.estimateQueued = false;
    this.regionalShapes = new Map();
    this.regionService = this.estimated && config.regions?.length
      ? new RegionalShapesService(config, this, { fetchImpl, now, logger })
      : null;
  }

  start() {
    if (this.started) return this.initialRefresh;
    this.logger.info?.(`Starting ${this.config.feedType} feed service`);
    this.started = true;
    this.regionService?.start();
    this.initialRefresh = this.refreshAll().finally(() => {
      if (!this.started) return;
      this.realtimeTimer = setInterval(() => void this.refreshRealtime(), this.config.refreshIntervalMs);
      if (!this.busradar && !this.transportRest) {
        this.staticTimer = setInterval(() => void this.refreshStatic(), this.config.staticRefreshIntervalMs);
      }
      if (this.estimated) {
        this.estimateTimer = setInterval(() => void this.refreshEstimate(), this.config.estimatedPositionRefreshIntervalMs);
        this.estimateTimer.unref();
      }
      this.realtimeTimer.unref();
      this.staticTimer?.unref();
    });
    return this.initialRefresh;
  }

  async refreshAll() {
    if (!this.busradar && !this.transportRest) await this.refreshStatic();
    await this.refreshRealtime();
  }

  refreshRealtime() {
    if (this.realtimeRefresh) return this.realtimeRefresh;
    this.realtimeRefresh = this.updateRealtime()
      .catch((error) => this.recordError("realtime", error))
      .finally(() => {
        this.realtimeRefresh = null;
      });
    return this.realtimeRefresh;
  }

  refreshStatic() {
    if (this.busradar || this.transportRest) return Promise.resolve(true);
    if (this.staticRefresh) return this.staticRefresh;
    this.staticRefresh = this.updateStatic()
      .catch((error) => this.recordError("static", error))
      .finally(() => {
        this.staticRefresh = null;
      });
    return this.staticRefresh;
  }

  refreshEstimate() {
    if (!this.estimated || !this.realtimeFeed || !this.staticHealth.lastSuccessAt) return Promise.resolve(false);
    if (this.estimateRefresh) {
      this.estimateQueued = true;
      return this.estimateRefresh;
    }
    this.estimateRefresh = this.updateEstimatedSnapshot()
      .catch((error) => {
        if (!this.abortController.signal.aborted) {
          this.logger.error?.(`Estimated position refresh failed: ${errorMessage(error)}`);
        }
        return false;
      })
      .finally(() => {
        this.estimateRefresh = null;
        if (this.estimateQueued && this.started) {
          this.estimateQueued = false;
          void this.refreshEstimate();
        }
      });
    return this.estimateRefresh;
  }

  async updateEstimatedSnapshot() {
    const startedAt = Date.now();
    this.snapshot = await estimateTripUpdatesAsync(this.realtimeFeed, this.staticFeed, {
      bbox: this.config.bbox,
      agencyIds: this.config.agencyIds,
      staleAfterSeconds: this.config.staleAfterSeconds,
      nowMs: this.now(),
      trackState: this.estimatedTracks,
      regionalShapes: this.regionalShapes,
    }, this.realtimeReceivedAt, { signal: this.abortController.signal });
    this.lastEstimateAt = new Date(this.now()).toISOString();
    this.lastEstimateDurationMs = Date.now() - startedAt;
    return true;
  }

  async updateRealtime() {
    this.realtimeHealth.lastAttemptAt = new Date(this.now()).toISOString();
    const url = this.busradar
      ? this.config.busRadarUrl
      : this.transportRest ? transportRestRadarUrl(this.config) : this.config.gtfsRtUrl;
    const accept = this.busradar
      ? "application/geo+json, application/json"
      : this.transportRest ? "application/json" : "application/x-protobuf";
    let buffer = this.realtimeBuffer;
    if (buffer) {
      this.realtimeBuffer = null;
    } else if (this.busradar || this.transportRest) {
      buffer = await fetchBuffer(this.fetchImpl, url, {
        accept,
        maxBytes: MAX_REALTIME_BYTES,
        signal: this.abortController.signal,
      });
    } else {
      const result = await fetchConditionalBuffer(this.fetchImpl, url, {
        accept,
        maxBytes: MAX_REALTIME_BYTES,
        signal: this.abortController.signal,
        etag: this.realtimeEtag,
        lastModified: this.realtimeLastModified,
      });
      if (result.notModified) {
        this.realtimeHealth.lastSuccessAt = new Date(this.now()).toISOString();
        this.realtimeHealth.lastError = null;
        return true;
      }
      this.realtimeEtag = result.etag;
      this.realtimeLastModified = result.lastModified;
      buffer = result.buffer;
    }
    const receivedAt = this.now();
    const options = {
      bbox: this.config.bbox,
      agencyIds: this.config.agencyIds,
      staleAfterSeconds: this.config.staleAfterSeconds,
      nowMs: receivedAt,
      trackState: this.estimatedTracks,
    };
    if (this.busradar || this.transportRest) {
      const feed = JSON.parse(buffer.toString("utf8"));
      this.snapshot = this.transportRest
        ? normalizeTransportRestFeed(feed, options, receivedAt, this.transportRestTracks)
        : normalizeBusradarFeed(feed, options, receivedAt, this.busRadarTracks);
    } else {
      const feed = FeedMessage.decode(buffer);
      this.realtimeFeed = feed;
      this.realtimeReceivedAt = receivedAt;
      if (this.estimated) {
        if (!this.lastEstimateAt) {
          await this.refreshEstimate();
        } else {
          void this.refreshEstimate();
        }
      } else {
        this.snapshot = normalizeFeed(feed, this.staticFeed, options, receivedAt);
      }
    }
    this.realtimeHealth.lastSuccessAt = new Date(this.now()).toISOString();
    this.realtimeHealth.lastError = null;
    this.logger.info?.(`${this.config.feedType} refresh completed with ${this.snapshot.vehicles.length} vehicles`);
    return true;
  }

  async updateStatic() {
    this.staticHealth.lastAttemptAt = new Date(this.now()).toISOString();
    this.logger.info?.(`Static GTFS refresh started for ${this.config.feedType}`);
    if (this.estimated) {
      this.realtimeBuffer = await fetchBuffer(this.fetchImpl, this.config.gtfsRtUrl, {
        accept: "application/x-protobuf",
        maxBytes: MAX_REALTIME_BYTES,
        signal: this.abortController.signal,
      });
      const realtimeFeed = FeedMessage.decode(this.realtimeBuffer);
      const tripIds = new Set(realtimeFeed.entity.map(entity => entity.tripUpdate?.trip?.tripId).filter(Boolean));
      const cachePath = this.config.staticCacheDir
        ? join(this.config.staticCacheDir,
          `${createHash("sha256").update(this.config.gtfsStaticUrl).digest("hex").slice(0, 16)}.zip`)
        : null;
      let download;
      try {
        download = await fetchStaticToFile(this.fetchImpl, this.config.gtfsStaticUrl, this.abortController.signal, cachePath);
      } catch (error) {
        if (cachePath && existsSync(cachePath)) {
          this.logger.error?.(`Static GTFS download failed, using cached archive: ${errorMessage(error)}`);
          download = { directory: null, path: cachePath, cached: true };
        } else {
          throw error;
        }
      }
      this.logger.info?.(`Static GTFS archive ${download.cached ? "reused from cache" : "downloaded"}`);
      try {
        this.staticFeed = await buildEstimatedStaticIndex(download.path, { bbox: this.config.bbox, tripIds });
        const stats = this.staticFeed.stats;
        this.logger.info?.(
          `Static GTFS index selected ${stats.selectedTrips} trips, ${stats.selectedStops} stops, ` +
          `${stats.selectedStopTimes} stop times, ${stats.selectedShapePoints} shape points`,
        );
      } finally {
        if (download.directory) await rm(download.directory, { recursive: true, force: true });
      }
    } else {
      const buffer = await fetchBuffer(this.fetchImpl, this.config.gtfsStaticUrl, {
        accept: "application/zip",
        maxBytes: MAX_STATIC_BYTES,
        signal: this.abortController.signal,
      });
      this.staticFeed = await parseStaticFeed(buffer);
    }
    this.realtimeBuffer = null;
    this.staticHealth.lastSuccessAt = new Date(this.now()).toISOString();
    this.staticHealth.lastError = null;
    const tripCount = this.staticFeed.trips?.size || 0;
    const stopCount = this.staticFeed.stops?.size || 0;
    this.logger.info?.(`Static GTFS refresh completed with ${tripCount} trips and ${stopCount} stops`);
    return true;
  }

  recordError(feed, error) {
    const health = feed === "realtime" ? this.realtimeHealth : this.staticHealth;
    health.lastErrorAt = new Date(this.now()).toISOString();
    health.lastError = errorMessage(error);
    const feedName = this.busradar ? "Busradar" : this.transportRest ? "transport.rest" : "GTFS";
    this.logger.error(`${feedName} ${feed} refresh failed: ${health.lastError}`);
    return false;
  }

  observeViewport(bbox, zoom) {
    this.regionService?.observeViewport(bbox, zoom);
  }

  getStaticIndex() {
    return this.staticFeed;
  }

  applyRegionalShapes(regionId, matches, { priority = 0 } = {}) {
    this.removeRegionalShapes(regionId, { refresh: false });
    const affected = new Set();
    for (const [tripId, match] of matches) {
      const existing = this.regionalShapes.get(tripId);
      if (existing && existing.priority > priority) continue;
      this.regionalShapes.set(tripId, { regionId, priority, ...match });
      affected.add(tripId);
    }
    this.invalidateRegionalShapes(affected, regionId);
    void this.refreshEstimate();
    return affected.size;
  }

  removeRegionalShapes(regionId, { refresh = true } = {}) {
    const affected = new Set();
    for (const [tripId, value] of this.regionalShapes) {
      if (value.regionId !== regionId) continue;
      this.regionalShapes.delete(tripId);
      affected.add(tripId);
    }
    this.invalidateRegionalShapes(affected, regionId);
    if (refresh) void this.refreshEstimate();
    return affected.size;
  }

  invalidateRegionalShapes(tripIds, regionId) {
    const prepared = this.staticFeed.preparedShapes;
    if (prepared) {
      const prefix = `region:${regionId}:`;
      for (const key of prepared.keys()) {
        if (key.startsWith(prefix)) prepared.delete(key);
      }
    }
    for (const key of this.estimatedTracks.keys()) {
      for (const tripId of tripIds) {
        if (key.startsWith(`${tripId}:`)) {
          this.estimatedTracks.delete(key);
          break;
        }
      }
    }
  }

  getSnapshot() {
    return this.snapshot;
  }

  getHealth() {
    const realtime = { ...this.realtimeHealth };
    const staticFeed = { ...this.staticHealth };
    const feedTimestampMs = this.realtimeFeed?.header?.timestamp
      ? Number(this.realtimeFeed.header.timestamp) * 1000
      : null;
    const staticReady = this.busradar || this.transportRest || (staticFeed.lastSuccessAt && !staticFeed.lastError);
    const ready = Boolean(realtime.lastSuccessAt && !realtime.lastError && staticReady);
    return {
      status: ready ? "ok" : "degraded",
      timestamp: new Date(this.now()).toISOString(),
      startedAt: this.startedAt,
      vehicles: this.snapshot.vehicles.length,
      realtime,
      static: staticFeed,
      ...(this.estimated ? {
        estimatedPositions: {
          lastAt: this.lastEstimateAt,
          durationMs: this.lastEstimateDurationMs,
          feedTimestamp: feedTimestampMs ? new Date(feedTimestampMs).toISOString() : null,
          feedAgeSeconds: feedTimestampMs ? Math.max(0, Math.round((this.now() - feedTimestampMs) / 1000)) : null,
        },
        ...(this.regionService ? { regions: this.regionService.getHealth() } : {}),
      } : {}),
    };
  }

  stop() {
    this.started = false;
    this.regionService?.stop();
    this.regionalShapes.clear();
    clearInterval(this.realtimeTimer);
    clearInterval(this.staticTimer);
    clearInterval(this.estimateTimer);
    this.realtimeTimer = null;
    this.staticTimer = null;
    this.estimateTimer = null;
    this.abortController.abort();
  }
}
