#!/usr/bin/env node
/**
 * Repository layout guard.
 *
 * Container packaging drifted once already: a stale `docker/` copy and
 * `deploy/docker/` diverged, so a fix landed in one and silently missed the
 * other. This check makes the layout a tested invariant instead of a
 * convention: exactly one place defines the container, and the checkout is the
 * app itself (no `app/` wrapper).
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOYMENT = 'deploy/docker';
// The GJC sandbox template image is not this app's deployment container; it is
// shipped as a template inside the server bundle (see SERVER_BUNDLE_INPUTS).
const SANDBOX_DOCKERFILE = 'docker/gjc/Dockerfile';
const REQUIRED = [
  'package.json',
  'server/index.js',
  `${DEPLOYMENT}/Dockerfile`,
  `${DEPLOYMENT}/docker-entrypoint.sh`,
  `${DEPLOYMENT}/docker-compose.yml`,
];
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-server',
  'dist-native',
  'release',
  '.tmp',
  '.gjc-worktrees',
]);
const DUPLICATE_MARKERS = [
  'docker/Dockerfile',
  'docker/docker-entrypoint.sh',
  'docker/docker-compose.yml',
];

function walk(relativeDirectory, found = []) {
  const absoluteDirectory = path.join(ROOT, relativeDirectory);
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(relativePath, found);
    else if (entry.isFile()) found.push(relativePath);
  }
  return found;
}

const errors = [];
const files = walk('');
const byBasename = (name) => files.filter((file) => path.basename(file) === name);

for (const marker of REQUIRED) {
  if (!existsSync(path.join(ROOT, marker))) errors.push(`missing required path: ${marker}`);
}

for (const marker of DUPLICATE_MARKERS) {
  if (existsSync(path.join(ROOT, marker))) {
    errors.push(`stale container packaging at ${marker}; ${DEPLOYMENT} is the single source of truth`);
  }
}

const composeFiles = byBasename('docker-compose.yml').filter((file) => file !== 'docker-compose.yml');
if (composeFiles.length !== 1 || composeFiles[0] !== `${DEPLOYMENT}/docker-compose.yml`) {
  errors.push(
    `expected exactly one compose file at ${DEPLOYMENT}/docker-compose.yml, found: ${
      composeFiles.length ? composeFiles.join(', ') : 'none'
    }`,
  );
}

const entrypoints = byBasename('docker-entrypoint.sh').filter((file) => file !== 'docker-entrypoint.sh');
if (entrypoints.length !== 1 || entrypoints[0] !== `${DEPLOYMENT}/docker-entrypoint.sh`) {
  errors.push(
    `expected exactly one entrypoint at ${DEPLOYMENT}/docker-entrypoint.sh, found: ${
      entrypoints.length ? entrypoints.join(', ') : 'none'
    }`,
  );
}

const dockerfiles = byBasename('Dockerfile');
for (const file of dockerfiles) {
  if (file === `${DEPLOYMENT}/Dockerfile` || file === SANDBOX_DOCKERFILE) continue;
  errors.push(`unexpected Dockerfile at ${file}; deployment packaging lives in ${DEPLOYMENT}`);
}

if (errors.length) {
  console.error('[layout] Repository layout drift detected:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `[layout] ok: ${DEPLOYMENT} is the only container packaging (${dockerfiles.length} Dockerfile${dockerfiles.length === 1 ? '' : 's'}, sandbox template allowed).`,
);
