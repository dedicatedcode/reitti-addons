function finiteParameter(value, name) {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`);
  return parsed;
}

export function parseViewport(searchParams) {
  const bboxParameter = searchParams.get("bbox");
  const zoomParameter = searchParams.get("zoom");
  const zoom = zoomParameter === null ? null : finiteParameter(zoomParameter, "zoom");
  if (zoom !== null && (zoom < 0 || zoom > 30)) throw new Error("zoom is outside the allowed range");

  let bbox = null;
  if (bboxParameter !== null) {
    const values = bboxParameter.split(",").map(Number);
    if (values.length !== 4 || values.some(value => !Number.isFinite(value))) {
      throw new Error("bbox must contain west,south,east,north");
    }
    const [west, south, east, north] = values;
    if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
      throw new Error("bbox is outside the allowed range");
    }
    bbox = values;
  }
  return { bbox, zoom };
}

export function applyViewport(snapshot, searchParams, minZoom, modelMinZooms = null) {
  const { bbox, zoom } = parseViewport(searchParams);

  const vehicles = snapshot.vehicles.filter(vehicle => {
    if (bbox && (vehicle.lon < bbox[0] || vehicle.lon > bbox[2] || vehicle.lat < bbox[1] || vehicle.lat > bbox[3])) {
      return false;
    }
    const vehicleMinZoom = vehicle.minZoom ?? modelMinZooms?.[vehicle.model] ?? minZoom;
    return zoom === null || zoom >= vehicleMinZoom;
  });
  return { timestamp: snapshot.timestamp, vehicles };
}
