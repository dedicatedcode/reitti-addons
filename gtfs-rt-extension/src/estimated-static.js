import { parse as csvParse } from "csv-parse";
import { createInterface } from "node:readline";
import yauzl from "yauzl";
import { parseHexColor } from "./colors.js";

const DEFAULT_TIMEZONE = "Europe/Berlin";
const ENTRY_LIMITS = Object.freeze({
  "agency.txt": 16 * 1024 * 1024,
  "stops.txt": 512 * 1024 * 1024,
  "stop_times.txt": 4 * 1024 * 1024 * 1024,
  "trips.txt": 1024 * 1024 * 1024,
  "routes.txt": 128 * 1024 * 1024,
  "shapes.txt": 4 * 1024 * 1024 * 1024,
});
const REQUIRED_ENTRIES = ["stops.txt", "stop_times.txt", "trips.txt", "routes.txt"];

export function openZip(source) {
  return new Promise((resolve, reject) => {
    const options = { lazyEntries: true, autoClose: false };
    const callback = (error, zip) => error ? reject(error) : resolve(zip);
    if (Buffer.isBuffer(source)) yauzl.fromBuffer(source, options, callback);
    else yauzl.open(source, options, callback);
  });
}

export function listEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    zip.on("error", reject);
    zip.on("entry", (entry) => {
      if (Object.hasOwn(ENTRY_LIMITS, entry.fileName)) entries.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.on("end", () => resolve(entries));
    zip.readEntry();
  });
}

function entryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

export function number(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function integer(value) {
  const parsed = number(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

export function coordinate(lat, lon) {
  return lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function parseGtfsTime(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export async function eachRow(zip, entry, maxBytes, visit) {
  if (entry.uncompressedSize > maxBytes) {
    throw new Error(`${entry.fileName} exceeds the ${maxBytes}-byte limit`);
  }
  const stream = await entryStream(zip, entry);
  const parser = csvParse({
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });
  stream.on("error", (error) => parser.destroy(error));
  stream.pipe(parser);
  let size = 0;
  stream.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`${entry.fileName} exceeds the ${maxBytes}-byte limit`);
      stream.destroy(error);
      parser.destroy(error);
    }
  });

  try {
    for await (const row of parser) await visit(row);
  } catch (error) {
    throw new Error(`Could not parse ${entry.fileName}: ${error.message}`);
  } finally {
    stream.destroy();
  }
}

const STOP_TIME_COLUMNS = [
  "trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "stop_headsign",
  "shape_dist_traveled",
];

function csvFields(line, maxIndex) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      fields.push(field);
      field = "";
      if (fields.length > maxIndex) return fields;
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

async function eachStopTimeRow(zip, entry, maxBytes, visit, { tripIds = null } = {}) {
  if (entry.uncompressedSize > maxBytes) {
    throw new Error(`${entry.fileName} exceeds the ${maxBytes}-byte limit`);
  }
  const stream = await entryStream(zip, entry);
  const parser = createInterface({ input: stream, crlfDelay: Infinity });
  let size = 0;
  let header = null;
  let indices = null;
  let maxIndex = 0;
  stream.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBytes) stream.destroy(new Error(`${entry.fileName} exceeds the ${maxBytes}-byte limit`));
  });

  try {
    for await (const line of parser) {
      if (header === null) {
        header = csvFields(line.replace(/^\uFEFF/, ""), 32);
        indices = Object.fromEntries(header.map((name, index) => [name.trim(), index]));
        for (const name of STOP_TIME_COLUMNS) {
          if (indices[name] === undefined) {
            if (name === "shape_dist_traveled" || name === "stop_headsign") indices[name] = -1;
            else throw new Error(`missing ${name} column`);
          }
        }
        maxIndex = Math.max(...STOP_TIME_COLUMNS.map(name => indices[name]).filter(index => index >= 0));
        continue;
      }
      if (!line) continue;
      const fields = csvFields(line, maxIndex);
      const tripId = fields[indices.trip_id];
      if (!tripId || (tripIds && !tripIds.has(tripId))) continue;
      await visit({
        trip_id: tripId,
        arrival_time: fields[indices.arrival_time] ?? "",
        departure_time: fields[indices.departure_time] ?? "",
        stop_id: fields[indices.stop_id] ?? "",
        stop_sequence: fields[indices.stop_sequence] ?? "",
        stop_headsign: indices.stop_headsign >= 0 ? fields[indices.stop_headsign] ?? "" : "",
        shape_dist_traveled: indices.shape_dist_traveled >= 0
          ? fields[indices.shape_dist_traveled] ?? "" : "",
      });
    }
    if (header === null) throw new Error("file is empty");
  } catch (error) {
    throw new Error(`Could not parse ${entry.fileName}: ${error.message}`);
  } finally {
    parser.close();
    stream.destroy();
  }
}

