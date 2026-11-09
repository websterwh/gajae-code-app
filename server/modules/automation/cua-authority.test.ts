import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { AutomationGrantStore } from './automation-grants.js';
import { AutomationService } from './automation.service.js';
import { ComputerUseStore } from './computer-use.js';
import { AgentDesktopClient } from './agent-desktop-client.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
  };
}

/** TextEdit-shaped inventory so window_id "w-7" resolves to a stable app identity. */
const INVENTORY = {
  structuredContent: {
    data: {
      apps: [{ pid: 42, name: 'TextEdit' }],
      windows: [{ pid: 42, id: 'w-7', title: 'README.md' }],
    },
  },
};

type Dispatched = { tool: string; args: Record<string, unknown> };

/**
 * A service whose driver transport is replaced by a recorder. Everything above
 * the transport — identity resolution, grant enforcement — is the real
 * implementation.
 */
function service(t: TestContext) {
  const previous = process.env.GAJAE_AUTOMATION;
  process.env.GAJAE_AUTOMATION = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.GAJAE_AUTOMATION;
    else process.env.GAJAE_AUTOMATION = previous;
  });

  const instance = new AutomationService();
  const grants = new AutomationGrantStore(memoryStorage());
  Object.defineProperty(instance, 'grants', { value: grants });
  // Authority is what these tests are about; the opt-in (off by default,
  // #131) is turned on so that the grant checks are the thing under test.
  const computerUse = new ComputerUseStore(memoryStorage());
  computerUse.set(true);
  Object.defineProperty(instance, 'computerUse', { value: computerUse });
  const dispatched: Dispatched[] = [];
  const inventory: string[] = [];
  instance.cua.call = async (tool, args) => {
    // Identity resolution reads; recorded separately from agent-visible work.
    if ((tool === 'desktop_list_apps' || tool === 'desktop_list_windows') && Object.keys(args).length === 0) {
      inventory.push(tool);
      return INVENTORY;
    }
    dispatched.push({ tool, args });
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  return { instance, grants, dispatched, inventory };
}

/* -------------------------------------------------------------------------- */
/* Server-side authority                                                      */
/* -------------------------------------------------------------------------- */

test('an ungranted application mutation is rejected at the server execution boundary', async (t) => {
  const { instance, dispatched } = service(t);
  await assert.rejects(
    instance.callComputer('session-a', 'desktop_focus_window', { window_id: 'w-7' }),
    /was not granted/u,
  );
  assert.deepEqual(dispatched, [], 'nothing may reach the driver without a grant');
});

test('a malformed ref_id is rejected before any driver round-trip', async (t) => {
  const { instance, dispatched, inventory } = service(t);
  await assert.rejects(
    instance.callComputer('session-a', 'desktop_click', { ref_id: 'e1' }),
    { name: 'AgentDesktopPolicyError', message: /ref_id does not match/u },
  );
  assert.deepEqual(dispatched, []);
  assert.deepEqual(inventory, [], 'a denied call must not even resolve identity');
});

test('computer authorization rejects policy-denied arguments before inventory or grants', async (t) => {
  const { instance, grants, inventory, dispatched } = service(t);
  await assert.rejects(
    instance.authorizeComputer('session-a', {
      tool: 'desktop_click',
      arguments: { ref_id: 'not-a-ref' },
      scope: 'always',
    }),
    { name: 'AgentDesktopPolicyError', message: /ref_id does not match/u },
  );
  assert.deepEqual(inventory, [], 'a denied authorization must not resolve application identity');
  assert.deepEqual(dispatched, []);
  assert.deepEqual(grants.list().always.applications, [], 'a denied authorization must not persist a grant');
});

test('computer authorization and execution share required-argument validation', async (t) => {
  const { instance, grants, inventory } = service(t);
  await assert.rejects(
    instance.authorizeComputer('session-a', {
      tool: 'desktop_select', arguments: { ref_id: '@s1:e1' }, scope: 'session',
    }),
    { name: 'AgentDesktopPolicyError', message: /requires "value"/u },
  );
  assert.deepEqual(inventory, []);
  assert.deepEqual(grants.list('session-a').session, []);
});

test('a granted application mutation is accepted and dispatched', async (t) => {
  const { instance, grants, dispatched } = service(t);
  grants.grant({ kind: 'application', value: 'TextEdit', scope: 'session', sessionId: 'session-a' });

  await instance.callComputer('session-a', 'desktop_focus_window', { window_id: 'w-7' });
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0], {
    tool: 'desktop_focus_window',
    args: { window_id: 'w-7' },
  });
});

