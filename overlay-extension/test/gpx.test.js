import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGpxText } from "../src/overlays/gpx.js";
import { normalizeGeoJson } from "../src/overlays/geometry.js";

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Track A</name><trkseg>
    <trkpt lat="52.51" lon="13.40"><ele>34</ele></trkpt>
    <trkpt lat="52.52" lon="13.41"><ele>35</ele></trkpt>
    <trkpt lat="52.53" lon="13.42"><ele>36</ele></trkpt>
  </trkseg></trk>
  <rte><name>Route B</name>
    <rtept lat="52.50" lon="13.39"/><rtept lat="52.49" lon="13.38"/>
  </rte>
  <wpt lat="52.51" lon="13.40"><name>Waypoint</name></wpt>
</gpx>`;

test("parses tracks, segments and routes", () => {
  const parsed = parseGpxText(GPX);
  assert.equal(parsed.type, "FeatureCollection");
  assert.equal(parsed.features.length, 2);
  assert.equal(parsed.features[0].properties.name, "Track A");
  assert.deepEqual(parsed.features[0].geometry.coordinates[0], [13.4, 52.51, 34]);
  assert.equal(parsed.features[1].properties.name, "Route B");
  assert.equal(parsed.features[1].geometry.coordinates.length, 2);
});

test("normalizes a parsed GPX file", () => {
  const normalized = normalizeGeoJson(parseGpxText(GPX));
  assert.equal(normalized.paths.length, 2);
  assert.equal(normalized.areas.length, 0);
  assert.equal(normalized.stats.points, 5);
});

test("accepts GPX 1.0 with namespace prefixes and self-closing points", () => {
  const gpx = `<gpx xmlns:g="http://www.topografix.com/GPX/1/0" version="1.0">
    <g:trk><g:name>Prefixed</g:name><g:trkseg>
      <g:trkpt lat="1" lon="2"/><g:trkpt lat="3" lon="4"/>
    </g:trkseg></g:trk>
  </gpx>`;
  const normalized = normalizeGeoJson(parseGpxText(gpx));
  assert.equal(normalized.paths.length, 1);
  assert.equal(normalized.paths[0].properties.name, "Prefixed");
  assert.deepEqual(normalized.paths[0].geometry.coordinates, [[2, 1], [4, 3]]);
});

test("drops elevation when only some points have it", () => {
  const gpx = `<gpx><trk><trkseg>
    <trkpt lat="1" lon="2"><ele>10</ele></trkpt>
    <trkpt lat="3" lon="4"/>
  </trkseg></trk></gpx>`;
  const normalized = normalizeGeoJson(parseGpxText(gpx));
  assert.deepEqual(normalized.paths[0].geometry.coordinates[0], [2, 1]);
});

test("rejects empty or unusable GPX", () => {
  assert.throws(() => parseGpxText(""), /empty/);
  assert.throws(() => parseGpxText("<gpx></gpx>"), /no track or route/);
  assert.throws(() => parseGpxText("<gpx><trk><trkseg/></trk></gpx>"), /no track or route/);
  assert.throws(() => parseGpxText("<html></html>"), /not a GPX/);
  assert.throws(() => parseGpxText("not xml"), /valid XML|not a GPX/);
});

test("rejects DTD and entity declarations", () => {
  assert.throws(
    () => parseGpxText('<!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><gpx/>'),
    /DOCTYPE/,
  );
});

test("ignores invalid coordinates", () => {
  const gpx = `<gpx><trk><trkseg>
    <trkpt lat="999" lon="2"/><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/>
  </trkseg></trk></gpx>`;
  const normalized = normalizeGeoJson(parseGpxText(gpx));
  assert.equal(normalized.paths[0].geometry.coordinates.length, 2);
  assert.equal(normalized.stats.ignoredPoints, 1);
});
