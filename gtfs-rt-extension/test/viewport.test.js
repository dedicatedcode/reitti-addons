import test from "node:test";
import assert from "node:assert/strict";
import { applyViewport } from "../src/viewport.js";

const snapshot = {
  timestamp: "2026-01-01T00:00:00.000Z",
  vehicles: [
    { vehicleId: "center", lon: 7.6, lat: 51.95 },
    { vehicleId: "outside", lon: 7.8, lat: 51.95 },
  ],
};

test("filters vehicles by viewport bounds", () => {
  const result = applyViewport(snapshot, new URLSearchParams("bbox=7.5,51.9,7.7,52.0&zoom=14"), 10);
  assert.deepEqual(result.vehicles.map(vehicle => vehicle.vehicleId), ["center"]);
});

test("uses zoom to hide vehicles below the configured minimum", () => {
  assert.equal(applyViewport(snapshot, new URLSearchParams("zoom=9"), 10).vehicles.length, 0);
  assert.equal(applyViewport(snapshot, new URLSearchParams("zoom=10"), 10).vehicles.length, 2);
  assert.equal(applyViewport(snapshot, new URLSearchParams(), 10).vehicles.length, 2);
});

test("allows long-distance models to override the default minimum zoom", () => {
  const result = applyViewport({
    timestamp: snapshot.timestamp,
    vehicles: [snapshot.vehicles[0], { ...snapshot.vehicles[1], vehicleId: "ice", minZoom: 5 }],
  }, new URLSearchParams("zoom=6"), 10);
  assert.deepEqual(result.vehicles.map(vehicle => vehicle.vehicleId), ["ice"]);
});

test("uses per-model minimum zooms when the manifest hides models", () => {
  const models = { bus: 10, tram: 10, train: 10, subway: 10, sbahn: 10, ic: 5, ice: 5 };
  const vehicles = [
    { vehicleId: "bus", lon: 7.6, lat: 51.95, model: "bus" },
    { vehicleId: "ice", lon: 7.6, lat: 51.95, model: "ice" },
  ];
  const result = applyViewport(
    { timestamp: snapshot.timestamp, vehicles },
    new URLSearchParams("zoom=6"),
    5,
    models,
  );
  assert.deepEqual(result.vehicles.map(vehicle => vehicle.vehicleId), ["ice"]);
});

test("does not cap the number of vehicles returned for a large bounding box", () => {
  const vehicles = Array.from({ length: 10_000 }, (_, index) => ({
    vehicleId: String(index),
    lon: 13.4,
    lat: 52.5,
    model: index % 2 ? "bus" : "train",
  }));
  const result = applyViewport(
    { timestamp: snapshot.timestamp, vehicles },
    new URLSearchParams("bbox=13.2,52.35,13.65,52.65&zoom=12"),
    5,
    { bus: 10, train: 10 },
  );
  assert.equal(result.vehicles.length, 10_000);
});

test("rejects malformed viewport parameters", () => {
  assert.throws(() => applyViewport(snapshot, new URLSearchParams("bbox=1,2,3"), 10), /bbox/);
  assert.throws(() => applyViewport(snapshot, new URLSearchParams("bbox=8,2,7,3"), 10), /bbox/);
  assert.throws(() => applyViewport(snapshot, new URLSearchParams("zoom=31"), 10), /zoom/);
});
