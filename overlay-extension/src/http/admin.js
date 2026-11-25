import {
  HttpError,
  InputError,
  readJsonBody,
  sendGeoJson,
  sendJson,
} from "../util.js";
import { exportFeatureCollection, summary } from "../overlays/model.js";
import { isActive, zonedNow } from "../overlays/validity.js";

const MAX_JSON_BODY = 24 * 1024 * 1024;

function registrationUrl(request, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "")
    .split(",")[0]
    .trim();
  if (!host) return "";
  const proto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "http";
  return `${proto}://${host}`;
}

function configPayload(request, config) {
  return {
    extensionName: config.extensionName,
    layerName: config.layerName,
    registrationUrl: registrationUrl(request, config),
    defaultTimezone: config.defaultTimezone,
    mapStyleUrl: config.mapStyleUrl,
    layerStyle: { color: config.lineColor, lineWidth: config.lineWidth },
    limits: {
      maxUploadBytes: config.maxUploadBytes,
      maxResponseBytes: config.maxResponseBytes,
    },
  };
}

function parseContent(payload, config) {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InputError("Request body must be a JSON object");
  }
  if (typeof payload.content !== "string" || !payload.content.trim()) {
    throw new InputError("content must be the file contents as a string");
  }
  if (Buffer.byteLength(payload.content) > config.maxUploadBytes) {
    throw new HttpError(413, `The upload is larger than ${config.maxUploadBytes} bytes`);
  }
  return {
    name: payload.name,
    filename: payload.filename,
    format: payload.format,
    content: payload.content,
    timezone: payload.timezone,
    validity: payload.validity,
    style: payload.style,
    enabled: payload.enabled,
  };
}

async function listOverlays(config, store) {
  const now = new Date();
  const overlays = store.list().map((overlay) =>
    summary(overlay, { now, date: null, maxResponseBytes: config.maxResponseBytes }),
  );
  return {
    overlays,
    totalBytes: overlays.filter((overlay) => overlay.enabled).reduce((total, overlay) => total + (overlay.stats.bytes || 0), 0),
  };
}

export async function handleAdmin({ request, response, url, config, store, logger, method = "GET" }) {
  const path = url.pathname;

  if (path === "/api/config" && method === "GET") {
    sendJson(response, 200, configPayload(request, config), { method });
    return;
  }

  if (path === "/api/overlays" && method === "GET") {
    const payload = await listOverlays(config, store);
    sendJson(response, 200, payload, { method });
    return;
  }

  if (path === "/api/overlays" && method === "POST") {
    const body = await readJsonBody(request, MAX_JSON_BODY);
    const overlay = await store.create(parseContent(body, config));
    logger.info(`created overlay ${overlay.id} (${overlay.stats.pathFeatures} paths, ${overlay.stats.areaFeatures} areas)`);
    sendJson(response, 201, summary(overlay, { maxResponseBytes: config.maxResponseBytes }), { method });
    return;
  }

  const geometryMatch = /^\/api\/overlays\/([^/]+)\/geometry$/.exec(path);
  if (geometryMatch && method === "POST") {
    const body = await readJsonBody(request, MAX_JSON_BODY);
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      throw new InputError("Request body must be a JSON object");
    }
    if (typeof body.content !== "string" || !body.content.trim()) {
      throw new InputError("content must be the file contents as a string");
    }
    if (Buffer.byteLength(body.content) > config.maxUploadBytes) {
      throw new HttpError(413, `The upload is larger than ${config.maxUploadBytes} bytes`);
    }
    const overlay = await store.replaceGeometry(geometryMatch[1], body);
    logger.info(`replaced geometry for ${overlay.id}`);
    sendJson(response, 200, summary(overlay, { maxResponseBytes: config.maxResponseBytes }), { method });
    return;
  }

  const exportMatch = /^\/api\/overlays\/([^/]+)\/export\.geojson$/.exec(path);
  if (exportMatch && method === "GET") {
    const overlay = store.get(exportMatch[1]);
    if (!overlay) throw new HttpError(404, "Overlay not found");
    sendGeoJson(response, 200, exportFeatureCollection(overlay), {
      method,
      headers: { "content-disposition": `attachment; filename="${overlay.id}.geojson"` },
    });
    return;
  }

  const overlayMatch = /^\/api\/overlays\/([^/]+)$/.exec(path);
  if (overlayMatch && method === "PUT") {
    const body = await readJsonBody(request, MAX_JSON_BODY);
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      throw new InputError("Request body must be a JSON object");
    }
    if (body.content !== undefined || body.filename !== undefined || body.format !== undefined) {
      throw new InputError("Use POST /api/overlays/:id/geometry to replace the file");
    }
    const overlay = await store.update(overlayMatch[1], body);
    sendJson(response, 200, summary(overlay, { maxResponseBytes: config.maxResponseBytes }), { method });
    return;
  }

  if (overlayMatch && method === "DELETE") {
    await store.remove(overlayMatch[1]);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }

  if (path === "/api/preview.geojson" && method === "GET") {
    const now = new Date();
    const timezones = new Map();
    const features = [];
    for (const overlay of store.list()) {
      const timeZone = overlay.validity.timezone;
      if (!timezones.has(timeZone)) timezones.set(timeZone, zonedNow(timeZone, now));
      const active = isActive(overlay.validity, { now: timezones.get(timeZone), date: null });
      const base = {
        overlayId: overlay.id,
        overlayName: overlay.name,
        color: overlay.style.color,
        lineWidth: overlay.style.lineWidth,
        active,
        enabled: overlay.enabled,
      };
      for (const path of overlay.geometry.paths) {
        features.push({
          type: "Feature",
          properties: { ...base, kind: "path", ...(path.properties?.name ? { name: path.properties.name } : {}) },
          geometry: path.geometry,
        });
      }
      for (const area of overlay.geometry.areas) {
        features.push({
          type: "Feature",
          properties: { ...base, kind: "area", ...(area.properties?.name ? { name: area.properties.name } : {}) },
          geometry: area.geometry,
        });
      }
    }
    sendGeoJson(response, 200, { type: "FeatureCollection", features }, { method });
    return;
  }

  throw new HttpError(404, "Not found");
}
