# arcwise-library

Lineup libraries for [Arcwise](https://github.com/265866/arcwise), the Valorant lineup browser: the
format, and a tool that checks a library folder and publishes it to the web.

Arcwise shows lineups from https://library.arcwise.lol by default, and from any other library you
add in its settings, from the web or a folder on disk.

## The format

[docs/format.md](docs/format.md) describes a library: `library.json`, `manifest.json`, and the clips
and pictures beside them. A library on the web is the same folder served as plain files.

## Publishing a library

You need [Bun](https://bun.sh), and for publishing, a Cloudflare account with an R2 bucket that has a
public custom domain, and the [Cloudflare CLI](https://github.com/cloudflare/cf) (`cf`) signed in to
that account.

```sh
bun install
bun src/cli.ts check <folder>       # what Arcwise would refuse, and missing pictures or clips that can't stream
bun src/cli.ts manifest <folder>    # writes manifest.json
cf auth login
bun src/cli.ts publish <folder> --bucket <bucket> --dry-run
bun src/cli.ts publish <folder> --bucket <bucket>
```

`publish` hashes every file (keeping the hashes in `<folder>/.publish-cache.json` for next time),
compares them with the `manifest.json` already in the bucket, and uploads only the files that
changed. It uploads `library.json` and `manifest.json` last, so Arcwise never reads a manifest that
names a file not uploaded yet. `--prune` also deletes files the library no longer has; without it they
stay. `--concurrency` sets how many files upload at once (4 by default; each upload is a call to
the Cloudflare API, which limits how many it answers). A publish that stops before it is done
resumes where it stopped: the files it uploaded are listed in `<folder>/.publish-journal-<bucket>`
until the manifest is uploaded.

R2 keeps no caching headers for objects uploaded this way, so set them on the custom domain's
zone: a cache rule that caches the domain's files (`library.json` and `manifest.json` for a minute,
everything else for a year), and a response header transform rule that sets `Cache-Control` as
[docs/format.md](docs/format.md#serving-a-library) says.

Any other static host works as well, as long as it serves the files at their paths and supports
range requests.

## Development

```sh
bun test
bunx tsc --noEmit
```
