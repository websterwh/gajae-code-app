/**
 * Case-insensitive subsequence match, the way a command palette searches:
 * "mp" finds "my-project" and "zox" finds "zoxide". A contiguous run and a
 * hit at the start of a word score higher, so the obvious candidate sorts
 * first instead of the shortest one. `null` means the query does not match.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const needle = query.trim().toLowerCase();
  const haystack = candidate.toLowerCase();
  if (!needle) return 0;

  let score = 0;
  let cursor = 0;
  let previousIndex = -1;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    // Adjacent characters, or a character that opens a word, are the matches a
    // person meant; scattered letters are the weakest kind of hit.
    if (found === previousIndex + 1) score += 3;
    else score += 1;
    if (found === 0 || /[\s._/-]/u.test(haystack.charAt(found - 1))) score += 2;
    previousIndex = found;
    cursor = found + 1;
  }

  // A shorter name that consumes the whole query is a better answer than a
  // long one that happens to contain the letters far apart.
  return score - Math.floor(haystack.length / 40);
}
