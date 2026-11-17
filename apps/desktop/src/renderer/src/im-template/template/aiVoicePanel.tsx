// @ts-nocheck
/**
 * 输入框工具栏「AI 声聊」按钮弹出的面板（QQ AI 声聊 / TTS 语音）。
 *
 * **只做前端** —— 本模块不碰任何协议，也不负责真正下发：面板把「文字 + 声线 id」
 * 交给上层（`onSend`），发不发得出去、怎么发由 chatPane 那一侧决定（和
 * linkCardPanel 一个套路）。
 *
 * 三件事在这里落地：
 *   1. **声线目录**：22 个声线 / 4 个分组（推荐 / 搞怪 / 古风 / 现代），**用中文名**
 *      展示（小新 / 酥心御姐 / 霸道总裁 …）。这份目录来自 QQ 的 0x929d_0 目录接口，
 *      目前硬编码在下面（没走协议）；
 *   2. **试听**：每条声线都有一条静态样音 ——
 *      `https://res.qpt.qq.com/qpilot/tts_sample/group/<样音文件名>.wav`。
 *      样音文件名**通常**等于 voiceId，但**不保证**（`lucy-voice-lizeyan` 的样音是
 *      `lucy-voice-lizeyan-2.wav`），所以一律用目录里记的 `sample`，不拿 id 硬拼；
 *   3. 样音是 QQ 的运营资源，**不入库**，这里现拼 URL 交给 <audio>，切走时释放。
 *
 * 群聊专用：私聊下这个按钮根本不渲染（见 chatPane 的 `canUseAiVoice`）。
 * 且 AI 声聊语音**只能单独发送** —— 不允许和输入框里的文字混在一条消息里。
 *
 * 样式全走主题 token（--weq-accent-effective / --weq-fg-* / --popover /
 * --im-color-line），主题色与深浅模式自动跟随，见 composer-media.css。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Pause, Play, SendHorizontal, Sparkles, Type, X } from 'lucide-react';
import type { RefObject } from 'react';
import { cn } from './classNames';
import {
  TtsComposer,
  type TtsSpeechRequest,
  type TtsSpeechResult,
  type TtsVoiceProvider,
} from './voicePanel';
import {
  type AiVoiceDraft,
  AI_VOICE_CATALOG,
  groupAiVoiceOptions,
  aiVoiceOption,
  aiVoiceSampleUrl,
} from './aiVoicePanel.shared';

export function AiVoicePanel({
  panelRef,
  disabled,
  disabledHint,
  allowAiVoice = true,
  initialTab,
  canSend = true,
  sendHint = '',
  ttsProviders = [],
  onSend,
  onSendAudioFile,
  onSynthesizeSpeech,
  onClose,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  /** QQ 未在线 / 完全离线等：面板照常填，只是发不出去。 */
  disabled: boolean;
  disabledHint: string;
  /**
   * 是否展示「AI 声聊」页签。群聊 true（两个页签：AI 声聊 / 文字转语音）；
   * 私聊 false —— 协议目标字段是群号，私聊只有「文字转语音」一个页签。
   */
  allowAiVoice?: boolean;
  initialTab?: 'ai' | 'tts';
  /** TTS 合成等服务商能力是否能发送（QQ 在线且允许注入）。 */
  canSend?: boolean;
  sendHint?: string;
  ttsProviders?: TtsVoiceProvider[];
  onSend: (draft: AiVoiceDraft) => void;
  /** 文字转语音：合成好的音频当普通语音条发（上层解 WAV 再转 SILK）。 */
  onSendAudioFile: (bytes: Uint8Array, fileName: string) => void;
  /** 文字交给已配置的 TTS 服务商合成（应用层注入，走 bootstrap.synthesizeSpeech）。 */
  onSynthesizeSpeech?: (request: TtsSpeechRequest) => Promise<TtsSpeechResult>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'ai' | 'tts'>(allowAiVoice ? (initialTab ?? 'ai') : 'tts');
  const [text, setText] = useState('');
  const [voiceId, setVoiceId] = useState(AI_VOICE_CATALOG[0]?.id ?? '');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // 一打开就把光标放进文本框；试听音频跟面板一起走，关掉就停。
  useEffect(() => {
    textRef.current?.focus({ preventScroll: true });
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const groups = useMemo(() => groupAiVoiceOptions(), []);
  const selected = aiVoiceOption(voiceId);
  const body = text.trim();
  const canSendAiVoice = body.length > 0 && !disabled;

  /** 播 / 停某条声线的样音。同一时刻只留一路。 */
  function toggleSample(key: string) {
    const current = audioRef.current;
    if (playingId === key && current) {
      current.pause();
      current.currentTime = 0;
      setPlayingId(null);
      return;
    }
    current?.pause();
    setSampleError(null);
    // key 形如 `<分组>:<voiceId>` —— 同一条声线会出现在多个分组，播放态按 key 记，
    // 但试听地址只跟 voiceId 有关（用目录里的样音文件名拼，见 aiVoiceSampleUrl）。
    const id = key.slice(key.indexOf(':') + 1);
    const audio = new Audio(aiVoiceSampleUrl(id));
    audio.preload = 'auto';
    audioRef.current = audio;
    audio.onended = () => setPlayingId((value) => (value === key ? null : value));
    audio.onerror = () => {
      setPlayingId((value) => (value === key ? null : value));
      setSampleError('这条声线的样音拉取失败，检查网络后重试。');
    };
    setPlayingId(key);
    void audio.play().catch(() => {
      setPlayingId(null);
      setSampleError('浏览器拦下了自动播放，再点一次试听。');
    });
  }

  return (
    <div
      className={cn('ai-voice-panel', allowAiVoice ? 'has-tabs' : 'is-direct')}
      ref={(node) => {
        if (panelRef) panelRef.current = node;
      }}
      role="dialog"
      aria-label="AI 声聊"
    >
      <header className={cn('ai-voice-head')}>
        <span className={cn('ai-voice-head-title')}>
          {allowAiVoice ? (
            <Sparkles size={14} strokeWidth={2.1} />
          ) : (
            <Type size={14} strokeWidth={2.1} />
          )}
          {allowAiVoice ? 'AI 声聊' : '文字转语音'}
        </span>
        <span className={cn('ai-voice-head-tag')}>
          {allowAiVoice ? '群聊 · 单独发送' : '单独发送'}
        </span>
        <button
          type="button"
          className={cn('ai-voice-close')}
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={15} strokeWidth={2.4} />
        </button>
      </header>

      {allowAiVoice ? (
        <div className={cn('ai-voice-panel-tabs')} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'ai'}
            className={cn(tab === 'ai' && 'active')}
            onClick={() => setTab('ai')}
          >
            <Sparkles size={13} strokeWidth={2.2} /> AI 声聊
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'tts'}
            className={cn(tab === 'tts' && 'active')}
            onClick={() => setTab('tts')}
          >
            <Type size={13} strokeWidth={2.2} /> 文字转语音
          </button>
        </div>
      ) : null}

      {tab === 'tts' ? (
        <div className={cn('ai-voice-body', 'ai-voice-tts-body')}>
          <TtsComposer
            providers={ttsProviders}
            canSend={canSend}
            sendHint={sendHint}
            onSendAudio={onSendAudioFile}
            onSynthesize={onSynthesizeSpeech}
          />
        </div>
      ) : (
        <>
          <div className={cn('ai-voice-body')}>
            <label className={cn('ai-voice-field')}>
              <span className={cn('ai-voice-label')}>
                要说的话
                <em className={cn('ai-voice-count')}>
                  <span className="weq-number weq-number-inherit">{text.length}</span>/200
                </em>
              </span>
              <textarea
                ref={textRef}
                className={cn('ai-voice-textarea')}
                rows={3}
                maxLength={200}
                value={text}
                placeholder="输入要合成语音的文字，例如：在吗？我马上到。"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    if (canSendAiVoice) onSend({ text: body, voiceId });
                  }
                }}
              />
            </label>

            <div className={cn('ai-voice-voices')}>
              <div className={cn('ai-voice-voices-head')}>
                <AudioLines size={13} strokeWidth={2} />
                声线
                {selected ? <span className={cn('ai-voice-selected')}>{selected.name}</span> : null}
              </div>
              <div className={cn('ai-voice-voices-list')} role="radiogroup" aria-label="声线">
                {groups.map((entry) => (
                  <div className={cn('ai-voice-group')} key={entry.group}>
                    <span className={cn('ai-voice-group-label')}>{entry.group}</span>
                    <div className={cn('ai-voice-group-items')}>
                      {entry.items.map(({ option, key }) => {
                        const active = option.id === voiceId;
                        const playing = playingId === key;
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
                              title={playing ? '停止试听' : `试听「${option.name}」`}
                              aria-label={playing ? '停止试听' : `试听「${option.name}」`}
                              onClick={() => toggleSample(key)}
                            >
                              {playing ? (
                                <Pause size={11} strokeWidth={2.6} />
                              ) : (
                                <Play size={11} strokeWidth={2.6} />
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {sampleError ? <span className={cn('ai-voice-error')}>{sampleError}</span> : null}
          </div>

          <footer className={cn('ai-voice-foot')}>
            <span className={cn('ai-voice-hint')}>
              {disabled ? (
                disabledHint
              ) : (
                <>
                  <Sparkles size={11} strokeWidth={2.2} />
                  合成后单独发送，不带输入框里的文字
                </>
              )}
            </span>
            <button
              type="button"
              className={cn('ai-voice-btn', 'primary')}
              title={disabled ? disabledHint : '合成并单独发送'}
              disabled={!canSendAiVoice}
              onClick={() => {
                if (!canSendAiVoice) return;
                onSend({ text: body, voiceId });
              }}
            >
              <SendHorizontal size={13} strokeWidth={2.2} />
              合成并发送
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
export type { AiVoiceOption, AiVoiceDraft } from './aiVoicePanel.shared';
