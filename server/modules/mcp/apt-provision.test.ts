import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { emptyLedger } from './ledger.js';
import { parsePackageSpec } from './pins.js';
import { installCommand, parseInstalledVersion, provisionPackages, verifyCommand } from './provision.js';

const dpkgInstalled = 'install ok installed\t0.9.4\n';

describe('apt packages', () => {
  test('installs without a shell and refuses recommends', () => {
    const install = installCommand('apt', parsePackageSpec('zoxide'), null);
    assert.equal(install.command, 'apt-get');
    assert.ok(install.args.includes('--no-install-recommends'));
    assert.equal(install.args.at(-1), 'zoxide');
    assert.ok(!install.args.includes('-c'));
  });

  test('a pin becomes apt’s name=version syntax', () => {
    const install = installCommand('apt', parsePackageSpec('zoxide'), '0.9.4');
    assert.equal(install.args.at(-1), 'zoxide=0.9.4');
  });

  test('verification asks dpkg, not PATH', () => {
    const verify = verifyCommand('apt', 'zoxide');
    assert.equal(verify.command, 'dpkg-query');
    assert.equal(verify.args.at(-1), 'zoxide');
    assert.equal(parseInstalledVersion('apt', 'zoxide', dpkgInstalled), '0.9.4');
    // `deinstall ok config-files` is not an installed package.
    assert.equal(parseInstalledVersion('apt', 'zoxide', 'deinstall ok config-files\t0.9.4\n'), null);
  });

  test('refreshes the index, then records what dpkg reports', async () => {
    const commands: string[] = [];
    const ledger = emptyLedger();
    await provisionPackages({
      manager: 'apt',
      packages: ['zoxide'],
      ledger,
      runner: async (command, args) => {
        commands.push(`${command} ${args.join(' ')}`);
        if (command === 'dpkg-query') {
          return commands.length === 1
            ? { code: 1, stdout: '', stderr: 'no packages found' }
            : { code: 0, stdout: dpkgInstalled, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      log: () => {},
    });

    assert.equal(commands[1], 'apt-get update -qq');
    assert.equal(ledger.packages.apt.zoxide?.status, 'installed');
    assert.equal(ledger.packages.apt.zoxide?.version, '0.9.4');
  });

  test('a failed install is recorded as failed, not installed', async () => {
    const ledger = emptyLedger();
    await provisionPackages({
      manager: 'apt',
      packages: ['nosuchpackage'],
      ledger,
      runner: async (command) => {
        if (command === 'dpkg-query') return { code: 1, stdout: '', stderr: '' };
        if (command === 'apt-get') return { code: 100, stdout: '', stderr: 'E: Unable to locate package' };
        return { code: 0, stdout: '', stderr: '' };
      },
      log: () => {},
    });

    assert.equal(ledger.packages.apt.nosuchpackage?.status, 'failed');
  });
});
