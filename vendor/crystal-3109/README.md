# vendor/crystal-3109

`@graphile/postgis` uses PostGIS's `typmod` (e.g. `geometry(Point,4326)`) to
narrow columns to a specific GraphQL type (`GeometryPoint` instead of the
generic `GeometryInterface`). Doing that properly requires resolving the type
at the *codec* level in postgraphile core, via a `pgCodecs_findModifiedPgCodec`
gather hook and a `PgCodec#baseCodec` field. As of this writing that support
only exists on an **unmerged, unreleased** upstream PR:
[graphile/crystal#3109](https://github.com/graphile/crystal/pull/3109)
(tracked in practice on
[benjaie/crystal#variants](https://github.com/benjaie/crystal/tree/variants)).

Since it isn't published, the packages below are **built locally from that
branch and vendored as tarballs**, then forced onto every consumer (including
postgraphile's own internal dependencies) via the `overrides` in
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml).

- `graphile-postgis-0.2.0.tgz` — `@graphile/postgis`, built from
  [`dargmuesli/graphile-postgis#prototype/crystal-3109-codec-level-typmod`](https://github.com/dargmuesli/graphile-postgis/tree/prototype/crystal-3109-codec-level-typmod)
  against the packages below.
- Everything else — the crystal packages that fix depends on:
  `@dataplan/pg`, `@dataplan/json`, `@graphile/lru`, `grafast`,
  `graphile-build`, `graphile-build-pg`, `graphile-config`, `pg-introspection`,
  `pg-sql2`, `tamedevil`.

## Why this is risky

This is an ad hoc snapshot of someone else's **actively-changing, unreviewed**
branch, running in what is otherwise a normal dependency tree. Concretely:

- No semver, no changelog, no security patches - a silent behavior change
  upstream only shows up if you happen to notice.
- The hook signature has already changed shape once mid-PR before this was
  vendored (`pgCodecs_findModifiedPgCodec`'s event fields, per the PR's commit
  history) - it can change again before merge, possibly breaking
  `@graphile/postgis`'s prototype branch silently or loudly.
- `pnpm install`/Docker build will show peer-dependency warnings (e.g.
  `@dataplan/pg@1.1.0` vs postgraphile wanting `^1.1.1`) - that's crystal's
  fork not having bumped its own package versions yet, not a real
  incompatibility (verified via `@graphile/postgis`'s own test suite against
  this exact build), but double check this hasn't changed on re-sync.

**Once graphile/crystal#3109 actually merges and ships in a release:** drop
this whole `vendor/crystal-3109/` directory, the `overrides` block in
`pnpm-workspace.yaml`, and go back to a normal `@graphile/postgis` version (or
its git branch, whichever has landed the equivalent fix by then) in
`package.json`.

## Re-syncing to a newer crystal#3109 commit

```sh
node scripts/vendor-crystal-3109/sync.mjs
```

This clones (or updates, if `WORKDIR` is reused) `benjaie/crystal#variants`
and this project's `dargmuesli/graphile-postgis#prototype/crystal-3109-codec-level-typmod`,
builds everything, rewrites the monorepo-internal `workspace:` dependency
specifiers to real versions (`npm pack` doesn't do this - only a real
`yarn`/`pnpm publish` does, and we deliberately don't publish), and updates
`vendor/crystal-3109/`, `pnpm-workspace.yaml`, and `package.json` in place.

It does **not** run any tests for you. After it finishes:

```sh
pnpm install
pnpm run lint                        # or: docker build --target lint .
docker build --target production .   # confirm the image still builds

# Ideally also run @graphile/postgis's own test suite against this exact
# build before trusting it - the script prints the path to that checkout.
```

Then review `git diff` (especially `pnpm-lock.yaml` and which tarball
filenames changed in `vendor/crystal-3109/`) before committing. See the
script's header comment for env var overrides (which fork/branch to pull,
etc.) and troubleshooting notes (e.g. what to do if a new crystal commit
introduces a package this script doesn't know about yet).
