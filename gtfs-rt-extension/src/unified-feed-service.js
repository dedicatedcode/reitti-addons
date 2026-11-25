import { FeedService } from "./feed-service.js";

function inside(vehicle, bbox) {
  const [west, south, east, north] = bbox;
  return vehicle.lon >= west && vehicle.lon <= east && vehicle.lat >= south && vehicle.lat <= north;
}

function intersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export class UnifiedFeedService {
  constructor(config, options = {}, serviceFactory = (childConfig, childOptions) => new FeedService(childConfig, childOptions)) {
    this.config = config;
    this.logger = options.logger || console;
    this.options = options;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.serviceFactory = serviceFactory;
    this.started = false;
    this.initialRefresh = null;
    this.liveIdleTimer = null;
    this.liveServices = new Map();
    this.liveLastDemand = new Map();
    this.estimated = serviceFactory({
      ...config,
      feedType: "gtfs-rt-estimated",
      refreshIntervalMs: config.estimatedRefreshIntervalMs,
    }, options);
    this.liveDefinitions = {
      berlin: {
        bbox: config.berlinBbox,
        config: { ...config, feedType: "transport-rest", bbox: config.berlinBbox },
      },
      muenster: {
        bbox: config.munsterBbox,
        config: { ...config, feedType: "busradar", bbox: config.munsterBbox },
      },
    };
  }

  start() {
    if (this.started) return this.initialRefresh;
    this.started = true;
    this.logger.info?.("Starting unified Germany transit extension (GTFS.de estimates; live city feeds are demand-driven)");
    this.initialRefresh = (async () => {
      const result = await this.estimated.start();
      if (!this.started) return result;
      const checkInterval = Math.min(60_000, Math.max(1_000, this.config.liveCityIdleTimeoutMs));
      this.liveIdleTimer = setInterval(() => this.deactivateIdleLiveServices(), checkInterval);
      this.liveIdleTimer.unref();
      const merged = this.mergedSnapshot();
      this.logger.info?.(
        `Unified estimated feed ready with ${merged.estimatedTotal} vehicles; ` +
        `live city feeds idle until their viewport is requested`,
      );
      return result;
    })();
    return this.initialRefresh;
  }

  refreshAll() {
    return Promise.all([
      this.estimated.refreshAll(),
      ...Array.from(this.liveServices.values(), service => service.refreshAll()),
    ]);
  }

  stop() {
    this.started = false;
    clearInterval(this.liveIdleTimer);
    this.liveIdleTimer = null;
    this.estimated.stop();
    for (const service of this.liveServices.values()) service.stop();
    this.liveServices.clear();
    this.liveLastDemand.clear();
  }

  observeViewport(bbox, zoom) {
    this.estimated.observeViewport?.(bbox, zoom);
    if (bbox !== null && zoom !== null && zoom < this.config.liveCityMinZoom) return;
    for (const [name, definition] of Object.entries(this.liveDefinitions)) {
      if (bbox === null || intersects(bbox, definition.bbox)) {
        this.ensureLiveService(name);
        this.liveLastDemand.set(name, this.now());
      }
    }
  }

  ensureLiveService(name) {
    if (this.liveServices.has(name)) return this.liveServices.get(name);
    const definition = this.liveDefinitions[name];
    if (!definition) return null;
    const service = this.serviceFactory(definition.config, this.options);
    this.liveServices.set(name, service);
    this.logger.info?.(`Live ${name} feed activated by viewport demand`);
    void Promise.resolve(service.start()).catch((error) => {
      this.logger.error?.(`Live ${name} feed failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
    return service;
  }

  deactivateIdleLiveServices() {
    const now = this.now();
    for (const [name, service] of this.liveServices) {
      const lastDemand = this.liveLastDemand.get(name) ?? 0;
      if (now - lastDemand < this.config.liveCityIdleTimeoutMs) continue;
      this.logger.info?.(`Live ${name} feed stopped after ${this.config.liveCityIdleTimeoutMs} ms without demand`);
      service.stop();
      this.liveServices.delete(name);
      this.liveLastDemand.delete(name);
    }
  }

  liveServiceReady(service) {
    const health = service.getHealth?.();
    if (health?.realtime) return Boolean(health.realtime.lastSuccessAt);
    return Boolean(service.getSnapshot?.().vehicles?.length);
  }

  mergedSnapshot() {
    const estimatedSnapshot = this.estimated.getSnapshot();
    const liveSnapshots = new Map();
    const activeReadyBboxes = [];
    for (const [name, service] of this.liveServices) {
      const snapshot = service.getSnapshot();
      liveSnapshots.set(name, snapshot);
      if (this.liveServiceReady(service)) {
        activeReadyBboxes.push(this.liveDefinitions[name].bbox);
      }
    }
    const estimated = estimatedSnapshot.vehicles
      .filter(vehicle => !activeReadyBboxes.some(bbox => inside(vehicle, bbox)));
    const liveVehicles = Array.from(liveSnapshots.values(), snapshot => snapshot.vehicles).flat();
    const timestamps = [estimatedSnapshot.timestamp, ...Array.from(liveSnapshots.values(), snapshot => snapshot.timestamp)].sort();
    return {
      timestamp: timestamps.at(-1) || new Date(this.now()).toISOString(),
      vehicles: [...estimated, ...liveVehicles],
      estimatedTotal: estimatedSnapshot.vehicles.length,
      estimatedOutsideLive: estimated.length,
      estimatedFiltered: estimatedSnapshot.vehicles.length - estimated.length,
      berlinCount: liveSnapshots.get("berlin")?.vehicles.length ?? 0,
      muensterCount: liveSnapshots.get("muenster")?.vehicles.length ?? 0,
    };
  }

  getSnapshot() {
    const merged = this.mergedSnapshot();
    return {
      timestamp: merged.timestamp,
      vehicles: merged.vehicles,
    };
  }

  getHealth() {
    const merged = this.mergedSnapshot();
    const estimatedHealth = this.estimated.getHealth();
    const sources = {
      estimated: { ...estimatedHealth, active: true },
    };
    const activeHealths = [sources.estimated];
    for (const name of Object.keys(this.liveDefinitions)) {
      if (!this.liveServices.has(name)) {
        sources[name] = { status: "idle", active: false, timestamp: null, vehicles: 0 };
        continue;
      }
      sources[name] = { ...this.liveServices.get(name).getHealth(), active: true };
      activeHealths.push(sources[name]);
    }
    const timestamps = activeHealths
      .map(source => Date.parse(source.timestamp))
      .filter(Number.isFinite);
    return {
      status: activeHealths.every(source => source.status === "ok") ? "ok" : "degraded",
      timestamp: new Date(timestamps.length ? Math.max(...timestamps) : this.now()).toISOString(),
      vehicles: merged.vehicles.length,
      estimated: {
        total: merged.estimatedTotal,
        outsideLiveCityBoxes: merged.estimatedOutsideLive,
        filteredInsideLiveCityBoxes: merged.estimatedFiltered,
      },
      ...(estimatedHealth.regions ? { regions: estimatedHealth.regions } : {}),
      sources,
    };
  }
}
