// Exposure policy for a server that can run shell commands as its owner.
//
// HOST is the single knob. Loopback keeps everything local; anything else is
// reachable from wherever that address routes. The bind itself is not refused -
// a container has to listen on 0.0.0.0 to be port-mapped, and with sign-in
// available there is no longer a "no authentication" mode to guard against - so
// the policy returns a warning that names what the address exposes.
import { isLoopbackHost, isWildcardHost } from '../../shared/networkHosts.js';

/**
 * Decide what to say about a bind address.
 *
 * Pure function — no process/env access — so the policy is unit-testable.
 *
 * @param {object} input
 * @param {string} input.host bind address (e.g. '127.0.0.1', '0.0.0.0')
 * @returns {{level: 'ok'|'warn', reason: string, message?: string}}
 */
export function evaluateExposure({ host }) {
    const scope = isWildcardHost(host)
        ? 'ALL network interfaces'
        : `network address ${host}`;

    if (isLoopbackHost(host)) {
        return { level: 'ok', reason: 'loopback' };
    }

    return {
        level: 'warn',
        reason: 'remote-bind',
        message:
            `HOST=${host} — listening on ${scope}. Anyone who can route to that ` +
            'address can reach this app, so keep it on a private network or behind ' +
            'a proxy and leave sign-in enabled. Set HOST=127.0.0.1 to keep it local.',
    };
}
