/**
 * Packages installed by the dependency tree that must not ship in a Gajae Code
 * App distribution.
 *
 * The app bundles `@gajae-code/coding-agent`, which this project does not
 * control. Its dependency tree is therefore a license surface we inherit
 * rather than choose. Earlier runtime versions pulled two packages whose terms
 * are incompatible with how this product is licensed; the 0.20.0 runtime no
 * longer depends on either, so the list below is currently empty.
 *
 * Removing them is a packaging decision, not a patch: nothing upstream is
 * modified, the deletion is re-applied on every build, and a runtime bump
 * needs no manual review because `check:dependency-licenses` fails when a new
 * incompatible package appears.
 *
 * Each entry must name what the exclusion costs. An exclusion whose package is
 * no longer in the tree also fails the check, so this list cannot rot into a
 * set of rules guarding nothing.
 *
 * Deleting a package is only safe when nothing imports it at module scope. When
 * something does, `stub` names a first-party package under `./stubs/` that is
 * installed in the deleted package's place so the import resolves; the stub's
 * own code fails the feature, not the runtime. The stub's version is rewritten
 * to the version it replaces so a tree listing still reads correctly.
 */
import { fileURLToPath } from 'node:url';

const STUBS_DIR = new URL('./stubs/', import.meta.url);

export const EXCLUDED_FROM_DISTRIBUTION = [
  // Empty as of the 0.20.0 runtime bump: @gajae-code/coding-agent 0.20.0 no
  // longer depends on markit-ai (which pulled mupdf) or beautiful-mermaid
  // (which pulled elkjs), so both rules guarded nothing and were dropped. The
  // removal and stub machinery stays for the next incompatible package, and
  // `npm run check:licenses` still fails on any disallowed license that is not
  // listed here.
];

async function installDistributionStub(fs, path, entry, target, replacedVersion) {
  const stubDir = path.join(fileURLToPath(STUBS_DIR), entry.stub);
  await fs.cp(stubDir, target, { recursive: true });
  const manifestPath = path.join(target, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.name !== entry.package) {
    throw new Error(`Stub ${entry.stub} is named ${manifest.name}, but it replaces ${entry.package}.`);
  }
  if (manifest.license !== 'MIT') {
    throw new Error(`Stub ${entry.stub} must be MIT so it can ship where ${entry.package} cannot.`);
  }
  manifest.version = replacedVersion;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function installedVersion(fs, path, target) {
  try {
    return JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Removes the excluded packages from an installed `node_modules` tree and
 * installs the recorded stubs in their place.
 *
 * Returns the names removed and the names that now hold a stub; a stubbed
 * package is also listed as removed, since none of its code remains.
 */
export async function removeExcludedDistributionPackages(fs, path, nodeModulesDir, entries = EXCLUDED_FROM_DISTRIBUTION) {
  const removed = [];
  const stubbed = [];
  for (const entry of entries) {
    const target = path.join(nodeModulesDir, ...entry.package.split('/'));
    try {
      const replacedVersion = await installedVersion(fs, path, target);
      await fs.rm(target, { recursive: true, force: true });
      removed.push(entry.package);
      if (entry.stub) {
        await installDistributionStub(fs, path, entry, target, replacedVersion ?? '0.0.0-gajae-stub');
        stubbed.push(entry.package);
      }
    } catch (error) {
      throw new Error(`Failed to exclude ${entry.package} from the distribution: ${error.message}`);
    }
  }
  return { removed, stubbed };
}

/** One line for build logs: what left the tree and what stands in for it. */
export function describeDistributionExclusions({ removed, stubbed }) {
  const stubNote = stubbed.length > 0 ? `; stubbed ${stubbed.join(', ')}` : '';
  return `Excluded ${removed.join(', ')}${stubNote} (see scripts/release/distribution-exclusions.mjs).`;
}

/**
 * A file name outside ASCII breaks the code signature the moment the bundle
 * crosses a filesystem: HFS+ (what `hdiutil` builds by default) stores it in
 * NFD, APFS keeps whatever bytes it is given, and CodeResources sealed NFC.
 * `@gajae-code/coding-agent` publishes a Hangul bin alias
 * (`node_modules/.bin/가재씨`), which is how the notarized beta.7 image
 * verified on its own mount and reported "a sealed resource is missing or
 * invalid" once Finder had copied it to /Applications. Bin links are not
 * runtime inputs for the payload, so a non-ASCII one is removed; any other
 * non-ASCII path fails the build rather than ship a bundle that breaks on copy.
 * Returns the payload-relative paths removed.
 */
export async function removeNonAsciiPaths(fs, path, payloadDir) {
  const removed = [];
  const kept = [];
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (/[^\x00-\x7f]/.test(entry.name)) {
        if (path.basename(current) === '.bin' && !entry.isDirectory()) {
          await fs.rm(filePath, { force: true });
          removed.push(path.relative(payloadDir, filePath));
        } else {
          kept.push(path.relative(payloadDir, filePath));
        }
        continue;
      }
      if (entry.isDirectory()) await walk(filePath);
    }
  };
  await walk(payloadDir);
  if (kept.length) throw new Error(`Payload paths outside ASCII cannot ship (the code signature would not survive a copy): ${kept.join(', ')}`);
  return removed;
}
