import { InputError } from "../util.js";

const MAX_NAME = 200;

function normalizePosition(value, counts) {
  if (!Array.isArray(value) || value.length < 2) {
    counts.ignoredPoints++;
    return null;
  }
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    counts.ignoredPoints++;
    return null;
  }
  counts.points++;
  const position = [lon, lat];
  const altitude = Number(value[2]);
  if (value.length > 2 && Number.isFinite(altitude)) position.push(altitude);
  return position;
}

function unifyDimensions(positions) {
  return positions.every((position) => position.length === 3)
    ? positions
    : positions.map((position) => [position[0], position[1]]);
}

function normalizeLine(coordinates, counts) {
  if (!Array.isArray(coordinates)) return null;
  const line = coordinates.map((position) => normalizePosition(position, counts)).filter(Boolean);
  if (line.length < 2) return null;
  return unifyDimensions(line);
}

function normalizeRing(coordinates, counts) {
  if (!Array.isArray(coordinates)) return null;
  const ring = coordinates.map((position) => normalizePosition(position, counts)).filter(Boolean);
  if (ring.length < 3) return null;
  const normalized = unifyDimensions(ring);
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1] || (first.length === 3 && first[2] !== last[2])) {
    normalized.push([...first]);
  }
  return normalized.length >= 4 ? normalized : null;
}

function normalizePolygon(coordinates, counts) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
  const rings = coordinates.map((ring) => normalizeRing(ring, counts)).filter(Boolean);
  return rings.length > 0 ? rings : null;
}

export function computeBbox(coordinates) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value) => {
    if (!Array.isArray(value) || value.length === 0) return;
    if (typeof value[0] === "number") {
      const lon = Number(value[0]);
      const lat = Number(value[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
      return;
    }
    value.forEach(visit);
  };
  visit(coordinates);
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

export function bboxIntersects(a, b) {
  if (!a || !b) return true;
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function featureName(feature, inherited) {
  const value = feature?.properties?.name;
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_NAME);
  return inherited ? inherited.slice(0, MAX_NAME) : null;
}

export function normalizeGeoJson(root, { inheritedName = null } = {}) {
  const counts = { points: 0, ignoredPoints: 0, pathFeatures: 0, areaFeatures: 0 };
  const paths = [];
  const areas = [];

  const add = (target, geometry, name) => {
    const bbox = computeBbox(geometry.coordinates);
    if (!bbox) return;
    const properties = name ? { name } : {};
    target.push({ type: "Feature", properties, geometry, bbox });
  };

  const visitGeometry = (geometry, name) => {
    if (!geometry || typeof geometry !== "object") return;
    switch (geometry.type) {
      case "LineString": {
        const line = normalizeLine(geometry.coordinates, counts);
        if (line) {
          add(paths, { type: "LineString", coordinates: line }, name);
          counts.pathFeatures++;
        }
        break;
      }
      case "MultiLineString": {
        if (!Array.isArray(geometry.coordinates)) break;
        for (const line of geometry.coordinates) {
          const normalized = normalizeLine(line, counts);
          if (normalized) {
            add(paths, { type: "LineString", coordinates: normalized }, name);
            counts.pathFeatures++;
          }
        }
        break;
      }
      case "Polygon": {
        const polygon = normalizePolygon(geometry.coordinates, counts);
        if (polygon) {
          add(areas, { type: "Polygon", coordinates: polygon }, name);
          counts.areaFeatures++;
        }
        break;
      }
      case "MultiPolygon": {
        if (!Array.isArray(geometry.coordinates)) break;
        for (const polygon of geometry.coordinates) {
          const normalized = normalizePolygon(polygon, counts);
          if (normalized) {
            add(areas, { type: "Polygon", coordinates: normalized }, name);
            counts.areaFeatures++;
          }
        }
        break;
      }
      case "Point":
      case "MultiPoint":
        counts.ignoredPoints += geometry.type === "Point" ? 1 : Array.isArray(geometry.coordinates) ? geometry.coordinates.length : 0;
        break;
      case "GeometryCollection":
        if (Array.isArray(geometry.geometries)) {
          geometry.geometries.forEach((child) => visitGeometry(child, name));
        }
        break;
      default:
        break;
    }
  };

  const visitNode = (node, name) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "FeatureCollection") {
      if (!Array.isArray(node.features)) throw new InputError("GeoJSON FeatureCollection has no features array");
      node.features.forEach((feature) => visitNode(feature, name));
      return;
    }
    if (node.type === "Feature") {
      visitGeometry(node.geometry, featureName(node, name));
      return;
    }
    visitGeometry(node, name);
  };

  visitNode(root, inheritedName);

  if (paths.length === 0 && areas.length === 0) {
    throw new InputError("The file contains no usable line or polygon geometry");
  }

  return { paths, areas, stats: counts };
}

export function parseGeoJsonText(content) {
  if (typeof content !== "string" || !content.trim()) throw new InputError("The file is empty");
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InputError("The file is not valid JSON");
  }
  return normalizeGeoJson(parsed);
}

export function featureCollection(features) {
  return { type: "FeatureCollection", features };
}

export function areaOutlines(areaFeature) {
  const rings = areaFeature?.geometry?.coordinates;
  if (!Array.isArray(rings)) return [];
  return rings.map((ring) => ({
    type: "Feature",
    properties: { ...(areaFeature.properties || {}) },
    geometry: { type: "LineString", coordinates: ring },
    bbox: computeBbox(ring),
  }));
}

export function areasToOutlines(areas) {
  return areas.flatMap((area) => areaOutlines(area));
}
