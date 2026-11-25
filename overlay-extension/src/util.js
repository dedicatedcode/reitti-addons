export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export class InputError extends HttpError {
  constructor(message) {
    super(400, message);
    this.name = "InputError";
  }
}

export function sendJson(response, status, value, { method = "GET", headers = {} } = {}) {
  const body = Buffer.from(JSON.stringify(value));
  sendBuffer(response, status, body, {
    method,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function sendGeoJson(response, status, value, { method = "GET", headers = {} } = {}) {
  const body = Buffer.from(JSON.stringify(value));
  sendBuffer(response, status, body, {
    method,
    headers: {
      "content-type": "application/geo+json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function sendBuffer(response, status, body, { method = "GET", headers = {} } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  response.writeHead(status, {
    "content-length": buffer.length,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  response.end(method === "HEAD" ? undefined : buffer);
}

export function sendError(response, error, { method = "GET" } = {}) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : "Internal server error";
  sendJson(response, status, { error: message }, { method });
}

export async function readBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function readJsonBody(request, maxBytes) {
  const contentType = (request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const body = await readBody(request, maxBytes);
  if (body.length === 0) throw new InputError("Request body is empty");
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new InputError("Request body is not valid JSON");
  }
}

export function slugify(value, fallback = "overlay") {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function addDays(date, amount) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function parseHexColor(value, fallback = "#d9a441") {
  const match = /^#?([\da-f]{6})$/i.exec(String(value || "").trim());
  return match ? `#${match[1].toLowerCase()}` : fallback;
}

export function hexToRgba(hex, alpha = 255) {
  const value = parseHexColor(hex);
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
    Math.max(0, Math.min(255, Math.round(Number(alpha) || 0))),
  ];
}

export function normalizeText(value, maxLength, field) {
  if (typeof value !== "string") throw new InputError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new InputError(`${field} must not be empty`);
  if (trimmed.length > maxLength) throw new InputError(`${field} is too long (max ${maxLength})`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new InputError(`${field} contains control characters`);
  return trimmed;
}
