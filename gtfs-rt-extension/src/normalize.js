import { colorForLine } from "./colors.js";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validSeconds(value) {
  let number = value;
  if (value && typeof value === "object" && typeof value.toNumber === "function") {
    number = value.toNumber();
  }
  if (!Number.isFinite(number) || number <= 0 || !Number.isFinite(new Date(number * 1000).getTime())) {
    return null;
  }
  return number;
}

function isoTimestamp(seconds) {
  return new Date(seconds * 1000).toISOString();
}

export function normalizeFeed(feed, staticFeed, options, receivedAtMs) {
  const feedTimestamp = validSeconds(feed.header?.timestamp);
  const receivedTimestamp = Math.floor(receivedAtMs / 1000);
  const staleBeforeMs = options.nowMs - options.staleAfterSeconds * 1000;
  const agencies = new Set(options.agencyIds);
  const [west, south, east, north] = options.bbox;
  const vehicles = [];

  for (const entity of feed.entity || []) {
    const vehiclePosition = entity.vehicle;
    const position = vehiclePosition?.position;
    if (!vehiclePosition || !position) continue;

    const lon = finiteNumber(position.longitude);
    const lat = finiteNumber(position.latitude);
    if (lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
    if (lon < west || lon > east || lat < south || lat > north) continue;

    const tripId = nonEmptyString(vehiclePosition.trip?.tripId);
    const staticTrip = tripId ? staticFeed.trips.get(tripId) : null;
    const routeId = nonEmptyString(vehiclePosition.trip?.routeId) || staticTrip?.routeId || null;
    const route = routeId ? staticFeed.routes.get(routeId) : null;
    if (agencies.size > 0 && (!route || !agencies.has(route.agencyId))) continue;

    const vehicleId = nonEmptyString(vehiclePosition.vehicle?.id) || nonEmptyString(entity.id);
    if (!vehicleId) continue;

    const timestamp = validSeconds(vehiclePosition.timestamp) || feedTimestamp || receivedTimestamp;
    if (timestamp * 1000 < staleBeforeMs) continue;

    const bearing = finiteNumber(position.bearing);
    const speed = Object.hasOwn(position, "speed") ? finiteNumber(position.speed) : null;
    vehicles.push({
      vehicleId,
      tripId,
      routeId,
      line: route?.shortName || routeId || "",
      lineColor: colorForLine(route?.shortName || routeId || "", route?.lineColor),
      labelColor: colorForLine(route?.shortName || routeId || "", route?.lineColor),
      headsign: staticTrip?.headsign || "",
      lon,
      lat,
      bearing: bearing ?? 0,
      speedKmh: speed !== null && speed >= 0 ? speed * 3.6 : null,
      updatedAt: isoTimestamp(timestamp),
      positionSource: "live",
      displayText: route?.shortName || routeId || "",
      vehicleType: "bus",
      model: "bus",
    });
  }

  return {
    timestamp: isoTimestamp(feedTimestamp || receivedTimestamp),
    vehicles,
  };
}
