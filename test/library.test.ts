import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, checkStructure, mediaFiles, streamable, type Library } from "../src/library";
import { buildManifest, diff } from "../src/manifest";
import { contentType, liveManifest, publish, type Store } from "../src/publish";

const MAP = "7eaecc1b-4337-bbf6-6ab9-04b8f06b3319";
const SOVA = "320b2a48-4d9b-a075-30f1-1f93a9b638fa";
const lib = (): Library => ({
  format: 1,
  maps: [{ id: MAP, name: "Ascent" }],
  agents: [{ id: SOVA, name: "Sova", role: "initiator", color: "#3D8BFF", abilities: [{ id: 10, name: "Shock Bolt", slot: 1 }] }],
  lineups: [{
    id: 1, map: MAP, agent: SOVA, ability: 10, side: "attack", title: "A",
    stand: { x: 1, y: 1, callout: null }, land: { x: 2, y: 2, callout: null }, bolts: [{ charge: 3, bounces: 1 }],
  }],
});

/** A box: 32-bit size, 4-letter type, then padding to that size. */
const box = (type: string, size: number) => {
  const b = new Uint8Array(size);
  new DataView(b.buffer).setUint32(0, size);
  b.set(new TextEncoder().encode(type), 4);
  return b;
};
const mp4 = (...boxes: Uint8Array[]) => new Blob(boxes);

async function folder(l: Library, files: Record<string, Blob | string>) {
  const dir = await mkdtemp(join(tmpdir(), "arcwise-library-test-"));
  await Bun.write(join(dir, "library.json"), JSON.stringify(l));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await Bun.write(join(dir, path), body);
  }
  return dir;
}

describe("checkStructure", () => {
  test("accepts a well-formed library", () => {
    expect(checkStructure(lib())).toEqual([]);
  });

  test("refuses what Arcwise refuses", () => {
    const l = lib();
    l.lineups.push({ ...l.lineups[0] });
    l.lineups.push({ ...l.lineups[0], id: 2, map: "nowhere" });
    l.lineups.push({ ...l.lineups[0], id: 3, ability: 99 });
    l.lineups.push({ ...l.lineups[0], id: 4, bolts: [{ charge: 4, bounces: 3 }] });
    l.agents[0].color = "blue";
    expect(checkStructure(l)).toEqual([
      "lineup 1 is listed more than once",
      "agent Sova has color blue, not #rrggbb",
      "lineup 2 refers to map nowhere, which the library does not list",
      "lineup 3 refers to ability 99, which is not its agent's",
      "lineup 4 has a bolt with charge 4",
      "lineup 4 has a bolt with 3 bounces",
    ]);
  });
});

test("mediaFiles lists what library.json implies, with the aim picture optional", () => {
  const files = mediaFiles(lib());
  expect(files.map(f => f.path)).toEqual([
    `maps/${MAP}.webp`, `maps/${MAP}-attack.svg`, `maps/${MAP}-defense.svg`,
    `agents/${SOVA}.webp`, "abilities/10.webp",
    "lineups/1.mp4", "lineups/1-start.webp", "lineups/1-end.webp", "lineups/1-aim.webp",
  ]);
  expect(files.filter(f => f.optional).map(f => f.path)).toEqual(["lineups/1-aim.webp"]);
});

test("streamable finds whether the index comes before the data", async () => {
  const dir = await folder(lib(), {
    "fast.mp4": mp4(box("ftyp", 24), box("moov", 40), box("mdat", 64)),
    "slow.mp4": mp4(box("ftyp", 24), box("mdat", 64), box("moov", 40)),
  });
  expect(await streamable(join(dir, "fast.mp4"))).toBe(true);
  expect(await streamable(join(dir, "slow.mp4"))).toBe(false);
  await rm(dir, { recursive: true });
});

test("check warns about missing pictures and clips that cannot stream", async () => {
  const dir = await folder(lib(), { "lineups/1.mp4": mp4(box("ftyp", 24), box("mdat", 64), box("moov", 40)) });
  const { report } = await check(dir);
  expect(report.errors).toEqual([]);
  expect(report.warnings).toContain("lineups/1-start.webp is missing; Arcwise shows a placeholder");
  expect(report.warnings.some(w => w.startsWith("lineups/1.mp4 has its index after its data"))).toBe(true);
  expect(report.warnings.some(w => w.includes("1-aim.webp"))).toBe(false);
  await rm(dir, { recursive: true });
});

