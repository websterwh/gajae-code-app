import { appConfigDb } from '@/modules/database/index.js';

/**
 * The user's master switch for computer use.
 *
 * Pairing a companion is not permission to hand the model a `computer` tool:
 * beta.19 withheld computer use until the user turned it on, and the switch
 * stays off by default. This store is that switch, and it is read on every run
 * and every call so turning it off takes effect immediately instead of at the
 * next restart. Pairing, Trust and the device picker all remain separate gates
 * below it.
 */
const CONFIG_KEY = 'automation.computerUse.v1';

type Storage = Pick<typeof appConfigDb, 'get' | 'set'>;

export class ComputerUseStore {
  constructor(private readonly storage: Storage = appConfigDb) {}

  enabled(): boolean {
    try {
      const raw = this.storage.get(CONFIG_KEY);
      if (!raw) return false;
      return (JSON.parse(raw) as { enabled?: unknown }).enabled === true;
    } catch {
      return false;
    }
  }

  set(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new Error('Computer use must be true or false.');
    this.storage.set(CONFIG_KEY, JSON.stringify({ enabled: value }));
    return value;
  }
}

export const computerUseStore = new ComputerUseStore();
