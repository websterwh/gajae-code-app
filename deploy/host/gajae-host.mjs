#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { renderAgentsMd } from './agents-md.mjs';
import { collectFacts, runCommand } from './facts.mjs';
import { describeVerbs, executeVerb } from './verbs.mjs';

const USAGE = `gajae-host — read-only host facts and the host verb allow-list

Usage:
  gajae-host inventory                 Print collected host facts as JSON
  gajae-host agents-md [--out PATH]    Write an AGENTS.md describing this host
  gajae-host verbs                     List the allow-listed verbs
  gajae-host run <verb> [--target NAME] [--allow-mutating]
                                       Run one allow-listed verb

Notes:
  - Every verb is a fixed command; a target is only a validated container or
    service name, never a command fragment.
  - Mutating verbs are declared but not enabled in this build.
  - This script is meant to run on the Docker host, not inside the app
    container (the container cannot see the host's processes or daemon).
`;

function parseArgs(argv) {
  const flags = { out: null, target: null, allowMutating: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-mutating') {
      flags.allowMutating = true;
    } else if (arg === '--out' || arg === '--target') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function printVerbs() {
  const rows = describeVerbs().map((verb) => [
    verb.id.padEnd(18),
    verb.mutating ? 'mutating' : 'read-only',
    verb.enabled ? 'enabled' : 'disabled',
    verb.target ?? '',
    verb.summary,
  ]);
  process.stdout.write(`${rows.map((row) => row.join('  ').trimEnd()).join('\n')}\n`);
}

async function main(argv) {
  const [action, ...rest] = argv;
  if (!action || action === 'help' || action === '--help' || action === '-h') {
    process.stdout.write(USAGE);
    return action ? 0 : 2;
  }
  const { flags, positional } = parseArgs(rest);

  if (action === 'inventory') {
    const facts = await collectFacts();
    process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
    return 0;
  }

  if (action === 'agents-md') {
    const facts = await collectFacts();
    const out = flags.out ?? path.join(process.cwd(), 'AGENTS.md');
    await writeFile(out, renderAgentsMd(facts, { root: process.cwd() }), 'utf8');
    process.stdout.write(`Wrote ${out}\n`);
    return 0;
  }

  if (action === 'verbs') {
    printVerbs();
    return 0;
  }

  if (action === 'run') {
    const verbId = positional[0];
    if (!verbId) throw new Error('run needs a verb id; see `gajae-host verbs`');
    const result = await executeVerb(verbId, {
      target: flags.target ?? undefined,
      allowMutating: flags.allowMutating,
      run: runCommand,
    });
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    return result.code === 0 ? 0 : 1;
  }

  throw new Error(`Unknown action ${action}; see gajae-host --help`);
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
