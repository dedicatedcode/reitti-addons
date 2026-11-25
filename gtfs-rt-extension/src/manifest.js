function extensionUrl(config, path) {
  return config.publicBaseUrl ? `${config.publicBaseUrl}${path}` : path;
}

function buildLayer(config, { colored, unified, estimated, transportRest, city, cityName }) {
  const suffix = colored ? "-colored" : "";
  const model = (name, minZoom = config.minZoom, scale = 4, extra = {}) => ({
    modelUrl: extensionUrl(config, `/assets/${name}${suffix}.glb`),
    scale,
    scaleReferenceZoom: 14,
    maxZoomScale: 192,
    zoomScaleExponent: 0.8,
    minZoom,
    ...extra,
  });
  const models = {
    bus: model("bus"),
    tram: model("tram"),
    train: model("train"),
    subway: model("subway"),
    sbahn: model("train"),
    ic: model("high-speed", Math.min(config.minZoom, 5), 4.5),
    ice: model("high-speed", Math.min(config.minZoom, 5), 4.5),
  };
  return {
    id: `${unified ? "germany-transit" : estimated ? "germany-estimated-transit" : transportRest ? "berlin-live-transit" : `${city}-live-buses`}${suffix}`,
    name: `${unified ? "Buses, trams and trains" : estimated ? "Estimated buses and trains" : transportRest ? "Live buses, trams and trains" : `${cityName} live buses`}${colored ? " (line colours)" : ""}`,
    type: "polling",
    protocol: "http",
    endpoint: extensionUrl(config, "/vehicles"),
    renderer: "ScenegraphLayer",
    format: "json",
    dataPath: "vehicles",
    pollIntervalMs: config.refreshIntervalMs,
    pollTrigger: "both",
    staleAfterMs: config.staleAfterSeconds * 1000,
    minZoom: unified || estimated ? Math.min(config.minZoom, 5) : config.minZoom,
    placement: "behind-buildings",
    zIndex: 0,
    mapping: {
      idField: "vehicleId",
      coordinateField: ["lon", "lat"],
      headingField: "bearing",
      modelField: "model",
      previousCoordinateField: ["previousLon", "previousLat"],
      previousHeadingField: "previousBearing",
      previousTimestampField: "previousUpdatedAt",
      ...(colored ? { colorField: "lineColor" } : {}),
      details: {
        titleFields: ["line", "headsign"],
        titleSeparator: " — ",
        status: {
          field: "positionSource",
          values: {
            estimated: { label: "Estimated" },
            live: { label: "Live" },
          },
        },
        rows: [
          { label: "Next stop", field: "nextStopName", timeField: "nextArrival" },
          { label: "Delay", field: "delayText" },
          { label: "Operator", field: "operator" },
        ],
      },
    },
    assets: {
      iconUrl: extensionUrl(config, "/assets/bus.svg"),
      modelUrl: extensionUrl(config, "/assets/bus.glb"),
      models,
      iconWidth: 40,
      iconHeight: 40,
      anchorY: 20,
      iconSize: 40,
      scale: 4,
    },
  };
}

export function buildManifest(config, variant = "neutral") {
  const unified = config.feedType === "germany";
  const busradar = config.feedType === "busradar";
  const estimated = config.feedType === "gtfs-rt-estimated";
  const transportRest = config.feedType === "transport-rest";
  const city = unified || estimated ? "germany" : transportRest ? "berlin" : busradar ? "muenster" : "luebeck";
  const cityName = transportRest ? "Berlin" : busradar ? "Münster" : "Lübeck";
  const colored = variant === "colored";
  const extensionName = unified
    ? colored ? "Germany Transit Colors" : "Germany Transit"
    : estimated
      ? colored ? "Berlin Estimated Transit Colors" : "Berlin Estimated Transit (GTFS.de)"
      : transportRest
        ? colored ? "Berlin Live Transit Colors" : "Berlin Live Transit"
        : colored ? `${cityName} Live Buses Colors` : `${cityName} Live Buses`;
  const description = unified
    ? colored
      ? "Line-coloured German bus, tram and train positions with live city feeds where available and GTFS.de estimates elsewhere."
      : "German bus, tram and train positions with live city feeds where available and GTFS.de estimates elsewhere."
    : estimated
      ? "Positions inferred from GTFS.de predictions and route shapes; not GPS measurements."
      : transportRest ? "Live bus, tram, and train movements in Berlin from VBB radar." : `Real-time city bus positions for ${cityName}.`;
  const layerOptions = { unified, estimated, transportRest, city, cityName };
  const neutralLayer = buildLayer(config, { ...layerOptions, colored: false });
  const coloredLayer = buildLayer(config, { ...layerOptions, colored: true });
  const layers = variant === "colored"
    ? [coloredLayer]
    : unified ? [neutralLayer, coloredLayer] : [neutralLayer];
  return {
    $schema: "https://reitti.dev/schemas/extension-manifest.v1.json",
    id: `${city}-transit${colored ? "-colored" : ""}`,
    name: extensionName,
    version: "1.0.0",
    description,
    icon: extensionUrl(config, "/assets/bus.svg"),
    layers,
  };
}
