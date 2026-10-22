// Checks a library folder the way Arcwise reads it (docs/format.md): the structure Arcwise refuses to
// load is an error, a missing picture or a clip that cannot stream is a warning.
import { exists } from "node:fs/promises";
import { join } from "node:path";

type Spot = { x: number; y: number; callout: string | null };
type Bolt = { charge: number; bounces: number; aim?: string };
export type Lineup = {
  id: number; map: string; agent: string; ability: number; side: string; title: string;
  stand: Spot; land: Spot; path?: [number, number][]; bolts?: Bolt[];
};
export type Library = {
  format: number;
  name?: string;
  maps: { id: string; name: string }[];
  agents: { id: string; name: string; role: string; color: string; abilities: { id: number; name: string; slot: number }[] }[];
  lineups: Lineup[];
};

export type Report = { errors: string[]; warnings: string[] };

const ROLES = new Set(["duelist", "initiator", "controller", "sentinel"]);
const SIDES = new Set(["attack", "defense"]);

/** The structure Arcwise refuses to load, given library.json alone. */
export function checkStructure(lib: Library): string[] {
  const errors: string[] = [];
  if (lib.format !== 1) errors.push(`format ${lib.format} is not 1`);
  const dupes = <T>(items: T[], key: (t: T) => string | number, kind: string) => {
    const seen = new Set<string | number>();
    for (const item of items) {
      const k = key(item);
      if (seen.has(k)) errors.push(`${kind} ${k} is listed more than once`);
      seen.add(k);
    }
    return seen;
  };
  const maps = dupes(lib.maps, m => m.id, "map");
  const agents = dupes(lib.agents, a => a.id, "agent");
  dupes(lib.agents.flatMap(a => a.abilities), ab => ab.id, "ability");
  dupes(lib.lineups, l => l.id, "lineup");
  const owner = new Map(lib.agents.flatMap(a => a.abilities.map(ab => [ab.id, a.id] as const)));
  for (const a of lib.agents) {
    if (!ROLES.has(a.role)) errors.push(`agent ${a.name} has role ${a.role}`);
    if (!/^#[0-9a-fA-F]{6}$/.test(a.color)) errors.push(`agent ${a.name} has color ${a.color}, not #rrggbb`);
  }
  for (const l of lib.lineups) {
    if (!maps.has(l.map)) errors.push(`lineup ${l.id} refers to map ${l.map}, which the library does not list`);
    if (!agents.has(l.agent)) errors.push(`lineup ${l.id} refers to agent ${l.agent}, which the library does not list`);
    else if (owner.get(l.ability) !== l.agent) errors.push(`lineup ${l.id} refers to ability ${l.ability}, which is not its agent's`);
    if (!SIDES.has(l.side)) errors.push(`lineup ${l.id} has side ${l.side}`);
    for (const b of l.bolts ?? []) {
      if (![0, 1, 2, 3].includes(b.charge)) errors.push(`lineup ${l.id} has a bolt with charge ${b.charge}`);
      if (![0, 1, 2].includes(b.bounces)) errors.push(`lineup ${l.id} has a bolt with ${b.bounces} bounces`);
    }
  }
  return errors;
}

/** Every media file library.json implies, and whether Arcwise needs it. */
export function mediaFiles(lib: Library): { path: string; optional: boolean }[] {
  const files: { path: string; optional: boolean }[] = [];
  for (const m of lib.maps) {
    files.push({ path: `maps/${m.id}.webp`, optional: false });
    for (const side of ["attack", "defense"]) files.push({ path: `maps/${m.id}-${side}.svg`, optional: false });
  }
  for (const a of lib.agents) {
    files.push({ path: `agents/${a.id}.webp`, optional: false });
    for (const ab of a.abilities) files.push({ path: `abilities/${ab.id}.webp`, optional: false });
  }
  for (const l of lib.lineups) {
    for (const suffix of [".mp4", "-start.webp", "-end.webp"]) files.push({ path: `lineups/${l.id}${suffix}`, optional: false });
    files.push({ path: `lineups/${l.id}-aim.webp`, optional: true });
  }
  return files;
}

/** Whether an MP4's index (moov) comes before its data (mdat), so it plays while it downloads. */
export async function streamable(path: string): Promise<boolean> {
  const file = Bun.file(path);
  const size = file.size;
  let at = 0;
  while (at + 8 <= size) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer());
    let length = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (type === "moov") return true;
    if (type === "mdat") return false;
    if (length === 1) length = Number(head.getBigUint64(8));
    else if (length === 0) return false;
    if (length < 8) return false;
    at += length;
  }
  return false;
}

export async function check(dir: string): Promise<{ lib: Library; report: Report }> {
  const lib: Library = await Bun.file(join(dir, "library.json")).json();
  const report: Report = { errors: checkStructure(lib), warnings: [] };
  for (const f of mediaFiles(lib)) {
    const path = join(dir, f.path);
    if (!(await exists(path))) {
      if (!f.optional) report.warnings.push(`${f.path} is missing; Arcwise shows a placeholder`);
    } else if (f.path.endsWith(".mp4") && !(await streamable(path))) {
      report.warnings.push(`${f.path} has its index after its data, so it cannot play until it has downloaded (ffmpeg -movflags +faststart fixes it)`);
    }
  }
  return { lib, report };
}
