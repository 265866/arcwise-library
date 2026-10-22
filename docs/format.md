# Library format

An Arcwise library is a folder of lineups: `library.json`, a `manifest.json`, and the clips and
pictures beside them. Arcwise reads one from a folder on disk or from any web address that serves
the folder's files as they are. This page describes version 1 of the layout.

```
library/
  library.json
  manifest.json
  maps/
    <map id>.webp              card image for the map chooser, about 5:2
    <map id>-attack.svg        overhead map, attack side
    <map id>-defense.svg       overhead map, defense side
  agents/
    <agent id>.webp            square portrait
  abilities/
    <ability id>.webp          square icon
  lineups/
    <lineup id>.mp4            the clip
    <lineup id>-start.webp     its first frame: the view from the stand spot
    <lineup id>-end.webp       its last frame: where the utility landed
    <lineup id>-aim.webp       optional: the crosshair at the moment of the throw
```

Clips play through Windows Media Foundation, so any codec it decodes works. AV1 needs the AV1
Video Extension from the Microsoft Store, which Windows 11 usually has. A clip served from a web
address starts playing while it downloads only when its index (the `moov` box) comes before its
data, as `ffmpeg -movflags +faststart` writes it. Overhead maps are square, and every position in
`library.json` is a percentage of the map's width (`x`) and height (`y`).

A missing image shows a placeholder, and a missing clip shows its first frame with a note.

## library.json

```json
{
  "format": 1,
  "name": "Arcwise lineups",
  "maps": [{ "id": "7eaecc1b-…", "name": "Ascent" }],
  "agents": [
    {
      "id": "320b2a48-…",
      "name": "Sova",
      "role": "initiator",
      "color": "#3D8BFF",
      "abilities": [{ "id": 10, "name": "Shock Bolt", "slot": 1 }]
    }
  ],
  "lineups": [
    {
      "id": 211,
      "map": "7eaecc1b-…",
      "agent": "320b2a48-…",
      "ability": 10,
      "side": "attack",
      "title": "Double shocks for A main",
      "tags": ["essential"],
      "stand": { "x": 20.5, "y": 80.25, "callout": "A Lobby" },
      "path": [[35.1, 60.0], [50.2, 50.4]],
      "land": { "x": 50.2, "y": 50.4, "callout": "A Main" },
      "steps": {
        "setup": [],
        "aim": null,
        "release": "Fire the first bolt at 1 charge with no bounce, then the second at full charge with 1 bounce",
        "note": null
      },
      "bolts": [
        { "charge": 1, "bounces": 0, "aim": "Top of the antenna" },
        { "charge": 3, "bounces": 1, "aim": "Left edge of the chimney" }
      ]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | Optional. What Arcwise calls the library in its settings; without it, the folder's name or the web address's host. |
| `id` | Map and agent ids are Riot's UUIDs, so lineups from several libraries share one map and one agent. Ability and lineup ids are numbers chosen by the library. |
| `role` | `duelist`, `initiator`, `controller` or `sentinel`; groups the agent chooser. |
| `color` | `#rrggbb`; tints the markers and highlights for that agent. |
| `slot` | The ability's place on the ability bar, 1 to 4; abilities are listed in this order. |
| `side` | `attack` or `defense`. |
| `tags` | Any of `essential` and `pro`; other values are ignored. |
| `path` | The throw's arc from the stand spot, drawn on the map. May be empty. |
| `callout` | The place name, or `null` when it has none. |
| `steps` | How to throw, or `null`. `note` is shown over the clip when the throw needs more than a plain click, such as a jump. |
| `bolts` | Optional, for Sova's bolts: one, or two for Double Shock Bolt, in the order fired. `charge` is the section of the bow's charge bar the fill reached when the bolt left: `0` for the first (no charge), `1`, `2`, or `3` for a full bar. `bounces` is `0` to `2`. `aim`, optional, says what the crosshair lines up with for that bolt, when the two bolts of a Double Shock Bolt aim apart. The panel draws each bolt as the bow's HUD. |

Fields Arcwise does not know are ignored, so a library can add its own.

Arcwise refuses a library whose lineups refer to a map, agent or ability it does not list, or that
lists a lineup id twice. When two libraries it shows list the same lineup id, it shows the lineup
from the library higher in its list.

## manifest.json

Every file in the library except `library.json` and `manifest.json` itself, with its size in bytes
and its SHA-256:

```json
{
  "format": 1,
  "files": {
    "lineups/211.mp4": { "size": 6429135, "sha256": "9f2c…" },
    "maps/7eaecc1b-…-attack.svg": { "size": 48211, "sha256": "41aa…" }
  }
}
```

Arcwise uses it to:

- download a library, or some of its maps, for offline use, showing progress and checking each file;
- fetch only what changed when the library is updated, and drop its copies of files that changed;
- ask for each file at `<path>?v=<first 16 hex digits of its sha256>`, so a cache can keep a file
  for as long as it likes: a changed file gets a new address.

A folder on disk needs no manifest. Without one, a library served from the web still works, but
Arcwise cannot download it for offline use, and its cached copies are kept until they are removed
by hand.

## Serving a library

Any web server or object store that serves the folder's files at their paths works, as long as it
supports HTTP range requests for the clips; Arcwise reads `<base>/library.json`, then each file at
`<base>/<path>`. The `publish` command in this repository uploads a folder to a Cloudflare R2
bucket and sets:

| Files | `Cache-Control` |
| --- | --- |
| `library.json`, `manifest.json` | `public, max-age=60` |
| everything else | `public, max-age=31536000, immutable` (Arcwise asks for them with `?v=`) |
