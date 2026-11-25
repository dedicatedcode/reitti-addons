const state = {
  config: null,
  overlays: [],
  selectedId: null,
  map: null,
  previewReady: false,
  dirty: false,
  totalBytes: 0,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  statusText: $("#statusText"),
  overlayCount: $("#overlayCount"),
  overlayList: $("#overlayList"),
  listFooter: $("#listFooter"),
  sizeSummary: $("#sizeSummary"),
  emptyState: $("#emptyState"),
  editorPanel: $("#editorPanel"),
  editorForm: $("#editorForm"),
  fieldName: $("#fieldName"),
  fieldEnabled: $("#fieldEnabled"),
  fieldColor: $("#fieldColor"),
  fieldWidth: $("#fieldWidth"),
  fieldAlpha: $("#fieldAlpha"),
  alphaValue: $("#alphaValue"),
  fieldTimezone: $("#fieldTimezone"),
  timezoneList: $("#timezoneList"),
  fieldMode: $("#fieldMode"),
  rangeFields: $("#rangeFields"),
  dailyFields: $("#dailyFields"),
  rangeStartDate: $("#rangeStartDate"),
  rangeStartTime: $("#rangeStartTime"),
  rangeEndDate: $("#rangeEndDate"),
  rangeEndTime: $("#rangeEndTime"),
  dailyStart: $("#dailyStart"),
  dailyEnd: $("#dailyEnd"),
  dailyFrom: $("#dailyFrom"),
  dailyTo: $("#dailyTo"),
  editorStatus: $("#editorStatus"),
  editorStats: $("#editorStats"),
  btnExport: $("#btnExport"),
  registrationUrl: $("#registrationUrl"),
  setupLayerName: $("#setupLayerName"),
  fileInput: $("#fileInput"),
  replaceInput: $("#replaceInput"),
  toast: $("#toast"),
};

let toastTimer = null;

function toast(message, kind = "ok", timeout = 4500) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast ${kind}`;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, timeout);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function setStatus(text) {
  elements.statusText.textContent = text || "";
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function todayInZone(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function clampNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

async function loadConfig() {
  state.config = await api("api/config");
  elements.registrationUrl.value = state.config.registrationUrl;
  elements.setupLayerName.textContent = state.config.layerName;
  const zones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [
          "UTC",
          "Europe/Berlin",
          "Europe/London",
          "Europe/Paris",
          "America/Los_Angeles",
          "America/New_York",
          "Asia/Tokyo",
          "Australia/Sydney",
        ];
  const fragment = document.createDocumentFragment();
  for (const zone of zones) {
    const option = document.createElement("option");
    option.value = zone;
    fragment.appendChild(option);
  }
  elements.timezoneList.replaceChildren(fragment);
}

async function loadOverlays({ keepSelection = true } = {}) {
  const payload = await api("api/overlays");
  state.overlays = payload.overlays || [];
  state.totalBytes = payload.totalBytes || 0;

  if (!keepSelection || (state.selectedId && !state.overlays.some((overlay) => overlay.id === state.selectedId))) {
    state.selectedId = null;
  }

  renderList();
  renderEmpty();
  if (state.selectedId) {
    const overlay = selectedOverlay();
    if (overlay && !state.dirty) populateEditor(overlay);
  } else {
    elements.editorPanel.hidden = true;
  }
  setStatus(`${state.overlays.length} overlay${state.overlays.length === 1 ? "" : "s"}`);
}

function selectedOverlay() {
  return state.overlays.find((overlay) => overlay.id === state.selectedId) || null;
}

function renderEmpty() {
  const empty = state.overlays.length === 0;
  elements.emptyState.hidden = !empty;
  elements.listFooter.hidden = empty;
}

function renderList() {
  elements.overlayCount.textContent = String(state.overlays.length);
  const fragment = document.createDocumentFragment();

  for (const overlay of state.overlays) {
    const item = document.createElement("div");
    item.className = "overlay-item";
    if (overlay.id === state.selectedId) item.classList.add("selected");
    if (!overlay.enabled) item.classList.add("disabled");
    item.addEventListener("click", () => selectOverlay(overlay.id));

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = overlay.style.color;

    const main = document.createElement("span");
    main.className = "overlay-main";
    const name = document.createElement("span");
    name.className = "overlay-name";
    name.textContent = overlay.name;
    const validity = document.createElement("span");
    validity.className = "overlay-validity";
    validity.textContent = overlay.validityText;
    main.append(name, validity);

    const side = document.createElement("span");
    side.className = "overlay-side";
    const badge = document.createElement("span");
    badge.className = `badge ${overlay.enabled && overlay.activeNow ? "live" : "off"}`;
    badge.textContent = !overlay.enabled ? "Off" : overlay.activeNow ? "Live" : "Idle";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `icon-btn ${overlay.enabled ? "on" : ""}`;
    toggle.title = overlay.enabled ? "Exclude from the Reitti layer" : "Include on the Reitti layer";
    toggle.textContent = overlay.enabled ? "◉" : "○";
    toggle.addEventListener("click", async (event) => {
      event.stopPropagation();
      await toggleEnabled(overlay);
    });
    side.append(badge, toggle);

    item.append(swatch, main, side);
    fragment.appendChild(item);
  }

  elements.overlayList.replaceChildren(fragment);

  if (state.overlays.length > 0) {
    const limit = state.config.limits.maxResponseBytes;
    const over = state.totalBytes > limit;
    elements.sizeSummary.textContent = `Enabled data ${formatBytes(state.totalBytes)} / ${formatBytes(limit)}${
      over ? " — viewport filtering may be needed" : ""
    }`;
    elements.sizeSummary.style.color = over ? "var(--danger)" : "";
  }
}

async function toggleEnabled(overlay) {
  try {
    const updated = await api(`api/overlays/${overlay.id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !overlay.enabled }),
    });
    replaceOverlay(updated);
    renderList();
    if (state.selectedId === updated.id && !state.dirty) populateEditor(updated);
    await loadPreview();
  } catch (error) {
    toast(error.message, "error");
  }
}

