import { strToU8, zipSync } from "fflate";

export const ESTIMATED_BBOX = [13.39, 52.49, 13.405, 52.51];
export const OUTPUT_BBOX = [13.39, 52.49, 13.43, 52.51];
export const BETWEEN_NOW = Date.parse("2026-01-15T07:05:00.000Z");
export const FEED_TIMESTAMP = BETWEEN_NOW / 1000;

export function estimatedStaticZip() {
  const tripRows = [
    ["r-bus", "t-bus", "shape-east", "Central Station"],
    ["r-tram", "t-tram", "shape-east", "Tram Central"],
    ["r-train", "t-train", "shape-east", "Train Central"],
    ["r-ferry", "t-ferry", "shape-east", "Ferry Central"],
    ["r-bus", "t-no-shape", "", "No shape"],
    ["r-bus", "t-overnight", "shape-east", "Night Central"],
    ["r-outside", "t-outside", "shape-outside", "Outside"],
  ];
  const stopTimeRows = [];
  for (const [tripId, start = "08:00:00"] of [
    ["t-bus"], ["t-tram"], ["t-train"], ["t-ferry"], ["t-no-shape"],
  ]) {
    const [hour] = start.split(":").map(Number);
    const prefix = String(hour).padStart(2, "0");
    stopTimeRows.push(`${tripId},${start},${start},A,1,0`);
    stopTimeRows.push(`${tripId},${prefix}:10:00,${prefix}:11:00,B,2,1000`);
    stopTimeRows.push(`${tripId},${prefix}:20:00,${prefix}:20:00,C,3,2000`);
  }
  stopTimeRows.push("t-overnight,24:20:00,24:20:00,C,3,2000");
  stopTimeRows.push("t-overnight,24:00:00,24:00:00,A,1,0");
  stopTimeRows.push("t-overnight,24:10:00,24:10:00,B,2,1000");
  stopTimeRows.push("t-outside,08:00:00,08:00:00,OUT,1,0");
  stopTimeRows.push("t-outside,08:10:00,08:10:00,FAR,2,1000");

  return Buffer.from(zipSync({
    "agency.txt": strToU8([
      "agency_id,agency_name,agency_timezone",
      "agency-berlin,Berlin Verkehr,Europe/Berlin",
      "agency-outside,Outside Operator,UTC",
      "",
    ].join("\n")),
    "stops.txt": strToU8([
      "stop_id,stop_name,stop_lat,stop_lon",
      "A,Start,52.50,13.40",
      'B,"Middle, East",52.50,13.41',
      "C,End,52.50,13.42",
      "OUT,Outside,52.50,13.50",
      "FAR,Far Away,52.50,13.51",
      "BAD,Invalid,999,13.40",
      "",
    ].join("\n")),
    "trips.txt": strToU8([
      "route_id,trip_id,trip_headsign,shape_id,service_id",
      ...tripRows.map(([route, trip, shape, headsign]) => `${route},${trip},${headsign},${shape},weekday`),
      "",
    ].join("\n")),
    "stop_times.txt": strToU8([
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled",
      ...stopTimeRows,
      "",
    ].join("\n")),
    "routes.txt": strToU8([
      "route_id,route_short_name,route_type,agency_id,route_color",
      "r-bus,B10,3,agency-berlin,1282DC",
      "r-tram,M1,0,agency-berlin,",
      "r-train,RE1,2,agency-berlin,E30613",
      "r-ferry,F1,4,agency-berlin,",
      "r-outside,X1,3,agency-outside,",
      "",
    ].join("\n")),
    "shapes.txt": strToU8([
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled",
      "shape-east,52.50,13.42,3,2000",
      "shape-east,52.50,13.40,1,0",
      "shape-east,52.50,13.41,2,1000",
      "shape-outside,52.50,13.50,1,0",
      "shape-outside,52.50,13.51,2,1000",
      "",
    ].join("\n")),
  }));
}

export function tripEntity(tripId, {
  updates = [],
  startDate = "20260115",
  timestamp = FEED_TIMESTAMP,
  scheduleRelationship = 0,
} = {}) {
  const tripRelationships = { SCHEDULED: 0, CANCELED: 3, CANCELLED: 3, DELETED: 7 };
  return {
    id: `update-${tripId}`,
    tripUpdate: {
      trip: {
        tripId,
        startDate,
        scheduleRelationship: typeof scheduleRelationship === "string"
          ? tripRelationships[scheduleRelationship]
          : scheduleRelationship,
      },
      stopTimeUpdate: updates,
      timestamp,
    },
  };
}

export function stopUpdate(stopSequence, stopId, {
  arrivalDelay,
  departureDelay,
  arrivalTime,
  departureTime,
  scheduleRelationship,
} = {}) {
  return {
    stopSequence,
    stopId,
    arrival: arrivalDelay !== undefined || arrivalTime !== undefined
      ? { delay: arrivalDelay, time: arrivalTime }
      : undefined,
    departure: departureDelay !== undefined || departureTime !== undefined
      ? { delay: departureDelay, time: departureTime }
      : undefined,
    scheduleRelationship: scheduleRelationship === "SKIPPED" ? 1 : scheduleRelationship,
  };
}
