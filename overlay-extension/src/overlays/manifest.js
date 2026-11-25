import { hexToRgba } from "../util.js";

function url(config, path) {
  return config.publicBaseUrl ? `${config.publicBaseUrl}${path}` : path.replace(/^\//, "");
}

export function buildManifest(config) {
  return {
    $schema: "https://reitti.dev/schemas/extension-manifest.v1.json",
    id: config.extensionId,
    name: config.extensionName,
    version: "1.0.0",
    description: "Time-windowed GPX and GeoJSON overlays.",
    icon: url(config, "/assets/icon.svg"),
    layers: [
      {
        id: config.layerId,
        name: config.layerName,
        description: config.layerDescription,
        type: "polling",
        protocol: "http",
        endpoint: url(config, "/overlays.geojson"),
        pollIntervalMs: config.pollIntervalMs,
        pollTrigger: "both",
        renderer: "PathLayer",
        format: "geojson",
        minZoom: config.minZoom,
        placement: config.placement,
        zIndex: config.zIndex,
        assets: {
          lineColor: hexToRgba(config.lineColor, 220),
          lineWidth: config.lineWidth,
        },
      },
    ],
  };
}