function replaceOverlay(updated) {
  const index = state.overlays.findIndex((overlay) => overlay.id === updated.id);
  if (index >= 0) state.overlays[index] = updated;
  else state.overlays.push(updated);
  state.totalBytes = state.overlays
    .filter((overlay) => overlay.enabled)
    .reduce((total, overlay) => total + (overlay.stats?.bytes || 0), 0);
}

function selectOverlay(id) {
  if (state.dirty && state.selectedId !== id) {
    if (!window.confirm("Discard unsaved changes?")) return;
  }
  state.selectedId = id;
  state.dirty = false;
  renderList();
  const overlay = selectedOverlay();
  if (!overlay) return;
  populateEditor(overlay);
  updateSelectedLayers();
}

function populateEditor(overlay) {
  elements.editorPanel.hidden = false;
  elements.fieldName.value = overlay.name;
  elements.fieldEnabled.checked = Boolean(overlay.enabled);
  elements.fieldColor.value = overlay.style.color || "#d9a441";
  elements.fieldWidth.value = String(overlay.style.lineWidth ?? 3);
  elements.fieldAlpha.value = String(overlay.style.lineAlpha ?? 220);
  elements.alphaValue.textContent = `${Math.round(((overlay.style.lineAlpha ?? 220) / 255) * 100)}%`;
  elements.fieldTimezone.value = overlay.validity.timezone || state.config.defaultTimezone;
  elements.fieldMode.value = overlay.validity.mode || "always";

  const validity = overlay.validity;
  elements.rangeStartDate.value = validity.startDate || "";
  elements.rangeStartTime.value = validity.startTime || "00:00";
  elements.rangeEndDate.value = validity.endDate || "";
  elements.rangeEndTime.value = validity.endTime || "23:59";
  elements.dailyStart.value = validity.dailyStart || "18:00";
  elements.dailyEnd.value = validity.dailyEnd || "23:00";
  elements.dailyFrom.value = validity.startDate || "";
  elements.dailyTo.value = validity.endDate || "";

  elements.editorStatus.className = `status-line ${
    !overlay.enabled ? "off" : overlay.activeNow ? "live" : "off"
  }`;
  elements.editorStatus.textContent = !overlay.enabled
    ? "Excluded from the Reitti layer"
    : overlay.activeNow
      ? `Live now · ${overlay.validityText}`
      : `Not active now · ${overlay.validityText}`;

  elements.editorStats.innerHTML = "";
  const rows = [
    ["Source", overlay.source?.filename || "—"],
    ["Format", (overlay.source?.format || "geojson").toUpperCase()],
    ["Points", String(overlay.stats?.points ?? 0)],
    ["Paths", String(overlay.stats?.pathFeatures ?? 0)],
    ["Areas", String(overlay.stats?.areaFeatures ?? 0)],
    ["Size", formatBytes(overlay.stats?.bytes || 0)],
  ];
  for (const [label, value] of rows) {
    const cell = document.createElement("span");
    cell.innerHTML = `${label}: <b></b>`;
    cell.querySelector("b").textContent = value;
    elements.editorStats.appendChild(cell);
  }
  if (overlay.stats?.bbox) {
    const bbox = document.createElement("span");
    bbox.style.gridColumn = "1 / -1";
    bbox.innerHTML = "BBox: <b></b>";
    bbox.querySelector("b").textContent = overlay.stats.bbox.map((value) => value.toFixed(4)).join(", ");
    elements.editorStats.appendChild(bbox);
  }
  if (overlay.tooLarge) {
    const warning = document.createElement("span");
    warning.style.gridColumn = "1 / -1";
    warning.style.color = "var(--danger)";
    warning.textContent = "This overlay alone is larger than the response limit; use a viewport or split the file.";
    elements.editorStats.appendChild(warning);
  }

  elements.btnExport.href = `api/overlays/${encodeURIComponent(overlay.id)}/export.geojson`;
  updateModeFields();
  updateSelectedLayers();
}

