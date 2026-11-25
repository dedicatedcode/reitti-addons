import { InputError, hexToRgba, parseHexColor, slugify } from "../util.js";
import { areasToOutlines, bboxIntersects, featureCollection, normalizeGeoJson, parseGeoJsonText } from "./geometry.js";
import { parseGpxText } from "./gpx.js";
import { describeValidity, isActive, normalizeValidity, zonedNow } from "./validity.js";

const DEFAULT_STYLE = { color: "#d9a441", lineWidth: 3, lineAlpha: 220 };

export function inferFormat(filename, explicit) {
  const format = String(explicit || "").trim().toLowerCase();
  if (format === "gpx" || format === "geojson" || format === "json") {
    return format === "json" ? "geojson" : format;
  }
  const extension = String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === "gpx") return "gpx";
  if (extension === "geojson" || extension === "json") return "geojson";
  throw new InputError("Could not determine the file format; upload a .gpx, .geojson, or .json file");
}

export function normalizeStyle(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const width = Number(source.lineWidth ?? DEFAULT_STYLE.lineWidth);
  if (!Number.isFinite(width) || width < 1 || width > 20) {
    throw new InputError("style.lineWidth must be between 1 and 20");
  }
  const alpha = Number(source.lineAlpha ?? DEFAULT_STYLE.lineAlpha);
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 255) {
    throw new InputError("style.lineAlpha must be between 0 and 255");
  }
  return {
    color: parseHexColor(source.color, DEFAULT_STYLE.color),
    lineWidth: Math.round(width * 2) / 2,
    lineAlpha: Math.round(alpha),
  };
}

export function parseOverlayContent({ filename, format, content }) {
  const resolvedFormat = inferFormat(filename, format);
  const normalized =
    resolvedFormat === "gpx"
      ? normalizeGeoJson(parseGpxText(content))
      : parseGeoJsonText(content);
  return { format: resolvedFormat, ...normalized };
}

export function unionBbox(features) {
  let bbox = null;
  for (const feature of features) {
    if (!feature.bbox) continue;
    if (!bbox) bbox = [...feature.bbox];
    else {
      bbox[0] = Math.min(bbox[0], feature.bbox[0]);
      bbox[1] = Math.min(bbox[1], feature.bbox[1]);
      bbox[2] = Math.max(bbox[2], feature.bbox[2]);
      bbox[3] = Math.max(bbox[3], feature.bbox[3]);
    }
  }
  return bbox;
}
function sizeOf(geometry) {
  return Buffer.byteLength(JSON.stringify(geometry));
}

function defaultName(filename, normalized) {
  const first = normalized.paths[0] || normalized.areas[0];
  const featureName = first?.properties?.name;
  if (featureName) return featureName;
  const stem = String(filename || "").replace(/\.[^.]+$/, "").trim();
  return stem || "Overlay";
}

export function buildOverlay(input, config) {
  const parsed = parseOverlayContent(input);
  const name = String(input.name || "").trim() || defaultName(input.filename, parsed);
  if (name.length > 200) throw new InputError("Overlay name is too long (max 200)");
  const geometry = { paths: parsed.paths, areas: parsed.areas };
  return {
    version: 1,
    name,
    enabled: input.enabled !== false,
    source: {
      filename: input.filename ? String(input.filename).slice(0, 255) : null,
      format: parsed.format,
    },
    style: normalizeStyle(input.style || {}),
    validity: normalizeValidity(input.validity, input.timezone || config.defaultTimezone),
    geometry,
    stats: {
      ...parsed.stats,
      bytes: sizeOf(geometry),
      bbox: unionBbox([...parsed.paths, ...parsed.areas]),
    },
    outlines: areasToOutlines(parsed.areas),
  };
}

