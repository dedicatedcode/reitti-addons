![](.github/banner.png)

# reitti-addons

**Reitti** is a self-hosted personal location tracking and analysis application. The name comes from Finnish, meaning
*"route"* or *"path"*. Head over to the [main repository](https://github.com/dedicatedcode/reitti) to learn more.

**reitti-addons** is a collection of tools that enhance or help with the usage of reitti. They live in this separate
repository instead of the main one. They either have **no release process of their own** (like the plain bash
scripts in *device-sync*) or are **not tied into any specific version of reitti** (like the standalone web tool in
*gpx-tool*).

Each tool works against a running reitti instance or produces data for it. Nothing here is required to run reitti
itself.

---

## Tools

| Tool                                          | Description                                                  | Tie-in to reitti                                                              | Docs                                                        |
|-----------------------------------------------|--------------------------------------------------------------|-------------------------------------------------------------------------------|-------------------------------------------------------------|
| [reitti-device-sync](device-sync/)            | Auto-uploads new GPX/FIT files from USB-attached GPS devices | Pushes recordings to reitti's import API using device-bound tokens            | [device-sync/README.md](device-sync/README.md)              |
| [GPX Test Data Generator](gpx-tool/)          | Interactive web tool for creating, importing, editing and randomizing realistic GPX tracks | Generates test data to import into reitti                                     | [gpx-tool/README.md](gpx-tool/README.md)                    |

---

## reitti-device-sync

A small bash tool that watches USB-attached GPS devices and pushes their recordings into your reitti instance. When you
plug a device in, a systemd user service starts automatically, finds files that have not been uploaded before, and sends
them to reitti. It is built for the **Garmin Edge 830** (FIT via MTP) and the **Columbus P-1 Mark II** (GPX via USB mass
storage), but generic: every device is just a config section with an upload URL and an API token.

It ties into reitti through the import APIs (`/api/v2/fit/import` for FIT, `/api/v1/gpx/import` for GPX) using
**device-bound tokens**, so ingested data is attributed to the right tracker. A local ledger plus reitti's own
duplicate-point handling ensures nothing is ever uploaded twice.

> **Setup:** reitti → *Settings → Devices* and *Settings → API Tokens* to create a device and token per tracker, then
> follow the full installation, configuration, systemd and troubleshooting guide in
> [device-sync/README.md](device-sync/README.md).

---

## GPX Test Data Generator (Polku)

An interactive web-based tool for creating, loading, editing and randomizing GPX tracks: click or paint points on a
map, simulate realistic GPS behavior (speed, elevation, accuracy), import existing GPX files to tweak and re-export
them, or hit *Randomize* to shift a whole track by a random offset around the globe and in time.

It is a handy companion for reitti: use it to generate or modify test data and import it into your instance to try out
features, fill a dev environment with plausible movement, or demo timelines. Run it with:

```bash
docker run -p 8080:80 dedicatedcode/reitti-gpx-generator
```

Then open http://localhost:8080 in your browser. All processing happens locally; no track data is ever sent to any
server.

> **Details:** features, alternative ways to run it and use cases in [gpx-tool/README.md](gpx-tool/README.md).

---

## Contributing & Support

Contributions are welcome! Please feel free to open a Pull Request. For bugs or ideas regarding these tools, use the
issue templates in this repository. Issues about reitti itself belong in the
[main repository](https://github.com/dedicatedcode/reitti/issues/new/choose).

**Get support for reitti:**

- Open a [new issue](https://github.com/dedicatedcode/reitti/issues/new/choose)
- Tag [@danielgraf](https://discuss.tchncs.de/u/danielgraf) on Lemmy
- Join **#reitti** on [libera.chat](https://libera.chat)

---

## License

This project is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). See the [LICENSE](LICENSE)
file for details.
