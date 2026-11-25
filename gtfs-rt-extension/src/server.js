import { loadConfig } from "./config.js";
import { FeedService } from "./feed-service.js";
import { UnifiedFeedService } from "./unified-feed-service.js";
import { createHttpServer } from "./http-server.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exitCode = 1;
}

if (config) {
  const service = config.feedType === "germany" ? new UnifiedFeedService(config) : new FeedService(config);
  const server = createHttpServer(config, service);
  let shuttingDown = false;

  server.listen(config.port, () => {
    console.log(`GTFS-RT extension (${config.feedType}) listening on port ${config.port}`);
    void service.start();
  });

  server.on("error", (error) => {
    console.error(`HTTP server error: ${error.message}`);
    service.stop();
    process.exitCode = 1;
  });

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down`);
    service.stop();

    const forceTimer = setTimeout(() => {
      server.closeAllConnections();
      process.exitCode = 1;
    }, 10_000);
    forceTimer.unref();

    await new Promise((resolve) => server.close(resolve));
    clearTimeout(forceTimer);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
