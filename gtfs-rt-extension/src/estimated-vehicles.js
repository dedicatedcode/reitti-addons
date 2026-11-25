import { DateTime } from "luxon";
import { colorForLine } from "./colors.js";
import { parseGtfsTime } from "./estimated-static.js";
import { delayText, isLongDistanceModel, vehicleModel } from "./vehicle-model.js";

const EARTH_RADIUS_METERS = 6_371_000;

function finiteNumber(value) {
  if (value && typeof value === "object" && typeof value.toNumber === "function") value = value.toNumber();
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validTimestamp(value) {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds <= 0 || !Number.isFinite(seconds * 1000)) return null;
  return seconds;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

export function haversineMeters(a, b) {
  const toRadians = Math.PI / 180;
  const deltaLat = (b.lat - a.lat) * toRadians;
  const deltaLon = (b.lon - a.lon) * toRadians;
  const lat1 = a.lat * toRadians;
  const lat2 = b.lat * toRadians;
  const value = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(value)));
}

export function bearingDegrees(a, b) {
  const toRadians = Math.PI / 180;
  const lat1 = a.lat * toRadians;
  const lat2 = b.lat * toRadians;
  const deltaLon = (b.lon - a.lon) * toRadians;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  if (x === 0 && y === 0) return 0;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function prepareShape(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + haversineMeters(points[index - 1], points[index]));
  }
  if (!(cumulative.at(-1) > 0)) return null;
  const shapeDistances = points.map((point) => point.distTraveled);
  const hasShapeDistances = shapeDistances.every((distance) => distance !== null && Number.isFinite(distance))
    && shapeDistances.every((distance, index) => index === 0 || distance >= shapeDistances[index - 1])
    && shapeDistances.at(-1) > shapeDistances[0];
  return { points, cumulative, shapeDistances: hasShapeDistances ? shapeDistances : null };
}

function projectOffset(stop, shape, minimumOffset = 0) {
  const total = shape.cumulative.at(-1);
  const longitudeScale = Math.cos(stop.lat * Math.PI / 180);
  let best = { distance: Infinity, offset: minimumOffset };
  for (let index = 0; index < shape.points.length - 1; index += 1) {
    const a = shape.points[index];
    const b = shape.points[index + 1];
    const segmentLength = shape.cumulative[index + 1] - shape.cumulative[index];
    if (segmentLength <= 0) continue;
    const dx = (b.lon - a.lon) * longitudeScale;
    const dy = b.lat - a.lat;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;
    const fraction = Math.max(0, Math.min(1,
      (((stop.lon - a.lon) * longitudeScale * dx) + ((stop.lat - a.lat) * dy)) / lengthSquared));
    const offset = shape.cumulative[index] + segmentLength * fraction;
    if (offset + 0.001 < minimumOffset) continue;
    const projectedLon = a.lon + (b.lon - a.lon) * fraction;
    const projectedLat = a.lat + (b.lat - a.lat) * fraction;
    const x = (stop.lon - projectedLon) * longitudeScale;
    const y = stop.lat - projectedLat;
    const distance = x * x + y * y;
    if (distance < best.distance) best = { distance, offset: Math.max(minimumOffset, offset) };
  }
  if (best.distance === Infinity) {
    return Math.max(minimumOffset, Math.min(total, shape.cumulative.at(-1)));
  }
  return Math.min(total, best.offset);
}

function segmentOffsets(previous, next, shape) {
  const distances = shape.shapeDistances;
  if (distances
    && previous.shapeDistTraveled !== null
    && next.shapeDistTraveled !== null
    && previous.shapeDistTraveled >= distances[0]
    && next.shapeDistTraveled <= distances.at(-1)
    && next.shapeDistTraveled >= previous.shapeDistTraveled) {
    return {
      distances,
      previous: previous.shapeDistTraveled,
      next: next.shapeDistTraveled,
    };
  }
  const previousOffset = projectOffset(previous.stop, shape);
  const nextOffset = projectOffset(next.stop, shape, previousOffset);
  return { distances: shape.cumulative, previous: previousOffset, next: nextOffset };
}

