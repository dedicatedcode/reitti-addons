import { XMLParser } from "fast-xml-parser";
import { InputError } from "../util.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ["trk", "trkseg", "trkpt", "rte", "rtept", "wpt"].includes(name),
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object" && typeof value["#text"] === "string") return value["#text"].trim();
  return null;
}

function pointOf(value) {
  if (!value || typeof value !== "object") return null;
  const lon = Number(value["@_lon"]);
  const lat = Number(value["@_lat"]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null;
  }
  const position = [lon, lat];
  const elevationText = textOf(value.ele);
  const elevation = elevationText == null || elevationText === "" ? Number.NaN : Number(elevationText);
  if (Number.isFinite(elevation)) position.push(elevation);
  return position;
}

function segmentOf(points) {
  const line = asArray(points).map(pointOf).filter(Boolean);
  return line.length >= 2 ? line : null;
}

export function parseGpxText(content) {
  if (typeof content !== "string" || !content.trim()) throw new InputError("The file is empty");
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) {
    throw new InputError("GPX files with DOCTYPE or ENTITY declarations are not accepted");
  }

  let parsed;
  try {
    parsed = parser.parse(content);
  } catch {
    throw new InputError("The file is not valid XML");
  }
  const gpx = parsed?.gpx;
  if (gpx == null || (typeof gpx !== "object" && typeof gpx !== "string")) {
    throw new InputError("The file is not a GPX document");
  }
  const document = typeof gpx === "object" ? gpx : {};

  const features = [];

  for (const track of asArray(document.trk)) {
    const name = textOf(track.name)?.slice(0, 200) || null;
    for (const segment of asArray(track.trkseg)) {
      const line = segmentOf(segment.trkpt);
      if (!line) continue;
      features.push({
        type: "Feature",
        properties: name ? { name } : {},
        geometry: { type: "LineString", coordinates: line },
      });
    }
  }

  for (const route of asArray(document.rte)) {
    const name = textOf(route.name)?.slice(0, 200) || null;
    const line = segmentOf(route.rtept);
    if (!line) continue;
    features.push({
      type: "Feature",
      properties: name ? { name } : {},
      geometry: { type: "LineString", coordinates: line },
    });
  }

  if (features.length === 0) {
    throw new InputError("The GPX file contains no track or route with at least two points");
  }

  return { type: "FeatureCollection", features };
}
