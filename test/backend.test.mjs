import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { activate } from "../plugin/backend.mjs";

const PROVIDERS = [
  { id: "polyhaven", name: "Poly Haven", assetTypes: ["model", "hdri"], access: "api", pricing: "free", supportsDownload: true },
  { id: "kenney", name: "Kenney", assetTypes: ["model"], access: "scrape", pricing: "free", supportsDownload: true },
  { id: "fab", name: "Fab", assetTypes: ["model"], access: "link", pricing: "freemium", supportsDownload: false },
  // Offers downloads from hosts the plugin has not checked, so it is never offered.
  { id: "mystery", name: "Mystery", assetTypes: ["model"], access: "api", pricing: "free", supportsDownload: true },
  // On the plugin's blocklist: it refuses every automated search.
  { id: "cgtrader", name: "CGTrader", assetTypes: ["model"], access: "scrape", pricing: "freemium", supportsDownload: false },
];
const CRATE = {
  id: "polyhaven:crate",
  provider: "polyhaven",
  title: "Crate",
  type: "model",
  url: "https://polyhaven.com/a/crate",
  license: { name: "CC-BY", attributionRequired: true },
  author: "Ana",
  price: { free: true },
  downloadable: true,
};
/** A paid listing, as a freemium source returns one when the server's free filter misses it. */
const PAID = { ...CRATE, id: "polyhaven:paid_crate", title: "Paid crate", price: { free: false, amount: 25, currency: "USD" } };
/** A listing from a source that only links to its own page. */
const LINK = { ...CRATE, id: "fab:chair", provider: "fab", title: "Chair", url: "https://www.fab.com/listings/chair", downloadable: false };
const GLTF = {
  url: "https://dl.polyhaven.org/crate/crate_2k.gltf",
  filename: "crate_2k.gltf",
  format: "gltf",
  includes: [
    { path: "crate.bin", url: "https://dl.polyhaven.org/crate/crate.bin" },
    { path: "textures/crate_diff.jpg", url: "https://dl.polyhaven.org/crate/diff.jpg" },
  ],
};

/** A zip of `entries` ({name, text, symlink?, size?}), deflated like the packs the sources serve; `size` overrides the declared size. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, text, symlink, size } of entries) {
    const raw = Buffer.from(text);
    const declared = size ?? raw.length;
    const packed = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A zip whose directory points past its own end, as a cut-off download leaves it. */
function truncatedZip() {
  const zip = makeZip([{ name: "tree.glb", text: "glb" }]);
  zip.writeUInt32LE(zip.length + 1000, zip.length - 6);
  return zip;
}

/** A fake Studio host whose delivery copies the output tree into the game, under `assetRoot` as Studio does for a game with a build step. */
function fakeHost(root, game, assetRoot = "") {
  const host = async (method, args) => {
    if (method === "storage.root") return root;
    if (method !== "assets.deliver") throw new Error(`unexpected host call ${method}`);
    const target = path.join(game, assetRoot, "assets", "arklanq-asset-search", args.jobId);
    await cp(args.output, target, { recursive: true });
    const files = await readdir(target, { recursive: true, withFileTypes: true });
    return files
      .filter((f) => f.isFile())
      .map((f) => path.relative(game, path.join(f.parentPath, f.name)))
      .sort();
  };
  return { project: "demo", directory: game, threadId: "t", callId: 1, signal: new AbortController().signal, host };
}

/**
 * Route fetch to a canned asset server and canned source files.
 * `assetFiles` is the asset's full file list; the files route, like the real server, leaves out those that need a login.
 * @param {{ asset?: any, files?: any[], assetFiles?: any[], blobs?: Record<string, Buffer | string>, redirects?: Record<string, string> }} [fake]
 */
function fakeServer({ asset = CRATE, files = [GLTF], assetFiles = files, blobs = {}, redirects = {} } = {}) {
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.hostname === "3d.shep.bot") {
      if (url.pathname === "/v1/providers") return Response.json({ providers: PROVIDERS });
      if (url.pathname === "/v1/search")
        return Response.json({
          results: [{ ...CRATE, description: "x".repeat(500), tags: ["a"] }, PAID, LINK, { ...CRATE, id: "mystery:box", provider: "mystery" }],
          providers: [
            { provider: "polyhaven", status: "ok", count: 1 },
            { provider: "fab", status: "link", searchUrl: "https://www.fab.com/search?q=crate" },
            { provider: "kenney", status: "timeout", error: "took too long" },
          ],
        });
      if (url.pathname.endsWith("/files")) return Response.json({ id: asset.id, files, totalBytes: 10 });
      if (url.pathname.startsWith("/v1/assets/")) return Response.json({ ...asset, files: assetFiles });
    }
    if (redirects[url.href]) return new Response(null, { status: 302, headers: { location: redirects[url.href] } });
    if (blobs[url.href] !== undefined) return new Response(blobs[url.href]);
    return new Response(`body of ${url.pathname}`);
  };
  return requests;
}

