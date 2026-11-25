import { strToU8, zipSync } from "fflate";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

export const NOW_MS = 1_000_000;

export function staticZip() {
  return Buffer.from(zipSync({
    "routes.txt": strToU8([
      "route_id,route_short_name,agency_id,route_long_name",
      'r1,"1",svl,"City, Centre"',
      "r2,2,other,Airport",
      ",ignored,svl,Ignored",
      "",
    ].join("\n")),
    "trips.txt": strToU8([
      "route_id,service_id,trip_id,trip_headsign",
      'r1,weekday,t1,"Hauptbahnhof, Zentrum"',
      "r2,weekday,t2,Airport",
      "r1,weekday,t3,",
      "",
    ].join("\n")),
    "stops.txt": strToU8("stop_id,stop_name\nunused,Unused\n"),
  }));
}

export function feedBuffer({ headerTimestamp = 980, entities = [] } = {}) {
  return Buffer.from(FeedMessage.encode(FeedMessage.create({
    header: {
      gtfsRealtimeVersion: "2.0",
      incrementality: "FULL_DATASET",
      timestamp: headerTimestamp,
    },
    entity: entities,
  })).finish());
}

export function decodeFeed(buffer) {
  return FeedMessage.decode(buffer);
}

export function vehicleEntity(id, {
  tripId = "t1",
  routeId,
  timestamp,
  longitude = 10.7,
  latitude = 53.86,
  bearing,
  speed,
  descriptorId = id,
} = {}) {
  return {
    id,
    vehicle: {
      trip: { tripId, routeId },
      position: { longitude, latitude, bearing, speed },
      timestamp,
      vehicle: { id: descriptorId },
    },
  };
}

export function baseEnvironment(upstreamUrl) {
  return {
    GTFS_RT_URL: `${upstreamUrl}/realtime`,
    GTFS_STATIC_URL: `${upstreamUrl}/static.zip`,
    BBOX: "10.55,53.78,10.92,53.99",
    STALE_AFTER_SECONDS: "90",
    REFRESH_INTERVAL_MS: "15000",
    STATIC_REFRESH_INTERVAL_MS: "21600000",
  };
}

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

export async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
