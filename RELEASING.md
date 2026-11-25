# Releasing images

Each add-on has its own version and its own image. There is no shared release version.

## Images

| Add-on | Docker Hub | GitHub Container Registry |
|---|---|---|
| Overlay extension | `dedicatedcode/reitti-overlay-extension` | `ghcr.io/dedicatedcode/reitti-overlay-extension` |
| GTFS-RT extension | `dedicatedcode/reitti-gtfs-rt-extension` | `ghcr.io/dedicatedcode/reitti-gtfs-rt-extension` |
| GPX tool | `dedicatedcode/reitti-gpx-generator` | `ghcr.io/dedicatedcode/reitti-gpx-generator` |

Every image is pushed to both registries with the same tags.

## Version files

| Add-on | Version file |
|---|---|
| Overlay extension | `overlay-extension/package.json` (`version`) |
| GTFS-RT extension | `gtfs-rt-extension/package.json` (`version`) |
| GPX tool | `gpx-tool/VERSION` |

## Tags

| Event | Image tags |
|---|---|
| Push to `main` touching the add-on | `develop`, `sha-<7>` |
| Git tag `<component>-vX.Y.Z` | `X.Y.Z`, `X.Y`, `latest` |
| Pull request touching the add-on | build only, no push |
| Manual workflow dispatch | `develop`/`sha` when run from `main`, or the supplied tag |

Git tag names:

- `overlay-extension-v1.2.3`
- `gtfs-rt-extension-v1.2.3`
- `gpx-tool-v1.2.3`

Use final SemVer tags for releases (`X.Y.Z`). The workflow publishes `latest` for every component
tag, so avoid pre-release tags such as `1.2.3-rc1` unless you change that rule.

`develop` is the moving main build. `latest` only moves when a release tag is pushed.

## Release process

1. Bump the version in the component's version file in a pull request.
2. Merge the pull request into `main`. This publishes `develop` and a `sha-<7>` tag.
3. Create a GitHub release with the matching tag, for example `overlay-extension-v1.2.3`, or push
   the tag from the command line:
   ```bash
   git tag overlay-extension-v1.2.3
   git push origin overlay-extension-v1.2.3
   ```
4. The workflow checks that the tag matches the version file and publishes `1.2.3`, `1.2`, and
   `latest` to Docker Hub and GHCR.

A manual build can be started from **Actions → Overlay extension image / GTFS-RT extension image /
GPX tool image → Run workflow**. Leave the tag empty to publish `develop` from `main`, or provide a
tag for a one-off image.

## What triggers a build

Each add-on has its own workflow with path filters:

- `overlay-extension/**`
- `gtfs-rt-extension/**`
- `gpx-tool/**`

A change in one add-on does not rebuild the others. Changes to the shared
`.github/workflows/_extension-image.yml` rebuild all three, because they all use it.

## Required repository configuration

- Docker Hub secrets: `DOCKER_HUB_USERNAME`, `DOCKER_HUB_ACCESS_TOKEN`.
- The GitHub Actions token needs `packages: write` for GHCR; the workflows set this in the caller.
- The first GHCR push creates the packages. Package visibility follows the repository settings.