test('reaching callComputer directly confers no authority', async (t) => {
  const { instance, dispatched } = service(t);
  // The audited gap: authorizeComputer computed authority that nothing consumed.
  const authorization = await instance.authorizeComputer('session-a', {
    tool: 'desktop_focus_window', arguments: { window_id: 'w-7' },
  });
  assert.equal(authorization.granted, false);
  assert.equal(authorization.application, 'TextEdit');

  await assert.rejects(instance.callComputer('session-a', 'desktop_focus_window', { window_id: 'w-7' }), /was not granted/u);
  await assert.rejects(instance.callComputer('session-a', 'desktop_resize_window', { window_id: 'w-7', width: 100, height: 100 }), /was not granted/u);
  await assert.rejects(instance.callComputer('session-a', 'desktop_launch', { app: 'TextEdit' }), /was not granted/u);
  assert.deepEqual(dispatched, []);
});

test('an application grant does not cross session boundaries', async (t) => {
  const { instance, grants, dispatched } = service(t);
  grants.grant({ kind: 'application', value: 'TextEdit', scope: 'session', sessionId: 'session-a' });

  await instance.callComputer('session-a', 'desktop_focus_window', { window_id: 'w-7' });
  await assert.rejects(instance.callComputer('session-b', 'desktop_focus_window', { window_id: 'w-7' }), /was not granted/u);
  assert.equal(dispatched.length, 1);
});

test('a grant for one application does not authorize another', async (t) => {
  const { instance, grants } = service(t);
  grants.grant({ kind: 'application', value: 'com.example.Other', scope: 'always' });
  await assert.rejects(instance.callComputer('session-a', 'desktop_focus_window', { window_id: 'w-7' }), /was not granted/u);
});

test('identity is re-resolved at dispatch, so a recycled window_id fails closed', async (t) => {
  const { instance, grants, dispatched } = service(t);
  grants.grant({ kind: 'application', value: 'TextEdit', scope: 'session', sessionId: 'session-a' });
  await instance.callComputer('session-a', 'desktop_focus_window', { window_id: 'w-7' });

  // The approved window now belongs to a different application.
  instance.cua.call = async (tool, args) => {
    if (tool === 'desktop_list_windows') {
      return { structuredContent: { data: { windows: [{ pid: 99, id: 'w-7', title: 'Imposter' }] } } };
    }
    if (tool === 'desktop_list_apps') {
      return { structuredContent: { data: { apps: [{ pid: 99, name: 'Imposter' }] } } };
    }
    dispatched.push({ tool, args });
    return { ok: true };
  };
  await assert.rejects(instance.callComputer('session-a', 'desktop_focus_window', { window_id: 'w-7' }), /was not granted/u);
  assert.equal(dispatched.length, 1, 'the recycled window_id must not reuse the old approval');
});

test('read-only discovery stays available without an application grant', async (t) => {
  const { instance } = service(t);
  for (const tool of ['desktop_list_apps', 'desktop_snapshot', 'desktop_find'] as const) {
    await assert.doesNotReject(instance.callComputer('session-a', tool, {}), tool);
  }
  // An app filter turns a discovery read into an application-bound one.
  await assert.rejects(instance.callComputer('session-a', 'desktop_list_windows', { app: 'TextEdit' }), /was not granted/u);
});

