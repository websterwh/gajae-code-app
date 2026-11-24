import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { resetComposerFreezeForTests } from '../../../shared/composerFreeze';

import { useVoiceInput } from './useVoiceInput';

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  url: string;
  readyState = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<string | ArrayBuffer> = [];
  constructor(url: string) { this.url = url; FakeSocket.instances.push(this); }
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  frames() { return this.sent.filter((frame): frame is ArrayBuffer => frame instanceof ArrayBuffer); }
}

type Processor = {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
  connect(): void;
  disconnect(): void;
};

class FakeContext {
  static processor: Processor | null = null;
  sampleRate: number;
  destination = {};
  constructor(options?: { sampleRate?: number }) { this.sampleRate = options?.sampleRate ?? 48_000; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() {
    const processor: Processor = { onaudioprocess: null, connect() {}, disconnect() {} };
    FakeContext.processor = processor;
    return processor;
  }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  close() { return Promise.resolve(); }
}

const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
const originalAudio = Object.getOwnPropertyDescriptor(window, 'AudioContext');
const originalMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

function microphone() {
  const track = { stops: 0, stop() { this.stops += 1; } };
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream };
}

let device = microphone();

beforeEach(() => {
  resetComposerFreezeForTests();
  localStorage.clear();
  FakeSocket.instances = [];
  FakeContext.processor = null;
  device = microphone();
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeContext });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => device.stream } });
});

afterEach(() => {
  cleanup();
  resetComposerFreezeForTests();
  localStorage.clear();
  if (originalSocket) Object.defineProperty(globalThis, 'WebSocket', originalSocket);
  else Reflect.deleteProperty(globalThis, 'WebSocket');
  if (originalAudio) Object.defineProperty(window, 'AudioContext', originalAudio);
  else Reflect.deleteProperty(window, 'AudioContext');
  if (originalMedia) Object.defineProperty(navigator, 'mediaDevices', originalMedia);
  else Reflect.deleteProperty(navigator, 'mediaDevices');
});

test('streaming buffers pcm until ready, shows partials, and delivers the final transcript', async () => {
  const partials: string[] = [];
  const finals: Array<[string, boolean | undefined]> = [];
  let resets = 0;
  const view = renderHook(() => useVoiceInput(
    async (text, send) => { finals.push([text, send]); },
    undefined,
    'A',
    { streaming: true, onPartial: (text) => partials.push(text), onStreamReset: () => { resets += 1; } },
  ));

  act(() => view.result.current.toggle());
  await waitFor(() => assert.equal(view.result.current.state, 'recording'));
  const socket = FakeSocket.instances[0];
  assert.match(socket.url, /\/api\/voice\/stream$/);

  const processor = FakeContext.processor;
  assert.ok(processor);
  act(() => processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) } }));
  assert.equal(socket.frames().length, 0, 'audio waits for the backend handshake');

  act(() => socket.open());
  assert.equal(JSON.parse(String(socket.sent[0])).type, 'config');
  act(() => socket.emit({ type: 'ready' }));
  assert.equal(socket.frames().length, 1);
  assert.equal(socket.frames()[0].byteLength, 4096 * 2);

  act(() => socket.emit({ type: 'partial', text: 'hel' }));
  act(() => socket.emit({ type: 'partial', text: 'hello' }));
  assert.deepEqual(partials, ['hel', 'hello']);
  act(() => socket.emit({ type: 'final', text: 'hello', segment: 1 }));
  assert.deepEqual(partials, ['hel', 'hello', 'hello']);

  act(() => view.result.current.stop({ send: true }));
  assert.deepEqual(JSON.parse(String(socket.sent.at(-1))), { type: 'end' });
  act(() => socket.emit({ type: 'done', text: 'hello world' }));
  await waitFor(() => assert.equal(view.result.current.state, 'idle'));

  assert.deepEqual(finals, [['hello world', true]]);
  assert.equal(resets, 0);
  assert.equal(device.track.stops, 1);
});

test('a backend error clears the live phrase and releases the microphone', async () => {
  const errors: string[] = [];
  const finals: string[] = [];
  let resets = 0;
  const view = renderHook(() => useVoiceInput(
    (text) => { finals.push(text); },
    (message) => errors.push(message),
    'A',
    { streaming: true, onPartial: () => {}, onStreamReset: () => { resets += 1; } },
  ));

  act(() => view.result.current.toggle());
  await waitFor(() => assert.equal(view.result.current.state, 'recording'));
  const socket = FakeSocket.instances[0];
  act(() => socket.open());
  act(() => socket.emit({ type: 'error', message: 'Voice backend unreachable: boom' }));

  await waitFor(() => assert.equal(view.result.current.state, 'idle'));
  assert.deepEqual(errors, ['Voice backend unreachable: boom']);
  assert.equal(resets, 1);
  assert.deepEqual(finals, []);
  assert.equal(device.track.stops, 1);
});
