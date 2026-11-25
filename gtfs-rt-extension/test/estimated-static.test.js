import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { parseEstimatedStaticFeed, parseGtfsTime } from "../src/estimated-static.js";
import { ESTIMATED_BBOX, estimatedStaticZip } from "./estimated-fixtures.js";

test("streaming index selects BBOX trips and retains their complete joined data", async () => {
  const index = await parseEstimatedStaticFeed(estimatedStaticZip(), { bbox: ESTIMATED_BBOX });

  assert.equal(index.timezone, "Europe/Berlin");
  assert.deepEqual([...index.trips.keys()].sort(), [
    "t-bus", "t-ferry", "t-no-shape", "t-overnight", "t-train", "t-tram",
  ]);
  assert.deepEqual([...index.stops.keys()].sort(), ["A", "B", "C"]);
  assert.deepEqual([...index.routes.keys()].sort(), ["r-bus", "r-ferry", "r-train", "r-tram"]);
  assert.deepEqual([...index.shapes.keys()], ["shape-east"]);
  assert.equal(index.trips.has("t-outside"), false);
  assert.equal(index.stops.has("OUT"), false);

  const bus = index.trips.get("t-bus");
  assert.equal(bus.routeId, "r-bus");
  assert.equal(bus.headsign, "Central Station");
  assert.deepEqual(bus.stopTimes.map((stop) => stop.stopId), ["A", "B", "C"]);
  assert.equal(index.stops.get("B").name, "Middle, East");
  assert.equal(index.routes.get("r-bus").routeType, 3);
  assert.deepEqual(index.routes.get("r-bus").lineColor, [18, 130, 220, 255]);
  assert.equal(index.routes.get("r-tram").lineColor, null);
  assert.equal(index.routes.get("r-bus").operator, "Berlin Verkehr");
  assert.deepEqual(index.shapes.get("shape-east").map((point) => point.sequence), [1, 2, 3]);
  assert.deepEqual(index.trips.get("t-overnight").stopTimes.map((stop) => stop.arrivalSeconds), [
    24 * 3600, 24 * 3600 + 600, 24 * 3600 + 1200,
  ]);
});

test("can restrict the static index to current realtime trip IDs", async () => {
  const index = await parseEstimatedStaticFeed(estimatedStaticZip(), {
    bbox: ESTIMATED_BBOX,
    tripIds: ["t-bus"],
  });
  assert.deepEqual([...index.trips.keys()], ["t-bus"]);
  assert.deepEqual([...index.stops.keys()].sort(), ["A", "B", "C"]);
  assert.deepEqual([...index.routes.keys()], ["r-bus"]);
});

test("supports missing optional shapes and agency files", async () => {
  const archive = zipSync({
    "stops.txt": strToU8("stop_id,stop_name,stop_lat,stop_lon\nA,Start,52.5,13.4\nB,End,52.5,13.41\n"),
    "stop_times.txt": strToU8("trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,A,1\nt1,08:10:00,08:10:00,B,2\n"),
    "trips.txt": strToU8("route_id,trip_id,trip_headsign\nr1,t1,Central\n"),
    "routes.txt": strToU8("route_id,route_short_name,route_type\nr1,1,3\n"),
  });
  const index = await parseEstimatedStaticFeed(Buffer.from(archive), { bbox: ESTIMATED_BBOX });
  assert.equal(index.timezone, "Europe/Berlin");
  assert.equal(index.shapes.size, 0);
  assert.equal(index.routes.get("r1").operator, null);
});

test("reports missing files, malformed CSV and selected-region resource limits", async () => {
  const missing = Buffer.from(zipSync({ "stops.txt": strToU8("stop_id\nA\n") }));
  await assert.rejects(parseEstimatedStaticFeed(missing, { bbox: ESTIMATED_BBOX }), /missing stop_times.txt/);

  const malformed = Buffer.from(zipSync({
    "stops.txt": strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,"unterminated,52.5,13.4\n'),
    "stop_times.txt": strToU8("trip_id,stop_id,stop_sequence\nt1,A,1\n"),
    "trips.txt": strToU8("trip_id,route_id\nt1,r1\n"),
    "routes.txt": strToU8("route_id\nr1\n"),
  }));
  await assert.rejects(parseEstimatedStaticFeed(malformed, { bbox: ESTIMATED_BBOX }), /Could not parse stops.txt/);
  await assert.rejects(
    parseEstimatedStaticFeed(estimatedStaticZip(), { bbox: ESTIMATED_BBOX, maxSelectedTrips: 0 }),
    /selected trips exceeds/,
  );
  await assert.rejects(parseEstimatedStaticFeed(Buffer.from("not a zip"), { bbox: ESTIMATED_BBOX }), /open static GTFS ZIP/);
});

test("parses GTFS times after midnight without wrapping them", () => {
  assert.equal(parseGtfsTime("24:00:00"), 86_400);
  assert.equal(parseGtfsTime("27:03:04"), 97_384);
  assert.equal(parseGtfsTime("23:61:00"), null);
  assert.equal(parseGtfsTime("not-a-time"), null);
});
