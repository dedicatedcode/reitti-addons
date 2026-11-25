const FALLBACK_COLORS = [
  [0, 114, 178, 255],
  [230, 85, 13, 255],
  [0, 158, 115, 255],
  [204, 121, 167, 255],
  [213, 94, 0, 255],
  [86, 180, 233, 255],
  [117, 112, 179, 255],
  [27, 158, 119, 255],
  [217, 95, 2, 255],
  [102, 166, 30, 255],
  [188, 80, 144, 255],
  [0, 136, 170, 255],
];

export function parseHexColor(value) {
  if (typeof value !== "string") return null;
  const match = /^#?([\da-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    255,
  ];
}

export function colorForLine(line, officialColor) {
  const official = parseHexColor(officialColor);
  if (official) return official;
  if (Array.isArray(officialColor) && officialColor.length === 4
    && officialColor.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
    return [...officialColor];
  }

  const text = String(line ?? "");
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return [...FALLBACK_COLORS[(hash >>> 0) % FALLBACK_COLORS.length]];
}
