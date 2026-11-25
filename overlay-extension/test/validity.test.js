import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeValidity,
  isActive,
  normalizeValidity,
  zonedNow,
} from "../src/overlays/validity.js";

const TZ = "Europe/Berlin";

function now(date, hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  return { date, minutes: hour * 60 + minute };
}

function range(overrides = {}) {
  return {
    mode: "range",
    timezone: TZ,
    startDate: "2026-08-30",
    startTime: "10:00",
    endDate: "2026-08-30",
    endTime: "12:00",
    dailyStart: null,
    dailyEnd: null,
    ...overrides,
  };
}

function daily(overrides = {}) {
  return {
    mode: "daily",
    timezone: TZ,
    dailyStart: "22:00",
    dailyEnd: "02:00",
    startDate: null,
    endDate: null,
    ...overrides,
  };
}

test("zonedNow converts to the requested time zone", () => {
  assert.deepEqual(zonedNow("UTC", new Date("2026-08-30T12:34:00Z")), {
    date: "2026-08-30",
    minutes: 754,
  });
  assert.deepEqual(zonedNow(TZ, new Date("2026-08-30T12:34:00Z")), {
    date: "2026-08-30",
    minutes: 874,
  });
  assert.deepEqual(zonedNow("America/Los_Angeles", new Date("2026-08-30T05:34:00Z")), {
    date: "2026-08-29",
    minutes: 22 * 60 + 34,
  });
});

test("zonedNow handles the midnight hour", () => {
  assert.deepEqual(zonedNow("UTC", new Date("2026-08-30T00:05:00Z")), {
    date: "2026-08-30",
    minutes: 5,
  });
});

test("always is active", () => {
  assert.equal(isActive({ mode: "always" }, { now: now("2026-08-30", "10:00") }), true);
});

test("range checks the current minute", () => {
  const validity = range();
  assert.equal(isActive(validity, { now: now("2026-08-30", "09:59") }), false);
  assert.equal(isActive(validity, { now: now("2026-08-30", "10:00") }), true);
  assert.equal(isActive(validity, { now: now("2026-08-30", "12:00") }), true);
  assert.equal(isActive(validity, { now: now("2026-08-30", "12:01") }), false);
});

test("range with open ends", () => {
  const from = range({ endDate: null, endTime: null });
  assert.equal(isActive(from, { now: now("2030-01-01", "00:00") }), true);
  assert.equal(isActive(from, { now: now("2026-08-29", "23:59") }), false);

  const until = range({ startDate: null, startTime: null });
  assert.equal(isActive(until, { now: now("2020-01-01", "00:00") }), true);
  assert.equal(isActive(until, { now: now("2026-08-30", "12:01") }), false);
});

test("other map days use whole-day overlap", () => {
  const validity = range();
  assert.equal(isActive(validity, { now: now("2026-09-10", "00:00"), date: "2026-08-30" }), true);
  assert.equal(isActive(validity, { now: now("2026-09-10", "00:00"), date: "2026-08-31" }), false);
});

test("daily window is inclusive and supports overnight", () => {
  const validity = daily();
  assert.equal(isActive(validity, { now: now("2026-08-30", "21:59") }), false);
  assert.equal(isActive(validity, { now: now("2026-08-30", "22:00") }), true);
  assert.equal(isActive(validity, { now: now("2026-08-30", "23:59") }), true);
  assert.equal(isActive(validity, { now: now("2026-08-31", "00:00") }), true);
  assert.equal(isActive(validity, { now: now("2026-08-31", "02:00") }), true);
  assert.equal(isActive(validity, { now: now("2026-08-31", "02:01") }), false);
  assert.equal(isActive(validity, { now: now("2026-08-31", "12:00") }), false);
});

test("daily window respects an optional date range", () => {
  const validity = daily({ startDate: "2026-08-30", endDate: "2026-09-02" });
  assert.equal(isActive(validity, { now: now("2026-08-29", "23:00") }), false);
  assert.equal(isActive(validity, { now: now("2026-08-30", "23:00") }), true);
  assert.equal(isActive(validity, { now: now("2026-09-03", "01:00") }), true);
  assert.equal(isActive(validity, { now: now("2026-09-04", "01:00") }), false);
});

test("equal daily start and end means all day", () => {
  const validity = daily({ dailyStart: "00:00", dailyEnd: "00:00" });
  assert.equal(isActive(validity, { now: now("2026-08-30", "12:00") }), true);
});

test("other map days ignore the daily time window", () => {
  const validity = daily({ startDate: "2026-08-30", endDate: "2026-09-02" });
  assert.equal(isActive(validity, { now: now("2026-09-10", "00:00"), date: "2026-09-01" }), true);
  assert.equal(isActive(validity, { now: now("2026-09-10", "00:00"), date: "2026-09-03" }), false);
});

test("describes validity", () => {
  assert.equal(describeValidity({ mode: "always" }), "Always");
  assert.match(describeValidity(range()), /2026-08-30 10:00 → 2026-08-30 12:00/);
  assert.match(describeValidity(daily()), /Daily 22:00–02:00/);
});

test("validates validity input", () => {
  assert.throws(() => normalizeValidity({ mode: "range", timezone: TZ }), /start date/);
  assert.throws(() => normalizeValidity({ mode: "daily", timezone: TZ }), /dailyStart/);
  assert.throws(
    () => normalizeValidity({ mode: "range", timezone: TZ, startDate: "2026-09-02", endDate: "2026-09-01" }),
    /after/,
  );
  assert.throws(() => normalizeValidity({ mode: "nope", timezone: TZ }), /mode/);
  assert.throws(() => normalizeValidity({ mode: "always", timezone: "Mars/Olympus" }), /time zone/);
});

test("normalizes defaults", () => {
  const rangeValidity = normalizeValidity(
    { mode: "range", timezone: TZ, startDate: "2026-08-30" },
    TZ,
  );
  assert.equal(rangeValidity.startTime, "00:00");
  assert.equal(rangeValidity.endDate, null);
  assert.equal(rangeValidity.endTime, null);

  const dailyValidity = normalizeValidity(
    { mode: "daily", timezone: TZ, dailyStart: "08:00", dailyEnd: "09:00" },
    TZ,
  );
  assert.equal(dailyValidity.startDate, null);
  assert.equal(dailyValidity.endDate, null);
});
