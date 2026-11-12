import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateAuditReport } from './check-audit.mjs';

const advisory = (name, ghsa, severity = 'high') => ({
  name, severity, title: 'fixture', url: `https://github.com/advisories/${ghsa}`,
});

function report(vulnerabilities = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { high: Object.keys(vulnerabilities).length, total: Object.keys(vulnerabilities).length } },
  };
}

test('high and critical advisories always block', () => {
  const high = evaluateAuditReport(report({ left: { name: 'left', severity: 'high', nodes: ['node_modules/left'], via: [advisory('left', 'GHSA-aaaa-bbbb-cccc')] } }));
  assert.match(high.errors.join('\n'), /GHSA-AAAA-BBBB-CCCC/);
  const critical = evaluateAuditReport(report({ right: { name: 'right', severity: 'critical', nodes: ['node_modules/right'], via: [advisory('right', 'GHSA-dddd-eeee-ffff', 'critical')] } }));
  assert.match(critical.errors.join('\n'), /^critical advisory GHSA-DDDD-EEEE-FFFF/m);
});

test('moderate and low advisories stay below the gate', () => {
  const result = evaluateAuditReport(report({ mid: { name: 'mid', severity: 'moderate', nodes: ['node_modules/mid'], via: [advisory('mid', 'GHSA-1111-2222-3333', 'moderate')] } }));
  assert.deepEqual(result.errors, []);
});

test('network errors, incomplete reports and non-object vulnerability maps fail closed', () => {
  for (const invalid of [{}, { error: { code: 'ECONNRESET' } }, { ...report(), vulnerabilities: [] }, { auditReportVersion: 1, vulnerabilities: {}, metadata: { vulnerabilities: {} } }]) {
    assert.match(evaluateAuditReport(invalid).errors.join('\n'), /invalid or incomplete/);
  }
});

test('dangling dependency edges and missing advisory evidence fail closed', () => {
  const dangling = evaluateAuditReport(report({
    child: { name: 'child', severity: 'high', nodes: ['node_modules/child'], via: ['missing'] },
  }));
  assert.match(dangling.errors.join('\n'), /Missing audit dependency evidence: missing/);

  const evidence = evaluateAuditReport(report({
    empty: { name: 'empty', severity: 'high', nodes: ['node_modules/empty'], via: [] },
  }));
  assert.match(evidence.errors.join('\n'), /Blocking advisory has no evidence: empty/);

  const malformed = evaluateAuditReport(report({
    broken: { name: 'broken', severity: 'high', nodes: ['node_modules/broken'], via: [null] },
  }));
  assert.match(malformed.errors.join('\n'), /Malformed audit advisory: broken/);
});

test('an unidentified blocking advisory is not treated as clean', () => {
  const result = evaluateAuditReport(report({
    mystery: { name: 'mystery', severity: 'high', nodes: ['node_modules/mystery'], via: [{ name: 'mystery', severity: 'high', title: 'no identifier here' }] },
  }));
  assert.match(result.errors.join('\n'), /Unidentified blocking advisory: mystery/);
});
