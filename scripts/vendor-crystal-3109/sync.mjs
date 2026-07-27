#!/usr/bin/env node
/**
 * Re-syncs vendor/crystal-3109/*.tgz against a fresh build of
 * graphile/crystal#3109 (https://github.com/graphile/crystal/pull/3109,
 * unmerged) and rebuilds @graphile/postgis against it.
 *
 * See vendor/crystal-3109/README.md for the why. This script automates the
 * mechanical parts; read its output, it will tell you what to do manually
 * (review the diff, run tests, commit).
 *
 * Usage: node scripts/vendor-crystal-3109/sync.mjs
 *
 * Env overrides:
 *   CRYSTAL_REMOTE   (default https://github.com/benjaie/crystal.git)
 *   CRYSTAL_BRANCH   (default variants)
 *   POSTGIS_REMOTE   (default https://github.com/dargmuesli/graphile-postgis.git)
 *   POSTGIS_BRANCH   (default prototype/crystal-3109-codec-level-typmod)
 *   WORKDIR          (default a temp dir; reused between runs if set, to skip re-cloning)
 */

import { execFileSync, execSync } from 'node:child_process'
import {
  mkdtempSync,
  existsSync,
  rmSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const VENDOR_DIR = path.join(REPO_ROOT, 'vendor/crystal-3109')

const CRYSTAL_REMOTE =
  process.env.CRYSTAL_REMOTE ?? 'https://github.com/benjaie/crystal.git'
const CRYSTAL_BRANCH = process.env.CRYSTAL_BRANCH ?? 'variants'
const POSTGIS_REMOTE =
  process.env.POSTGIS_REMOTE ??
  'https://github.com/dargmuesli/graphile-postgis.git'
const POSTGIS_BRANCH =
  process.env.POSTGIS_BRANCH ?? 'prototype/crystal-3109-codec-level-typmod'
const WORKDIR =
  process.env.WORKDIR ?? mkdtempSync(path.join(tmpdir(), 'crystal-3109-sync-'))
const CRYSTAL_DIR = path.join(WORKDIR, 'crystal')
const POSTGIS_DIR = path.join(WORKDIR, 'graphile-postgis')
const PACK_DIR = path.join(WORKDIR, 'packed')

// Packages that make up the crystal#3109 fix, relative to the crystal repo root.
// If a future crystal commit adds new packages to this dependency chain, `tsc
// -b` will fail below with a clear "Cannot find module" style error - add the
// missing package's path here and re-run.
const CRYSTAL_PACKAGES = [
  'utils/lru',
  'utils/graphile-config',
  'utils/pg-sql2',
  'utils/pg-introspection',
  'utils/tamedevil',
  'grafast/grafast',
  'grafast/dataplan-json',
  'grafast/dataplan-pg',
  'graphile-build/graphile-build',
  'graphile-build/graphile-build-pg',
]

function log(msg) {
  console.log(`\n\x1b[1m>> ${msg}\x1b[0m`)
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

function cloneOrUpdate(remote, branch, dir) {
  if (existsSync(dir)) {
    log(
      `Reusing existing checkout at ${dir} (set WORKDIR unset / delete it to force a fresh clone)`,
    )
    run('git', ['fetch', 'origin', branch], dir)
    run('git', ['checkout', branch], dir)
    run('git', ['reset', '--hard', `origin/${branch}`], dir)
  } else {
    run('git', ['clone', '--branch', branch, remote, dir])
  }
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: dir,
  })
    .toString()
    .trim()
  return sha
}

function packagePathToName(pkgDir) {
  const pkg = JSON.parse(
    readFileSync(path.join(pkgDir, 'package.json'), 'utf8'),
  )
  return { name: pkg.name, version: pkg.version }
}

function npmPack(pkgDir, destDir, extraArgs = []) {
  const output = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--pack-destination', destDir, ...extraArgs],
    { cwd: pkgDir },
  )
    .toString()
    .trim()
    .split('\n')
  return output[output.length - 1].trim() // npm pack prints the tarball filename last
}