function interpolateShape(shape, distances, target) {
  const first = distances[0];
  const last = distances.at(-1);
  if (!Number.isFinite(target)) return null;
  const clamped = Math.max(first, Math.min(last, target));
  let upper = 1;
  while (upper < distances.length && distances[upper] < clamped) upper += 1;
  if (upper >= distances.length) upper = distances.length - 1;
  let lower = Math.max(0, upper - 1);
  if (clamped <= distances[0]) {
    lower = 0;
    upper = 1;
  }
  const length = distances[upper] - distances[lower];
  const fraction = length > 0 ? (clamped - distances[lower]) / length : 0;
  const a = shape.points[lower];
  const b = shape.points[upper];
  let deltaLon = b.lon - a.lon;
  if (deltaLon > 180) deltaLon -= 360;
  if (deltaLon < -180) deltaLon += 360;
  let lon = a.lon + deltaLon * fraction;
  if (lon > 180) lon -= 360;
  if (lon < -180) lon += 360;

  let bearingA = a;
  let bearingB = b;
  if (clamped >= last) {
    for (let index = shape.points.length - 1; index > 0; index -= 1) {
      if (haversineMeters(shape.points[index - 1], shape.points[index]) > 0) {
        bearingA = shape.points[index - 1];
        bearingB = shape.points[index];
        break;
      }
    }
  } else if (length <= 0) {
    for (let index = upper + 1; index < shape.points.length; index += 1) {
      if (haversineMeters(a, shape.points[index]) > 0) {
        bearingB = shape.points[index];
        break;
      }
    }
  }
  return {
    lon,
    lat: a.lat + (b.lat - a.lat) * fraction,
    bearing: bearingDegrees(bearingA, bearingB),
  };
}

function cumulativeDistance(shape, distances, target) {
  const clamped = Math.max(distances[0], Math.min(distances.at(-1), target));
  let upper = 1;
  while (upper < distances.length && distances[upper] < clamped) upper += 1;
  upper = Math.min(upper, distances.length - 1);
  const lower = Math.max(0, upper - 1);
  const length = distances[upper] - distances[lower];
  const fraction = length > 0 ? (clamped - distances[lower]) / length : 0;
  return shape.cumulative[lower] + (shape.cumulative[upper] - shape.cumulative[lower]) * fraction;
}

function maximumSpeedMetersPerSecond(model) {
  if (model === "ice" || model === "ic") return 100;
  if (["train", "sbahn", "subway", "tram"].includes(model)) return 70;
  if (model === "ferry") return 35;
  return 45;
}

function scheduleName(value, names) {
  return typeof value === "string" ? value : names[value];
}

