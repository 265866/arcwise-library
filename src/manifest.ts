// manifest.json: every file in a library but library.json and the manifest itself, with its size and
// SHA-256 (docs/format.md). Hashing tens of gigabytes takes a while, so hashes are kept in
// .publish-cache.json beside the library and reused while a file's size and modified time match.
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export type Entry = { size: number; sha256: string };
export type Manifest = { format: 1; files: Record<string, Entry> };
type Cache = Record<string, Entry & { mtime: number }>;

const SKIP = new Set(["library.json", "manifest.json"]);

/** Library-relative paths, with forward slashes, of every file that belongs in the manifest. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(e => e.isFile())
    .map(e => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .filter(p => !SKIP.has(p) && !p.split("/").some(part => part.startsWith(".")))
    .sort();
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

export async function buildManifest(dir: string, onProgress?: (done: number, total: number) => void): Promise<Manifest> {
  const cachePath = join(dir, ".publish-cache.json");
  const cacheFile = Bun.file(cachePath);
  const cache: Cache = (await cacheFile.exists()) ? await cacheFile.json() : {};
  const paths = await listFiles(dir);
  const files: Record<string, Entry> = {};
  const fresh: Cache = {};
  let done = 0, next = 0;
  // A few files at a time keeps the disk busy without opening thousands at once.
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < paths.length) {
      const path = paths[next++];
      const info = await stat(join(dir, path));
      const hit = cache[path];
      const entry = hit && hit.size === info.size && hit.mtime === info.mtimeMs
        ? { size: hit.size, sha256: hit.sha256 }
        : { size: info.size, sha256: await sha256(join(dir, path)) };
      files[path] = entry;
      fresh[path] = { ...entry, mtime: info.mtimeMs };
      onProgress?.(++done, paths.length);
    }
  }));
  await Bun.write(cachePath, JSON.stringify(fresh));
  const sorted = Object.fromEntries(Object.keys(files).sort().map(k => [k, files[k]]));
  return { format: 1, files: sorted };
}

/** What a publish must upload and may delete to turn `remote` into `local`. */
export function diff(local: Manifest, remote: Manifest | null): { upload: string[]; remove: string[] } {
  const theirs = remote?.files ?? {};
  const upload = Object.keys(local.files).filter(p => theirs[p]?.sha256 !== local.files[p].sha256);
  const remove = Object.keys(theirs).filter(p => !(p in local.files));
  return { upload, remove };
}