const realFetch = globalThis.fetch;
let root;
let game;
let ctx;
let plugin;
beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "asset-search-plugin-"));
  root = path.join(base, "storage");
  game = path.join(base, "game");
  await mkdir(root);
  await mkdir(game);
  ctx = fakeHost(root, game);
  plugin = await activate(/** @type {any} */ ({}));
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("search asks only the switched-on sources, with the free filter, and splits out links and failures", async () => {
  const requests = fakeServer();
  await plugin.action("configure", { source: "kenney", enabled: false }, ctx);
  const answer = await plugin.tool("search", { query: " crate ", types: "model,hdri", limit: 99 }, ctx);

  const sent = requests.find((u) => u.pathname === "/v1/search");
  assert.equal(sent.searchParams.get("providers"), "polyhaven", "only switched-on sources the plugin downloads from");
  assert.equal(sent.searchParams.get("free"), "true");
  assert.equal(sent.searchParams.get("type"), "model,hdri");
  assert.equal(sent.searchParams.get("limit"), "30");
  assert.equal(answer.results[0].id, "polyhaven:crate");
  assert.ok(answer.results[0].description.length <= 200);
  assert.equal(answer.results[0].tags, undefined);
  assert.deepEqual(answer.results.map((r) => r.id), ["polyhaven:crate"], "paid, link-only and unsupported listings are left out");
  assert.equal("free" in answer.results[0] || "price" in answer.results[0], false);
  assert.equal("freeOnly" in answer, false);
  assert.deepEqual(answer.alsoSearchOn, []);
  assert.equal(answer.allowLinks, false);
  assert.deepEqual(answer.failed, [{ source: "kenney", status: "timeout", error: "took too long" }]);
  assert.deepEqual(answer.switchedOff, ["kenney"]);
});

test("allowing links adds link-only sources and listings, survives a restart, and never adds unsupported sources", async () => {
  const requests = fakeServer();
  await plugin.action("configure", { allowLinks: true }, ctx);
  const fresh = await activate(/** @type {any} */ ({}));
  const answer = await fresh.tool("search", { query: "crate" }, ctx);
  assert.equal(requests.find((u) => u.pathname === "/v1/search").searchParams.get("providers"), "polyhaven,kenney,fab");
  assert.deepEqual(answer.results.map((r) => r.id), ["polyhaven:crate", "fab:chair"]);
  assert.deepEqual(answer.alsoSearchOn, [{ source: "fab", url: "https://www.fab.com/search?q=crate" }]);
  assert.equal(answer.allowLinks, true);
  const settings = await fresh.action("settings", {}, ctx);
  assert.equal(settings.allowLinks, true);
  assert.deepEqual(settings.sources.map((s) => s.id), ["polyhaven", "kenney", "fab"]);
});

test("a blocked source is never searched, listed or accepted, even with links allowed", async () => {
  const requests = fakeServer();
  await plugin.action("configure", { allowLinks: true }, ctx);
  await plugin.tool("search", { query: "crate" }, ctx);
  assert.doesNotMatch(requests.find((u) => u.pathname === "/v1/search").searchParams.get("providers"), /cgtrader/);
  assert.equal((await plugin.action("settings", {}, ctx)).sources.some((s) => s.id === "cgtrader"), false);
  await assert.rejects(plugin.action("configure", { source: "cgtrader", enabled: true }, ctx), /Unknown source/);
  await assert.rejects(plugin.tool("details", { id: "cgtrader:chair" }, ctx), /CGTrader is not a source this plugin supports/);
});

test("search asks for free assets only, even when an older version saved a choice that allowed paid ones", async () => {
  const requests = fakeServer();
  await writeFile(path.join(root, "config.json"), JSON.stringify({ disabled: [], freeOnly: false }));
  await plugin.action("configure", { freeOnly: false }, ctx);
  await plugin.tool("search", { query: "crate" }, ctx);
  assert.equal(requests.find((u) => u.pathname === "/v1/search").searchParams.get("free"), "true");
  assert.equal("freeOnly" in (await plugin.action("settings", {}, ctx)), false);
});