function serviceDay(trip, descriptor, predictedReferenceMs, timezone) {
  if (/^\d{8}$/.test(descriptor.startDate || "")) {
    const parsed = DateTime.fromFormat(descriptor.startDate, "yyyyLLdd", { zone: timezone });
    if (parsed.isValid) return parsed.startOf("day");
  }
  const reference = DateTime.fromMillis(predictedReferenceMs, { zone: timezone });
  if (!reference.isValid) return null;
  const first = trip.stopTimes.find((stop) => stop.departureSeconds !== null || stop.arrivalSeconds !== null);
  const tripStart = parseGtfsTime(descriptor.startTime);
  const offset = tripStart ?? (first ? (first.departureSeconds ?? first.arrivalSeconds) : null);
  if (offset === null || offset === undefined) return reference.startOf("day");
  let best = null;
  let bestDistance = Infinity;
  for (let days = -2; days <= 2; days += 1) {
    const candidate = reference.startOf("day").plus({ days });
    const distance = Math.abs(candidate.toMillis() + offset * 1000 - predictedReferenceMs);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function eventDelay(event) {
  const delay = finiteNumber(event?.delay);
  return delay === null ? 0 : delay;
}

function predictedStops(trip, tripUpdate, day, index, instanceOffsetSeconds = 0) {
  const updates = tripUpdate.stopTimeUpdate || [];
  const bySequence = new Map();
  for (const update of updates) {
    const sequence = finiteNumber(update.stopSequence);
    if (sequence !== null && Number.isInteger(sequence)) bySequence.set(sequence, update);
  }
  const used = new Set();
  const result = [];
  let inheritedDelayMs = (finiteNumber(tripUpdate.delay) ?? 0) * 1000;

  for (const staticStop of trip.stopTimes) {
    const stop = index.stops.get(staticStop.stopId);
    if (!stop) continue;
    let update = bySequence.get(staticStop.stopSequence);
    if (update) {
      used.add(update);
    } else {
      update = updates.find(candidate => !candidate.stopSequence
        && candidate.stopId === staticStop.stopId && !used.has(candidate));
      if (update) used.add(update);
    }
    if (scheduleName(update?.scheduleRelationship, { 0: "SCHEDULED", 1: "SKIPPED", 2: "NO_DATA" }) === "SKIPPED") continue;

    const staticArrivalSeconds = staticStop.arrivalSeconds ?? staticStop.departureSeconds;
    const staticDepartureSeconds = staticStop.departureSeconds ?? staticStop.arrivalSeconds;
    const staticArrivalMs = staticArrivalSeconds === null || staticArrivalSeconds === undefined || !day
      ? null : day.toMillis() + (staticArrivalSeconds + instanceOffsetSeconds) * 1000;
    const staticDepartureMs = staticDepartureSeconds === null || staticDepartureSeconds === undefined || !day
      ? null : day.toMillis() + (staticDepartureSeconds + instanceOffsetSeconds) * 1000;

    const arrival = update?.arrival;
    const arrivalTimestamp = validTimestamp(arrival?.time);
    const arrivalAbsoluteMs = arrivalTimestamp === null ? null : arrivalTimestamp * 1000;
    if (arrivalAbsoluteMs !== null && staticArrivalMs !== null) {
      inheritedDelayMs = arrivalAbsoluteMs - staticArrivalMs;
    } else if (arrival && finiteNumber(arrival.delay) !== null) {
      inheritedDelayMs = eventDelay(arrival) * 1000;
    }
    const arrivalMs = arrivalAbsoluteMs ?? (staticArrivalMs === null ? null : staticArrivalMs + inheritedDelayMs);

    const departure = update?.departure;
    const departureTimestamp = validTimestamp(departure?.time);
    const departureAbsoluteMs = departureTimestamp === null ? null : departureTimestamp * 1000;
    if (departureAbsoluteMs !== null && staticDepartureMs !== null) {
      inheritedDelayMs = departureAbsoluteMs - staticDepartureMs;
    } else if (departure && finiteNumber(departure.delay) !== null) {
      inheritedDelayMs = eventDelay(departure) * 1000;
    }
    const departureMs = departureAbsoluteMs ?? (staticDepartureMs === null ? null : staticDepartureMs + inheritedDelayMs);

    const resolvedArrivalMs = arrivalMs ?? departureMs;
    const resolvedDepartureMs = departureMs ?? arrivalMs;
    if (resolvedArrivalMs === null || resolvedDepartureMs === null || resolvedDepartureMs < resolvedArrivalMs) continue;
    result.push({
      ...staticStop,
      stop,
      arrivalMs: resolvedArrivalMs,
      departureMs: resolvedDepartureMs,
      staticArrivalMs,
      staticDepartureMs,
    });
  }
  return result;
}

function currentSegment(stops, nowMs) {
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    if (stop.departureMs > stop.arrivalMs && nowMs >= stop.arrivalMs && nowMs < stop.departureMs) {
      return { dwell: true, previous: stop, next: stops[index + 1] || null, progress: 0 };
    }
  }
  for (let index = 0; index < stops.length - 1; index += 1) {
    const previous = stops[index];
    const next = stops[index + 1];
    const duration = next.arrivalMs - previous.departureMs;
    if (duration > 0 && nowMs >= previous.departureMs && nowMs <= next.arrivalMs) {
      return {
        dwell: false,
        previous,
        next,
        progress: Math.max(0, Math.min(1, (nowMs - previous.departureMs) / duration)),
      };
    }
  }
  return null;
}

function realtimeReference(tripUpdate) {
  for (const update of tripUpdate.stopTimeUpdate || []) {
    for (const event of [update.arrival, update.departure]) {
      const timestamp = validTimestamp(event?.time);
      if (timestamp !== null) return timestamp * 1000;
    }
  }
  return null;
}

function vehicleType(routeType, line) {
  if (/^(RE|RB|ICE|IC)\s*\d/i.test(line || "")) return "train";
  if (routeType === 0 || routeType === 1 || (routeType >= 900 && routeType < 1000)) return "tram";
  if (routeType === 3 || routeType === 11 || (routeType >= 200 && routeType < 300)
    || (routeType >= 700 && routeType < 900)) return "bus";
  if (routeType === 4 || (routeType >= 1000 && routeType < 1100)) return "ferry";
  if (routeType === 2 || routeType === 12 || (routeType >= 100 && routeType < 200)
    || (routeType >= 300 && routeType < 600)) return "train";
  return "other";
}

function delayForSegment(segment) {
  const predicted = segment.dwell ? segment.previous.departureMs : segment.next?.arrivalMs;
  const scheduled = segment.dwell ? segment.previous.staticDepartureMs : segment.next?.staticArrivalMs;
  if (predicted === null || predicted === undefined || scheduled === null || scheduled === undefined) return 0;
  return Math.round((predicted - scheduled) / 1000);
}

function estimationContext(feed, index, options, receivedAtMs) {
  const nowMs = options.nowMs ?? receivedAtMs;
  const feedTimestamp = validTimestamp(feed.header?.timestamp);
  const receivedTimestamp = Math.floor(receivedAtMs / 1000);
  const outputTimestamp = feedTimestamp || receivedTimestamp;
  const trackState = options.trackState || null;
  return {
    nowMs,
    outputTimestamp,
    staleBeforeMs: nowMs - (options.staleAfterSeconds ?? 90) * 1000,
    agencies: new Set(options.agencyIds || []),
    bbox: options.bbox,
    index,
    trackState,
    currentTracks: trackState ? new Map() : null,
    preparedShapes: index.preparedShapes || (index.preparedShapes = new Map()),
    regionalShapes: options.regionalShapes || null,
    vehicles: [],
  };
}

function estimateEntity(entity, context) {
  const { nowMs, outputTimestamp, staleBeforeMs, agencies, bbox, index, trackState, currentTracks, preparedShapes, regionalShapes } = context;
  const tripUpdate = entity.tripUpdate;
  const descriptor = tripUpdate?.trip;
  const tripId = descriptor?.tripId;
  if (!tripUpdate || !tripId || entity.isDeleted) return null;
  const relationship = scheduleName(descriptor.scheduleRelationship, {
    0: "SCHEDULED",
    1: "ADDED",
    2: "UNSCHEDULED",
    3: "CANCELED",
    5: "REPLACEMENT",
    6: "DUPLICATED",
    7: "DELETED",
  });
  if (["CANCELED", "CANCELLED", "DELETED"].includes(relationship)) return null;
  const trip = index.trips.get(tripId);
  if (!trip) return null;
  const route = index.routes.get(trip.routeId);
  if (agencies.size > 0 && (!route?.agencyId || !agencies.has(route.agencyId))) return null;
  const regionalShape = regionalShapes?.get(tripId) || null;
  const shapeKey = regionalShape
    ? `region:${regionalShape.regionId}:${regionalShape.shapeId}`
    : trip.shapeId || `stops:${tripId}`;
  if (!preparedShapes.has(shapeKey)) {
    const shapePoints = regionalShape?.points?.length >= 2
      ? regionalShape.points
      : trip.shapeId && index.shapes.has(trip.shapeId)
        ? index.shapes.get(trip.shapeId)
        : trip.stopTimes.map((stopTime, sequence) => {
          const stop = index.stops.get(stopTime.stopId);
          return stop ? { ...stop, sequence, distTraveled: null } : null;
        }).filter(Boolean);
    preparedShapes.set(shapeKey, prepareShape(shapePoints));
  }
  const shape = preparedShapes.get(shapeKey);
  if (!shape) return null;
  const entityTimestamp = validTimestamp(tripUpdate.timestamp) || outputTimestamp;
  if (entityTimestamp * 1000 < staleBeforeMs) return null;

  const referenceMs = realtimeReference(tripUpdate) ?? nowMs;
  const day = serviceDay(trip, descriptor, referenceMs, index.timezone);
  const firstStop = trip.stopTimes.find(stop => stop.departureSeconds !== null || stop.arrivalSeconds !== null);
  const templateStart = firstStop ? (firstStop.departureSeconds ?? firstStop.arrivalSeconds) : null;
  const requestedStart = parseGtfsTime(descriptor.startTime);
  const instanceOffsetSeconds = requestedStart !== null && templateStart !== null
    ? requestedStart - templateStart : 0;
  const stops = predictedStops(trip, tripUpdate, day, index, instanceOffsetSeconds);
  if (stops.length < 2) return null;
  const segment = currentSegment(stops, nowMs);
  if (!segment?.next) return null;

  const line = route?.shortName || trip.routeId || "";
  const model = vehicleModel(route?.routeType, line);
  const instanceId = `${tripId}:${descriptor.startDate || day?.toISODate() || "current"}:${descriptor.startTime || ""}`;
  const offsets = segmentOffsets(segment.previous, segment.next, shape);
  const target = offsets.previous + (offsets.next - offsets.previous) * segment.progress;
  const rawDistance = cumulativeDistance(shape, offsets.distances, target);
  let distance = rawDistance;
  const previousTrack = trackState?.get(instanceId);
  const sameTrack = previousTrack?.shapeKey === shapeKey;
  const elapsedSeconds = sameTrack ? Math.max(0, (nowMs - previousTrack.timeMs) / 1000) : 0;
  if (sameTrack) {
    const maximumDistance = previousTrack.distance + maximumSpeedMetersPerSecond(model) * elapsedSeconds;
    distance = Math.min(maximumDistance, Math.max(previousTrack.distance, rawDistance));
  }
  const position = interpolateShape(shape, shape.cumulative, distance);
  if (!position) return null;
  const snapDistance = sameTrack ? haversineMeters(previousTrack, segment.previous.stop) : 0;
  const canSnapToStop = !sameTrack || rawDistance >= previousTrack.distance - 0.001
    && snapDistance <= maximumSpeedMetersPerSecond(model) * elapsedSeconds + 0.1;
  if (segment.dwell && distance >= rawDistance - 0.001 && canSnapToStop) {
    position.lon = segment.previous.stop.lon;
    position.lat = segment.previous.stop.lat;
  }
  if (position.lon < -180 || position.lon > 180 || position.lat < -90 || position.lat > 90) return null;
  if (bbox) {
    const [west, south, east, north] = bbox;
    const epsilon = 1e-9;
    if (position.lon < west - epsilon || position.lon > east + epsilon
      || position.lat < south - epsilon || position.lat > north + epsilon) return null;
  }

  const delaySeconds = delayForSegment(segment);
  currentTracks?.set(instanceId, {
    shapeKey,
    distance,
    timeMs: nowMs,
    lon: position.lon,
    lat: position.lat,
    bearing: position.bearing,
  });
  return {
    vehicleId: instanceId,
    tripId,
    routeId: trip.routeId,
    line,
    lineColor: colorForLine(line, route?.lineColor),
    labelColor: [255, 210, 90, 255],
    headsign: trip.headsign || "",
    lon: position.lon,
    lat: position.lat,
    bearing: position.bearing,
    speedKmh: null,
    updatedAt: iso(entityTimestamp * 1000),
    positionSource: "estimated",
    displayText: `≈ ${line}`,
    vehicleType: vehicleType(route?.routeType, line),
    model,
    ...(isLongDistanceModel(model) ? { minZoom: 5 } : {}),
    routeType: route?.routeType ?? null,
    previousStopName: segment.previous.stop.name,
    previousDeparture: iso(segment.previous.departureMs),
    nextStopName: segment.next.stop.name,
    nextStopId: segment.next.stopId,
    nextArrival: iso(segment.next.arrivalMs),
    delaySeconds,
    delayText: delayText(delaySeconds),
    operator: route?.operator || null,
    ...(previousTrack ? {
      previousLon: previousTrack.lon,
      previousLat: previousTrack.lat,
      ...(Number.isFinite(previousTrack.bearing) ? { previousBearing: previousTrack.bearing } : {}),
      ...(Number.isFinite(previousTrack.timeMs) ? { previousUpdatedAt: iso(previousTrack.timeMs) } : {}),
    } : {}),
  };
}

function finishEstimate(context) {
  if (context.trackState) {
    context.trackState.clear();
    for (const [vehicleId, track] of context.currentTracks) context.trackState.set(vehicleId, track);
  }
  return { timestamp: iso(context.outputTimestamp * 1000), vehicles: context.vehicles };
}

export function estimateTripUpdates(feed, index, options, receivedAtMs) {
  const context = estimationContext(feed, index, options, receivedAtMs);
  for (const entity of feed.entity || []) {
    const vehicle = estimateEntity(entity, context);
    if (vehicle) context.vehicles.push(vehicle);
  }
  return finishEstimate(context);
}

export async function estimateTripUpdatesAsync(feed, index, options, receivedAtMs, { yieldEvery = 100, signal = null } = {}) {
  const context = estimationContext(feed, index, options, receivedAtMs);
  let processed = 0;
  for (const entity of feed.entity || []) {
    if (signal?.aborted) throw new Error("Estimate aborted");
    const vehicle = estimateEntity(entity, context);
    if (vehicle) context.vehicles.push(vehicle);
    processed += 1;
    if (processed % yieldEvery === 0) await new Promise(resolve => setImmediate(resolve));
  }
  return finishEstimate(context);
}
