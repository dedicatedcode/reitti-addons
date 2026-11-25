import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { buildManifest } from "./manifest.js";
import { applyViewport, parseViewport } from "./viewport.js";

const busIcon = readFileSync(new URL("../assets/bus.svg", import.meta.url));
const attribution = readFileSync(new URL("../assets/ATTRIBUTION.txt", import.meta.url));
const modelNames = [
  "bus", "bus-colored",
  "tram", "tram-colored",
  "train", "train-colored",
  "subway", "subway-colored",
  "high-speed", "high-speed-colored",
  "sbahn", "ic", "ice",
];
const models = new Map(modelNames.map(name => [name, readFileSync(new URL(`../assets/${name}.glb`, import.meta.url))]));
const manifests = {
  "/reitti-extension.json": buildManifest,
  "/reitti-extension-colored.json": (config) => buildManifest(config, "colored"),
};

function currentGermanDate() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function send(response, status, headers, body, method = "GET") {
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(method === "HEAD" ? undefined : body);
}

function sendJson(response, status, value, method) {
  send(response, status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  }, JSON.stringify(value), method);
}

function authorized(request, apiKey) {
  if (!apiKey) return true;
  const match = /^Bearer\s+(.+)$/.exec(request.headers.authorization || "");
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(apiKey);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requestMinZoom(config) {
  return config.feedType === "germany" || config.feedType === "gtfs-rt-estimated"
    ? Math.min(config.minZoom, 5)
    : config.minZoom;
}

function modelMinZooms(config) {
  const longDistance = Math.min(config.minZoom, 5);
  return {
    bus: config.minZoom,
    tram: config.minZoom,
    train: config.minZoom,
    subway: config.minZoom,
    sbahn: config.minZoom,
    ic: longDistance,
    ice: longDistance,
    ferry: config.minZoom,
    other: config.minZoom,
  };
}

export function createHttpServer(config, service, { logger = console } = {}) {
  return createServer(async (request, response) => {
    const method = request.method || "GET";
    if (!["GET", "HEAD"].includes(method)) {
      sendJson(response, 405, { error: "Method not allowed" }, method);
      return;
    }

    let requestUrl;
    let pathname;
    try {
      requestUrl = new URL(request.url, "http://localhost");
      pathname = requestUrl.pathname;
    } catch {
      sendJson(response, 400, { error: "Invalid request URL" }, method);
      return;
    }

    try {
      if (pathname === "/health") {
        const health = service.getHealth();
        sendJson(response, health.status === "ok" ? 200 : 503, health, method);
        return;
      }
      if (pathname === "/assets/bus.svg") {
        send(response, 200, {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=3600",
        }, busIcon, method);
        return;
      }
      if (pathname === "/assets/ATTRIBUTION.txt" || pathname === "/attribution") {
        send(response, 200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "public, max-age=3600",
        }, attribution, method);
        return;
      }
      const modelMatch = /^\/assets\/([a-z0-9-]+)\.glb$/.exec(pathname);
      if (modelMatch && models.has(modelMatch[1])) {
        send(response, 200, {
          "content-type": "model/gltf-binary",
          "cache-control": "public, max-age=3600",
        }, models.get(modelMatch[1]), method);
        return;
      }
      if (!["/vehicles", "/reitti-extensions.json", ...Object.keys(manifests)].includes(pathname)) {
        sendJson(response, 404, { error: "Not found" }, method);
        return;
      }
      if (!authorized(request, config.extensionApiKey)) {
        response.setHeader("www-authenticate", 'Bearer realm="reitti-gtfs-rt-extension"');
        sendJson(response, 401, { error: "Unauthorized" }, method);
        return;
      }
      if (manifests[pathname]) {
        sendJson(response, 200, manifests[pathname](config), method);
      } else if (pathname === "/reitti-extensions.json") {
        sendJson(response, 200, {
          extensions: Object.values(manifests).map(build => build(config)),
        }, method);
      } else {
        try {
          const requestedDate = requestUrl.searchParams.get("date");
          let snapshot;
          if (requestedDate && requestedDate !== currentGermanDate()) {
            snapshot = { timestamp: new Date().toISOString(), vehicles: [] };
          } else {
            const viewport = parseViewport(requestUrl.searchParams);
            if (typeof service.observeViewport === "function") {
              service.observeViewport(viewport.bbox, viewport.zoom);
            }
            snapshot = applyViewport(
              service.getSnapshot(),
              requestUrl.searchParams,
              requestMinZoom(config),
              modelMinZooms(config),
            );
          }
          logger.info?.(`Vehicle request bbox=${requestUrl.searchParams.get("bbox") || "*"} zoom=${requestUrl.searchParams.get("zoom") || "*"} date=${requestUrl.searchParams.get("date") || "*"} -> ${snapshot.vehicles.length} vehicles`);
          sendJson(response, 200, snapshot, method);
        } catch (error) {
          sendJson(response, 400, { error: error.message }, method);
        }
      }
    } catch (error) {
      logger.error(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) sendJson(response, 500, { error: "Internal server error" }, method);
      else response.end();
    }
  });
}
