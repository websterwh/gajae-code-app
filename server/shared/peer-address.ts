/**
 * Address classification for the two decisions that depend on it: which clients
 * the sign-in gate treats as local, and whether a forwarded header came from a
 * proxy on this network rather than from the client that wrote it.
 */

export const stripMappedV4 = (address: string): string => address.replace(/^::ffff:/iu, '');

export function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address === 'localhost' || address.startsWith('127.');
}

/** RFC1918 plus unique-local IPv6: "the machine next to this one". */
export function isPrivateAddress(address: string): boolean {
  const value = stripMappedV4(String(address ?? '').trim());
  if (!value) return false;
  return isLoopbackAddress(value)
    || value.startsWith('10.')
    || value.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./u.test(value)
    || /^f[cd][0-9a-f]{2}:/iu.test(value);
}
