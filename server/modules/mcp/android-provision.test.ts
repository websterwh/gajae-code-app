import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { emptyLedger } from './ledger.js';
import { parsePackageSpec } from './pins.js';
import {
  installCommand,
  parseInstalledVersion,
  provisionPackages,
  uninstallCommand,
  verifyCommand,
} from './provision.js';

const revision = '35.0.0\n';

describe('android sdk components', () => {
  test('installs through sdkmanager with the component as an argument', () => {
    const install = installCommand('android', parsePackageSpec('platforms;android-35'), null);
    assert.equal(install.command, 'sh');
    assert.equal(install.args.at(-1), 'platforms;android-35');
    const script = install.args[1] ?? '';
    assert.match(script, /sdkmanager/, 'the command-line tools are bootstrapped with sdkmanager');
    assert.match(script, /--licenses/, 'licenses are accepted without a prompt');
  });

  test('a component names its own revision, so a pin is not rewritten', () => {
    const install = installCommand('android', parsePackageSpec('build-tools;35.0.0'), '35.0.0');
    assert.equal(install.args.at(-1), 'build-tools;35.0.0');
  });

  test('verification reads Pkg.Revision from the component directory', () => {
    const verify = verifyCommand('android', 'platforms;android-35');
    assert.equal(verify.command, 'sh');
    assert.equal(verify.args.at(-1), 'platforms;android-35');
    assert.match(verify.args[1] ?? '', /source\.properties/u);
    assert.equal(parseInstalledVersion('android', 'platforms;android-35', revision), '35.0.0');
    assert.equal(parseInstalledVersion('android', 'platforms;android-35', ''), null);
  });

  test('uninstall goes through sdkmanager too', () => {
    const uninstall = uninstallCommand('android', 'platforms;android-35');
    assert.equal(uninstall.command, 'sh');
    assert.equal(uninstall.args.at(-1), 'platforms;android-35');
    assert.match(uninstall.args[1] ?? '', /--uninstall/u);
  });

  test('an installed component is recorded at its revision', async () => {
    const ledger = emptyLedger();
    let installed = false;
    const outcomes = await provisionPackages({
      manager: 'android',
      packages: ['platforms;android-35'],
      ledger,
      runner: async (command, args) => {
        if (command !== 'sh') return { code: 0, stdout: '', stderr: '' };
        if ((args[1] ?? '').includes('source.properties')) {
          return installed
            ? { code: 0, stdout: revision, stderr: '' }
            : { code: 1, stdout: '', stderr: '' };
        }
        installed = true;
        return { code: 0, stdout: '', stderr: '' };
      },
      log: () => {},
    });

    assert.equal(outcomes[0]?.status, 'installed');
    assert.equal(ledger.packages.android['platforms;android-35']?.version, '35.0.0');
  });

  test('a failed download is recorded as failed, not installed', async () => {
    const ledger = emptyLedger();
    const outcomes = await provisionPackages({
      manager: 'android',
      packages: ['platform-tools'],
      ledger,
      runner: async (command, args) => ({
        code: (args[1] ?? '').includes('source.properties') ? 1 : 2,
        stdout: '',
        stderr: 'curl: (6) Could not resolve host: dl.google.com',
      }),
      log: () => {},
    });

    assert.equal(outcomes[0]?.status, 'failed');
    assert.equal(ledger.packages.android['platform-tools']?.status, 'failed');
    assert.match(ledger.packages.android['platform-tools']?.error ?? '', /resolve host/u);
  });
});
