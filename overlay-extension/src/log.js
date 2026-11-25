const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (levelName, args) => {
    if (LEVELS[levelName] < threshold) return;
    const line = `${new Date().toISOString()} ${levelName.toUpperCase().padEnd(5)} ${args
      .map((value) => (typeof value === "string" ? value : inspect(value)))
      .join(" ")}`;
    if (levelName === "error" || levelName === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}

function inspect(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