test("details and download refuse a paid asset before fetching any file", async () => {
  const requests = fakeServer({ asset: PAID });
  for (const tool of ["details", "download"]) {
    await assert.rejects(plugin.tool(tool, { id: PAID.id }, ctx), /only free assets/);
  }
  assert.equal(requests.some((u) => u.pathname.endsWith("/files") || u.hostname !== "3d.shep.bot"), false);
  assert.deepEqual(await readdir(game), []);
});

test("settings lists every source with its switch, and configure refuses unknown sources", async () => {
  fakeServer();
  const settings = await plugin.action("configure", { source: "kenney", enabled: false }, ctx);
  assert.equal("freeOnly" in settings, false);
  assert.equal(settings.allowLinks, false);
  assert.equal(settings.sources.some((s) => "pricing" in s), false);
  assert.deepEqual(
    settings.sources.map((s) => [s.id, s.enabled]),
    [["polyhaven", true], ["kenney", false]],
    "by default only sources the plugin downloads from",
  );
  await plugin.action("configure", { source: "kenney", enabled: true }, ctx);
  assert.ok((await plugin.action("settings", {}, ctx)).sources.every((s) => s.enabled));
  for (const source of ["../x", "mystery"])
    await assert.rejects(plugin.action("configure", { source, enabled: false }, ctx), /Unknown source/);
});

test("search refuses to run with every source switched off", async () => {
  fakeServer();
  for (const source of ["polyhaven", "kenney"]) await plugin.action("configure", { source, enabled: false }, ctx);
  await assert.rejects(plugin.tool("search", { query: "crate" }, ctx), /Every source is switched off/);
});

test("download puts a glTF and its companions at their relative paths and returns the credit line", async () => {
  fakeServer();
  const result = await plugin.tool("download", { id: "polyhaven:crate", format: "gltf" }, ctx);
  const folder = result.folder;
  assert.match(folder, /^assets\/arklanq-asset-search\/[a-f0-9-]{36}$/);
  assert.deepEqual(result.files, [`${folder}/crate.bin`, `${folder}/crate_2k.gltf`, `${folder}/textures/crate_diff.jpg`]);
  assert.deepEqual(result.entries, [`${folder}/crate_2k.gltf`]);
  assert.equal(await readFile(path.join(game, folder, "textures/crate_diff.jpg"), "utf8"), "body of /crate/diff.jpg");
  assert.equal(result.attribution, '"Crate" by Ana, CC-BY, https://polyhaven.com/a/crate');
  assert.deepEqual(await readdir(path.join(root, "downloads")), [], "staging copy removed");
});

test("download names the folder Studio delivered to, also inside public/ for a game with a build step", async () => {
  fakeServer();
  const result = await plugin.tool("download", { id: "polyhaven:crate" }, fakeHost(root, game, "public"));
  assert.match(result.folder, /^public\/assets\/arklanq-asset-search\/[a-f0-9-]{36}$/);
  assert.ok(result.files.every((f) => f.startsWith(`${result.folder}/`)));
});

test("a zip pack is unpacked, skipping links, dot files and macOS clutter", async () => {
  const zipUrl = "https://kenney.nl/media/kit.zip";
  const zip = makeZip([
    { name: "kit/Models/FBX/tree.fbx", text: "fbx" },
    { name: "kit/Models/tree.glb", text: "glb" },
    { name: "kit/License.txt", text: "CC0" },
    { name: "kit/link", text: "/etc/passwd", symlink: true },
    { name: "__MACOSX/kit/._tree.glb", text: "x" },
    { name: "kit/.DS_Store", text: "x" },
  ]);
  fakeServer({
    asset: { ...CRATE, id: "kenney:kit", provider: "kenney" },
    files: [{ url: zipUrl, filename: "kenney_kit.zip", format: "zip" }],
    blobs: { [zipUrl]: zip },
  });
  const result = await plugin.tool("download", { id: "kenney:kit" }, ctx);
  const folder = result.folder;
  assert.deepEqual(result.files, [
    `${folder}/kenney_kit/kit/License.txt`,
    `${folder}/kenney_kit/kit/Models/FBX/tree.fbx`,
    `${folder}/kenney_kit/kit/Models/tree.glb`,
  ]);
  assert.deepEqual(result.entries, [`${folder}/kenney_kit/kit/Models/tree.glb`, `${folder}/kenney_kit/kit/Models/FBX/tree.fbx`]);
  assert.equal(await readFile(path.join(game, folder, "kenney_kit/kit/Models/tree.glb"), "utf8"), "glb");
});

