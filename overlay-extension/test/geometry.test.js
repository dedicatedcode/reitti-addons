import assert from "node:assert/strict";
import { test } from "node:test";
import {
  areasToOutlines,
  bboxIntersects,
  computeBbox,
  normalizeGeoJson,
} from "../src/overlays/geometry.js";

function feature(geometry, properties = {}) {
  return { type: "Feature", properties, geometry };
}

test("normalizes lines, multi lines and polygons", () => {
  const result = normalizeGeoJson({
    type: "FeatureCollection",
    features: [
      feature(
        { type: "LineString", coordinates: [[13.4, 52.5], [13.5, 52.6]] },
        { name: "road" },
      ),
      feature({
        type: "MultiLineString",
        coordinates: [
          [[13.4, 52.5], [13.45, 52.55]],
          [[13.5, 52.6], [13.55, 52.65], [13.56, 52.66]],
        ],
      }),
      feature({
        type: "Polygon",
        coordinates: [
          [[13.4, 52.5], [13.5, 52.5], [13.5, 52.6]],
          [[13.42, 52.52], [13.43, 52.52], [13.43, 52.53], [13.42, 52.52]],
        ],
      }),
      feature({
        type: "MultiPolygon",
        coordinates: [
          [[[13.4, 52.5], [13.5, 52.5], [13.5, 52.6], [13.4, 52.5]]],
        ],
      }),
    ],
  });

  assert.equal(result.stats.pathFeatures, 3);
  assert.equal(result.stats.areaFeatures, 2);
  assert.equal(result.paths[0].properties.name, "road");
  assert.deepEqual(result.paths[0].bbox, [13.4, 52.5, 13.5, 52.6]);
  assert.equal(result.areas[0].geometry.coordinates.length, 2);
  assert.equal(result.areas[0].geometry.coordinates[0].length, 4);
  assert.deepEqual(result.areas[0].geometry.coordinates[0][0], result.areas[0].geometry.coordinates[0][3]);
});

test("accepts bare geometries, features and geometry collections", () => {
  const bare = normalizeGeoJson({ type: "LineString", coordinates: [[0, 0], [1, 1]] });
  assert.equal(bare.paths.length, 1);

  const single = normalizeGeoJson(feature({ type: "LineString", coordinates: [[0, 0], [1, 1]] }));
  assert.equal(single.paths.length, 1);

  const collection = normalizeGeoJson(
    feature({
      type: "GeometryCollection",
      geometries: [
        { type: "LineString", coordinates: [[0, 0], [1, 1]] },
        { type: "Point", coordinates: [0, 0] },
        { type: "Polygon", coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] },
      ],
    }),
  );
  assert.equal(collection.paths.length, 1);
  assert.equal(collection.areas.length, 1);
  assert.equal(collection.stats.ignoredPoints, 1);
});

test("drops invalid coordinates and short lines", () => {
  const result = normalizeGeoJson({
    type: "FeatureCollection",
    features: [
      feature({
        type: "LineString",
        coordinates: [[999, 0], [0, 999], [13.4, 52.5], [13.5, 52.6]],
      }),
      feature({ type: "LineString", coordinates: [[13.4, 52.5]] }),
    ],
  });
  assert.equal(result.paths.length, 1);
  assert.equal(result.paths[0].geometry.coordinates.length, 2);
  assert.equal(result.stats.ignoredPoints, 2);
});

test("keeps altitude only when every point has it", () => {
  const mixed = normalizeGeoJson(
    feature({
      type: "LineString",
      coordinates: [[13.4, 52.5, 10], [13.5, 52.6]],
    }),
  );
  assert.deepEqual(mixed.paths[0].geometry.coordinates[0], [13.4, 52.5]);

  const full = normalizeGeoJson(
    feature({
      type: "LineString",
      coordinates: [[13.4, 52.5, 10], [13.5, 52.6, 20]],
    }),
  );
  assert.deepEqual(full.paths[0].geometry.coordinates[0], [13.4, 52.5, 10]);
});

test("rejects files without usable geometry", () => {
  assert.throws(
    () =>
      normalizeGeoJson({
        type: "FeatureCollection",
        features: [feature({ type: "Point", coordinates: [13.4, 52.5] })],
      }),
    /no usable line or polygon/,
  );
  assert.throws(() => normalizeGeoJson({ type: "FeatureCollection" }), /features array/);
});

test("creates outlines for every polygon ring", () => {
  const result = normalizeGeoJson({
    type: "FeatureCollection",
    features: [
      feature(
        {
          type: "Polygon",
          coordinates: [
            [[0, 0], [1, 0], [1, 1], [0, 0]],
            [[0.2, 0.2], [0.3, 0.2], [0.3, 0.3], [0.2, 0.2]],
          ],
        },
        { name: "zone" },
      ),
    ],
  });
  const outlines = areasToOutlines(result.areas);
  assert.equal(outlines.length, 2);
  assert.equal(outlines[0].properties.name, "zone");
  assert.deepEqual(outlines[0].geometry.coordinates[0], outlines[0].geometry.coordinates.at(-1));
});

test("computes and intersects bounding boxes", () => {
  assert.deepEqual(computeBbox([[13.4, 52.5], [13.5, 52.6]]), [13.4, 52.5, 13.5, 52.6]);
  assert.equal(bboxIntersects([0, 0, 2, 2], [1, 1, 3, 3]), true);
  assert.equal(bboxIntersects([0, 0, 1, 1], [2, 2, 3, 3]), false);
  assert.equal(bboxIntersects(null, [2, 2, 3, 3]), true);
});
