import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";

/** The public 3D Asset Server (github.com/arielshad/3d-asset-server). */
const API = "https://3d.shep.bot";
/** Hosts the plugin downloads files from, each also matching its subdomains. Keep in step with network.hosts. */
const FILE_HOSTS = [
  "3d.shep.bot",
  "polyhaven.org",
  "ambientcg.com",
  "struffelproductions.com",
  "blenderkit.com",
  "kenney.nl",
  "texturecan.com",
  "hdrmaps.com",
];
/** One search fans out to every source, each with its own 12 s limit on the server. */
const SEARCH_TIMEOUT_MS = 60_000;
/** How long one download may take; Studio ends a plugin call after 190 s. */
const DOWNLOAD_TIMEOUT_MS = 170_000;
/** The source list changes rarely, so the panel and searches share one copy for a while. */
const CATALOGUE_TTL_MS = 10 * 60_000;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const MAX_REDIRECTS = 5;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const DESCRIPTION_CHARS = 200;
/** How many delivered paths a download lists; a pack can hold hundreds of files. */
const LISTED_FILES = 40;
const CONFIG_FILE = "config.json";
const USER_AGENT = "genex-asset-search/0.1";
/** Defaults: every source on, only free assets. */
const DEFAULT_CONFIG = { disabled: [], freeOnly: true };

