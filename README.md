# 3D Asset Search for Genex

A [Genex](https://github.com/genex-games/genex-desktop) plugin that searches many sites for free 3D models, materials, textures and HDRIs and brings them into the game. Search runs through [3D Asset Server](https://github.com/arielshad/3d-asset-server).

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

- The plugin finds and downloads free assets only, and never buys anything.
- By default it offers only sources it downloads from, so every result can go straight into the game.
- In **Configuration** you choose the sources it searches. You can also allow sources that only link to their pages; for those, agents give you the link.
- Downloads are limited to 512 MiB, or 1 GiB after unpacking.

## Privacy

- Searches go to `3d.shep.bot`, the public [3D Asset Server](https://github.com/arielshad/3d-asset-server) run by a third party. It receives your search terms and the sources you switched on.
- Files are downloaded straight from the source sites, such as Poly Haven or ambientCG.
- See the [3D Asset Server privacy page](https://3d.shep.bot/privacy).

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
