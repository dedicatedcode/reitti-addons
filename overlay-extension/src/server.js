import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { OverlayStore } from "./overlays/store.js";
import { createApp } from "./app.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const store = new OverlayStore(config);
await store.load();
if (store.loadErrors.length > 0) {
  for (const failure of store.loadErrors) {
    logger.warn(`Skipping unreadable overlay ${failure.file}: ${failure.error}`);
  }
}

const server = createServer(createApp({ config, store, logger }));
let shuttingDown = false;

server.listen(config.port, config.host, () => {
  logger.info(
    `Reitti Overlays listening on http://${config.host}:${config.port} (${store.list().length} overlays, time zone ${config.defaultTimezone})`,
  );
  logger.info(`Register this URL in Reitti: ${config.publicBaseUrl || "http://<host>:<port>"}`);
});

server.on("error", (error) => {
  logger.error(`HTTP server error: ${error.message}`);
  process.exitCode = 1;
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down`);
  const force = setTimeout(() => {
    server.closeAllConnections();
    process.exitCode = 1;
  }, 10_000);
  force.unref();
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(force);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