function updateModeFields() {
  const mode = elements.fieldMode.value;
  elements.rangeFields.hidden = mode !== "range";
  elements.dailyFields.hidden = mode !== "daily";
}

function readEditor() {
  const mode = elements.fieldMode.value;
  const timezone = elements.fieldTimezone.value.trim();
  const style = {
    color: elements.fieldColor.value,
    lineWidth: clampNumber(elements.fieldWidth.value, 1, 20, 3),
    lineAlpha: Math.round(clampNumber(elements.fieldAlpha.value, 0, 255, 220)),
  };
  let validity;
  if (mode === "range") {
    validity = {
      mode,
      timezone,
      startDate: elements.rangeStartDate.value || null,
      startTime: elements.rangeStartTime.value || "00:00",
      endDate: elements.rangeEndDate.value || null,
      endTime: elements.rangeEndTime.value || "23:59",
    };
  } else if (mode === "daily") {
    validity = {
      mode,
      timezone,
      dailyStart: elements.dailyStart.value || "00:00",
      dailyEnd: elements.dailyEnd.value || "23:59",
      startDate: elements.dailyFrom.value || null,
      endDate: elements.dailyTo.value || null,
    };
  } else {
    validity = { mode: "always", timezone };
  }
  return {
    name: elements.fieldName.value.trim(),
    enabled: elements.fieldEnabled.checked,
    style,
    validity,
  };
}

