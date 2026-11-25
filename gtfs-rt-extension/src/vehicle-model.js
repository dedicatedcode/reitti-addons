export function vehicleModel(routeType, line, mode) {
  const name = String(line || "").trim().toUpperCase();
  const normalizedMode = String(mode || "").trim().toLowerCase();
  if (/^ICE\s*\d/.test(name)) return "ice";
  if (/^(IC|EC)\s*\d/.test(name)) return "ic";
  if (/^S\s*\d/.test(name) || routeType === 109) return "sbahn";
  if (["subway", "metro"].includes(normalizedMode) || /^U\s*\d/.test(name)
    || routeType === 1 || [400, 401, 402].includes(routeType)) return "subway";
  if (routeType === 0 || (routeType >= 900 && routeType < 1000) || normalizedMode === "tram") return "tram";
  if (routeType === 4 || (routeType >= 1000 && routeType < 1100) || normalizedMode === "ferry") return "ferry";
  if (routeType === 2 || routeType === 12 || routeType === 101 || routeType === 102 || (routeType >= 100 && routeType < 200)
    || (routeType >= 300 && routeType < 600) || /^(RE|RB)\s*\d/.test(name) || normalizedMode === "train") return "train";
  return "bus";
}

export function isLongDistanceModel(model) {
  return model === "ice" || model === "ic";
}

export function delayText(delaySeconds) {
  const delay = Math.round(delaySeconds);
  const sign = delay >= 0 ? "+" : "−";
  const absolute = Math.abs(delay);
  return absolute >= 60 ? `${sign}${Math.round(absolute / 60)} min` : `${sign}${absolute} s`;
}
