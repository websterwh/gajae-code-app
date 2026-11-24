import { useTranslation } from 'react-i18next';
import { Mic, Square, Loader2 } from 'lucide-react';

import { PromptInputButton } from '../../../shared/view/ui';
import type { VoiceInputState } from '../hooks/useVoiceInput';

type Props = {
  state: VoiceInputState;
  /** 0..1 microphone level while recording; shapes the live bars. */
  level?: number;
  onToggle: () => void;
  errorMsg?: string | null;
  disabled?: boolean;
};

// Fixed shape, so the bars move with the voice instead of all changing at once.
const BAR_SCALES = [0.45, 0.8, 1, 0.65, 0.35];
// The meter reports quiet room levels most of the time. A perceptual curve and
// gain make normal speech move the bars without touching capture or recording.
const VISUAL_CURVE = 0.6;
const VISUAL_GAIN = 1.45;

// Push-to-talk mic button (presentational). Recording state and the stop-and-send action
// are owned by the composer so the main Send button can drive them too. This button just
// starts recording and, while recording, stops and drops the transcript into the input box.
export default function VoiceInputButton({ state, level = 0, onToggle, errorMsg, disabled = false }: Props) {
  const { t } = useTranslation('chat');
  const visualLevel = level > 0 ? Math.min(1, Math.pow(level, VISUAL_CURVE) * VISUAL_GAIN) : 0;

  const icon =
    state === 'recording' ? (
      <Square className="text-destructive" />
    ) : state !== 'idle' ? (
      <Loader2 className="animate-spin" />
    ) : (
      <Mic />
    );

  return (
    <span className="relative inline-flex shrink-0 items-center gap-1.5">
      {state === 'recording' ? (
        <span aria-hidden className="flex h-5 items-center gap-[2px]">
          {BAR_SCALES.map((scale, index) => (
            <span
              key={index}
              className="w-[2px] rounded-full bg-destructive"
              style={{ height: `${Math.max(2, Math.round(visualLevel * 18 * scale))}px` }}
            />
          ))}
        </span>
      ) : null}
      {errorMsg && (
        <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded bg-destructive px-2 py-1 text-xs whitespace-nowrap text-destructive-foreground shadow-lg">
          {errorMsg}
        </span>
      )}
      <PromptInputButton
        disabled={state !== 'recording' && (disabled || state !== 'idle')}
        aria-label={state === 'recording' ? t('voice.stopRecording') : t('voice.input')}
        tooltip={{ content: state === 'recording' ? t('voice.stopRecording') : t('voice.input') }}
        onClick={(e: { preventDefault: () => void }) => {
          e.preventDefault();
          onToggle();
        }}
      >
        {icon}
      </PromptInputButton>
    </span>
  );
}