async function saveEditor(event) {
  event.preventDefault();
  const overlay = selectedOverlay();
  if (!overlay) return;
  const payload = readEditor();
  if (!payload.name) {
    toast("The overlay needs a name", "error");
    return;
  }
  try {
    const updated = await api(`api/overlays/${encodeURIComponent(overlay.id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    state.dirty = false;
    replaceOverlay(updated);
    renderList();
    populateEditor(updated);
    await loadPreview();
    toast("Overlay saved");
  } catch (error) {
    toast(error.message, "error", 8000);
  }
}

async function deleteOverlay() {
  const overlay = selectedOverlay();
  if (!overlay) return;
  if (!window.confirm(`Delete "${overlay.name}"?`)) return;
  try {
    await api(`api/overlays/${encodeURIComponent(overlay.id)}`, { method: "DELETE" });
    state.selectedId = null;
    state.dirty = false;
    await loadOverlays({ keepSelection: false });
    await loadPreview();
    toast("Overlay deleted");
  } catch (error) {
    toast(error.message, "error");
  }
}

function fitOverlay() {
  const overlay = selectedOverlay();
  const bbox = overlay?.stats?.bbox;
  if (!bbox || !state.map) return;
  state.map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    { padding: 80, maxZoom: 16, duration: 600 },
  );
}

function applyToday() {
  const timeZone = elements.fieldTimezone.value.trim() || state.config.defaultTimezone;
  const today = todayInZone(timeZone);
  elements.rangeStartDate.value = today;
  elements.rangeStartTime.value = "00:00";
  elements.rangeEndDate.value = today;
  elements.rangeEndTime.value = "23:59";
  state.dirty = true;
}

function formatFromFilename(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".gpx")) return "gpx";
  if (lower.endsWith(".geojson")) return "geojson";
  if (lower.endsWith(".json")) return "geojson";
  return null;
}

function fileStem(name) {
  return String(name).replace(/\.[^.]+$/, "").trim() || "Overlay";
}

async function importFile(file) {
  if (!file) return;
  if (state.dirty && !window.confirm("Discard unsaved changes?")) {
    elements.fileInput.value = "";
    return;
  }
  if (file.size > state.config.limits.maxUploadBytes) {
    toast(`The file is larger than ${formatBytes(state.config.limits.maxUploadBytes)}`, "error");
    return;
  }
  const format = formatFromFilename(file.name);
  if (!format) {
    toast("Use a .gpx, .geojson, or .json file", "error");
    return;
  }
  setStatus(`Importing ${file.name}…`);
  try {
    const content = await file.text();
    const created = await api("api/overlays", {
      method: "POST",
      body: JSON.stringify({
        name: fileStem(file.name),
        filename: file.name,
        format,
        content,
        timezone: state.config.defaultTimezone,
      }),
    });
    state.selectedId = created.id;
    state.dirty = false;
    await loadOverlays();
    await loadPreview();
    fitOverlay();
    toast(`Imported ${created.name}`);
  } catch (error) {
    toast(error.message, "error", 8000);
  } finally {
    setStatus(`${state.overlays.length} overlay${state.overlays.length === 1 ? "" : "s"}`);
    elements.fileInput.value = "";
  }
}

async function replaceFile(file) {
  const overlay = selectedOverlay();
  if (!overlay || !file) return;
  if (state.dirty && !window.confirm("Unsaved changes will be lost. Replace the file anyway?")) {
    elements.replaceInput.value = "";
    return;
  }
  if (file.size > state.config.limits.maxUploadBytes) {
    toast(`The file is larger than ${formatBytes(state.config.limits.maxUploadBytes)}`, "error");
    return;
  }
  const format = formatFromFilename(file.name);
  if (!format) {
    toast("Use a .gpx, .geojson, or .json file", "error");
    return;
  }
  try {
    const content = await file.text();
    const updated = await api(`api/overlays/${encodeURIComponent(overlay.id)}/geometry`, {
      method: "POST",
      body: JSON.stringify({ filename: file.name, format, content }),
    });
    replaceOverlay(updated);
    state.dirty = false;
    populateEditor(updated);
    renderList();
    await loadPreview();
    fitOverlay();
    toast("File replaced");
  } catch (error) {
    toast(error.message, "error", 8000);
  } finally {
    elements.replaceInput.value = "";
  }
}

function buildMap() {
  state.map = new maplibregl.Map({
    container: "map",
    style: state.config.mapStyleUrl,
    center: [8.5, 48.5],
    zoom: 3,
    attributionControl: { compact: true },
  });
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  state.map.on("load", async () => {
    state.map.addSource("overlays", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    state.map.addLayer({
      id: "overlay-fill",
      type: "fill",
      source: "overlays",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": ["coalesce", ["get", "color"], "#d9a441"],
        "fill-opacity": [
          "case",
          ["all", ["get", "enabled"], ["get", "active"]],
          0.18,
          0.04,
        ],
      },
    });
    state.map.addLayer({
      id: "overlay-area-outline",
      type: "line",
      source: "overlays",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "line-color": ["coalesce", ["get", "color"], "#d9a441"],
        "line-width": 1.5,
        "line-opacity": [
          "case",
          ["all", ["get", "enabled"], ["get", "active"]],
          0.85,
          0.25,
        ],
      },
    });
    state.map.addLayer({
      id: "overlay-line",
      type: "line",
      source: "overlays",
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["coalesce", ["get", "color"], "#d9a441"],
        "line-width": ["coalesce", ["get", "lineWidth"], 3],
        "line-opacity": [
          "case",
          ["all", ["get", "enabled"], ["get", "active"]],
          1,
          0.3,
        ],
      },
    });
    state.map.addLayer({
      id: "overlay-selected-fill",
      type: "fill",
      source: "overlays",
      filter: ["all", ["==", ["geometry-type"], "Polygon"], ["==", ["get", "overlayId"], ""]],
      paint: { "fill-color": "#ffffff", "fill-opacity": 0.05 },
    });
    state.map.addLayer({
      id: "overlay-selected-area",
      type: "line",
      source: "overlays",
      filter: ["all", ["==", ["geometry-type"], "Polygon"], ["==", ["get", "overlayId"], ""]],
      paint: { "line-color": "#ffffff", "line-width": 2, "line-opacity": 0.8 },
    });
    state.map.addLayer({
      id: "overlay-selected-line",
      type: "line",
      source: "overlays",
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "overlayId"], ""]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-width": ["+", ["coalesce", ["get", "lineWidth"], 3], 2],
        "line-opacity": 0.65,
      },
    });
    state.previewReady = true;
    updateSelectedLayers();
    await loadPreview();
    state.map.on("click", (event) => {
      const features = state.map.queryRenderedFeatures(event.point, {
        layers: ["overlay-line", "overlay-fill", "overlay-area-outline"],
      });
      if (features.length > 0 && features[0].properties?.overlayId) {
        selectOverlay(features[0].properties.overlayId);
      }
    });
    for (const id of ["overlay-line", "overlay-fill", "overlay-area-outline"]) {
      state.map.on("mouseenter", id, () => {
        state.map.getCanvas().style.cursor = "pointer";
      });
      state.map.on("mouseleave", id, () => {
        state.map.getCanvas().style.cursor = "";
      });
    }
  });
}

async function loadPreview() {
  if (!state.map || !state.previewReady) return;
  const response = await fetch("api/preview.geojson", { cache: "no-store" });
  if (!response.ok) {
    toast("Could not load the preview", "error");
    return;
  }
  const data = await response.json();
  state.map.getSource("overlays")?.setData(data);
}

function updateSelectedLayers() {
  if (!state.map || !state.previewReady) return;
  const selected = state.selectedId || "";
  const selectedFilter = (geometryType) => [
    "all",
    ["==", ["geometry-type"], geometryType],
    ["==", ["get", "overlayId"], selected],
  ];
  state.map.setFilter("overlay-selected-line", selectedFilter("LineString"));
  state.map.setFilter("overlay-selected-fill", selectedFilter("Polygon"));
  state.map.setFilter("overlay-selected-area", selectedFilter("Polygon"));
}

function bindEvents() {
  elements.editorForm.addEventListener("submit", saveEditor);
  elements.editorForm.addEventListener("input", () => {
    state.dirty = true;
  });
  elements.fieldAlpha.addEventListener("input", () => {
    elements.alphaValue.textContent = `${Math.round((Number(elements.fieldAlpha.value) / 255) * 100)}%`;
  });
  elements.fieldMode.addEventListener("change", updateModeFields);
  $("#btnToday").addEventListener("click", applyToday);
  $("#btnAllDay").addEventListener("click", () => {
    elements.dailyStart.value = "00:00";
    elements.dailyEnd.value = "00:00";
    state.dirty = true;
  });
  $("#btnDelete").addEventListener("click", deleteOverlay);
  $("#btnFit").addEventListener("click", fitOverlay);
  $("#btnReplace").addEventListener("click", () => elements.replaceInput.click());
  elements.replaceInput.addEventListener("change", () => replaceFile(elements.replaceInput.files?.[0]));

  $("#btnImport").addEventListener("click", () => elements.fileInput.click());
  $("#btnEmptyImport").addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", () => importFile(elements.fileInput.files?.[0]));

  $("#btnRefresh").addEventListener("click", async () => {
    try {
      await loadOverlays();
      await loadPreview();
      toast("Refreshed");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  $("#btnCopyRegistration").addEventListener("click", async () => {
    const value = elements.registrationUrl.value;
    try {
      await navigator.clipboard.writeText(value);
      toast("Manifest URL copied");
    } catch {
      elements.registrationUrl.select();
      document.execCommand("copy");
      toast("Manifest URL copied");
    }
  });

  document.addEventListener("dragenter", (event) => {
    if ([...(event.dataTransfer?.types || [])].includes("Files")) event.preventDefault();
  });
  document.addEventListener("dragover", (event) => {
    if ([...(event.dataTransfer?.types || [])].includes("Files")) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    importFile(event.dataTransfer.files[0]);
  });

  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function start() {
  try {
    await loadConfig();
    bindEvents();
    await loadOverlays({ keepSelection: false });
    buildMap();
    setInterval(() => {
      loadOverlays().catch(() => {});
    }, 30000);
  } catch (error) {
    setStatus("Failed to start");
    toast(error.message, "error", 15000);
  }
}

start();
