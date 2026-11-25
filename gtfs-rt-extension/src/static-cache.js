import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_ESTIMATED_STATIC_BYTES = 512 * 1024 * 1024;
export const STATIC_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

function staticCacheMetadata(cachePath) {
  try {
    return JSON.parse(readFileSync(`${cachePath}.json`, "utf8"));
  } catch {
    return {};
  }
}

export async function fetchStaticToFile(
  fetchImpl,
  url,
  signal,
  cachePath = null,
  { maxBytes = MAX_ESTIMATED_STATIC_BYTES } = {},
) {
  const directory = cachePath ? null : await mkdtemp(join(tmpdir(), "reitti-gtfs-static-"));
  const zipPath = cachePath || join(directory, "static.zip");
  if (cachePath) mkdirSync(dirname(cachePath), { recursive: true });
  const metadata = cachePath ? staticCacheMetadata(cachePath) : {};
  const headers = { accept: "application/zip", "user-agent": "reitti-gtfs-rt-extension/1.0" };
  if (cachePath && existsSync(cachePath)) {
    if (metadata.etag) headers["if-none-match"] = metadata.etag;
    if (metadata.lastModified) headers["if-modified-since"] = metadata.lastModified;
  }

  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(STATIC_DOWNLOAD_TIMEOUT_MS)]),
  });
  if (response.status === 304 && cachePath && existsSync(cachePath)) {
    await response.body?.cancel();
    return { directory, path: zipPath, cached: true };
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (directory) await rm(directory, { recursive: true, force: true });
    throw new Error(`Upstream returned HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    if (directory) await rm(directory, { recursive: true, force: true });
    throw new Error(`Upstream response exceeds the ${maxBytes}-byte limit`);
  }
  if (!response.body) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw new Error("Upstream returned an empty response");
  }

  const target = cachePath ? `${zipPath}.tmp-${process.pid}` : zipPath;
  let size = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new Error(`Upstream response exceeds the ${maxBytes}-byte limit`));
      } else {
        callback(null, chunk);
      }
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(target));
    if (size === 0) throw new Error("Upstream returned an empty response");
    if (cachePath) {
      renameSync(target, zipPath);
      writeFileSync(`${zipPath}.json`, JSON.stringify({
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      }));
    }
    return { directory, path: zipPath, cached: false };
  } catch (error) {
    if (cachePath && existsSync(target)) unlinkSync(target);
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
