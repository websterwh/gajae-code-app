import { useEffect, useRef, useState } from 'react';

import { beginComposerOperation } from '../../../shared/composerFreeze';
import { transcribeVoice } from '../../../utils/voiceApi';

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

export type VoiceInputState = 'idle' | 'starting' | 'recording' | 'stopping' | 'transcribing';
type Recording = { phase: VoiceInputState; stop(send?: boolean): void; depart(): void };

export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void | Promise<void>,
  onError?: (msg: string) => void,
  ownerKey = '',
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
    const releaseMicrophone = () => { releaseMeter(); stream?.getTracks().forEach((track) => track.stop()); stream = null; };
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
