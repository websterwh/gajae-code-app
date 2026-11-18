/**
 * apt has no fast way to search descriptions: `apt-cache search gh` scans every
 * field of the index and was measured at 68-73s on a warm cache, while
 * `--names-only` answers the same index in 1.1s. Decompression is not the cost
 * - descriptions are. `apt-cache dumpavail` prints the whole index once in
 * 1.6s, so the description table is built from that and reused: parsing it
 * costs about a second and matching a query against all 63k packages is
 * single-digit milliseconds, versus tens of seconds for a fresh scan.
 */
export type AptEntry = { name: string; description: string };

const PACKAGE_PREFIX = 'Package: ';
const DESCRIPTION_PREFIXES = ['Description: ', 'Description-en: '] as const;

/**
 * Stanzas are separated by a blank line and `dumpavail` is not indented, so a
 * line starting with `Package:` opens one. Only the first description line is
 * kept: the continuation lines are the long description, and apt's search
 * output shows the synopsis.
 */
export function parseDumpavail(stdout: string): AptEntry[] {
  const entries: AptEntry[] = [];
  let name = '';
  let description = '';

  for (const line of stdout.split('\n')) {
    if (line === '') {
      if (name) entries.push({ name, description });
      name = '';
      description = '';
      continue;
    }
    if (!name && line.startsWith(PACKAGE_PREFIX)) {
      name = line.slice(PACKAGE_PREFIX.length).trim();
      continue;
    }
    if (!description) {
      const prefix = DESCRIPTION_PREFIXES.find((candidate) => line.startsWith(candidate));
      if (prefix) description = line.slice(prefix.length).trim();
    }
  }
  if (name) entries.push({ name, description });
  return entries;
}

export default parseDumpavail;
