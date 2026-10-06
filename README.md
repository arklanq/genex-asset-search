# 3D Asset Search for Genex

A Genex Studio plugin that lets in-app agents search 17 sites for 3D models, PBR materials,
textures and HDRIs at once, and bring free ones straight into the game. Search runs through the
public [3D Asset Server](https://github.com/arielshad/3d-asset-server) at `https://3d.shep.bot`;
files are downloaded directly from the source sites.

## Install

In Genex: **Plugins → Add → Install from GitHub** and paste `https://github.com/arklanq/genex-asset-search`. Studio installs the latest release. To install by hand instead, download `asset-search-<version>.zip` from [Releases](https://github.com/arklanq/genex-asset-search/releases), unpack it and choose its folder with **Plugins → Add → Load local plugin…**.

## Tools

| Tool | What it does |
| --- | --- |
| `asset-search__search` | Ranked results from the sources switched on, with licence, price, formats and `downloadable`. |
| `asset-search__details` | Licence, credit line and the exact files a download would bring in. |
| `asset-search__download` | Downloads an asset with its companion files into `assets/asset-search/<job>/` (`public/assets/…` in a game with a build step), unpacking zip packs. |
| `asset-search__sources` | The sources and the user's choices. |

## Configuration

Plugins → 3D Asset Search → **Configuration**:

- The price switch is off by default (**Free assets only**). Switched on (**Free and paid assets**), paid
  listings show up with their price and link; the plugin never buys anything.
- One switch per source. A switched-off source is left out of searches and its assets cannot be
  downloaded.

The choices are saved in the plugin's own storage, outside games.

## Safety

- Downloads only over https from the hosts in `network.hosts`, checking every redirect.
- Zip entries that escape the folder are refused; links, dot files, `node_modules` and `__MACOSX` are
  skipped. ZIP64, encrypted and damaged archives are refused.
- 512 MiB per download, 1 GiB unpacked, 5,000 entries per archive.

## Develop

```bash
npm test
node /path/to/genex-desktop/scripts/plugin-doctor.ts plugin
```

Load `plugin/` in Studio with Plugins → Add → Load local plugin…, then press **Watch folder**.

## Release

Bump `version` in `plugin/plugin.json` and `package.json`, commit, then push a matching tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The Release workflow runs the tests and publishes a GitHub release with `asset-search-<version>.zip` attached.
