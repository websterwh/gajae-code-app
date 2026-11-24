import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyGjcRunFailure,
  gjcRunFailure,
  GJC_AUTH_FAILED_CODE,
  GJC_RUN_FAILED_CODE,
  GJC_USAGE_LIMIT_CODE,
} from './gjc-run-failure.js';

test('a usage-limit failure is classified as its own cause', () => {
  assert.equal(classifyGjcRunFailure("You've hit your usage limit. Resets at 5pm."), 'usage_limit');
  assert.equal(classifyGjcRunFailure('429 rate limit exceeded'), 'usage_limit');
  assert.equal(classifyGjcRunFailure('Your credit balance is too low'), 'usage_limit');
});

test('an authentication failure is classified separately', () => {
  assert.equal(classifyGjcRunFailure('401 Unauthorized: invalid api key'), 'auth');
  assert.equal(classifyGjcRunFailure('Please sign in again'), 'auth');
});

test('an unclassified failure stays the run, never the worker', () => {
  assert.equal(classifyGjcRunFailure('tool crashed'), null);
  assert.equal(classifyGjcRunFailure(undefined), null);
  assert.deepEqual(gjcRunFailure(null), { code: GJC_RUN_FAILED_CODE, message: 'GJC run failed.' });
});

test('each classified cause maps to a fixed sentence and code', () => {
  assert.equal(gjcRunFailure('usage_limit').code, GJC_USAGE_LIMIT_CODE);
  assert.match(gjcRunFailure('usage_limit').message, /usage limit/);
  assert.equal(gjcRunFailure('auth').code, GJC_AUTH_FAILED_CODE);
  assert.match(gjcRunFailure('auth').message, /sign-in/i);
});
