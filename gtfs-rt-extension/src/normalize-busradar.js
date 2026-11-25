import { colorForLine } from "./colors.js";

const EARTH_RADIUS_METERS = 6_371_000;
const MIN_MOVEMENT_METERS = 2;

function text(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validSeconds(value) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(new Date(value * 1000).getTime())) {
    return null;
  }
  return value;
}

function radians(degrees) {
  return degrees * Math.PI / 180;
}

function distanceMeters(from, to) {
  const fromLat = radians(from.lat);
  const toLat = radians(to.lat);
  const latDelta = toLat - fromLat;
  const lonDelta = radians(to.lon - from.lon);
  const a = Math.sin(latDelta / 2) ** 2
    + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(lonDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

function bearingDegrees(from, to) {
  const fromLat = radians(from.lat);
  const toLat = radians(to.lat);
  const lonDelta = radians(to.lon - from.lon);
  const y = Math.sin(lonDelta) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat)
    - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(lonDelta);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function normalizeBusradarFeed(feed, options, receivedAtMs, trackState = new Map()) {
  if (feed?.type !== "FeatureCollection" || !Array.isArray(feed.features)) {
    throw new Error("Busradar response must be a GeoJSON FeatureCollection");
  }

  const receivedTimestamp = Math.floor(receivedAtMs / 1000);
  const staleBeforeMs = options.nowMs - options.staleAfterSeconds * 1000;
  const [west, south, east, north] = options.bbox;
  const candidates = new Map();

  for (const feature of feed.features) {
    const properties = feature?.properties;
    const coordinates = feature?.geometry?.coordinates;
    if (!properties || feature.geometry?.type !== "Point" || !Array.isArray(coordinates)) continue;

    const lon = finiteNumber(coordinates[0]);
    const lat = finiteNumber(coordinates[1]);
    if (lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
    if (lon < west || lon > east || lat < south || lat > north) continue;

    const vehicleId = text(properties.fahrzeugid);
    if (!vehicleId) continue;
    const timestamp = validSeconds(properties.visfahrplanlagezst) ?? receivedTimestamp;
    if (timestamp * 1000 < staleBeforeMs) continue;

    const existing = candidates.get(vehicleId);
    if (existing && existing.timestamp > timestamp) continue;

    const routeId = text(properties.linienid);
    const previous = trackState.get(vehicleId);
    const position = { lon, lat };
    const bearing = previous && distanceMeters(previous, position) >= MIN_MOVEMENT_METERS
      ? bearingDegrees(previous, position)
      : finiteNumber(previous?.bearing) ?? 0;

    candidates.set(vehicleId, {
      timestamp,
      vehicle: {
        vehicleId,
        tripId: text(properties.fahrtbezeichner),
        routeId,
        line: text(properties.linientext) || routeId || "",
        lineColor: colorForLine(text(properties.linientext) || routeId || ""),
        labelColor: colorForLine(text(properties.linientext) || routeId || ""),
        headsign: text(properties.richtungstext) || "",
        lon,
        lat,
        bearing,
        speedKmh: null,
        updatedAt: new Date(timestamp * 1000).toISOString(),
        positionSource: "live",
        displayText: text(properties.linientext) || routeId || "",
        vehicleType: "bus",
        model: "bus",
        ...(previous ? {
          previousLon: previous.lon,
          previousLat: previous.lat,
          ...(Number.isFinite(previous.bearing) ? { previousBearing: previous.bearing } : {}),
          ...(Number.isFinite(previous.timeMs) ? { previousUpdatedAt: new Date(previous.timeMs).toISOString() } : {}),
        } : {}),
      },
    });
  }

  const vehicles = [];
  const currentTracks = new Map();
  for (const { vehicle } of candidates.values()) {
    vehicles.push(vehicle);
    currentTracks.set(vehicle.vehicleId, {
      lon: vehicle.lon,
      lat: vehicle.lat,
      bearing: vehicle.bearing,
      timeMs: Date.parse(vehicle.updatedAt),
    });
  }
  trackState.clear();
  for (const [vehicleId, track] of currentTracks) trackState.set(vehicleId, track);

  return {
    timestamp: new Date(receivedAtMs).toISOString(),
    vehicles,
  };
}
