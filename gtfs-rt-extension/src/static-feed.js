import { parse } from "csv-parse/sync";
import yauzl from "yauzl";

const MAX_ROUTES_BYTES = 32 * 1024 * 1024;
const MAX_TRIPS_BYTES = 128 * 1024 * 1024;

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function findEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    zip.on("error", reject);
    zip.on("entry", (entry) => {
      if (["routes.txt", "trips.txt"].includes(entry.fileName)) {
        entries.set(entry.fileName, entry);
      }
      zip.readEntry();
    });
    zip.on("end", () => resolve(entries));
    zip.readEntry();
  });
}

function readEntry(zip, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > maxBytes) {
      reject(new Error(`${entry.fileName} exceeds the ${maxBytes}-byte limit`));
      return;
    }

    zip.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          stream.destroy(new Error(`${entry.fileName} exceeds the ${maxBytes}-byte limit`));
        } else {
          chunks.push(chunk);
        }
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks, size)));
    });
  });
}

function parseRows(buffer, fileName) {
  try {
    return parse(buffer, {
      bom: true,
      columns: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (error) {
    throw new Error(`Could not parse ${fileName}: ${error.message}`);
  }
}

export async function parseStaticFeed(buffer) {
  const zip = await openZip(buffer);
  try {
    const entries = await findEntries(zip);
    for (const fileName of ["routes.txt", "trips.txt"]) {
      if (!entries.has(fileName)) throw new Error(`Static GTFS ZIP is missing ${fileName}`);
    }

    const [routesBuffer, tripsBuffer] = await Promise.all([
      readEntry(zip, entries.get("routes.txt"), MAX_ROUTES_BYTES),
      readEntry(zip, entries.get("trips.txt"), MAX_TRIPS_BYTES),
    ]);

    const routes = new Map();
    for (const row of parseRows(routesBuffer, "routes.txt")) {
      if (!row.route_id) continue;
      routes.set(row.route_id, {
        shortName: row.route_short_name || "",
        agencyId: row.agency_id || "",
      });
    }

    const trips = new Map();
    for (const row of parseRows(tripsBuffer, "trips.txt")) {
      if (!row.trip_id) continue;
      trips.set(row.trip_id, {
        routeId: row.route_id || null,
        headsign: row.trip_headsign || "",
      });
    }

    return { routes, trips };
  } finally {
    zip.close();
  }
}

export function emptyStaticFeed() {
  return { routes: new Map(), trips: new Map() };
}