// The packed package.json files still contain `"dep": "workspace:^..."` from
// the monorepo - npm pack doesn't rewrite those (only `yarn`/`pnpm publish`
// do, and we deliberately don't publish). Rewrite them to real ranges using
// versions we just built, or install breaks with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND.
function fixWorkspaceRefs(tgzPath, versionsByName) {
  const workdir = `${tgzPath}.extracted`
  rmSync(workdir, { recursive: true, force: true })
  mkdirSync(workdir, { recursive: true })
  run('tar', ['-xzf', tgzPath, '-C', workdir])

  const pkgJsonPath = path.join(workdir, 'package', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  let changed = false
  const unresolved = []

  for (const section of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = pkg[section]
    if (!deps) continue
    for (const [depName, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        if (versionsByName[depName]) {
          deps[depName] = `^${versionsByName[depName]}`
          changed = true
        } else {
          unresolved.push(`${section}.${depName} (${spec})`)
        }
      }
    }
  }

  if (unresolved.length) {
    console.warn(
      `  WARNING: ${path.basename(tgzPath)} has workspace: deps we don't vendor and can't rewrite: ${unresolved.join(', ')}\n` +
        `  If these are in "dependencies" (not devDependencies), pnpm install will fail downstream - add the` +
        ` missing package to CRYSTAL_PACKAGES in this script.`,
    )
  }

  if (changed) {
    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
    rmSync(tgzPath)
    run('tar', ['-czf', tgzPath, '-C', workdir, 'package'])
  }
  rmSync(workdir, { recursive: true, force: true })
}

// IMPORTANT: these must be real top-level `dependencies` entries, not just
// pnpm `overrides` (in pnpm-workspace.yaml or package.json's `pnpm` field).
// Overrides alone were tried first and silently did NOT take effect here -
// likely because @graphile/postgis declares several of these as
// `peerDependencies`, and pnpm's `autoInstallPeers` auto-installation of
// those peers doesn't reliably go through the overrides mechanism. The
// symptom if this regresses: postgraphile silently falls back to the base
// interface type (e.g. GeographyInterface) instead of a narrowed type (e.g.
// GeographyPoint) for every typmod-constrained column, with no error at all
// - always verify against a live schema after re-syncing, not just that the
// install/build succeeds. See the git history of this file/README for the
// incident.
function updatePackageJsonDeps(filenameByName, postgisFilename) {
  const pkgJsonPath = path.join(REPO_ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  for (const [pkgName, filename] of Object.entries(filenameByName)) {
    pkg.dependencies[pkgName] = `file:vendor/crystal-3109/${filename}`
  }
  pkg.dependencies['@graphile/postgis'] =
    `file:vendor/crystal-3109/${postgisFilename}`
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n')
}

async function main() {
  mkdirSync(PACK_DIR, { recursive: true })

  log(`Cloning/updating crystal fork (${CRYSTAL_REMOTE}#${CRYSTAL_BRANCH})`)
  const crystalSha = cloneOrUpdate(CRYSTAL_REMOTE, CRYSTAL_BRANCH, CRYSTAL_DIR)
  console.log(`crystal @ ${crystalSha}`)

  log('yarn install in crystal (uses its own pinned yarn via corepack)')
  run('corepack', ['enable'])
  run('yarn', ['install'], CRYSTAL_DIR)

  // graphile-build-pg's tsconfig references grafast/ruru (the bundled GraphiQL
  // UI), which `tsc -b` can't build on its own - ruru.js/ruru.css etc. are
  // webpack-bundled first into src/bundleCode.ts / bundleMeta.ts by this
  // workspace script (same as crystal's own root `build-init` script runs).
  // Without it, tsc -b fails with "Cannot find module './bundleCode.ts'".
  log("Building ruru (webpack bundle step tsc -b can't do itself)")
  run('yarn', ['workspace', 'ruru-components', 'build-package'], CRYSTAL_DIR)
  run('yarn', ['workspace', 'ruru', 'build-package'], CRYSTAL_DIR)

  log(`Building crystal packages via tsc -b: ${CRYSTAL_PACKAGES.join(', ')}`)
  run('npx', ['tsc', '-b', ...CRYSTAL_PACKAGES], CRYSTAL_DIR)

  log('Packing crystal packages')
  const versionsByName = {}
  for (const pkgPath of CRYSTAL_PACKAGES) {
    const { name, version } = packagePathToName(path.join(CRYSTAL_DIR, pkgPath))
    versionsByName[name] = version
  }
  const filenameByName = {}
  for (const pkgPath of CRYSTAL_PACKAGES) {
    const dir = path.join(CRYSTAL_DIR, pkgPath)
    const filename = npmPack(dir, PACK_DIR)
    const { name } = packagePathToName(dir)
    filenameByName[name] = filename
    console.log(`  ${name} -> ${filename}`)
  }

  log('Rewriting workspace: protocol refs inside packed package.json files')
  for (const filename of Object.values(filenameByName)) {
    fixWorkspaceRefs(path.join(PACK_DIR, filename), versionsByName)
  }

  log(
    `Cloning/updating graphile-postgis prototype (${POSTGIS_REMOTE}#${POSTGIS_BRANCH})`,
  )
  cloneOrUpdate(POSTGIS_REMOTE, POSTGIS_BRANCH, POSTGIS_DIR)

  log('yarn install in graphile-postgis (normal deps first)')
  run('yarn', ['install'], POSTGIS_DIR)

  log("Linking crystal packages into graphile-postgis's node_modules")
  const LINK_MAP = {
    '@dataplan/pg': 'grafast/dataplan-pg',
    'graphile-build-pg': 'graphile-build/graphile-build-pg',
    grafast: 'grafast/grafast',
    'graphile-build': 'graphile-build/graphile-build',
    'graphile-config': 'utils/graphile-config',
    'pg-introspection': 'utils/pg-introspection',
    'pg-sql2': 'utils/pg-sql2',
    tamedevil: 'utils/tamedevil',
    '@dataplan/json': 'grafast/dataplan-json',
    '@graphile/lru': 'utils/lru',
  }
  for (const [name, subpath] of Object.entries(LINK_MAP)) {
    const target = path.join(POSTGIS_DIR, 'node_modules', name)
    rmSync(target, { recursive: true, force: true })
    execSync(
      `mkdir -p "$(dirname "${target}")" && ln -s "${path.join(CRYSTAL_DIR, subpath)}" "${target}"`,
    )
  }

  log('Typechecking graphile-postgis against the linked crystal build')
  run('npx', ['tsc', '--noEmit', '-p', 'tsconfig.build.json'], POSTGIS_DIR)

  log('Building and packing graphile-postgis')
  run('npm', ['run', 'build'], POSTGIS_DIR)
  const postgisFilename = npmPack(POSTGIS_DIR, PACK_DIR)
  console.log(`  @graphile/postgis -> ${postgisFilename}`)

  log(`Replacing vendor/crystal-3109/ contents`)
  rmSync(VENDOR_DIR, { recursive: true, force: true })
  mkdirSync(VENDOR_DIR, { recursive: true })
  for (const filename of readdirSync(PACK_DIR)) {
    cpSync(path.join(PACK_DIR, filename), path.join(VENDOR_DIR, filename))
  }

  log('Updating package.json dependencies')
  updatePackageJsonDeps(filenameByName, postgisFilename)

  log('Done. Next steps (not automated - review before trusting them):')
  console.log(`
  1. rm -rf node_modules pnpm-lock.yaml && cd ${REPO_ROOT} && pnpm install
     (a full reinstall, not an incremental one - re-resolving from a stale
     lockfile/store has silently kept wrong package versions around before)
  2. grep -c "graphile-build-pg@[0-9]" pnpm-lock.yaml - if this finds more
     than one distinct version, or more than one distinct '@dataplan/pg@',
     STOP: something is pulling in the real registry package alongside the
     vendored one, and every typmod-constrained column will silently fall
     back to its base interface type at runtime with no error anywhere.
  3. pnpm run lint   (or: docker build --target lint .)
  4. docker build --target production .   (confirm it still builds)
  5. Actually RUN the built image against a real (or reproduced) database
     and check a known typmod-constrained geometry/geography column via a
     live GraphQL query - a successful build proves nothing here, this is
     the one check that would have caught the bug that motivated this
     comment. Also run graphile-postgis's own test suite against this same
     crystal build (see ${POSTGIS_DIR}, __tests__/).
  6. git status / git diff - check pnpm-lock.yaml and vendor/crystal-3109/*
     look sane, then commit.

  crystal commit vendored: ${crystalSha}
  Work dir (crystal + graphile-postgis clones + packed tarballs) left at:
  ${WORKDIR}
  (delete it, or set WORKDIR to reuse it next time and skip re-cloning)
`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
