import { appConfigDb } from '@/modules/database/index.js';

import type { HostProfile } from './host-discovery.js';

/**
 * The last detection, kept so the answer outlives the click that produced it.
 *
 * Detection is an explicit action in the UI, but an agent arrives later and
 * never presses it: without this, "what kind of machine is this" was derivable
 * only by re-reading the daemon, and nothing recorded what had already been
 * found. The whole profile is stored rather than just the OS, because the
 * manager names and the guidance are the part an agent needs before it touches
 * anything.
 */
const PROFILE_KEY = 'host.profile.v1';

export type SavedHostProfile = { detectedAt: number; profile: HostProfile };

export function readSavedHostProfile(): SavedHostProfile | null {
  const raw = appConfigDb.get(PROFILE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedHostProfile>;
    if (!parsed.profile || typeof parsed.profile !== 'object') return null;
    return {
      detectedAt: typeof parsed.detectedAt === 'number' ? parsed.detectedAt : 0,
      profile: parsed.profile,
    };
  } catch {
    return null;
  }
}

/** A detection that cannot be stored is still a detection: the response carries it. */
export function saveHostProfile(profile: HostProfile): SavedHostProfile {
  const saved: SavedHostProfile = { detectedAt: Date.now(), profile };
  try {
    appConfigDb.set(PROFILE_KEY, JSON.stringify(saved));
  } catch {
    return saved;
  }
  return saved;
}
