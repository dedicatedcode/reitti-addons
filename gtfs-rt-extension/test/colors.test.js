import test from "node:test";
import assert from "node:assert/strict";
import { colorForLine, parseHexColor } from "../src/colors.js";

test("parses official six-digit hex colors into opaque RGBA arrays", () => {
  assert.deepEqual(parseHexColor("1282DC"), [18, 130, 220, 255]);
  assert.deepEqual(parseHexColor("#cc0066"), [204, 0, 102, 255]);
  assert.equal(parseHexColor("fff"), null);
  assert.equal(parseHexColor("not-a-color"), null);
  assert.equal(parseHexColor(null), null);
});

test("uses official colors first and a stable pleasant palette fallback by line", () => {
  assert.deepEqual(colorForLine("M4", "#cc0066"), [204, 0, 102, 255]);
  const fallback = colorForLine("M4");
  assert.deepEqual(fallback, colorForLine("M4"));
  assert.deepEqual(fallback, colorForLine("M4", "invalid"));
  assert.equal(fallback.length, 4);
  assert.equal(fallback[3], 255);
  assert.ok(fallback.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255));
  assert.notDeepEqual(fallback, colorForLine("RE1"));
});