test("a zip pack keeps an empty file that its tool deflated", async () => {
  const zipUrl = "https://kenney.nl/media/kit.zip";
  fakeServer({
    asset: { ...CRATE, id: "kenney:kit", provider: "kenney" },
    files: [{ url: zipUrl, filename: "kit.zip", format: "zip" }],
    blobs: { [zipUrl]: makeZip([{ name: "tree.glb", text: "glb" }, { name: "empty.txt", text: "" }]) },
  });
  const result = await plugin.tool("download", { id: "kenney:kit" }, ctx);
  assert.deepEqual(result.files, [`${result.folder}/kit/empty.txt`, `${result.folder}/kit/tree.glb`]);
  assert.equal(await readFile(path.join(game, result.folder, "kit/empty.txt"), "utf8"), "");
});

test("hostile archives, paths and hosts are refused before anything reaches the game", async () => {
  const zipUrl = "https://kenney.nl/media/evil.zip";
  const cases = [
    [{ files: [{ url: zipUrl, filename: "evil.zip", format: "zip" }], blobs: { [zipUrl]: makeZip([{ name: "../../escape.txt", text: "x" }]) } }, /Refused file path/],
    [{ files: [{ url: zipUrl, filename: "evil.zip", format: "zip" }], blobs: { [zipUrl]: makeZip([{ name: "/etc/escape", text: "x" }]) } }, /Refused file path/],
    [{ files: [{ url: zipUrl, filename: "evil.zip", format: "zip" }], blobs: { [zipUrl]: Buffer.from("not a zip") } }, /damaged/],
    [{ files: [{ url: zipUrl, filename: "evil.zip", format: "zip" }], blobs: { [zipUrl]: makeZip([{ name: "bomb.bin", text: "x".repeat(4096), size: 16 }]) } }, /damaged/],
    [{ files: [{ url: zipUrl, filename: "evil.zip", format: "zip" }], blobs: { [zipUrl]: truncatedZip() } }, /damaged/],
    [{ files: [{ ...GLTF, filename: "../crate.gltf" }] }, /Refused file path/],
    [{ files: [{ ...GLTF, includes: [{ path: "../../x.bin", url: GLTF.url }] }] }, /Refused file path/],
    [{ files: [{ ...GLTF, url: "https://evil.example/crate.gltf", includes: [] }] }, /evil\.example is not a host/],
    [{ files: [{ ...GLTF, url: "http://dl.polyhaven.org/crate.gltf", includes: [] }] }, /not a host/],
    [{ files: [{ ...GLTF, includes: [] }], redirects: { [GLTF.url]: "https://169.254.169.254/latest" } }, /169\.254\.169\.254 is not a host/],
    [{ files: [{ ...GLTF, requiresAuth: true }] }, /needs a login/],
    [{ files: [], assetFiles: [{ ...GLTF, requiresAuth: true }] }, /needs a login/],
    [{ files: [] }, /no direct download/],
  ];
  for (const [fake, error] of cases) {
    fakeServer({ asset: { ...CRATE, id: "kenney:kit", provider: "kenney" }, ...fake });
    await assert.rejects(plugin.tool("download", { id: "kenney:kit" }, ctx), error);
  }
  await assert.rejects(readdir(path.join(game, "assets")), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(root, "downloads")), []);
});

test("bad ids and switched-off sources are refused before the server is asked for files", async () => {
  const requests = fakeServer();
  for (const id of ["crate", "polyhaven:../../v1/stats", "polyhaven:a b", "Polyhaven:x"])
    await assert.rejects(plugin.tool("details", { id }, ctx), /id must be/);
  await plugin.action("configure", { source: "polyhaven", enabled: false }, ctx);
  await assert.rejects(plugin.tool("download", { id: "polyhaven:crate" }, ctx), /Poly Haven is switched off/);
  await assert.rejects(plugin.tool("details", { id: "fab:chair" }, ctx), /Fab only links to its pages/);
  await plugin.action("configure", { allowLinks: true }, ctx);
  await assert.rejects(plugin.tool("details", { id: "mystery:box" }, ctx), /Mystery is not a source this plugin supports/);
  assert.equal(requests.filter((u) => u.pathname.startsWith("/v1/assets")).length, 0);
});

