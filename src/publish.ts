// Uploads a library folder to a Cloudflare R2 bucket: the files whose SHA-256 differs from the live
// manifest, then library.json, then manifest.json, so a client never reads a manifest that names a
// file not uploaded yet.
import { join } from "node:path";
import { diff, type Manifest } from "./manifest";

/** Puts and deletes objects; WranglerStore uses the account `wrangler login` signed in to. */
export interface Store {
  put(key: string, file: string, contentType: string, cacheControl: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg",
};
export const contentType = (path: string) => TYPES[path.slice(path.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";

// Arcwise asks for every file but the two indexes at <path>?v=<hash>, so a changed file has a new
// address and the old one can stay cached for good.
const INDEXES = new Set(["library.json", "manifest.json"]);
export const cacheControl = (path: string) =>
  INDEXES.has(path) ? "public, max-age=60" : "public, max-age=31536000, immutable";

export class WranglerStore implements Store {
  constructor(private bucket: string) {}

  private async run(args: string[]) {
    const proc = Bun.spawn(["bunx", "wrangler", ...args, "--remote"], { stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`wrangler ${args.slice(0, 4).join(" ")} failed: ${err.trim().split("\n").slice(-3).join(" ")}`);
  }

  put(key: string, file: string, type: string, cache: string) {
    return this.run(["r2", "object", "put", `${this.bucket}/${key}`, `--file=${file}`, `--content-type=${type}`, `--cache-control=${cache}`]);
  }

  remove(key: string) {
    return this.run(["r2", "object", "delete", `${this.bucket}/${key}`]);
  }
}

export async function fetchManifest(base: string): Promise<Manifest | null> {
  const res = await fetch(new URL("manifest.json", base.endsWith("/") ? base : `${base}/`), { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.url}: HTTP ${res.status}`);
  return (await res.json()) as Manifest;
}

async function withRetries<T>(what: string, attempt: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i >= tries) throw new Error(`${what}: ${(e as Error).message}`);
      await Bun.sleep(1000 * 2 ** i);
    }
  }
}

export type PublishOptions = {
  store: Store; concurrency: number; prune: boolean; dryRun: boolean;
  log: (line: string) => void;
};

/** Uploads what changed and returns what it did; with dryRun, only what it would do. */
export async function publish(dir: string, local: Manifest, remote: Manifest | null, opts: PublishOptions) {
  const { upload, remove } = diff(local, remote);
  const bytes = upload.reduce((sum, p) => sum + local.files[p].size, 0);
  opts.log(`${upload.length} files to upload (${(bytes / 1e9).toFixed(2)} GB), ${remove.length} no longer in the library${opts.prune ? "" : " (kept; --prune deletes them)"}`);
  if (opts.dryRun) return { upload, remove: opts.prune ? remove : [] };

  let next = 0, done = 0;
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    while (next < upload.length) {
      const path = upload[next++];
      await withRetries(path, () => opts.store.put(path, join(dir, path), contentType(path), cacheControl(path)));
      if (++done % 100 === 0 || done === upload.length) opts.log(`uploaded ${done}/${upload.length}`);
    }
  }));
  await withRetries("library.json", () => opts.store.put("library.json", join(dir, "library.json"), contentType("library.json"), cacheControl("library.json")));
  await Bun.write(join(dir, "manifest.json"), JSON.stringify(local));
  await withRetries("manifest.json", () => opts.store.put("manifest.json", join(dir, "manifest.json"), contentType("manifest.json"), cacheControl("manifest.json")));
  if (opts.prune) for (const path of remove) await withRetries(path, () => opts.store.remove(path));
  return { upload, remove: opts.prune ? remove : [] };
}
