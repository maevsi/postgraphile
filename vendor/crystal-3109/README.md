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
branch and vendored as tarballs**, then pinned as **explicit top-level
`dependencies`** in [`package.json`](../../package.json) so postgraphile's own
internal copies never load alongside them (see "Why explicit dependencies,
not `overrides`" below - this is not the obvious choice and getting it wrong
fails silently).

- `graphile-postgis-0.2.0.tgz` — `@graphile/postgis`, built from
  [`dargmuesli/graphile-postgis#prototype/crystal-3109-codec-level-typmod`](https://github.com/dargmuesli/graphile-postgis/tree/prototype/crystal-3109-codec-level-typmod)
  against the packages below.
- Everything else — the crystal packages that fix depends on:
  `@dataplan/pg`, `@dataplan/json`, `@graphile/lru`, `grafast`,
  `graphile-build`, `graphile-build-pg`, `graphile-config`, `pg-introspection`,
  `pg-sql2`, `tamedevil`.

## Incident: this silently regressed all type narrowing once already

The first version of this setup used pnpm's `overrides` (tried in both
`pnpm-workspace.yaml` and `package.json`'s `pnpm` field) instead of explicit
`dependencies`. It looked correct - `pnpm install`, `pnpm why grafast`, the
Docker `lint` and `production` builds all passed - but the **actually
installed** `graphile-build-pg` and `@dataplan/pg` in the built image were
still the plain **registry** versions (5.1.1 / 1.1.1, one patch ahead of our
vendored 5.1.0 / 1.1.0), not the vendored crystal build. `@graphile/postgis`
itself installed correctly (it's a plain top-level dependency), but the
`pgCodecs_findModifiedPgCodec` hook it registers was never called, because
the registry `graphile-build-pg` doesn't know that hook exists. The result:
every typmod-constrained geometry/geography column - `location:
GeographyPoint` - silently fell back to its base interface -
`location: GeographyInterface` - with no error, no warning, nothing. It only
surfaced as an unexplained schema diff after a real deploy.

Root cause, as best determined: `@graphile/postgis` declares several of
these packages as `peerDependencies`, and pnpm's `autoInstallPeers` behavior
for auto-installing peers doesn't reliably route through `overrides`. Why
`pnpm why <pkg>` still showed a single deduped version at the time: several
of these packages' *current registry version happens to share the exact
version string* our vendored build also uses (or `pnpm why` was checked
before a full lockfile regeneration surfaced the real resolution) - `pnpm
why` was not sufficient to catch this; only inspecting the actual **built**
image's `node_modules` (or, better, running it) caught it.

**Lesson**: after any change here, don't stop at "the build succeeded" -
actually run the built image against a real schema and query a known
typmod-constrained column. See step 5 in the re-sync steps below.

## Why explicit dependencies, not `overrides`

Given the above, this repo pins all 10 packages directly in `package.json`'s
`dependencies`, each pointing at its `vendor/crystal-3109/*.tgz`. This is a
top-level, unambiguous requirement that pnpm can't route around the way it
apparently can with `overrides` + peer auto-install. Confirmed empirically:
with explicit dependencies alone (no `overrides` at all), `pnpm-lock.yaml`
contains exactly one resolved version of each package, matching the vendored
tarball - checked directly in the lockfile, not just via `pnpm why`.

## Why this is risky regardless

This is an ad hoc snapshot of someone else's **actively-changing, unreviewed**
branch, running in what is otherwise a normal dependency tree. Concretely:

- No semver, no changelog, no security patches - a silent behavior change
  upstream only shows up if you happen to notice.
- The hook signature has already changed shape once mid-PR before this was
  vendored (`pgCodecs_findModifiedPgCodec`'s event fields, per the PR's commit
  history) - it can change again before merge, possibly breaking
  `@graphile/postgis`'s prototype branch silently or loudly.
- As demonstrated above, a *correct-looking* dependency setup can still
  silently fail to actually use the vendored build. Trust a live schema
  check, not a green build.

**Once graphile/crystal#3109 actually merges and ships in a release:** drop
this whole `vendor/crystal-3109/` directory and the explicit dependency
pins added for it in `package.json`, and go back to a normal
`@graphile/postgis` version (or its git branch, whichever has landed the
equivalent fix by then).

## Re-syncing to a newer crystal#3109 commit

```sh
node scripts/vendor-crystal-3109/sync.mjs
```

This clones (or updates, if `WORKDIR` is reused) `benjaie/crystal#variants`
and this project's `dargmuesli/graphile-postgis#prototype/crystal-3109-codec-level-typmod`,
builds everything, rewrites the monorepo-internal `workspace:` dependency
specifiers to real versions (`npm pack` doesn't do this - only a real
`yarn`/`pnpm publish` does, and we deliberately don't publish), and updates
`vendor/crystal-3109/` and `package.json`'s `dependencies` in place.

It does **not** run any tests for you, and does **not** verify the result
actually works. After it finishes, in order:

```sh
# 1. Full reinstall, not incremental - see the incident above.
rm -rf node_modules pnpm-lock.yaml && pnpm install

# 2. Sanity check the lockfile itself before trusting anything else.
#    More than one distinct version here means the vendored build isn't
#    actually being used, silently.
grep -c "graphile-build-pg@[0-9]" pnpm-lock.yaml   # expect: 1
grep -c "'@dataplan/pg@[0-9]"      pnpm-lock.yaml   # expect: 1

# 3. Normal checks.
pnpm run lint                        # or: docker build --target lint .
docker build --target production .   # confirm the image still builds

# 4. The one check that actually matters: run the built image against a
#    real (or reproduced) database and query a known typmod-constrained
#    geometry/geography column, e.g. `address.location`. A successful
#    build proves nothing on its own - see the incident above.

# 5. Also run @graphile/postgis's own test suite against this exact
#    crystal build - the script prints the path to that checkout.
```

Then review `git diff` (especially `pnpm-lock.yaml` and which tarball
filenames changed in `vendor/crystal-3109/`) before committing. See the
script's header comment for env var overrides (which fork/branch to pull,
etc.) and troubleshooting notes (e.g. what to do if a new crystal commit
introduces a package this script doesn't know about yet).