export function hydrateOverlay(raw, config) {
  if (!raw || typeof raw !== "object") throw new InputError("Overlay file is not an object");
  if (!raw.id || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(raw.id)) {
    throw new InputError("Overlay file has an invalid id");
  }
  if (!raw.name || typeof raw.name !== "string") throw new InputError("Overlay file has no name");
  if (!raw.geometry || !Array.isArray(raw.geometry.paths) || !Array.isArray(raw.geometry.areas)) {
    throw new InputError("Overlay file has no geometry");
  }
  const geometry = { paths: raw.geometry.paths, areas: raw.geometry.areas };
  return {
    version: 1,
    id: raw.id,
    name: raw.name.slice(0, 200),
    enabled: raw.enabled !== false,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
    source: {
      filename: raw.source?.filename || null,
      format: raw.source?.format === "gpx" ? "gpx" : "geojson",
    },
    style: normalizeStyle(raw.style || {}),
    validity: normalizeValidity(raw.validity, config.defaultTimezone),
    geometry,
    stats: {
      points: Number(raw.stats?.points) || 0,
      ignoredPoints: Number(raw.stats?.ignoredPoints) || 0,
      pathFeatures: geometry.paths.length,
      areaFeatures: geometry.areas.length,
      bytes: sizeOf(geometry),
      bbox: unionBbox([...geometry.paths, ...geometry.areas]),
    },
    outlines: areasToOutlines(geometry.areas),
  };
}

export function serializeOverlay(overlay) {
  return {
    version: 1,
    id: overlay.id,
    name: overlay.name,
    enabled: overlay.enabled,
    createdAt: overlay.createdAt,
    updatedAt: overlay.updatedAt,
    source: overlay.source,
    style: overlay.style,
    validity: overlay.validity,
    geometry: overlay.geometry,
    stats: overlay.stats,
  };
}

export function newOverlayId(name, existingIds) {
  const base = slugify(name, "overlay");
  if (!existingIds.has(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base.slice(0, 44)}-${index}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${base.slice(0, 40)}-${Date.now().toString(36)}`;
}

export function publicFeature(feature, overlay) {
  return {
    type: "Feature",
    properties: {
      ...(feature.properties?.name ? { name: feature.properties.name } : {}),
      lineColor: hexToRgba(overlay.style.color, overlay.style.lineAlpha),
      lineWidth: overlay.style.lineWidth,
    },
    geometry: feature.geometry,
  };
}

export function overlayFeatures(overlay, bbox) {
  const features = [];
  for (const path of overlay.geometry.paths) {
    if (bboxIntersects(path.bbox, bbox)) features.push(publicFeature(path, overlay));
  }
  for (const outline of overlay.outlines) {
    if (bboxIntersects(outline.bbox, bbox)) features.push(publicFeature(outline, overlay));
  }
  return features;
}

export function exportFeatureCollection(overlay) {
  const features = [];
  for (const path of overlay.geometry.paths) {
    features.push({
      type: "Feature",
      properties: {
        ...(path.properties?.name ? { name: path.properties.name } : {}),
        lineColor: overlay.style.color,
        lineWidth: overlay.style.lineWidth,
      },
      geometry: path.geometry,
    });
  }
  for (const area of overlay.geometry.areas) {
    features.push({
      type: "Feature",
      properties: {
        ...(area.properties?.name ? { name: area.properties.name } : {}),
        lineColor: overlay.style.color,
        fillColor: hexToRgba(overlay.style.color, 70),
        lineWidth: overlay.style.lineWidth,
      },
      geometry: area.geometry,
    });
  }
  return featureCollection(features);
}

export function summary(overlay, { date = null, now = new Date(), maxResponseBytes = Infinity } = {}) {
  const localNow = zonedNow(overlay.validity.timezone, now);
  const active = isActive(overlay.validity, { now: localNow, date });
  return {
    id: overlay.id,
    name: overlay.name,
    enabled: overlay.enabled,
    createdAt: overlay.createdAt,
    updatedAt: overlay.updatedAt,
    source: overlay.source,
    style: overlay.style,
    validity: overlay.validity,
    validityText: describeValidity(overlay.validity),
    activeNow: active,
    stats: overlay.stats,
    tooLarge: overlay.stats.bytes > maxResponseBytes,
  };
}
