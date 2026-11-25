import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegions } from "../src/regions.js";

async function withRegionFile(content, callback) {
  const directory = await mkdtemp(join(tmpdir(), "reitti-regions-"));
  try {
    const path = join(directory, "regions.json");
    await writeFile(path, content);
    return await callback(path, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("loads the built-in NAH.SH region when no file is present", () => {
  const regions = loadRegions({}, { cwd: "/tmp/definitely-no-regions-file" });
  assert.equal(regions.length, 1);
  assert.equal(regions[0].id, "nahsh");
  assert.deepEqual(regions[0].bbox, [7.8, 53.3, 11.4, 55.1]);
  assert.equal(regions[0].minZoom, 10);
  assert.equal(regions[0].maxStopDistanceMeters, 150);
  assert.equal(regions[0].minCoverage, 0.7);
  assert.equal(regions[0].minSimilarity, 0.6);
});

test("loads a configured regions file and normalizes optional fields", async () => {
  const content = JSON.stringify({
    regions: [{
      id: "test-region",
      name: "Test Region",
      bbox: "8,50,9,51",
      staticUrl: "https://example.com/gtfs.zip",
      minZoom: 7,
      priority: 3,
      maxStopDistanceMeters: 250,
      minCoverage: 0.8,
      minSimilarity: 0.5,
      cacheFile: "custom.zip",
    }],
  });
  await withRegionFile(content, async (path) => {
    const regions = loadRegions({ REGIONS_FILE: path });
    assert.equal(regions.length, 1);
    assert.deepEqual(regions[0].bbox, [8, 50, 9, 51]);
    assert.equal(regions[0].minZoom, 7);
    assert.equal(regions[0].priority, 3);
    assert.equal(regions[0].maxStopDistanceMeters, 250);
    assert.equal(regions[0].minCoverage, 0.8);
    assert.equal(regions[0].minSimilarity, 0.5);
    assert.equal(regions[0].cacheFile, "custom.zip");
  });
});

test("skips disabled regions and accepts a bare array", async () => {
  const content = JSON.stringify([
    { id: "enabled", bbox: [8, 50, 9, 51], staticUrl: "https://example.com/a.zip" },
    { id: "disabled", bbox: [8, 50, 9, 51], staticUrl: "https://example.com/b.zip", enabled: false },
  ]);
  await withRegionFile(content, async (path) => {
    const regions = loadRegions({ REGIONS_FILE: path });
    assert.deepEqual(regions.map((region) => region.id), ["enabled"]);
  });
});

test("rejects invalid region configuration", async () => {
  await withRegionFile(JSON.stringify({
    regions: [{ id: "bad id", bbox: [8, 50, 9, 51], staticUrl: "https://example.com/a.zip" }],
  }), async (path) => {
    assert.throws(() => loadRegions({ REGIONS_FILE: path }), /id contains invalid characters/);
  });
  await withRegionFile(JSON.stringify({
    regions: [{ id: "bad", bbox: [9, 50, 8, 51], staticUrl: "https://example.com/a.zip" }],
  }), async (path) => {
    assert.throws(() => loadRegions({ REGIONS_FILE: path }), /bbox is outside/);
  });
  await withRegionFile(JSON.stringify({
    regions: [{ id: "bad", bbox: [8, 50, 9, 51], staticUrl: "ftp://example.com/a.zip" }],
  }), async (path) => {
    assert.throws(() => loadRegions({ REGIONS_FILE: path }), /HTTP or HTTPS/);
  });
  await withRegionFile(JSON.stringify({
    regions: [
      { id: "same", bbox: [8, 50, 9, 51], staticUrl: "https://example.com/a.zip" },
      { id: "same", bbox: [8, 50, 9, 51], staticUrl: "https://example.com/b.zip" },
    ],
  }), async (path) => {
    assert.throws(() => loadRegions({ REGIONS_FILE: path }), /defined more than once/);
  });
  await withRegionFile("not json", async (path) => {
    assert.throws(() => loadRegions({ REGIONS_FILE: path }), /not valid JSON/);
  });
});
