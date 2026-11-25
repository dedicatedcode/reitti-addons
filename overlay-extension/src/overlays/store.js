import { mkdir, readdir, readFile, rename, unlink, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { InputError, normalizeText } from "../util.js";
import { areasToOutlines } from "./geometry.js";
import {
  buildOverlay,
  hydrateOverlay,
  newOverlayId,
  normalizeStyle,
  parseOverlayContent,
  serializeOverlay,
  unionBbox,
} from "./model.js";
import { normalizeValidity } from "./validity.js";

export class OverlayStore {
  #lock = Promise.resolve();
  #counter = 0;

  constructor(config) {
    this.config = config;
    this.directory = join(config.dataDir, "overlays");
    this.overlays = new Map();
    this.loadErrors = [];
  }

  async load() {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(this.directory, entry.name);
      try {
        const raw = JSON.parse(await readFile(path, "utf8"));
        const overlay = hydrateOverlay(raw, this.config);
        if (this.overlays.has(overlay.id)) {
          throw new Error(`duplicate overlay id ${overlay.id}`);
        }
        this.overlays.set(overlay.id, overlay);
      } catch (error) {
        this.loadErrors.push({ file: entry.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return this;
  }

  list() {
    return [...this.overlays.values()].sort((a, b) => {
      const created = String(a.createdAt).localeCompare(String(b.createdAt));
      return created !== 0 ? created : a.name.localeCompare(b.name);
    });
  }

  get(id) {
    return this.overlays.get(id) || null;
  }

  async create(input) {
    const overlay = buildOverlay(input, this.config);
    return this.#withLock(async () => {
      const now = new Date().toISOString();
      overlay.id = newOverlayId(overlay.name, new Set(this.overlays.keys()));
      overlay.createdAt = now;
      overlay.updatedAt = now;
      await this.#write(overlay);
      this.overlays.set(overlay.id, overlay);
      return overlay;
    });
  }

  async update(id, patch) {
    return this.#withLock(async () => {
      const overlay = this.#require(id);
      const next = { ...overlay };
      if (patch.name !== undefined) next.name = normalizeText(patch.name, 200, "name");
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== "boolean") throw new InputError("enabled must be a boolean");
        next.enabled = patch.enabled;
      }
      if (patch.style !== undefined) next.style = normalizeStyle({ ...overlay.style, ...patch.style });
      if (patch.validity !== undefined) {
        next.validity = normalizeValidity(
          { ...overlay.validity, ...patch.validity },
          overlay.validity.timezone || this.config.defaultTimezone,
        );
      }
      next.updatedAt = new Date().toISOString();
      await this.#write(next);
      this.overlays.set(id, next);
      return next;
    });
  }

  async replaceGeometry(id, input) {
    const parsed = parseOverlayContent(input);
    return this.#withLock(async () => {
      const overlay = this.#require(id);
      const geometry = { paths: parsed.paths, areas: parsed.areas };
      const next = {
        ...overlay,
        source: {
          filename: input.filename ? String(input.filename).slice(0, 255) : overlay.source.filename,
          format: parsed.format,
        },
        geometry,
        stats: {
          ...parsed.stats,
          bytes: Buffer.byteLength(JSON.stringify(geometry)),
          bbox: unionBbox([...geometry.paths, ...geometry.areas]),
        },
        outlines: areasToOutlines(geometry.areas),
        updatedAt: new Date().toISOString(),
      };
      await this.#write(next);
      this.overlays.set(id, next);
      return next;
    });
  }

  async remove(id) {
    return this.#withLock(async () => {
      this.#require(id);
      await unlink(this.#file(id)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.overlays.delete(id);
    });
  }

  async stats() {
    let bytes = 0;
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const info = await stat(join(this.directory, entry.name));
        bytes += info.size;
      }
    } catch {
      return { bytes: 0 };
    }
    return { bytes };
  }

  #require(id) {
    const overlay = this.overlays.get(id);
    if (!overlay) throw new InputError(`Overlay ${id} does not exist`);
    return overlay;
  }

  #file(id) {
    return join(this.directory, `${id}.json`);
  }

  async #write(overlay) {
    const target = this.#file(overlay.id);
    const temporary = `${target}.tmp-${process.pid}-${this.#counter++}`;
    await writeFile(temporary, JSON.stringify(serializeOverlay(overlay), null, 2), "utf8");
    await rename(temporary, target);
  }

  #withLock(task) {
    const next = this.#lock.then(task, task);
    this.#lock = next.catch(() => {});
    return next;
  }
}
