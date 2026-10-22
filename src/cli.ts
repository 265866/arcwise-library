// arcwise-library: check a library folder, write its manifest, or publish it to Cloudflare R2.
//   bun src/cli.ts check <dir>
//   bun src/cli.ts manifest <dir>
//   bun src/cli.ts publish <dir> --bucket <name> [--concurrency 4] [--prune] [--dry-run]
import { check } from "./library";
import { buildManifest } from "./manifest";
import { CfStore, liveManifest, publish } from "./publish";

const [command, dir, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string) => rest.includes(`--${name}`);
const log = (line: string) => console.log(line);

function usage(): never {
  console.error("usage: bun src/cli.ts check|manifest|publish <dir> [--bucket <name> --concurrency <n> --prune --dry-run]");
  process.exit(2);
}

if (!dir || !["check", "manifest", "publish"].includes(command)) usage();

const { lib, report } = await check(dir);
for (const w of report.warnings) console.warn(`warning: ${w}`);
for (const e of report.errors) console.error(`error: ${e}`);
log(`${lib.lineups.length} lineups, ${lib.maps.length} maps, ${lib.agents.length} agents; ${report.errors.length} errors, ${report.warnings.length} warnings`);
if (report.errors.length) process.exit(1);
if (command === "check") process.exit(0);

let last = 0;
const manifest = await buildManifest(dir, (done, total) => {
  if (done - last >= 1000 || done === total) { last = done; log(`hashed ${done}/${total}`); }
});
if (command === "manifest") {
  await Bun.write(`${dir}/manifest.json`, JSON.stringify(manifest));
  log(`wrote manifest.json: ${Object.keys(manifest.files).length} files`);
  process.exit(0);
}

const bucket = flag("bucket");
if (!bucket) usage();
const concurrency = Number(flag("concurrency") ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1) usage();
const store = new CfStore(bucket);
const remote = await liveManifest(store);
log(remote ? `live manifest lists ${Object.keys(remote.files).length} files` : "nothing published yet");
await publish(dir, manifest, remote, {
  store, concurrency, prune: has("prune"), dryRun: has("dry-run"), log,
});
log(has("dry-run") ? "dry run: nothing uploaded" : "published");