function checkLimit(size, limit, description) {
  if (size > limit) throw new Error(`Static GTFS ${description} exceeds the ${limit} entry limit`);
}

function validTimezone(value) {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

async function buildIndex(zip, entries, options) {
  for (const fileName of REQUIRED_ENTRIES) {
    if (!entries.has(fileName)) throw new Error(`Static GTFS ZIP is missing ${fileName}`);
  }

  const limits = {
    maxSelectedTrips: options.maxSelectedTrips ?? 250_000,
    maxSelectedShapePoints: options.maxSelectedShapePoints ?? 10_000_000,
  };
  const [west, south, east, north] = options.bbox;
  let selectedTripIds = options.tripIds ? new Set(options.tripIds) : null;
  if (!selectedTripIds) {
    const bboxStopIds = new Set();
    await eachRow(zip, entries.get("stops.txt"), ENTRY_LIMITS["stops.txt"], async (row) => {
      const lat = number(row.stop_lat);
      const lon = number(row.stop_lon);
      if (!row.stop_id || !coordinate(lat, lon)) return;
      if (lon >= west && lon <= east && lat >= south && lat <= north) {
        bboxStopIds.add(row.stop_id);
      }
    });

    selectedTripIds = new Set();
    await eachRow(zip, entries.get("stop_times.txt"), ENTRY_LIMITS["stop_times.txt"], async (row) => {
      if (row.trip_id && bboxStopIds.has(row.stop_id)) {
        selectedTripIds.add(row.trip_id);
        checkLimit(selectedTripIds.size, limits.maxSelectedTrips, "selected trips");
      }
    });
  }

  const trips = new Map();
  const selectedRouteIds = new Set();
  const selectedShapeIds = new Set();
  await eachRow(zip, entries.get("trips.txt"), ENTRY_LIMITS["trips.txt"], async (row) => {
    if (!selectedTripIds.has(row.trip_id)) return;
    const trip = {
      tripId: row.trip_id,
      routeId: row.route_id || null,
      headsign: row.trip_headsign || "",
      shapeId: row.shape_id || null,
      stopTimes: [],
    };
    trips.set(row.trip_id, trip);
    if (trip.routeId) selectedRouteIds.add(trip.routeId);
    if (trip.shapeId) selectedShapeIds.add(trip.shapeId);
  });

  const neededStopIds = new Set();
  let selectedStopTimeRows = 0;
  await eachStopTimeRow(zip, entries.get("stop_times.txt"), ENTRY_LIMITS["stop_times.txt"], async (row) => {
    const trip = trips.get(row.trip_id);
    const stopSequence = integer(row.stop_sequence);
    if (!trip || !row.stop_id || stopSequence === null) return;
    if (!trip.headsign && row.stop_headsign) trip.headsign = row.stop_headsign;
    selectedStopTimeRows += 1;
    neededStopIds.add(row.stop_id);
    trip.stopTimes.push({
      stopId: row.stop_id,
      stopSequence,
      arrivalSeconds: parseGtfsTime(row.arrival_time),
      departureSeconds: parseGtfsTime(row.departure_time),
      shapeDistTraveled: number(row.shape_dist_traveled),
    });
  }, { tripIds: selectedTripIds });
  for (const trip of trips.values()) {
    trip.stopTimes.sort((a, b) => a.stopSequence - b.stopSequence);
  }

  const stops = new Map();
  await eachRow(zip, entries.get("stops.txt"), ENTRY_LIMITS["stops.txt"], async (row) => {
    if (!neededStopIds.has(row.stop_id)) return;
    const lat = number(row.stop_lat);
    const lon = number(row.stop_lon);
    if (!coordinate(lat, lon)) return;
    stops.set(row.stop_id, {
      stopId: row.stop_id,
      name: row.stop_name || row.stop_id,
      lat,
      lon,
    });
  });

  const routes = new Map();
  await eachRow(zip, entries.get("routes.txt"), ENTRY_LIMITS["routes.txt"], async (row) => {
    if (!selectedRouteIds.has(row.route_id)) return;
    routes.set(row.route_id, {
      routeId: row.route_id,
      shortName: row.route_short_name || "",
      routeType: integer(row.route_type),
      lineColor: parseHexColor(row.route_color),
      agencyId: row.agency_id || null,
      operator: null,
    });
  });

  let timezone = DEFAULT_TIMEZONE;
  if (entries.has("agency.txt")) {
    const selectedAgencyIds = new Set([...routes.values()].map((route) => route.agencyId).filter(Boolean));
    let defaultAgency = null;
    let timezoneAgency = null;
    await eachRow(zip, entries.get("agency.txt"), ENTRY_LIMITS["agency.txt"], async (row) => {
      const agency = {
        agencyId: row.agency_id || null,
        name: row.agency_name || null,
        timezone: validTimezone(row.agency_timezone) ? row.agency_timezone : null,
      };
      if (!defaultAgency) defaultAgency = agency;
      if (!timezoneAgency && agency.timezone) timezoneAgency = agency;
      if (agency.agencyId && selectedAgencyIds.has(agency.agencyId)) {
        for (const route of routes.values()) {
          if (route.agencyId === agency.agencyId) route.operator = agency.name;
        }
      }
    });
    if (timezoneAgency?.timezone) timezone = timezoneAgency.timezone;
    if (routes.size > 0 && [...routes.values()].every((route) => !route.agencyId)) {
      for (const route of routes.values()) route.operator = defaultAgency?.name || null;
    }
  }

  const shapes = new Map();
  let selectedShapePoints = 0;
  if (entries.has("shapes.txt")) {
    await eachRow(zip, entries.get("shapes.txt"), ENTRY_LIMITS["shapes.txt"], async (row) => {
      if (!selectedShapeIds.has(row.shape_id)) return;
      const lat = number(row.shape_pt_lat);
      const lon = number(row.shape_pt_lon);
      const sequence = integer(row.shape_pt_sequence);
      if (!coordinate(lat, lon) || sequence === null) return;
      selectedShapePoints += 1;
      checkLimit(selectedShapePoints, limits.maxSelectedShapePoints, "selected shape points");
      if (!shapes.has(row.shape_id)) shapes.set(row.shape_id, []);
      shapes.get(row.shape_id).push({
        lat,
        lon,
        sequence,
        distTraveled: number(row.shape_dist_traveled),
      });
    });
    for (const points of shapes.values()) points.sort((a, b) => a.sequence - b.sequence);
  }

  return {
    trips,
    routes,
    stops,
    shapes,
    timezone,
    stats: {
      selectedTrips: trips.size,
      selectedStops: stops.size,
      selectedStopTimes: selectedStopTimeRows,
      selectedShapePoints,
    },
  };
}

async function parse(source, options) {
  if (!Array.isArray(options?.bbox) || options.bbox.length !== 4) {
    throw new Error("A BBOX is required to build the estimated static index");
  }
  let zip;
  try {
    zip = await openZip(source);
  } catch (error) {
    throw new Error(`Could not open static GTFS ZIP: ${error.message}`);
  }
  try {
    const entries = await listEntries(zip);
    return await buildIndex(zip, entries, options);
  } finally {
    zip.close();
  }
}

export async function buildEstimatedStaticIndex(zipPath, options) {
  if (typeof zipPath !== "string" || !zipPath) throw new Error("A static GTFS ZIP path is required");
  return parse(zipPath, options);
}

export async function parseEstimatedStaticFeed(buffer, options) {
  if (!Buffer.isBuffer(buffer)) throw new Error("A static GTFS ZIP buffer is required");
  return parse(buffer, options);
}

export function emptyEstimatedStaticIndex() {
  return {
    trips: new Map(),
    routes: new Map(),
    stops: new Map(),
    shapes: new Map(),
    timezone: DEFAULT_TIMEZONE,
  };
}
