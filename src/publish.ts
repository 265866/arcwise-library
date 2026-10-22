// Uploads a library folder to a Cloudflare R2 bucket with the `cf` CLI: the files whose SHA-256
// differs from the live manifest, then library.json, then manifest.json, so a client never reads a
// manifest that names a file not uploaded yet.
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { diff, type Manifest } from "./manifest";

/** Reads, puts and deletes objects; CfStore uses the account the `cf` CLI is signed in to. */
export interface Store {
  /** Names the store in the journal of uploads a publish has not finished. */
  readonly name: string;
  get(key: string): Promise<string | null>;
  put(key: string, file: string, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg",
};
export const contentType = (path: string) => TYPES[path.slice(path.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream";

// R2 error 10007: the key does not exist.
const MISSING = "[10007]";

export class CfStore implements Store {
  constructor(private bucket: string) {}

  get name() {
    return this.bucket;
  }

  private async run(args: string[]) {
    const proc = Bun.spawn(["cf", "r2", "objects", ...args, "--bucket-name", this.bucket], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { ok: code === 0, out, err: `${err}${code === 0 ? "" : out}` };
  }

  private failed(what: string, err: string): never {
    throw new Error(`cf r2 objects ${what} failed: ${err.trim().split("\n").filter((l) => l.trim()).slice(0, 3).join(" ")}`);
  }

  async get(key: string) {
    const { ok, out, err } = await this.run(["get", key]);
    if (ok) return out;
    if (err.includes(MISSING)) return null;
    this.failed(`get ${key}`, err);
  }

  async put(key: string, file: string, type: string) {
    const { ok, err } = await this.run(["put", key, "--file", file, "--content-type", type]);
    if (!ok) this.failed(`put ${key}`, err);
  }

  async remove(key: string) {
    const { ok, err } = await this.run(["delete", key, "--force"]);
    if (!ok) this.failed(`delete ${key}`, err);
  }
}

/** The manifest already in the store, or null when nothing is published yet. */
export async function liveManifest(store: Store): Promise<Manifest | null> {
  const text = await store.get("manifest.json");
  return text === null ? null : (JSON.parse(text) as Manifest);
}

// Six tries over about a minute ride out the Cloudflare API's rate limit (HTTP 429).
async function withRetries<T>(what: string, attempt: () => Promise<T>, waitMs: number, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i >= tries) throw new Error(`${what}: ${(e as Error).message}`);
      await Bun.sleep(waitMs * 2 ** (i - 1));
    }
  }
}

export type PublishOptions = {
  store: Store; concurrency: number; prune: boolean; dryRun: boolean;
  log: (line: string) => void;
  /** The wait before the first retry, doubling after each; 2 s unless set. */
  retryMs?: number;
};

// Each file uploaded is written to a journal, so a publish that stopped before its manifest went up
// resumes where it stopped instead of uploading everything again. The manifest's upload ends it.
const journalOf = (dir: string, store: Store) => join(dir, `.publish-journal-${store.name}`);

// With --prune, the files to delete are listed in a second file until all are deleted, since once
// the new manifest is live a later publish no longer knows of them.
const pruneListOf = (dir: string, store: Store) => join(dir, `.publish-prune-${store.name}`);

async function lines(path: string) {
  const file = Bun.file(path);
  return (await file.exists()) ? (await file.text()).split("\n").filter(Boolean) : [];
}

async function uploadedBefore(journal: string, local: Manifest) {
  const done = new Set<string>();
  for (const line of await lines(journal)) {
    const at = line.indexOf(" ");
    const path = line.slice(at + 1);
    if (at > 0 && local.files[path]?.sha256 === line.slice(0, at)) done.add(path);
  }
  return done;
}

/** Uploads what changed and returns what it did; with dryRun, only what it would do. */
export async function publish(dir: string, local: Manifest, remote: Manifest | null, opts: PublishOptions) {
  const journal = journalOf(dir, opts.store);
  const retry = <T>(what: string, attempt: () => Promise<T>) => withRetries(what, attempt, opts.retryMs ?? 2000);
  const changed = diff(local, remote);
  const before = await uploadedBefore(journal, local);
  const pruneList = pruneListOf(dir, opts.store);
  const leftOver = (await lines(pruneList)).filter((p) => !local.files[p] && !changed.remove.includes(p));
  const upload = changed.upload.filter((p) => !before.has(p)), remove = [...changed.remove, ...leftOver];
  if (before.size) opts.log(`${before.size} files were uploaded by a publish that did not finish`);
  const bytes = upload.reduce((sum, p) => sum + local.files[p].size, 0);
  opts.log(`${upload.length} files to upload (${(bytes / 1e9).toFixed(2)} GB), ${remove.length} no longer in the library${opts.prune ? "" : " (kept; --prune deletes them)"}`);
  if (opts.dryRun) return { upload, remove: opts.prune ? remove : [] };

  let next = 0, done = 0;
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    while (next < upload.length) {
      const path = upload[next++];
      await retry(path, () => opts.store.put(path, join(dir, path), contentType(path)));
      await appendFile(journal, `${local.files[path].sha256} ${path}\n`);
      if (++done % 100 === 0 || done === upload.length) opts.log(`uploaded ${done}/${upload.length}`);
    }
  }));
  await retry("library.json", () => opts.store.put("library.json", join(dir, "library.json"), contentType("library.json")));
  await Bun.write(join(dir, "manifest.json"), JSON.stringify(local));
  await retry("manifest.json", () => opts.store.put("manifest.json", join(dir, "manifest.json"), contentType("manifest.json")));
  if (opts.prune && remove.length) await Bun.write(pruneList, remove.map((p) => `${p}\n`).join(""));
  await rm(journal, { force: true });
  if (opts.prune) {
    for (const path of remove) await retry(path, () => opts.store.remove(path));
    await rm(pruneList, { force: true });
  }
  return { upload, remove: opts.prune ? remove : [] };
}
