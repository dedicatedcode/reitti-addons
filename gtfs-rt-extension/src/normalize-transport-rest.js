import { colorForLine } from "./colors.js";
import { delayText, vehicleModel } from "./vehicle-model.js";

const EARTH_RADIUS_METERS = 6_371_000;
const MIN_MOVEMENT_METERS = 2;
const SUPPORTED_VEHICLE_TYPES = new Set(["bus", "train", "tram", "ferry"]);

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

function vehicleType(line) {
  const mode = text(line?.mode)?.toLowerCase();
  if (mode === "subway" || mode === "metro") return "tram";
  return SUPPORTED_VEHICLE_TYPES.has(mode) ? mode : "other";
}

function nextStopoverFields(stopover) {
  return {
    nextStopName: text(stopover?.stop?.name),
    nextStopId: text(stopover?.stop?.id),
    nextArrival: text(stopover?.arrival) || text(stopover?.departure) || text(stopover?.when),
    delaySeconds: finiteNumber(stopover?.arrivalDelay) ?? finiteNumber(stopover?.departureDelay),
  };
}

export function normalizeTransportRestFeed(feed, options, receivedAtMs, trackState = new Map()) {
  if (!Array.isArray(feed?.movements)) {
    throw new Error("transport.rest response must contain a movements array");
  }

  const feedTimestamp = validSeconds(feed.realtimeDataUpdatedAt);
  const updatedAtMs = feedTimestamp === null ? receivedAtMs : feedTimestamp * 1000;
  const staleBeforeMs = options.nowMs - options.staleAfterSeconds * 1000;
  const [west, south, east, north] = options.bbox;
  const candidates = new Map();

  if (updatedAtMs >= staleBeforeMs) {
    for (const movement of feed.movements) {
      const tripId = text(movement?.tripId);
      const lon = finiteNumber(movement?.location?.longitude);
      const lat = finiteNumber(movement?.location?.latitude);
      if (!tripId || lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
      if (lon < west || lon > east || lat < south || lat > north) continue;

      const line = text(movement.line?.name) || "";
      const lineColor = colorForLine(line, movement.line?.color?.bg);
      const stopFields = nextStopoverFields(movement.nextStopovers?.[0]);
      const previous = trackState.get(tripId);
      candidates.set(tripId, {
        vehicleId: tripId,
        tripId,
        routeId: text(movement.line?.id),
        line,
        lineColor,
        labelColor: lineColor,
        headsign: text(movement.direction) || "",
        lon,
        lat,
        bearing: 0,
        speedKmh: null,
        updatedAt: new Date(updatedAtMs).toISOString(),
        positionSource: "live",
        displayText: line,
        vehicleType: vehicleType(movement.line),
        model: vehicleModel(null, line, movement.line?.mode),
        ...(previous ? {
          previousLon: previous.lon,
          previousLat: previous.lat,
          ...(Number.isFinite(previous.bearing) ? { previousBearing: previous.bearing } : {}),
          ...(Number.isFinite(previous.timeMs) ? { previousUpdatedAt: new Date(previous.timeMs).toISOString() } : {}),
        } : {}),
        ...stopFields,
        delayText: Number.isFinite(stopFields.delaySeconds) ? delayText(stopFields.delaySeconds) : null,
        operator: text(movement.line?.operator?.name),
      });
    }
  }

  const vehicles = [];
  const currentTracks = new Map();
  for (const vehicle of candidates.values()) {
    const previous = trackState.get(vehicle.vehicleId);
    const position = { lon: vehicle.lon, lat: vehicle.lat };
    vehicle.bearing = previous && distanceMeters(previous, position) >= MIN_MOVEMENT_METERS
      ? bearingDegrees(previous, position)
      : finiteNumber(previous?.bearing) ?? 0;
    vehicles.push(vehicle);
    currentTracks.set(vehicle.vehicleId, { ...position, bearing: vehicle.bearing, timeMs: updatedAtMs });
  }
  trackState.clear();
  for (const [vehicleId, track] of currentTracks) trackState.set(vehicleId, track);

  return {
    timestamp: new Date(receivedAtMs).toISOString(),
    vehicles,
  };
}
