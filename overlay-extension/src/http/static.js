import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError, sendBuffer, sendJson } from "../util.js";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../../public/", import.meta.url)));

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] || "application/octet-stream";
}

function securityHeaders(config) {
  let styleOrigin = "";
  try {
    styleOrigin = new URL(config.mapStyleUrl).origin;
  } catch {
    styleOrigin = "";
  }
  const remoteOrigins = [...new Set([styleOrigin, ...(config.mapTileOrigins || [])].filter(Boolean))];
  const remoteList = remoteOrigins.length > 0 ? ` ${remoteOrigins.join(" ")}` : "";
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${remoteList}`,
    `connect-src 'self'${remoteList}`,
    "font-src 'self' data:",
    "worker-src blob:",
    "child-src blob:",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

async function sendFile(response, path, { method, cacheControl, headers = {} }) {
  let body;
  try {
    body = await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, "Not found");
    throw error;
  }
  sendBuffer(response, 200, body, {
    method,
    headers: {
      "content-type": contentType(path),
      "cache-control": cacheControl,
      ...headers,
    },
  });
}

export async function handleStatic({ response, url, config, store, method = "GET" }) {
  const path = url.pathname;

  if (path === "/health") {
    sendJson(
      response,
      200,
      {
        status: "ok",
        version: "1.0.0",
        uptimeSeconds: Math.round(process.uptime()),
        now: new Date().toISOString(),
        defaultTimezone: config.defaultTimezone,
        overlays: {
          total: store.list().length,
          enabled: store.list().filter((overlay) => overlay.enabled).length,
        },
        layer: { id: config.layerId, name: config.layerName },
        loadErrors: store.loadErrors,
      },
      { method },
    );
    return;
  }

  if (path === "/assets/icon.svg") {
    await sendFile(response, join(PUBLIC_DIR, "img", "icon.svg"), {
      method,
      cacheControl: "public, max-age=3600",
      headers: securityHeaders(config),
    });
    return;
  }

  let relative;
  if (path === "/") relative = "index.html";
  else if (/^\/(app\.(js|css)|vendor\/[a-z0-9._-]+|fonts\/[a-z0-9._-]+|img\/[a-z0-9._-]+)$/i.test(path)) {
    relative = path.slice(1);
  } else {
    throw new HttpError(404, "Not found");
  }

  const file = resolve(join(PUBLIC_DIR, relative));
  if (file !== PUBLIC_DIR && !file.startsWith(`${PUBLIC_DIR}${sep}`)) {
    throw new HttpError(404, "Not found");
  }

  const isEntry = relative === "index.html" || relative === "app.js" || relative === "app.css";
  await sendFile(response, file, {
    method,
    cacheControl: isEntry ? "no-cache" : "public, max-age=86400",
    headers: isEntry ? securityHeaders(config) : { "x-content-type-options": "nosniff" },
  });
}
