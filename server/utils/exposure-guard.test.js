import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExposure } from './exposure-guard.js';

test('loopback binds are quiet', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
        const result = evaluateExposure({ host });
        assert.equal(result.level, 'ok', host);
        assert.equal(result.reason, 'loopback');
    }
});

test('HOST is honoured: any non-loopback bind is reported, never refused', () => {
    for (const host of ['0.0.0.0', '::', '192.168.0.10', '198.51.100.51']) {
        const result = evaluateExposure({ host });
        assert.equal(result.level, 'warn', host);
        assert.equal(result.reason, 'remote-bind');
        assert.match(result.message, new RegExp(`HOST=${host.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
    }
});

test('remote bind messages identify wildcard and specific addresses', () => {
    const wildcard = evaluateExposure({ host: '0.0.0.0' });
    assert.match(wildcard.message, /ALL network interfaces/);
    const specific = evaluateExposure({ host: '192.168.0.10' });
    assert.match(specific.message, /network address 192\.168\.0\.10/);
});
