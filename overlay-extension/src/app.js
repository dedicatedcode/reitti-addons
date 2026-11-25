import { HttpError, sendError, sendJson } from "./util.js";
import { buildManifest } from "./overlays/manifest.js";
import { handleData } from "./http/data.js";
import { handleAdmin } from "./http/admin.js";
import { handleStatic } from "./http/static.js";

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]);

export function createApp({ config, store, logger }) {
  return async function app(request, response) {
    const method = request.method || "GET";
    let url;
    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      sendError(response, new HttpError(400, "Invalid request URL"), { method });
      return;
    }

    try {
      if (!ALLOWED_METHODS.has(method)) {
        response.setHeader("allow", "GET, HEAD, POST, PUT, DELETE");
        throw new HttpError(405, "Method not allowed");
      }

      if (url.pathname === "/reitti-extension.json") {
        if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
        sendJson(response, 200, buildManifest(config), { method });
        return;
      }

      if (url.pathname === "/overlays.geojson") {
        if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
        handleData({ response, url, config, store, logger, method });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        await handleAdmin({ request, response, url, config, store, logger, method });
        return;
      }

      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
      await handleStatic({ request, response, url, config, store, logger, method });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) {
        logger.error(`${method} ${url.pathname} failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      } else {
        logger.debug(`${method} ${url.pathname} -> ${status}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.headersSent) sendError(response, error, { method });
      else response.end();
    }
  };
}