test("details reports the files a download would fetch for the chosen format", async () => {
  const requests = fakeServer();
  const answer = await plugin.tool("details", { id: "polyhaven:crate", format: "gltf", resolution: "1k" }, ctx);
  const files = requests.find((u) => u.pathname.endsWith("/files"));
  assert.equal(files.searchParams.get("format"), "gltf");
  assert.equal(files.searchParams.get("resolution"), "1k");
  assert.deepEqual(answer.download, [
    { file: "crate_2k.gltf", format: "gltf", resolution: undefined, bytes: undefined, companions: 2, needsLogin: undefined },
  ]);
});

test("download takes files from the hosts of every source that offers downloads", async () => {
  const urls = [
    "https://polyfork.dev/files/chest.glb",
    "https://grab3d.com/download/chest.glb",
    "https://upload.wikimedia.org/wikipedia/commons/a/ab/Chest.stl",
    "https://opengameart.org/sites/default/files/chest.glb",
  ];
  for (const url of urls) {
    const filename = url.split("/").at(-1);
    fakeServer({ files: [{ url, filename, format: "glb" }], blobs: { [url]: "model" } });
    const result = await plugin.tool("download", { id: "polyhaven:crate" }, ctx);
    assert.deepEqual(result.files.map((f) => path.basename(f)), [filename], url);
  }
});

test("download of a listing that only links to its page sends the user to the page, without fetching any file", async () => {
  const page = { url: "https://www.fab.com/listings/chair", filename: "chair", format: "other" };
  const requests = fakeServer({ asset: LINK, files: [page] });
  await plugin.action("configure", { allowLinks: true }, ctx);
  await assert.rejects(plugin.tool("download", { id: LINK.id }, ctx), (error) => {
    assert.match(error.message, /no direct download/);
    assert.ok(error.message.includes(LINK.url));
    assert.doesNotMatch(error.message, /not a host/);
    return true;
  });
  assert.equal(requests.some((u) => u.hostname !== "3d.shep.bot"), false);
});

test("details marks an asset not downloadable when a file comes from a host the plugin does not download from", async () => {
  const outside = { ...GLTF, includes: [{ path: "crate.bin", url: "https://cdn.unknown.example/crate.bin" }] };
  fakeServer({ files: [outside] });
  const answer = await plugin.tool("details", { id: "polyhaven:crate" }, ctx);
  assert.equal(answer.downloadable, false);
  assert.match(answer.notDownloadable, /cdn\.unknown\.example/);
  assert.equal(answer.url, CRATE.url);

  fakeServer();
  const allowed = await plugin.tool("details", { id: "polyhaven:crate" }, ctx);
  assert.equal(allowed.downloadable, true);
  assert.equal(allowed.notDownloadable, undefined);
});

test("an answer from the asset server that is not JSON is reported as the server's", async () => {
  globalThis.fetch = async () => new Response("<html>Gateway</html>", { headers: { "content-type": "text/html" } });
  await assert.rejects(plugin.tool("details", { id: "polyhaven:crate" }, ctx), /^Error: 3D Asset Server 200/);
});

test("quick switches in the panel all persist", async () => {
  fakeServer();
  await Promise.all([
    plugin.action("configure", { source: "kenney", enabled: false }, ctx),
    plugin.action("configure", { source: "fab", enabled: false }, ctx),
    plugin.action("configure", { allowLinks: true }, ctx),
  ]);
  const settings = await plugin.action("settings", {}, ctx);
  assert.equal(settings.allowLinks, true);
  assert.deepEqual(settings.sources.filter((s) => !s.enabled).map((s) => s.id), ["kenney", "fab"]);
});

test("a download follows a redirect to an allowed host and gives up on a redirect loop", async () => {
  const cdn = "https://cdn3.struffelproductions.com/crate.gltf";
  fakeServer({ files: [{ ...GLTF, includes: [] }], redirects: { [GLTF.url]: cdn }, blobs: { [cdn]: "gltf" } });
  const result = await plugin.tool("download", { id: "polyhaven:crate" }, ctx);
  assert.equal(await readFile(path.join(game, result.folder, "crate_2k.gltf"), "utf8"), "gltf");

  fakeServer({ files: [{ ...GLTF, includes: [] }], redirects: { [GLTF.url]: GLTF.url } });
  await assert.rejects(plugin.tool("download", { id: "polyhaven:crate" }, ctx), /Too many redirects/);
});
