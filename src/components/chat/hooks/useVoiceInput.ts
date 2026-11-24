import { useEffect, useRef, useState } from 'react';

import { beginComposerOperation } from '../../../shared/composerFreeze';
import { transcribeVoice, voiceStreamAddress, voiceStreamHandshake } from '../../../utils/voiceApi';

const RECORDING_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function recordingType(): string {
  if (typeof MediaRecorder === 'undefined') return '';

  for (const candidate of RECORDING_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // Some browser implementations throw while probing a type.
    }
  }

  return '';
}

function extensionFor(type: string): string {
  if (type.includes('mp4')) return 'm4a';
  return type.includes('ogg') ? 'ogg' : 'webm';
}

const STREAM_SAMPLE_RATE = 16_000;
const STREAM_BUFFER_SIZE = 4096;
const STREAM_PENDING_LIMIT = 64;
const STREAM_DONE_TIMEOUT_MS = 15_000;

/**
 * Convert one captured block to the PCM the streaming endpoint expects. A
 * context created at 16 kHz already reports that rate; a browser that only
 * gives its device rate is resampled here, so the wire format never changes.
 */
function pcmFrame(input: Float32Array, sampleRate: number): ArrayBuffer {
  const step = sampleRate / STREAM_SAMPLE_RATE;
  const length = Math.max(1, Math.floor(input.length / step));
  const pcm = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * step;
    const low = Math.floor(position);
    const high = Math.min(input.length - 1, low + 1);
    const first = input[low] ?? 0;
    const sample = step === 1 ? first : first + ((input[high] ?? 0) - first) * (position - low);
    const clamped = Math.max(-1, Math.min(1, sample));
    pcm[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm.buffer;
}

export type VoiceInputState = 'idle' | 'starting' | 'recording' | 'stopping' | 'transcribing';
export type VoiceInputOptions = {
  /** Capture live and use the backend's partial/final stream instead of one upload. */
  streaming?: boolean;
  /** The current phrase while speaking, so the composer can show it as it forms. */
  onPartial?: (text: string) => void;
  /** Streaming ended without a transcript; put the composer back the way it was. */
  onStreamReset?: () => void;
};
type Recording = { phase: VoiceInputState; stop(send?: boolean): void; depart(): void };

export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void | Promise<void>,
  onError?: (msg: string) => void,
  ownerKey = '',
  options: VoiceInputOptions = {},
) {
  const [state, setState] = useState<VoiceInputState>('idle');
  // 0..1 microphone level while recording, for the composer's live indicator.
  const [level, setLevel] = useState(0);
  const recording = useRef<Recording | null>(null);
  const owner = useRef<object | null>(null);

  useEffect(() => {
    const visit = {};
    owner.current = visit;
    setState('idle');
    setLevel(0);
    return () => {
      owner.current = null;
      const prior = recording.current;
      recording.current = null;
      // Stop capturing on departure, but retain the operation through the
      // recorder's final data/stop events and any already accepted HTTP work.
      // A pending permission request cannot be cancelled: its promise owns it.
      prior?.depart();
    };
  }, [ownerKey]);

  async function begin() {
    const visit = owner.current;
    if (!visit || recording.current) return;
    const finishOperation = beginComposerOperation('voice');
    if (!finishOperation) return;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let sendWhenDone = false;
    let finished = false;
    let stopCapture: () => void = () => {};
    let streamStop: ((send?: boolean) => void) | null = null;
    const session: Recording = { phase: 'starting', stop, depart() { stop(); releaseMicrophone(); } };
    const isVisible = () => owner.current === visit && recording.current === session;
    const report = (message: string) => { if (isVisible()) onError?.(message); };
    // The level meter reads the same stream the recorder writes, so it never
    // captures a second time. Every piece is optional: a browser without Web
    // Audio (or a test double without it) simply keeps the level at zero.
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let meterFrame = 0;
    const releaseMeter = () => {
      if (meterFrame) cancelAnimationFrame(meterFrame);
      meterFrame = 0;
      analyser = null;
      if (audioContext) { void audioContext.close().catch(() => {}); audioContext = null; }
      if (isVisible()) setLevel(0);
    };
    const releaseMicrophone = () => { stopCapture(); releaseMeter(); stream?.getTracks().forEach((track) => track.stop()); stream = null; };
    const startMeter = (captured: MediaStream) => {
      if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return;
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        audioContext = new Ctor();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.6;
        audioContext.createMediaStreamSource(captured).connect(analyser);
      } catch {
        // A locked-down or mocked audio stack must not stop the recording.
        releaseMeter();
        return;
      }
      const meterNode = analyser;
      if (!meterNode) return;
      const samples = new Uint8Array(meterNode.fftSize);
      const tick = () => {
        if (finished) return;
        meterNode.getByteTimeDomainData(samples);
        let power = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          power += centered * centered;
        }
        if (isVisible()) setLevel(Math.min(1, Math.sqrt(power / samples.length) * 4));
        meterFrame = requestAnimationFrame(tick);
      };
      meterFrame = requestAnimationFrame(tick);
    };
    const phase = (next: VoiceInputState) => { session.phase = next; if (isVisible()) setState(next); };
    const finish = () => {
      if (finished) return;
      finished = true;
      releaseMicrophone();
      if (recorder) { recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null; }
      chunks = [];
      phase('idle');
      if (recording.current === session) recording.current = null;
      finishOperation();
    };
    function stop(send = false) {
      if (streamStop) { streamStop(send); return; }
      if (finished || session.phase !== 'recording' || !recorder || recorder.state === 'inactive') return;
      sendWhenDone = send;
      phase('stopping');
      try { recorder.stop(); } catch (error) {
        // A failed stop request is not evidence that recording finished. Keep
        // its actual owner, report the failure, and allow a real Stop retry.
        phase('recording');
        report(`Recording could not stop: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Streaming keeps the same owner and composer admission as a recording: the
    // socket is only a transport, and a final transcript is delivered through
    // the same callback once the backend closes the phrase.
    const startStream = (captured: MediaStream) => {
      if (typeof WebSocket === 'undefined' || typeof window === 'undefined') {
        report('Streaming transcription is unavailable in this browser.');
        finish();
        return;
      }
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        report('Streaming needs Web Audio in this browser.');
        finish();
        return;
      }
      let context: AudioContext;
      try {
        context = new Ctor({ sampleRate: STREAM_SAMPLE_RATE });
      } catch {
        try {
          context = new Ctor();
        } catch {
          report('Streaming needs Web Audio in this browser.');
          finish();
          return;
        }
      }
      let processor: ScriptProcessorNode;
      let source: MediaStreamAudioSourceNode;
      let silence: GainNode;
      try {
        source = context.createMediaStreamSource(captured);
        processor = context.createScriptProcessor(STREAM_BUFFER_SIZE, 1, 1);
        silence = context.createGain();
        silence.gain.value = 0;
        source.connect(processor);
        processor.connect(silence);
        // A processor only runs while connected to the destination; a zero gain
        // keeps the graph alive without echoing the microphone.
        silence.connect(context.destination);
      } catch {
        void context.close().catch(() => {});
        report('Streaming needs Web Audio in this browser.');
        finish();
        return;
      }
      let captureClosed = false;
      stopCapture = () => {
        if (captureClosed) return;
        captureClosed = true;
        processor.onaudioprocess = null;
        try { source.disconnect(); processor.disconnect(); silence.disconnect(); } catch { /* already disconnected */ }
        void context.close().catch(() => {});
        if (isVisible()) setLevel(0);
      };
      const pending: ArrayBuffer[] = [];
      const finals: string[] = [];
      let partial = '';
      let socket: WebSocket | null = null;
      let ready = false;
      let settled = false;
      let completed = false;
      let doneText: string | null = null;
      let requestedEnd = false;
      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      const phrase = () => [...finals, partial].filter((part) => part.trim()).join(' ').trim();
      const showPartial = () => { if (isVisible()) options.onPartial?.(phrase()); };
      const stopTimer = () => { if (closeTimer) clearTimeout(closeTimer); closeTimer = null; };
      const settle = () => {
        if (settled) return;
        settled = true;
        stopTimer();
        const live = socket;
        socket = null;
        try { live?.close(); } catch { /* already closed */ }
        stopCapture();
        releaseMicrophone();
        const text = (doneText ?? phrase()).trim();
        if (!completed) {
          options.onStreamReset?.();
          finish();
          return;
        }
        if (!text) {
          report('No speech detected');
          finish();
          return;
        }
        phase('transcribing');
        void (async () => {
          try {
            await onTranscript(text, isVisible() && sendWhenDone);
          } catch (error) {
            report(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            finish();
          }
        })();
      };
      const connect = () => {
        try {
          socket = new WebSocket(voiceStreamAddress());
        } catch {
          report('Streaming transcription failed.');
          finish();
          return;
        }
        const live = socket;
        live.binaryType = 'arraybuffer';
        live.onopen = () => {
          try { live.send(JSON.stringify({ type: 'config', ...voiceStreamHandshake() })); } catch { /* close follows */ }
        };
        live.onmessage = (event) => {
          if (settled) return;
          let payload: { type?: unknown; text?: unknown; message?: unknown };
          try { payload = JSON.parse(String(event.data)); } catch { return; }
          if (!payload || typeof payload !== 'object') return;
          if (payload.type === 'ready') {
            ready = true;
            for (const frame of pending.splice(0)) {
              if (live.readyState !== WebSocket.OPEN) break;
              live.send(frame);
            }
            // Stop may have been pressed while the handshake was in flight.
            if (requestedEnd && live.readyState === WebSocket.OPEN) live.send(JSON.stringify({ type: 'end' }));
            return;
          }
          if (payload.type === 'partial' && typeof payload.text === 'string') {
            partial = payload.text;
            showPartial();
            return;
          }
          if (payload.type === 'final' && typeof payload.text === 'string') {
            if (payload.text.trim()) finals.push(payload.text.trim());
            partial = '';
            showPartial();
            return;
          }
          if (payload.type === 'done') {
            completed = true;
            if (typeof payload.text === 'string') doneText = payload.text;
            settle();
            return;
          }
          if (payload.type === 'error') {
            report(typeof payload.message === 'string' ? payload.message : 'Streaming transcription failed.');
            settle();
          }
        };
        live.onerror = () => {
          if (settled) return;
          report('Streaming transcription failed.');
          settle();
        };
        live.onclose = () => {
          if (settled) return;
          if (requestedEnd && phrase()) completed = true;
          settle();
        };
      };
      streamStop = (send = false) => {
        if (finished || settled) return;
        sendWhenDone = send;
        requestedEnd = true;
        phase('stopping');
        stopCapture();
        if (socket && ready && socket.readyState === WebSocket.OPEN) {
          try { socket.send(JSON.stringify({ type: 'end' })); } catch { settle(); return; }
        } else if (!socket) {
          settle();
          return;
        }
        stopTimer();
        closeTimer = setTimeout(() => {
          if (settled) return;
          report('Streaming transcription timed out');
          settle();
        }, STREAM_DONE_TIMEOUT_MS);
      };
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let power = 0;
        for (const sample of input) power += sample * sample;
        if (isVisible()) setLevel(Math.min(1, Math.sqrt(power / input.length) * 4));
        const frame = pcmFrame(input, context.sampleRate);
        if (socket?.readyState === WebSocket.OPEN && ready) socket.send(frame);
        else if (pending.length < STREAM_PENDING_LIMIT) pending.push(frame);
      };
      connect();
      phase('recording');
    };
    recording.current = session;
    phase('starting');

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      if (!isVisible()) {
        finish();
        return;
      }
      if (options.streaming) {
        startStream(stream);
        return;
      }
      const type = recordingType();
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);

      recorder.ondataavailable = ({ data }) => {
        if (!finished && data.size > 0) chunks.push(data);
      };

      recorder.onstop = async () => {
        if (finished || session.phase === 'transcribing') return;
        releaseMicrophone();
        phase('transcribing');
        const recordedType = recorder?.mimeType || 'audio/webm';
        const audio = new Blob(chunks, { type: recordedType });
        try {
          if (audio.size < 800) { report('Recording too short'); return; }
          const response = await transcribeVoice(audio, `recording.${extensionFor(recordedType)}`);
          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`transcribe ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
          }

          const payload = await response.json();
          const transcript = String(payload?.text || '').trim();
          // Capture the original delivery callback at begin(), not a newer
          // route's callback. Offscreen completion saves input but never sends.
          if (transcript) await onTranscript(transcript, isVisible() && sendWhenDone);
          else report('No speech detected');
        } catch (error) {
          report(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          finish();
        }
      };
      recorder.onerror = () => {
        report('Recording failed.');
        // MediaRecorder supplies final data and a stop event after an error.
        // Do not release admission before that terminal event arrives.
        stop();
      };

      recorder.start();
      startMeter(stream);
      phase('recording');
    } catch (error) {
      const microphoneError = error as { name?: string; message?: string };
      let message = `Mic error: ${microphoneError?.message || error}`;
      if (microphoneError?.name === 'NotAllowedError') message = 'Microphone access denied.';
      else if (microphoneError?.name === 'NotFoundError') message = 'No microphone found.';
      try { report(message); } finally { finish(); }
    }
  }
  const stop = (opts?: { send?: boolean }) => recording.current?.stop(opts?.send);
  const toggle = () => { if (!recording.current) void begin(); else recording.current.stop(); };

  return { state, level, toggle, stop };
}