const ASSET_TYPES = ["model", "texture", "material", "hdri", "sprite", "ui", "audio", "font", "pack", "other"];
const ASSET_ID = /^[a-z0-9]{1,40}:[^\s?#]{1,200}$/;
/** Files a game loads directly, so a download can point at them inside a pack. */
const ENTRY_EXTENSIONS = [".glb", ".gltf", ".fbx", ".obj", ".usdz", ".blend", ".hdr", ".exr"];

// Zip record signatures and the values that mean "this archive needs ZIP64".
const ZIP_END = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP_END_SEARCH = 22 + 0xffff;
const ZIP64_COUNT = 0xffff;
const ZIP64_SIZE = 0xffffffff;
const ZIP_METHOD = { Stored: 0, Deflate: 8 };
const ZIP_FLAG_ENCRYPTED = 0x1;
const ZIP_FLAG_UTF8 = 0x800;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;

const MESSAGE = {
  ProjectRequired: "Open a game first.",
  QueryRequired: "search needs a query, for example \"low poly tree\".",
  BadType: `types must be some of ${ASSET_TYPES.join(", ")}.`,
  BadId: "id must be an asset id from asset-search__search, such as polyhaven:wooden_crate_01.",
  BadProvider: "Unknown source.",
  NoSources: "Every source is switched off. Open Plugins → 3D Asset Search → Configuration and switch one on.",
  SourceOff: (name) => `${name} is switched off in Configuration; ask the user before using it.`,
  NotFound: "No asset with that id.",
  NoFiles: (url) => `This asset has no direct download. Send the user to its page: ${url}`,
  NoMatch: "No files match that format and resolution. Call asset-search__details to see what is available.",
  NeedsLogin: (url) => `This file needs a login or payment on the source site: ${url}`,
  BadHost: (host) => `${host} is not a host this plugin downloads from.`,
  BadPath: (name) => `Refused file path ${name}.`,
  TooLarge: "The download is larger than 512 MiB. Pick a lower resolution or a smaller format.",
  TooLargeUnpacked: "The archive unpacks to more than 1 GiB.",
  TooManyRedirects: "Too many redirects.",
  BadZip: "The archive is damaged or uses a format the plugin cannot unpack (ZIP64 or encryption).",
  Server: (status, reason) => `3D Asset Server ${status}: ${reason}`,
  Source: (host, status) => `${host} answered ${status}.`,
  UnknownTool: "Unknown 3D asset tool.",
  UnknownAction: "Unknown 3D asset action.",
};

/** @typedef {import('./plugin-sdk/index.d.ts').PluginContext} Context */
/** @typedef {{ disabled: string[], freeOnly: boolean }} Config */

/**
 * Call the asset server and return its JSON, or throw its own reason.
 * @param {string} route
 * @param {AbortSignal} [signal]
 */
async function server(route, signal) {
  const response = await fetch(`${API}${route}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });
  const body = await response.json().catch(() => null);
  if (response.ok) return body;
  throw new Error(MESSAGE.Server(response.status, body?.error ?? response.statusText));
}

/** @type {{ at: number, list: any[] } | undefined} */
let catalogue;

/** Every source the server knows, cached for a few minutes. @param {AbortSignal} [signal] */
async function providers(signal) {
  if (catalogue && Date.now() - catalogue.at < CATALOGUE_TTL_MS) return catalogue.list;
  const { providers: list } = await server("/v1/providers", signal);
  catalogue = { at: Date.now(), list };
  return list;
}

/** @param {Context} ctx */
const configPath = async (ctx) => path.join(String(await ctx.host("storage.root")), CONFIG_FILE);

/**
 * The user's choices from the panel; a missing or damaged file means the defaults.
 * @param {Context} ctx
 * @returns {Promise<Config>}
 */
async function readConfig(ctx) {
  try {
    const saved = JSON.parse(await readFile(await configPath(ctx), "utf8"));
    return {
      disabled: Array.isArray(saved.disabled) ? saved.disabled.filter((id) => typeof id === "string") : [],
      freeOnly: typeof saved.freeOnly === "boolean" ? saved.freeOnly : DEFAULT_CONFIG.freeOnly,
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** Serialize config writes so two quick switches in the panel do not drop each other. */
let configWrite = Promise.resolve();

/**
 * Apply one change to the saved config and return the result.
 * @param {Context} ctx
 * @param {(config: Config) => void} change
 * @returns {Promise<Config>}
 */
function updateConfig(ctx, change) {
  const next = configWrite.then(async () => {
    const config = await readConfig(ctx);
    change(config);
    const file = await configPath(ctx);
    // Write a sibling first, so a crash never leaves half a file.
    await writeFile(`${file}.tmp`, JSON.stringify(config));
    await rename(`${file}.tmp`, file);
    return config;
  });
  configWrite = next.then(() => {}, () => {});
  return next;
}

/** @param {unknown} text @param {number} max */
const clip = (text, max) => {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value || undefined;
};

/** The credit line a licence asks for, or nothing when it asks for none. @param {any} asset */
function attribution(asset) {
  if (!asset.license?.attributionRequired) return undefined;
  const by = asset.author ? ` by ${asset.author}` : "";
  return `"${asset.title}"${by}, ${asset.license.name}, ${asset.url}`;
}

/** What an agent needs to choose an asset, without the long fields. @param {any} a */
const brief = (a) => ({
  id: a.id,
  title: a.title,
  type: a.type,
  source: a.provider,
  free: a.price?.free,
  price: a.price?.free === false && a.price.amount !== undefined ? `${a.price.amount} ${a.price.currency ?? ""}`.trim() : undefined,
  license: a.license?.name,
  commercialUse: a.license?.commercialUse,
  attributionRequired: a.license?.attributionRequired,
  downloadable: a.downloadable,
  formats: a.formats,
  resolutions: a.resolutions,
  polyCount: a.polyCount,
  animated: a.animated,
  rigged: a.rigged,
  author: a.author,
  description: clip(a.description, DESCRIPTION_CHARS),
  url: a.url,
});

/** @param {unknown} value */
function parseTypes(value) {
  if (value === undefined || value === null || value === "") return [];
  const types = (Array.isArray(value) ? value : String(value).split(",")).map((t) => String(t).trim()).filter(Boolean);
  if (!types.every((t) => ASSET_TYPES.includes(t))) throw new Error(MESSAGE.BadType);
  return types;
}

/** @param {unknown} value */
function assetId(value) {
  const id = String(value ?? "").trim();
  if (!ASSET_ID.test(id) || id.split("/").includes("..")) throw new Error(MESSAGE.BadId);
  return id;
}

/** The server takes the id as one path segment, so its slashes must be escaped. @param {string} id */
const assetRoute = (id) => `/v1/assets/${encodeURIComponent(id).replace(/%3A/g, ":")}`;

/**
 * Search the switched-on sources with the user's free/paid choice.
 * @param {Record<string, any>} args
 * @param {Context} ctx
 */
async function search(args, ctx) {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error(MESSAGE.QueryRequired);
  const types = parseTypes(args.types);
  const config = await readConfig(ctx);
  const sources = (await providers(ctx.signal)).filter((p) => !config.disabled.includes(p.id));
  if (!sources.length) throw new Error(MESSAGE.NoSources);
  const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
  const params = new URLSearchParams({ q: query, limit: String(limit), providers: sources.map((p) => p.id).join(",") });
  if (types.length) params.set("type", types.join(","));
  if (config.freeOnly) params.set("free", "true");
  if (Number(args.offset) > 0) params.set("offset", String(Math.trunc(Number(args.offset))));
  const answer = await server(`/v1/search?${params}`, ctx.signal);
  const report = /** @type {any[]} */ (answer.providers ?? []);
  return {
    query,
    freeOnly: config.freeOnly,
    results: (answer.results ?? []).map(brief),
    // Sites that block automated search come back only as a link to their own search.
    alsoSearchOn: report.filter((r) => r.status === "link" && r.searchUrl).map((r) => ({ source: r.provider, url: r.searchUrl })),
    failed: report
      .filter((r) => r.status === "error" || r.status === "timeout")
      .map((r) => ({ source: r.provider, status: r.status, error: r.error })),
    switchedOff: config.disabled,
  };
}

/**
 * The asset and the files a download would fetch, refusing a source the user switched off.
 * @param {Record<string, any>} args
 * @param {Context} ctx
 */
async function lookup(args, ctx) {
  const id = assetId(args.id);
  const config = await readConfig(ctx);
  const source = id.split(":")[0];
  if (config.disabled.includes(source)) {
    const name = (await providers(ctx.signal)).find((p) => p.id === source)?.name ?? source;
    throw new Error(MESSAGE.SourceOff(name));
  }
  const selection = new URLSearchParams();
  if (args.format) selection.set("format", String(args.format));
  if (args.resolution) selection.set("resolution", String(args.resolution));
  const asset = await server(assetRoute(id), ctx.signal).catch((error) => {
    throw String(error.message).includes(" 404:") ? new Error(MESSAGE.NotFound) : error;
  });
  const { files, totalBytes } = await server(`${assetRoute(id)}/files?${selection}`, ctx.signal);
  return { asset, files: /** @type {any[]} */ (files ?? []), totalBytes };
}

/**
 * Licence, formats and the exact files a download would bring in. Free.
 * @param {Record<string, any>} args
 * @param {Context} ctx
 */
async function details(args, ctx) {
  const { asset, files, totalBytes } = await lookup(args, ctx);
  return {
    ...brief(asset),
    description: clip(asset.description, DESCRIPTION_CHARS * 4),
    tags: asset.tags,
    attribution: attribution(asset),
    download: files.map((f) => ({
      file: f.filename,
      format: f.format,
      resolution: f.resolution,
      bytes: f.sizeBytes,
      companions: f.includes?.length || undefined,
      needsLogin: f.requiresAuth || undefined,
    })),
    totalBytes,
  };
}

/** @param {string} url */
function allowedUrl(url) {
  const target = new URL(url);
  const allowed = FILE_HOSTS.some((h) => target.hostname === h || target.hostname.endsWith(`.${h}`));
  if (target.protocol !== "https:" || !allowed) throw new Error(MESSAGE.BadHost(target.hostname));
  return target;
}

/**
 * Fetch a file, checking every redirect against the host list.
 * @param {string} url
 * @param {AbortSignal} signal
 */
async function fetchFile(url, signal) {
  let current = allowedUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, { redirect: "manual", signal, headers: { "User-Agent": USER_AGENT } });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = allowedUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(MESSAGE.Source(current.hostname, response.status));
    return response;
  }
  throw new Error(MESSAGE.TooManyRedirects);
}

/**
 * A relative path inside the download folder, or nothing for a file that should be left out.
 * @param {string} name
 */
function safeRelative(name) {
  const parts = name.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name) || parts.includes("..")) throw new Error(MESSAGE.BadPath(name));
  // Studio refuses dot paths and dependency folders in a game; archives bring __MACOSX clutter.
  const skipped = parts.some((p) => p.startsWith(".") || p === "node_modules" || p === "__MACOSX");
  return parts.length && !skipped ? parts.join("/") : undefined;
}

/**
 * Stream one file to disk under the shared byte budget.
 * @param {string} url
 * @param {string} target
 * @param {{ bytes: number }} budget
 * @param {AbortSignal} signal
 */
async function saveFile(url, target, budget, signal) {
  const response = await fetchFile(url, signal);
  await mkdir(path.dirname(target), { recursive: true });
  const counted = Readable.fromWeb(/** @type {any} */ (response.body)).map((chunk) => {
    budget.bytes += chunk.length;
    if (budget.bytes > MAX_DOWNLOAD_BYTES) throw new Error(MESSAGE.TooLarge);
    return chunk;
  });
  await pipeline(counted, createWriteStream(target, { flags: "wx" }));
}

/**
 * Find the zip's central directory.
 * @param {Buffer} zip
 */
function zipEnd(zip) {
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - ZIP_END_SEARCH); at--) {
    if (zip.readUInt32LE(at) !== ZIP_END) continue;
    const entries = zip.readUInt16LE(at + 10);
    const offset = zip.readUInt32LE(at + 16);
    if (entries === ZIP64_COUNT || offset === ZIP64_SIZE) break;
    return { entries, offset };
  }
  throw new Error(MESSAGE.BadZip);
}

/**
 * Inflate one entry to exactly its declared size; more output means a damaged or hostile archive.
 * @param {Buffer} data
 * @param {number} size
 */
function inflate(data, size) {
  try {
    // zlib refuses a limit of 0, and tools do deflate empty files.
    return inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
  } catch {
    throw new Error(MESSAGE.BadZip);
  }
}

/**
 * Unpack a zip into `dir`, refusing paths that escape it and skipping links.
 * @param {Buffer} zip
 * @param {string} dir
 */
async function unzip(zip, dir) {
  try {
    await unpackEntries(zip, dir);
  } catch (error) {
    // A record pointing outside the file, as a cut-off download leaves it, fails the buffer read.
    throw error instanceof RangeError ? new Error(MESSAGE.BadZip) : error;
  }
}

/** @param {Buffer} zip @param {string} dir */
async function unpackEntries(zip, dir) {
  const { entries, offset } = zipEnd(zip);
  if (entries > MAX_ZIP_ENTRIES) throw new Error(MESSAGE.BadZip);
  let unpacked = 0;
  for (let i = 0, at = offset; i < entries; i++) {
    if (zip.readUInt32LE(at) !== ZIP_CENTRAL) throw new Error(MESSAGE.BadZip);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const headerExtra = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString(flags & ZIP_FLAG_UTF8 ? "utf8" : "latin1", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + headerExtra;
    if (name.endsWith("/") || (mode & UNIX_TYPE_MASK) === UNIX_SYMLINK) continue;
    const relative = safeRelative(name);
    if (!relative) continue;
    if (flags & ZIP_FLAG_ENCRYPTED || packed === ZIP64_SIZE || size === ZIP64_SIZE) throw new Error(MESSAGE.BadZip);
    if (zip.readUInt32LE(local) !== ZIP_LOCAL) throw new Error(MESSAGE.BadZip);
    unpacked += size;
    if (unpacked > MAX_UNPACKED_BYTES) throw new Error(MESSAGE.TooLargeUnpacked);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + packed);
    const bytes = method === ZIP_METHOD.Deflate ? inflate(data, size) : data;
    if (![ZIP_METHOD.Stored, ZIP_METHOD.Deflate].includes(method) || bytes.length !== size) throw new Error(MESSAGE.BadZip);
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
}

/**
 * Download the chosen files, unpack archives and copy everything into the game.
 * @param {Record<string, any>} args
 * @param {Context} ctx
 */
async function download(args, ctx) {
  const { asset, files } = await lookup(args, ctx);
  if (!asset.files?.length && !files.length) throw new Error(MESSAGE.NoFiles(asset.url));
  // The server's file selection leaves out files behind a login, so an asset with only those selects none.
  const loginOnly = asset.files?.length && asset.files.every((/** @type {any} */ f) => f.requiresAuth);
  if (files.some((f) => f.requiresAuth) || (!files.length && loginOnly)) throw new Error(MESSAGE.NeedsLogin(asset.url));
  if (!files.length) throw new Error(MESSAGE.NoMatch);
  const jobId = randomUUID();
  const dir = path.join(String(await ctx.host("storage.root")), "downloads", jobId);
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
  const budget = { bytes: 0 };
  try {
    for (const file of files) {
      const main = safeRelative(file.filename);
      if (!main) throw new Error(MESSAGE.BadPath(file.filename));
      // Companions sit next to the main file at their own relative paths, so a glTF finds its textures.
      for (const extra of file.includes ?? []) {
        const relative = safeRelative(path.posix.join(path.posix.dirname(main), extra.path));
        if (relative) await saveFile(extra.url, path.join(dir, relative), budget, signal);
      }
      const target = path.join(dir, main);
      await saveFile(file.url, target, budget, signal);
      if (path.extname(main).toLowerCase() === ".zip") {
        await unzip(await readFile(target), target.slice(0, -".zip".length));
        await rm(target);
      }
    }
    const delivered = /** @type {string[]} */ (await ctx.host("assets.deliver", { output: dir, jobId }));
    const rank = (/** @type {string} */ f) => ENTRY_EXTENSIONS.indexOf(path.extname(f).toLowerCase());
    // Web-friendly formats first: a pack often ships the same models as FBX, OBJ and glTF.
    const entries = delivered.filter((f) => rank(f) >= 0).sort((a, b) => rank(a) - rank(b));
    return {
      id: asset.id,
      title: asset.title,
      license: asset.license?.name,
      attribution: attribution(asset),
      folder: `assets/asset-search/${jobId}`,
      fileCount: delivered.length,
      entries: entries.slice(0, LISTED_FILES),
      files: delivered.slice(0, LISTED_FILES),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The source list with each source's switch, and the free/paid choice, for the panel.
 * @param {Context} ctx
 */
async function settings(ctx) {
  const [config, list] = await Promise.all([readConfig(ctx), providers(ctx.signal)]);
  return {
    freeOnly: config.freeOnly,
    sources: list.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      types: p.assetTypes,
      pricing: p.pricing,
      access: p.access,
      directDownload: p.supportsDownload,
      enabled: !config.disabled.includes(p.id),
    })),
  };
}

/** @type {Record<string, (args: Record<string, any>, ctx: Context) => Promise<unknown>>} */
const TOOLS = {
  search,
  details,
  sources: (_args, ctx) => settings(ctx),
  async download(args, ctx) {
    if (!ctx.project || !ctx.directory) throw new Error(MESSAGE.ProjectRequired);
    return download(args, ctx);
  },
};

/** @type {Record<string, (args: Record<string, any>, ctx: Context) => Promise<unknown>>} */
const ACTIONS = {
  settings: (_args, ctx) => settings(ctx),
  // One change per call: `{source, enabled}` flips a source, `{freeOnly}` flips the price filter.
  async configure(args, ctx) {
    if (typeof args.freeOnly === "boolean") {
      await updateConfig(ctx, (config) => {
        config.freeOnly = args.freeOnly;
      });
    }
    if (typeof args.source === "string" && typeof args.enabled === "boolean") {
      if (!(await providers(ctx.signal)).some((p) => p.id === args.source)) throw new Error(MESSAGE.BadProvider);
      await updateConfig(ctx, (config) => {
        const others = config.disabled.filter((id) => id !== args.source);
        config.disabled = args.enabled ? others : [...others, args.source];
      });
    }
    return settings(ctx);
  },
};

/** @type {import('./plugin-sdk/index.d.ts').Activate} */
export const activate = async () => ({
  async tool(name, args, ctx) {
    const run = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
    if (!run) throw new Error(MESSAGE.UnknownTool);
    return run(args, ctx);
  },
  async action(name, args, ctx) {
    const run = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
    if (!run) throw new Error(MESSAGE.UnknownAction);
    return run(args, ctx);
  },
});
