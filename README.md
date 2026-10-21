# 3D Asset Search for Genex

A [Genex](https://github.com/genex-games/genex-desktop) plugin that searches 17 sites for free 3D models, materials, textures and HDRIs and brings them into the game. Search runs through [3D Asset Server](https://github.com/arielshad/3d-asset-server).

## Install

In Genex, open **Plugins → Add → Install from GitHub** and paste `https://github.com/arklanq/genex-asset-search`.

## Tools

| Tool | What it does |
| --- | --- |
| `arklanq-asset-search__search` | Searches the enabled sources. Free. |
| `arklanq-asset-search__details` | Shows the licence, credit line and files for an asset. Free. |
| `arklanq-asset-search__download` | Downloads an asset into `assets/arklanq-asset-search/`. Free. |
| `arklanq-asset-search__sources` | Lists the sources and your settings. Free. |

## Notes

- In **Configuration** you choose the sources and whether paid assets are shown. The plugin never buys anything.
- Downloads are limited to 512 MiB, or 1 GiB after unpacking.

## Develop

```bash
npm test
```

To check the package, run this from a genex-desktop checkout:

```bash
npm run plugin:doctor -- /path/to/genex-asset-search/plugin
```

## Release

Bump `version` in `plugin/plugin.json` and `package.json`, commit, then push a matching tag, such as `v0.2.0`. The workflow publishes a GitHub release with `arklanq-asset-search-<version>.zip`.
