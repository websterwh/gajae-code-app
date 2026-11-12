#!/usr/bin/env node
// Keep npm's high/critical gate. Nothing is skipped: an advisory either has no
// installed copy or it blocks the build. The reviewed extract-zip exceptions
// were retired together with the backport when @puppeteer/browsers 3 replaced
// extract-zip with modern-tar.
import { execFile as execFileCallback } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const ADVISORY_PATTERN = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/iu;

async function auditReport() {
  try {
    const { stdout } = await execFile('npm', ['audit', '--json'], { cwd: REPOSITORY_ROOT, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    // npm reports advisories with a nonzero exit. Network/error-only JSON is
    // rejected by evaluateAuditReport, not misinterpreted as a clean report.
    if (typeof error.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    throw new Error('npm audit did not produce a report: ' + error.message);
  }
}

export function evaluateAuditReport(report) {
  const errors = [];
  if (!report || report.error || report.auditReportVersion !== 2 || !report.vulnerabilities
    || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)
    || !report.metadata?.vulnerabilities) {
    return { errors: ['npm audit returned an invalid or incomplete report.'] };
  }

  for (const vulnerability of Object.values(report.vulnerabilities)) {
    if (!BLOCKING_SEVERITIES.has(vulnerability.severity)) continue;
    if (!Array.isArray(vulnerability.via) || !vulnerability.via.length) {
      errors.push('Blocking advisory has no evidence: ' + vulnerability.name);
      continue;
    }
    for (const via of vulnerability.via) {
      // String edges refer to the advisory-bearing dependency, never an
      // advisory of their own. A dangling edge is not a clean audit.
      if (typeof via === 'string') {
        if (!report.vulnerabilities[via]) errors.push('Missing audit dependency evidence: ' + via);
        continue;
      }
      if (!via || typeof via !== 'object') {
        errors.push('Malformed audit advisory: ' + vulnerability.name);
        continue;
      }
      if (!BLOCKING_SEVERITIES.has(via.severity ?? vulnerability.severity)) continue;
      const advisory = ADVISORY_PATTERN.exec(via.url ?? via.title ?? '')?.[0]?.toUpperCase();
      if (!advisory) { errors.push('Unidentified blocking advisory: ' + vulnerability.name); continue; }
      const severity = via.severity ?? vulnerability.severity;
      errors.push(severity + ' advisory ' + advisory + ' in ' + (via.name ?? vulnerability.name) + ': ' + (via.title ?? ''));
    }
  }

  return { errors };
}

async function main() {
  const report = await auditReport();
  const { errors } = evaluateAuditReport(report);
  if (errors.length) {
    console.error('Dependency audit failed:\n' + errors.map(error => '  - ' + error).join('\n'));
    console.error('\nRun npm audit for the full report. Do not bypass the integrity gate.');
    process.exitCode = 1;
    return;
  }
  const belowGate = Object.entries(report.metadata.vulnerabilities)
    .filter(([severity, count]) => !BLOCKING_SEVERITIES.has(severity) && severity !== 'total' && count > 0)
    .map(([severity, count]) => count + ' ' + severity).join(', ');
  console.log('Dependency audit passed (no high or critical advisories' + (belowGate ? '; below the gate: ' + belowGate : '') + ').');
}

const entry = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (entry !== null && entry === await realpath(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error('Dependency audit failed: ' + error.message); process.exitCode = 1; });
}
