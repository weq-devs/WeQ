// @ts-nocheck
import { usePreferenceState } from '../../lib/clientPreferences';
/** 在线 AI 声聊的声线、样音与发送控件，共用语音模式的草稿文本。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { AudioLines, Pause, Play, SendHorizontal } from 'lucide-react';
import { cn } from './classNames';
import { useQQAction } from '../../components/qq-actions/shared.shared';
import { trpc } from '../../trpc/client';
import {
  type AiVoiceDraft,
  groupAiVoiceOptions,
  onlineAiVoiceOptions,
  aiVoiceSampleUrl,
} from './aiVoicePanel.shared';

export function AiVoiceControls({
  groupId,
  text,
  disabled,
  disabledHint,
  onSend,
  sendRef,
}: {
  groupId: number;
  text: string;
  disabled: boolean;
  disabledHint: string;
  onSend: (draft: AiVoiceDraft) => void;
  sendRef: RefObject<HTMLButtonElement | null>;
}) {
  const [requestedVoiceId, setVoiceId] = usePreferenceState('aiVoiceId');
  const session = useQQAction(`ai-voice-catalog:${groupId ?? ''}`);
  const catalog = trpc.account.qqActions.aiVoiceCatalog.useQuery(
    { ...session.binding!, groupId: groupId ?? 0 },
    {
      enabled: session.available && !!groupId,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 试听音频跟面板一起走，关掉就停。
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const groups = useMemo(() => {
    const online = onlineAiVoiceOptions(catalog.data ?? []);
    return online.length
      ? online
      : groupAiVoiceOptions().map(({ group, items }) => ({
          group,
          items: items.map(({ key, option }) => ({
            key,
            option: { ...option, sampleUrl: aiVoiceSampleUrl(option.id) },
          })),
        }));
  }, [catalog.data]);
  const options = groups.flatMap(({ items }) => items.map(({ option }) => option));
  const selected = options.find((option) => option.id === requestedVoiceId) ?? options[0];
  const voiceId = selected?.id ?? '';
  const body = text.trim();
  const canSendAiVoice = body.length > 0 && text.length <= 200 && !!voiceId && !disabled;

  function stopSample() {
    const audio = audioRef.current;
    audioRef.current = null;
    audio?.pause();
    setPlayingKey(null);
  }

  function toggleSample(key: string, url: string) {
    if (playingKey === key) {
      stopSample();
      return;
    }
    stopSample();
    setSampleError(null);
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => {
      if (audioRef.current === audio) stopSample();
    };
    function failed(message: string) {
      if (audioRef.current !== audio) return;
      stopSample();
      setSampleError(message);
    }
    audio.onerror = () => failed('这条声线的样音加载失败，请重试。');
    setPlayingKey(key);
    void audio.play().catch((error: unknown) => {
      failed(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? '播放未获授权，请再点一次试听。'
          : '这条声线的样音加载失败，请重试。',
      );
    });
  }

  return (
    <div className={cn('voice-synthesis-controls', 'ai-voice-controls')}>
      <div className={cn('ai-voice-voices')}>
        <div className={cn('ai-voice-voices-head')}>
          <AudioLines size={13} strokeWidth={2} />
          声线
        </div>
        <div className={cn('ai-voice-voices-list')} role="radiogroup" aria-label="声线">
          {groups.map((entry) => (
            <div className={cn('ai-voice-group')} key={entry.group}>
              <span className={cn('ai-voice-group-label')}>{entry.group}</span>
              <div className={cn('ai-voice-group-items')}>
                {entry.items.map(({ option, key }) => {
                  const active = option.id === voiceId;
                  const playing = playingKey === key;
                  const sampleLabel = `${playing ? '停止试听' : '试听'}「${option.name}」`;
                  return (
                    <div className={cn('ai-voice-chip', active && 'is-active')} key={key}>
                      <button
                        type="button"
                        className={cn('ai-voice-chip-pick')}
                        role="radio"
                        aria-checked={active}
                        title={`${option.name}（${option.id}）`}
                        onClick={() => setVoiceId(option.id)}
                      >
                        {option.name}
                      </button>
                      <button
                        type="button"
                        className={cn('ai-voice-chip-play', playing && 'is-playing')}
                        title={option.sampleUrl ? sampleLabel : '该声线暂无样音'}
                        aria-label={sampleLabel}
                        disabled={!option.sampleUrl}
                        onClick={() => option.sampleUrl && toggleSample(key, option.sampleUrl)}
                      >
                        {playing ? <Pause size={11} /> : <Play size={11} />}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {sampleError ? (
        <span className={cn('ai-voice-error')} role="status">
          {sampleError}
        </span>
      ) : null}
      <footer className="ai-voice-foot">
        <button
          type="button"
          className={cn('ai-voice-btn', 'primary')}
          ref={sendRef}
          title={disabled ? disabledHint : '合成并发送'}
          disabled={!canSendAiVoice}
          onClick={() => onSend({ text: body, voiceId })}
        >
          <SendHorizontal size={13} strokeWidth={2.2} />
          合成并发送
        </button>
      </footer>
    </div>
  );
}
export type { AiVoiceOption, AiVoiceDraft } from './aiVoicePanel.shared';
