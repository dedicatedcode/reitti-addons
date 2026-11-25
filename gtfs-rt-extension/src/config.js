import { resolve } from "node:path";
import { loadRegions } from "./regions.js";

const DEFAULT_BBOX = "10.55,53.78,10.92,53.99";
const DEFAULT_BUS_RADAR_URL = "https://rest.busradar.conterra.de/prod/fahrzeuge";
const DEFAULT_TRANSPORT_REST_URL = "https://v6.vbb.transport.rest/radar";

function numberSetting(value, fallback, name, { integer = false, minimum = 0, maximum = Infinity } = {}) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < minimum || parsed > maximum) {
    const range = Number.isFinite(maximum) ? `between ${minimum} and ${maximum}` : `>= ${minimum}`;
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} ${range}`);
  }
  return parsed;
}

function httpUrl(value, name, required = true) {
  if (!value?.trim()) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return url.toString();
}

function publicBaseUrl(value) {
  const parsed = httpUrl(value, "PUBLIC_BASE_URL", false);
  if (!parsed) return null;
  const url = new URL(parsed);
  if (url.search || url.hash || url.username || url.password) {
    throw new Error("PUBLIC_BASE_URL must not contain credentials, a query, or a fragment");
  }
  return parsed.replace(/\/+$/, "");
}

function bbox(value) {
  const parts = (value?.trim() || DEFAULT_BBOX).split(",").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error("BBOX must contain west,south,east,north numbers");
  }
  const [west, south, east, north] = parts;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    throw new Error("BBOX must be a valid, non-empty west,south,east,north bounding box");
  }
  return Object.freeze(parts);
}

export function loadConfig(env = process.env) {
  const feedType = env.FEED_TYPE?.trim() || "gtfs-rt";
  if (!["germany", "gtfs-rt", "gtfs-rt-estimated", "busradar", "transport-rest"].includes(feedType)) {
    throw new Error("FEED_TYPE must be germany, gtfs-rt, gtfs-rt-estimated, busradar or transport-rest");
  }
  const unified = feedType === "germany";
  const busradar = feedType === "busradar" || unified;
  const transportRest = feedType === "transport-rest" || unified;
  const withoutStaticGtfs = !unified && (busradar || transportRest);
  const estimated = unified || feedType === "gtfs-rt-estimated";
  const regions = estimated ? loadRegions(env) : Object.freeze([]);
  const agencyIds = (env.AGENCY_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const staticRefreshDefault = unified || feedType === "gtfs-rt-estimated" ? 300_000 : 21_600_000;

  return Object.freeze({
    port: numberSetting(env.PORT, 8090, "PORT", { integer: true, minimum: 1, maximum: 65_535 }),
    publicBaseUrl: publicBaseUrl(env.PUBLIC_BASE_URL),
    feedType,
    gtfsRtUrl: withoutStaticGtfs ? null : httpUrl(env.GTFS_RT_URL, "GTFS_RT_URL"),
    gtfsStaticUrl: withoutStaticGtfs ? null : httpUrl(env.GTFS_STATIC_URL, "GTFS_STATIC_URL"),
    busRadarUrl: busradar
      ? httpUrl(env.BUS_RADAR_URL || DEFAULT_BUS_RADAR_URL, "BUS_RADAR_URL")
      : null,
    transportRestUrl: transportRest
      ? httpUrl(env.TRANSPORT_REST_URL || DEFAULT_TRANSPORT_REST_URL, "TRANSPORT_REST_URL")
      : null,
    transportRestResults: numberSetting(env.TRANSPORT_REST_RESULTS, 10_000, "TRANSPORT_REST_RESULTS", { integer: true, minimum: 1 }),
    bbox: bbox(env.BBOX),
    berlinBbox: bbox(env.BERLIN_BBOX || env.BBOX),
    munsterBbox: bbox(env.MUNSTER_BBOX || "7.45,51.80,7.80,52.15"),
    agencyIds: Object.freeze(agencyIds),
    staleAfterSeconds: numberSetting(env.STALE_AFTER_SECONDS, 180, "STALE_AFTER_SECONDS", { minimum: 1, maximum: 86_400 }),
    minZoom: numberSetting(env.MIN_ZOOM, 10, "MIN_ZOOM", { minimum: 0, maximum: 30 }),
    liveCityMinZoom: numberSetting(env.LIVE_CITY_MIN_ZOOM, 10, "LIVE_CITY_MIN_ZOOM", { minimum: 0, maximum: 30 }),
    liveCityIdleTimeoutMs: numberSetting(env.LIVE_CITY_IDLE_TIMEOUT_MS, 600_000, "LIVE_CITY_IDLE_TIMEOUT_MS", { integer: true, minimum: 1 }),
    refreshIntervalMs: numberSetting(env.REFRESH_INTERVAL_MS, 15_000, "REFRESH_INTERVAL_MS", { integer: true, minimum: 1 }),
    estimatedRefreshIntervalMs: numberSetting(env.ESTIMATED_REFRESH_INTERVAL_MS, 15_000, "ESTIMATED_REFRESH_INTERVAL_MS", { integer: true, minimum: 1 }),
    estimatedPositionRefreshIntervalMs: numberSetting(env.ESTIMATED_POSITION_REFRESH_INTERVAL_MS, 15_000, "ESTIMATED_POSITION_REFRESH_INTERVAL_MS", { integer: true, minimum: 1 }),
    staticRefreshIntervalMs: numberSetting(env.STATIC_REFRESH_INTERVAL_MS, staticRefreshDefault, "STATIC_REFRESH_INTERVAL_MS", { integer: true, minimum: 1 }),
    staticCacheDir: env.STATIC_CACHE_DIR?.trim() ? resolve(env.STATIC_CACHE_DIR.trim()) : null,
    regions,
    regionShapesMinZoom: numberSetting(env.REGION_SHAPES_MIN_ZOOM, 10, "REGION_SHAPES_MIN_ZOOM", { minimum: 0, maximum: 30 }),
    regionShapesIdleTimeoutMs: numberSetting(env.REGION_SHAPES_IDLE_TIMEOUT_MS, 600_000, "REGION_SHAPES_IDLE_TIMEOUT_MS", { integer: true, minimum: 1 }),
    regionShapesRefreshIntervalMs: numberSetting(env.REGION_SHAPES_REFRESH_INTERVAL_MS, 86_400_000, "REGION_SHAPES_REFRESH_INTERVAL_MS", { integer: true, minimum: 1 }),
    extensionApiKey: env.EXTENSION_API_KEY?.trim() || null,
  });
}
