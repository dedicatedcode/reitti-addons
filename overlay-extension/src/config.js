import { resolve } from "node:path";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PLACEMENTS = new Set(["behind-buildings", "above-buildings", "below-paths", "top"]);

function text(value, fallback) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function integer(value, fallback, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function number(value, fallback, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function id(value, name) {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${name} must match ${ID_PATTERN}`);
  }
  return value;
}

function hexColor(value, fallback, name) {
  const match = /^#?([\da-f]{6})$/i.exec((value || "").trim());
  if (!match) {
    if (value === undefined || String(value).trim() === "") return fallback;
    throw new Error(`${name} must be a hex colour like #d9a441`);
  }
  return `#${match[1].toLowerCase()}`;
}

function httpUrl(value, name) {
  if (value === undefined || value.trim() === "") return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} must not contain credentials, a query, or a fragment`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function timezone(value, fallback) {
  const candidate = text(value, fallback);
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format(new Date());
  } catch {
    throw new Error(`DEFAULT_TIMEZONE is not a valid IANA time zone: ${candidate}`);
  }
  return candidate;
}

function origins(value, fallback) {
  return String(value || fallback)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try {
        const url = new URL(part);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
        return url.origin;
      } catch {
        throw new Error(`MAP_TILE_ORIGINS contains an invalid origin: ${part}`);
      }
    });
}

export function loadConfig(env = process.env) {
  const placement = text(env.PLACEMENT, "below-paths");
  if (!PLACEMENTS.has(placement)) {
    throw new Error(`PLACEMENT must be one of ${[...PLACEMENTS].join(", ")}`);
  }

  return Object.freeze({
    port: integer(env.PORT, 8090, "PORT", { minimum: 1, maximum: 65535 }),
    host: text(env.HOST, "0.0.0.0"),
    dataDir: resolve(text(env.DATA_DIR, "./data")),
    publicBaseUrl: httpUrl(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL"),
    extensionId: id(text(env.EXTENSION_ID, "reitti-overlays"), "EXTENSION_ID"),
    extensionName: text(env.EXTENSION_NAME, "Reitti Overlays").slice(0, 256),
    layerId: id(text(env.LAYER_ID, "overlays"), "LAYER_ID"),
    layerName: text(env.LAYER_NAME, "Overlays").slice(0, 256),
    layerDescription: text(
      env.LAYER_DESCRIPTION,
      "Time-windowed GPX and GeoJSON overlays managed by the Reitti Overlay extension.",
    ).slice(0, 1000),
    defaultTimezone: timezone(env.DEFAULT_TIMEZONE, "UTC"),
    pollIntervalMs: integer(env.POLL_INTERVAL_MS, 15000, "POLL_INTERVAL_MS", {
      minimum: 1000,
      maximum: 86_400_000,
    }),
    minZoom: integer(env.MIN_ZOOM, 0, "MIN_ZOOM", { minimum: 0, maximum: 30 }),
    zIndex: integer(env.Z_INDEX, 0, "Z_INDEX", { minimum: -10000, maximum: 10000 }),
    placement,
    lineColor: hexColor(env.LINE_COLOR, "#d9a441", "LINE_COLOR"),
    lineWidth: number(env.LINE_WIDTH, 3, "LINE_WIDTH", { minimum: 0, maximum: 64 }),
    mapStyleUrl: text(
      env.MAP_STYLE_URL,
      "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    ),
    mapTileOrigins: origins(
      env.MAP_TILE_ORIGINS,
      "https://tiles.basemaps.cartocdn.com",
    ),
    maxUploadBytes: integer(env.MAX_UPLOAD_BYTES, 20 * 1024 * 1024, "MAX_UPLOAD_BYTES", {
      minimum: 1024,
    }),
    maxResponseBytes: integer(env.MAX_RESPONSE_BYTES, 5 * 1024 * 1024, "MAX_RESPONSE_BYTES", {
      minimum: 1024,
    }),
    logLevel: text(env.LOG_LEVEL, "info").toLowerCase(),
  });
}
