import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { OverlayStore } from "../src/overlays/store.js";

const GEOJSON = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Line" },
      geometry: { type: "LineString", coordinates: [[13.4, 52.5], [13.5, 52.6]] },
    },
  ],
});

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), "overlay-store-"));
  const config = loadConfig({ DATA_DIR: dir, DEFAULT_TIMEZONE: "Europe/Berlin" });
  const store = new OverlayStore(config);
  await store.load();
  return { dir, config, store };
}

test("creates, updates, replaces and deletes overlays", async () => {
  const { dir, store } = await makeStore();
  try {
    const created = await store.create({ name: "Test", filename: "test.geojson", format: "geojson", content: GEOJSON });
    assert.equal(created.id, "test");
    assert.equal(created.style.color, "#d9a441");
    assert.equal(created.stats.pathFeatures, 1);
    assert.equal(store.list().length, 1);

    const updated = await store.update(created.id, {
      name: "Renamed",
      enabled: false,
      style: { color: "#ff0000", lineWidth: 6 },
      validity: { mode: "daily", timezone: "Europe/Berlin", dailyStart: "10:00", dailyEnd: "12:00" },
    });
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.enabled, false);
    assert.equal(updated.style.lineWidth, 6);
    assert.equal(updated.validity.mode, "daily");

    const replaced = await store.replaceGeometry(created.id, {
      filename: "area.geojson",
      format: "geojson",
      content: JSON.stringify({
        type: "Feature",
        properties: { name: "Area" },
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        },
      }),
    });
    assert.equal(replaced.stats.pathFeatures, 0);
    assert.equal(replaced.stats.areaFeatures, 1);
    assert.equal(replaced.outlines.length, 1);

    const raw = JSON.parse(await readFile(join(dir, "overlays", "test.json"), "utf8"));
    assert.equal(raw.name, "Renamed");
    assert.equal(raw.geometry.areas.length, 1);
    assert.equal(raw.outlines, undefined);

    await store.remove(created.id);
    assert.equal(store.list().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loads persisted overlays and creates unique ids", async () => {
  const { dir, config, store } = await makeStore();
  try {
    await store.create({ name: "Same name", filename: "one.geojson", content: GEOJSON });
    await store.create({ name: "Same name", filename: "two.geojson", content: GEOJSON });
    assert.deepEqual(store.list().map((overlay) => overlay.id).sort(), ["same-name", "same-name-2"]);

    const reloaded = new OverlayStore(config);
    await reloaded.load();
    assert.equal(reloaded.list().length, 2);
    assert.equal(reloaded.list()[0].outlines.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports corrupt files without deleting them", async () => {
  const { dir, config } = await makeStore();
  try {
    await mkdir(join(dir, "overlays"), { recursive: true });
    await writeFile(join(dir, "overlays", "broken.json"), "{not json", "utf8");
    const store = new OverlayStore(config);
    await store.load();
    assert.equal(store.list().length, 0);
    assert.equal(store.loadErrors.length, 1);
    assert.equal(store.loadErrors[0].file, "broken.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects invalid uploads", async () => {
  const { dir, store } = await makeStore();
  try {
    await assert.rejects(
      () => store.create({ name: "Bad", filename: "bad.geojson", content: "{}" }),
      /no usable/,
    );
    await assert.rejects(
      () => store.create({ name: "Bad", filename: "bad.txt", content: GEOJSON }),
      /format/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
