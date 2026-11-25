import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REGION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_REGION_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "nahsh",
    name: "Schleswig-Holstein / Hamburg",
    bbox: Object.freeze([7.8, 53.3, 11.4, 55.1]),
    staticUrl: "https://opendata.schleswig-holstein.de/dataset/5e0652d8-7f59-42fc-92ab-a6358f800e1d/resource/f0eff75f-88de-411c-8bdc-0a55bb67d9fd/download/fahrplandaten",
    minZoom: 10,
    priority: 10,
  }),
]);

function normalizedBbox(value, id) {
  const parts = Array.isArray(value)
    ? value
    : String(value || "").split(",").map((part) => part.trim());
  if (parts.length !== 4) throw new Error(`Region ${id}: bbox must contain west,south,east,north`);
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part))) {
    throw new Error(`Region ${id}: bbox must contain finite numbers`);
  }
  const [west, south, east, north] = numbers;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    throw new Error(`Region ${id}: bbox is outside the allowed range`);
  }
  return Object.freeze(numbers);
}

function normalizedUrl(value, id) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error(`Region ${id}: staticUrl must be a valid URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Region ${id}: staticUrl must use HTTP or HTTPS`);
  }
  return url.toString();
}

function normalizedNumber(value, fallback, name, id, { integer = false, minimum = 0, maximum = Infinity } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || parsed < minimum || parsed > maximum) {
    throw new Error(`Region ${id}: ${name} is outside the allowed range`);
  }
  return parsed;
}

function normalizeRegion(definition, index) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error(`Region ${index + 1} must be an object`);
  }
  const id = String(definition.id || "").trim();
  if (!REGION_ID.test(id)) {
    throw new Error(`Region ${index + 1}: id contains invalid characters`);
  }
  const name = String(definition.name || id).trim();
  if (!name) throw new Error(`Region ${id}: name must not be empty`);
  const bbox = normalizedBbox(definition.bbox, id);
  const enabled = definition.enabled !== false;
  if (!enabled) return null;
  const staticUrl = normalizedUrl(definition.staticUrl, id);
  const minZoom = normalizedNumber(definition.minZoom, null, "minZoom", id, {
    integer: true,
    minimum: 0,
    maximum: 30,
  });
  const priority = normalizedNumber(definition.priority, 0, "priority", id);
  const maxStopDistanceMeters = normalizedNumber(
    definition.maxStopDistanceMeters,
    150,
    "maxStopDistanceMeters",
    id,
    { minimum: 1, maximum: 5000 },
  );
  const minCoverage = normalizedNumber(definition.minCoverage, 0.7, "minCoverage", id, {
    minimum: 0,
    maximum: 1,
  });
  const minSimilarity = normalizedNumber(definition.minSimilarity, 0.6, "minSimilarity", id, {
    minimum: 0,
    maximum: 1,
  });
  const cacheFile = definition.cacheFile
    ? String(definition.cacheFile).trim()
    : `${id}.zip`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cacheFile)) {
    throw new Error(`Region ${id}: cacheFile contains invalid characters`);
  }
  return Object.freeze({
    id,
    name,
    bbox,
    staticUrl,
    minZoom,
    priority,
    maxStopDistanceMeters,
    minCoverage,
    minSimilarity,
    cacheFile,
    enabled: true,
  });
}

function normalizeRegions(value, source) {
  const definitions = Array.isArray(value) ? value : value?.regions;
  if (!Array.isArray(definitions)) {
    throw new Error(`${source} must contain a regions array`);
  }
  const ids = new Set();
  const regions = [];
  definitions.forEach((definition, index) => {
    const region = normalizeRegion(definition, index);
    if (!region) return;
    if (ids.has(region.id)) throw new Error(`Region ${region.id} is defined more than once`);
    ids.add(region.id);
    regions.push(region);
  });
  return Object.freeze(regions);
}

function readRegionFile(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read regions file ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Regions file ${path} is not valid JSON: ${error.message}`);
  }
}

export function loadRegions(env = process.env, { cwd = process.cwd() } = {}) {
  const configuredFile = env.REGIONS_FILE?.trim();
  if (configuredFile) {
    const path = resolve(cwd, configuredFile);
    if (!existsSync(path)) throw new Error(`REGIONS_FILE not found: ${path}`);
    return normalizeRegions(readRegionFile(path), path);
  }

  const defaultFile = resolve(cwd, "regions.json");
  if (existsSync(defaultFile)) {
    return normalizeRegions(readRegionFile(defaultFile), defaultFile);
  }
  return normalizeRegions(DEFAULT_REGION_DEFINITIONS, "built-in region defaults");
}