describe("manifest", () => {
  test("lists every file but the indexes and dotfiles, with size and sha256", async () => {
    const dir = await folder(lib(), { "a/b.webp": "hello", "manifest.json": "{}", ".secret": "x" });
    const m = await buildManifest(dir);
    expect(m).toEqual({
      format: 1,
      files: { "a/b.webp": { size: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" } },
    });
    await rm(dir, { recursive: true });
  });

  test("reuses a cached hash only while size and modified time match", async () => {
    const dir = await folder(lib(), { "x.webp": "one" });
    await buildManifest(dir);
    const cache = JSON.parse(await Bun.file(join(dir, ".publish-cache.json")).text());
    cache["x.webp"].sha256 = "stale";
    await Bun.write(join(dir, ".publish-cache.json"), JSON.stringify(cache));
    expect((await buildManifest(dir)).files["x.webp"].sha256).toBe("stale");
    const later = new Date(Date.now() + 5000);
    await utimes(join(dir, "x.webp"), later, later);
    expect((await buildManifest(dir)).files["x.webp"].sha256).not.toBe("stale");
    await rm(dir, { recursive: true });
  });

  test("diff uploads new and changed files and lists removed ones", () => {
    const e = (sha256: string) => ({ size: 1, sha256 });
    const local = { format: 1 as const, files: { a: e("1"), b: e("2"), c: e("3") } };
    const remote = { format: 1 as const, files: { a: e("1"), b: e("old"), gone: e("9") } };
    expect(diff(local, remote)).toEqual({ upload: ["b", "c"], remove: ["gone"] });
    expect(diff(local, null)).toEqual({ upload: ["a", "b", "c"], remove: [] });
  });
});

describe("publish", () => {
  class Fake implements Store {
    readonly name = "bucket";
    calls: string[] = [];
    failures = new Map<string, number>();
    objects = new Map<string, string>();
    async get(key: string) { return this.objects.get(key) ?? null; }
    async put(key: string, _file: string, type: string) {
      const left = this.failures.get(key) ?? 0;
      if (left > 0) { this.failures.set(key, left - 1); throw new Error("flaky"); }
      this.calls.push(`put ${key} ${type}`);
    }
    async remove(key: string) { this.calls.push(`remove ${key}`); }
  }
  const opts = (store: Store, extra = {}) => ({ store, concurrency: 2, prune: false, dryRun: false, log: () => {}, retryMs: 1, ...extra });

  test("uploads changed media, then library.json, then the manifest last", async () => {
    const dir = await folder(lib(), { "lineups/1.mp4": "clip", "lineups/1-start.webp": "pic" });
    const local = await buildManifest(dir);
    const store = new Fake();
    store.failures.set("lineups/1.mp4", 1);
    await publish(dir, local, { format: 1, files: { "lineups/1-start.webp": local.files["lineups/1-start.webp"], "old.webp": { size: 1, sha256: "x" } } }, opts(store));
    expect(store.calls).toEqual([
      "put lineups/1.mp4 video/mp4",
      "put library.json application/json",
      "put manifest.json application/json",
    ]);
    expect(await Bun.file(join(dir, "manifest.json")).json()).toEqual(local);
    await rm(dir, { recursive: true });
  }, 15000);

  test("a publish that stopped resumes after the files it uploaded", async () => {
    const dir = await folder(lib(), { "lineups/1.mp4": "one", "lineups/2.mp4": "two" });
    const local = await buildManifest(dir);
    const stopped = new Fake();
    stopped.failures.set("lineups/2.mp4", Infinity);
    await expect(publish(dir, local, null, opts(stopped, { concurrency: 1 }))).rejects.toThrow("lineups/2.mp4");
    expect(stopped.calls).toEqual(["put lineups/1.mp4 video/mp4"]);
    const resumed = new Fake();
    await publish(dir, local, null, opts(resumed));
    expect(resumed.calls).toEqual(["put lineups/2.mp4 video/mp4", "put library.json application/json", "put manifest.json application/json"]);
    expect(await Bun.file(join(dir, ".publish-journal-bucket")).exists()).toBe(false);
    const again = new Fake();
    await publish(dir, local, null, opts(again));
    expect(again.calls[0]).toBe("put lineups/1.mp4 video/mp4");
    await rm(dir, { recursive: true });
  });

  test("prunes only when asked, and a dry run touches nothing", async () => {
    const dir = await folder(lib(), { "a.webp": "a" });
    const local = await buildManifest(dir);
    const remote = { format: 1 as const, files: { "gone.webp": { size: 1, sha256: "x" } } };
    const dry = new Fake();
    expect(await publish(dir, local, remote, opts(dry, { dryRun: true, prune: true }))).toEqual({ upload: ["a.webp"], remove: ["gone.webp"] });
    expect(dry.calls).toEqual([]);
    const pruning = new Fake();
    await publish(dir, local, remote, opts(pruning, { prune: true }));
    expect(pruning.calls.at(-1)).toBe("remove gone.webp");
    await rm(dir, { recursive: true });
  });

  test("names types by extension", () => {
    expect([contentType("x.svg"), contentType("x.WEBP"), contentType("x.bin")]).toEqual(["image/svg+xml", "image/webp", "application/octet-stream"]);
  });

  test("reads the live manifest from the store, or none before the first publish", async () => {
    const store = new Fake();
    expect(await liveManifest(store)).toBeNull();
    store.objects.set("manifest.json", JSON.stringify({ format: 1, files: { a: { size: 1, sha256: "x" } } }));
    expect(await liveManifest(store)).toEqual({ format: 1, files: { a: { size: 1, sha256: "x" } } });
  });
});
