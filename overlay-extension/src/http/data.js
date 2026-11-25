import { HttpError, InputError, isDate, sendGeoJson } from "../util.js";
import { overlayFeatures } from "../overlays/model.js";
import { isActive, zonedNow } from "../overlays/validity.js";

export function parseBbox(value) {
  if (value == null || value === "") return null;
  const parts = String(value).split(",").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new InputError("bbox must be west,south,east,north");
  }
  const [west, south, east, north] = parts;
  if (west < -180 || west > 180 || east < -180 || east > 180 || south < -90 || south > 90 || north < -90 || north > 90) {
    throw new InputError("bbox coordinates are out of range");
  }
  if (west >= east || south >= north) {
    throw new InputError("bbox must be a non-empty west,south,east,north box");
  }
  return parts;
}

export function parseDateParam(value) {
  if (value == null || value === "") return null;
  if (!isDate(value)) throw new InputError("date must be YYYY-MM-DD");
  return value;
}

export function parseZoom(value) {
  if (value == null || value === "") return null;
  const zoom = Number(value);
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 30) throw new InputError("zoom must be an integer from 0 to 30");
  return zoom;
}

export function handleData({ response, url, config, store, logger, method = "GET" }) {
  const date = parseDateParam(url.searchParams.get("date"));
  const bbox = parseBbox(url.searchParams.get("bbox"));
  const zoom = parseZoom(url.searchParams.get("zoom"));

  if (config.minZoom > 0 && zoom != null && zoom < config.minZoom) {
    sendGeoJson(response, 200, { type: "FeatureCollection", features: [] }, { method });
    return;
  }

  const now = new Date();
  const timezones = new Map();
  const features = [];
  let activeOverlays = 0;

  for (const overlay of store.list()) {
    if (!overlay.enabled) continue;
    const timeZone = overlay.validity.timezone;
    if (!timezones.has(timeZone)) timezones.set(timeZone, zonedNow(timeZone, now));
    if (!isActive(overlay.validity, { now: timezones.get(timeZone), date })) continue;
    activeOverlays++;
    features.push(...overlayFeatures(overlay, bbox));
  }

  const payload = { type: "FeatureCollection", features };
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > config.maxResponseBytes) {
    throw new HttpError(
      413,
      `The overlay response is ${body.length} bytes, above the configured limit of ${config.maxResponseBytes}. Zoom in, shorten the validity, or simplify the files.`,
    );
  }

  logger.debug(
    `overlays date=${date || "*"} bbox=${bbox ? bbox.join(",") : "*"} zoom=${zoom ?? "*"} active=${activeOverlays} features=${features.length} bytes=${body.length}`,
  );
  sendGeoJson(response, 200, payload, { method });
}