test('a ref_id resolves to the application whose snapshot produced it', async (t) => {
  const { instance, grants, dispatched } = service(t);
  instance.cua.call = async (tool, args) => {
    dispatched.push({ tool, args });
    if (tool === 'desktop_snapshot') {
      return { structuredContent: { data: { app: 'TextEdit', snapshot_id: 's1abc', tree: {} } } };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  grants.grant({ kind: 'application', value: 'TextEdit', scope: 'session', sessionId: 'session-a' });

  await instance.callComputer('session-a', 'desktop_snapshot', { app: 'TextEdit' });
  // Interaction tools carry no app field, so the snapshot is the only link
  // back to the approved application.
  await instance.callComputer('session-a', 'desktop_type', { ref_id: '@s1abc:e2', text: 'HELLO' });
  assert.deepEqual(dispatched[dispatched.length - 1], {
    tool: 'desktop_type',
    args: { ref_id: '@s1abc:e2', text: 'HELLO' },
  });
});

test('a ref_id from another session does not resolve', async (t) => {
  const { instance, grants } = service(t);
  instance.cua.call = async (tool) => tool === 'desktop_snapshot'
    ? { structuredContent: { data: { app: 'TextEdit', snapshot_id: 's1abc', tree: {} } } }
    : { ok: true };
  grants.grant({ kind: 'application', value: 'TextEdit', scope: 'session', sessionId: 'session-a' });

  await instance.callComputer('session-a', 'desktop_snapshot', { app: 'TextEdit' });
  await assert.rejects(
    instance.callComputer('session-b', 'desktop_type', { ref_id: '@s1abc:e2', text: 'HELLO' }),
    /requires a resolvable application identity/u,
  );
});

test('window_id resolves against agent-desktop 1.2.0\'s bare-array window list', async (t) => {
  const { instance, grants, dispatched } = service(t);
  instance.cua.call = async (tool, args) => {
    if (tool === 'desktop_list_windows') return { structuredContent: { data: [{ id: 'w-9', pid: 42 }] } };
    if (tool === 'desktop_list_apps') return { structuredContent: { data: { apps: [{ pid: 42, name: 'TextEdit' }] } } };
    dispatched.push({ tool, args });
    return { ok: true };
  };
  grants.grant({ kind: 'application', value: 'TextEdit', scope: 'session', sessionId: 'session-a' });

  await instance.callComputer('session-a', 'desktop_focus_window', { window_id: 'w-9' });
  assert.equal(dispatched.length, 1);
});

test('session lifecycle tools need no application identity', async (t) => {
  const { instance, dispatched } = service(t);
  await instance.callComputer('session-a', 'desktop_session_start', {});
  assert.deepEqual(dispatched, [{ tool: 'desktop_session_start', args: {} }]);
});

test('a driver dead end names the recovery path instead of ending the loop', async (t) => {
  const { instance, grants } = service(t);
  grants.grant({ kind: 'application', value: 'TextEdit', scope: 'session', sessionId: 'session-a' });
  const INVENTORY_REPLY = (tool: string, args: Record<string, unknown>) =>
    (tool === 'desktop_list_windows' || tool === 'desktop_list_apps') && Object.keys(args).length === 0;

  // agent-desktop's own text for an app that owns no visible window.
  instance.cua.call = async () => ({
    isError: true,
    content: [{ type: 'text', text: "Application 'TextEdit' is running but has no matching window" }],
  });
  await assert.rejects(
    instance.callComputer('session-a', 'desktop_snapshot', { app: 'TextEdit' }),
    /no matching window[\s\S]*desktop_press \{combo:"cmd\+n"/u,
  );

  // A window-addressed dead end: identity still resolves from the live
  // inventory, so the call reaches the driver and gains the hint.
  instance.cua.call = async (tool, args) => INVENTORY_REPLY(tool, args)
    ? INVENTORY
    : { isError: true, content: [{ type: 'text', text: "Window 'w-7' exists but is not exposed through accessibility" }] };
  await assert.rejects(
    instance.callComputer('session-a', 'desktop_snapshot', { window_id: 'w-7' }),
    /not exposed through accessibility[\s\S]*desktop_list_windows[\s\S]*accessible/u,
  );

  // The remote transport rejects rather than returning isError; same hint.
  instance.cua.call = async (tool, args) => {
    if (INVENTORY_REPLY(tool, args)) return INVENTORY;
    throw new Error("Window 'w-7' exists but is not exposed through accessibility");
  };
  await assert.rejects(
    instance.callComputer('session-a', 'desktop_snapshot', { window_id: 'w-7' }),
    /not exposed through accessibility[\s\S]*desktop_list_windows/u,
  );

  // An unrelated driver error is passed through untouched.
  instance.cua.call = async () => ({ isError: true, content: [{ type: 'text', text: 'Permission denied' }] });
  await assert.rejects(
    instance.callComputer('session-a', 'desktop_snapshot', { app: 'TextEdit' }),
    { message: 'Permission denied' },
  );
});

test('a batch is authorized by the application its ref_ids were minted in', async (t) => {
  const { instance, grants, dispatched } = service(t);
  grants.grant({ kind: 'application', value: 'TextEdit', scope: 'session', sessionId: 'session-a' });
  instance.cua.call = async (tool, args) => {
    dispatched.push({ tool, args });
    if (tool === 'desktop_snapshot') {
      return { structuredContent: { data: { snapshot_id: 's1', app: 'TextEdit' } } };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  await instance.callComputer('session-a', 'desktop_snapshot', { app: 'TextEdit' });
  const commands = JSON.stringify([{ command: 'type', args: { ref_id: '@s1:e2', text: 'hi' } }]);
  await instance.callComputer('session-a', 'desktop_batch', { commands_json: commands });
  assert.deepEqual(dispatched.at(-1), { tool: 'desktop_batch', args: { commands_json: commands } });
});

test('a batch whose refs belong to no snapshot is rejected, never dispatched', async (t) => {
  const { instance, grants, dispatched } = service(t);
  grants.grant({ kind: 'application', value: 'TextEdit', scope: 'session', sessionId: 'session-a' });
  await assert.rejects(
    instance.callComputer('session-a', 'desktop_batch', {
      commands_json: JSON.stringify([{ command: 'click', args: { ref_id: '@unknown:e1' } }]),
    }),
    /requires a resolvable application identity/u,
  );
  assert.deepEqual(dispatched, []);
});

/* -------------------------------------------------------------------------- */
/* The guard sits at the driver transport                                     */
/* -------------------------------------------------------------------------- */

test('the driver client refuses a denied call before it starts any transport', async () => {
  const client = new AgentDesktopClient();
  // No driver is installed in this test; a policy denial must still win, which
  // proves the guard runs ahead of process spawn rather than beside it.
  await assert.rejects(client.call('desktop_click', { ref_id: 'bad-ref' }),
    { name: 'AgentDesktopPolicyError', message: /ref_id does not match/u });
  await assert.rejects(client.call('desktop_select', { ref_id: '@s1:e1' }),
    { name: 'AgentDesktopPolicyError', message: /requires "value"/u });
  await assert.rejects(client.call('desktop_launch', {}),
    { name: 'AgentDesktopPolicyError', message: /requires "app"/u });
});

/* -------------------------------------------------------------------------- */
/* Both external callers reach the same policy                                */
/* -------------------------------------------------------------------------- */

async function bridgeCall(socketPath: string, token: string, request: Record<string, unknown>) {
  const socket = net.createConnection(socketPath);
  await once(socket, 'connect');
  socket.write(`${JSON.stringify({ id: 'req-1', token, ...request })}\n`);
  const [chunk] = await once(socket, 'data');
  socket.destroy();
  return JSON.parse(String(chunk)) as { ok: boolean; error?: string };
}

test('the authenticated bridge and the HTTP route share one authority policy',
  { skip: process.platform === 'win32' }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'pr03-authority-'));
    const previousSocket = process.env.GAJAE_AUTOMATION_SOCKET;
    process.env.GAJAE_AUTOMATION_SOCKET = join(directory, 'bridge.sock');
    const { instance, grants, dispatched } = service(t);
    t.after(async () => {
      await instance.shutdown();
      if (previousSocket === undefined) delete process.env.GAJAE_AUTOMATION_SOCKET;
      else process.env.GAJAE_AUTOMATION_SOCKET = previousSocket;
      await rm(directory, { recursive: true, force: true });
    });

    await instance.startBridge();
    const socketPath = process.env.GJC_AUTOMATION_SOCKET!;
    const token = process.env.GJC_AUTOMATION_TOKEN!;

    // Bridge caller, no grant: rejected.
    const ungranted = await bridgeCall(socketPath, token, {
      surface: 'computer', sessionId: 'session-a', tool: 'desktop_focus_window', arguments: { window_id: 'w-7' },
    });
    assert.equal(ungranted.ok, false);
    assert.match(ungranted.error!, /was not granted/u);

    // Bridge caller with a malformed ref: rejected before dispatch.
    const malformed = await bridgeCall(socketPath, token, {
      surface: 'computer', sessionId: 'session-a', tool: 'desktop_click',
      arguments: { ref_id: 'bad-ref' },
    });
    assert.equal(malformed.ok, false);

    // The HTTP route is a different caller reaching the same method.
    await assert.rejects(
      instance.callComputer('session-a', 'desktop_focus_window', { window_id: 'w-7' }),
      /was not granted/u,
      'POST /api/automation/computer/:sessionId/call funnels through callComputer',
    );
    assert.equal(dispatched.length, 0);

    // With a grant, the same bridge request succeeds.
    grants.grant({ kind: 'application', value: 'TextEdit', scope: 'session', sessionId: 'session-a' });
    const granted = await bridgeCall(socketPath, token, {
      surface: 'computer', sessionId: 'session-a', tool: 'desktop_focus_window', arguments: { window_id: 'w-7' },
    });
    assert.equal(granted.ok, true, granted.error);
    assert.equal(dispatched.length, 1);

    // A granted session still cannot pass unreviewed arguments.
    const malformedAfterGrant = await bridgeCall(socketPath, token, {
      surface: 'computer', sessionId: 'session-a', tool: 'desktop_click',
      arguments: { ref_id: '@s1:e1', window_id: 'w-7', unknown_field: 1 },
    });
    assert.equal(malformedAfterGrant.ok, false);
    assert.equal(dispatched.length, 1);
  });
