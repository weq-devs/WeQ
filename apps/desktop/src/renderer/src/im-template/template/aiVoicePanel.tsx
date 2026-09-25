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
import { AudioLines, Pause, Play, SendHorizontal, Sparkles, X } from 'lucide-react';
import type { RefObject } from 'react';
import { cn } from './classNames';
import { elementToToken } from './draftElements';

/** 样音前缀 —— 拼上样音文件名再加 `.wav` 就是试听地址。 */
export const AI_VOICE_SAMPLE_BASE = 'https://res.qpt.qq.com/qpilot/tts_sample/group/';

/**
 * 声线目录 —— 2026-09-26 从 QQ 客户端「AI 声聊」面板的目录响应
 * （OIDB `0x929d_0`）里取全，一共 4 组、22 条去重后 22 个声线。
 *
 * 每条目录项是 `{ voiceId, 中文名, 样音 URL }`：
 *   - `voiceId` 是**要发给服务端**的那个 id（`SendAiVoice.voiceId`）；
 *   - 中文名是面板上的显示名（`小新` / `酥心御姐` / `霸道总裁` …）；
 *   - 样音 URL 的文件名**大概率等于 voiceId，但不保证** —— 实测
 *     `lucy-voice-lizeyan`（霸道总裁）的样音文件是 `lucy-voice-lizeyan-2.wav`。
 *     所以试听地址一律用目录里给的 `sample`，不要拿 voiceId 硬拼。
 *
 * 样音是 QQ 的运营资源，**不入库**；需要试听时按 {@link aiVoiceSampleUrl} 现拼。
 */
export type AiVoiceOption = {
  /** 发给服务端的声线 id，如 `lucy-voice-suxinjiejie`。 */
  id: string;
  /** 面板上的中文名，如 `酥心御姐`。 */
  name: string;
  /** 样音文件名（**不含** `.wav`）；见 {@link aiVoiceSampleUrl}。 */
  sample: string;
};

/** `voiceId → 目录信息`。面板与试听地址都以它为准。 */
export const AI_VOICE_CATALOG: AiVoiceOption[] = [
  { id: 'lucy-voice-laibixiaoxin', name: '小新', sample: 'lucy-voice-laibixiaoxin' },
  { id: 'lucy-voice-houge', name: '猴哥', sample: 'lucy-voice-houge' },
  { id: 'lucy-voice-silang', name: '四郎', sample: 'lucy-voice-silang' },
  { id: 'lucy-voice-guangdong-f1', name: '东北老妹儿', sample: 'lucy-voice-guangdong-f1' },
  { id: 'lucy-voice-guangxi-m1', name: '广西大表哥', sample: 'lucy-voice-guangxi-m1' },
  { id: 'lucy-voice-daji', name: '妲己', sample: 'lucy-voice-daji' },
  // 注意：这条的样音文件名带 `-2`，与 voiceId 不同。
  { id: 'lucy-voice-lizeyan', name: '霸道总裁', sample: 'lucy-voice-lizeyan-2' },
  { id: 'lucy-voice-suxinjiejie', name: '酥心御姐', sample: 'lucy-voice-suxinjiejie' },
  { id: 'lucy-voice-m8', name: '说书先生', sample: 'lucy-voice-m8' },
  { id: 'lucy-voice-male1', name: '憨憨小弟', sample: 'lucy-voice-male1' },
  { id: 'lucy-voice-male3', name: '憨厚老哥', sample: 'lucy-voice-male3' },
  { id: 'lucy-voice-lvbu', name: '吕布', sample: 'lucy-voice-lvbu' },
  { id: 'lucy-voice-xueling', name: '元气少女', sample: 'lucy-voice-xueling' },
  { id: 'lucy-voice-f37', name: '文艺少女', sample: 'lucy-voice-f37' },
  { id: 'lucy-voice-male2', name: '磁性大叔', sample: 'lucy-voice-male2' },
  { id: 'lucy-voice-female1', name: '邻家小妹', sample: 'lucy-voice-female1' },
  { id: 'lucy-voice-m14', name: '低沉男声', sample: 'lucy-voice-m14' },
  { id: 'lucy-voice-f38', name: '傲娇少女', sample: 'lucy-voice-f38' },
  { id: 'lucy-voice-m101', name: '爹系男友', sample: 'lucy-voice-m101' },
  { id: 'lucy-voice-female2', name: '暖心姐姐', sample: 'lucy-voice-female2' },
  { id: 'lucy-voice-f36', name: '温柔妹妹', sample: 'lucy-voice-f36' },
  { id: 'lucy-voice-f34', name: '书香少女', sample: 'lucy-voice-f34' },
];

/**
 * 面板里的分组 —— 与 QQ 客户端一致（推荐 / 搞怪 / 古风 / 现代）。
 *
 * **同一条声线可以出现在多个组里**（小新、猴哥、东北老妹儿、广西大表哥同时在
 * 「推荐」和「搞怪」；妲己、四郎同时在「推荐」和「古风」），所以这不是互斥分类，
 * 只能按分组分别列出。
 */
export const AI_VOICE_GROUPS: Array<{ name: string; ids: string[] }> = [
  {
    name: '推荐',
    ids: [
      'lucy-voice-laibixiaoxin',
      'lucy-voice-houge',
      'lucy-voice-silang',
      'lucy-voice-guangdong-f1',
      'lucy-voice-guangxi-m1',
      'lucy-voice-daji',
      'lucy-voice-lizeyan',
      'lucy-voice-suxinjiejie',
    ],
  },
  {
    name: '搞怪',
    ids: [
      'lucy-voice-laibixiaoxin',
      'lucy-voice-houge',
      'lucy-voice-guangdong-f1',
      'lucy-voice-guangxi-m1',
      'lucy-voice-m8',
      'lucy-voice-male1',
      'lucy-voice-male3',
    ],
  },
  { name: '古风', ids: ['lucy-voice-daji', 'lucy-voice-silang', 'lucy-voice-lvbu'] },
  {
    name: '现代',
    ids: [
      'lucy-voice-lizeyan',
      'lucy-voice-suxinjiejie',
      'lucy-voice-xueling',
      'lucy-voice-f37',
      'lucy-voice-male2',
      'lucy-voice-female1',
      'lucy-voice-m14',
      'lucy-voice-f38',
      'lucy-voice-m101',
      'lucy-voice-female2',
      'lucy-voice-f36',
      'lucy-voice-f34',
    ],
  },
];

const CATALOG_BY_ID = new Map(AI_VOICE_CATALOG.map((option) => [option.id, option]));

/** 取一条声线的目录信息；id 不在目录里时返回 null（面板不该出现这种情况）。 */
export function aiVoiceOption(id: string): AiVoiceOption | null {
  return CATALOG_BY_ID.get(id) ?? null;
}

/**
 * 试听地址 —— 用目录里记的**样音文件名**拼，不要用 voiceId。
 * （`lucy-voice-lizeyan` 的样音是 `lucy-voice-lizeyan-2.wav`。）
 */
export function aiVoiceSampleUrl(id: string): string {
  const option = CATALOG_BY_ID.get(id);
  return `${AI_VOICE_SAMPLE_BASE}${option?.sample ?? id}.wav`;
}

/** 面板里的分组（常量表 → 带上目录信息的可渲染结构；查不到的 id 直接跳过）。 */
export function groupAiVoiceOptions(): Array<{
  group: string;
  items: Array<{ option: AiVoiceOption; key: string }>;
}> {
  return AI_VOICE_GROUPS.map((entry) => ({
    group: entry.name,
    items: entry.ids
      .map((id) => CATALOG_BY_ID.get(id))
      .filter((option): option is AiVoiceOption => Boolean(option))
      // 同一条声线出现在多个分组：key 带上分组名，React 列表里才不会重。
      .map((option) => ({ option, key: `${entry.name}:${option.id}` })),
  })).filter((entry) => entry.items.length > 0);
}

export type AiVoiceDraft = {
  text: string;
  voiceId: string;
};

/**
 * 草稿 → codec 元素（`kind: 'ptt'`）。
 *
 * 只填 AI 声聊真正要传达的那几项，字段名对齐收侧 codec（wire tag 见括号）：
 *   - `isAiVoice`（45915）只有 AI 声聊片段会出现，收侧靠它画「AI」徽标；
 *   - `pttVoiceId`（45905）是声线（面板选的 `lucy-voice-*`，真正下发时由协议层
 *     换成服务端签发的那串，面板只负责把「用哪条声线」带过去）；
 *   - `pttTranscript`（45923）就是合成原文。
 *
 * 波形（45925）不必给：AI 声聊片段的波形本来就是一条固定 30 字节的合成条，
 * 跟音频长度无关（见 docs/database/nt_msg/elements/ptt.md）。
 */
export function aiVoiceElement(draft: AiVoiceDraft): Record<string, unknown> {
  return {
    kind: 'ptt',
    isAiVoice: true,
    pttVoiceId: draft.voiceId,
    pttTranscript: draft.text,
    source: 'ai-voice',
  };
}

/** 草稿 → 元素 token（跟语音 / 链接卡片同一条通路，chatPane 的 extraTokens 直接吃）。 */
export function aiVoiceToken(draft: AiVoiceDraft): string {
  return elementToToken(aiVoiceElement(draft));
}

export function AiVoicePanel({
  panelRef,
  disabled,
  disabledHint,
  onSend,
  onClose,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  /** QQ 未在线 / 完全离线等：面板照常填，只是发不出去。 */
  disabled: boolean;
  disabledHint: string;
  onSend: (draft: AiVoiceDraft) => void;
  onClose: () => void;
}) {
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
  const canSend = body.length > 0 && !disabled;

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
      className={cn('ai-voice-panel')}
      ref={(node) => {
        if (panelRef) panelRef.current = node;
      }}
      role="dialog"
      aria-label="AI 声聊"
    >
      <header className={cn('ai-voice-head')}>
        <span className={cn('ai-voice-head-title')}>
          <Sparkles size={14} strokeWidth={2.1} />
          AI 声聊
        </span>
        <span className={cn('ai-voice-head-tag')}>仅群聊 · 单独发送</span>
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

      <div className={cn('ai-voice-body')}>
        <label className={cn('ai-voice-field')}>
          <span className={cn('ai-voice-label')}>
            要说的话
            <em className={cn('ai-voice-count')}>{text.length}/200</em>
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
                if (canSend) onSend({ text: body, voiceId });
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
          disabled={!canSend}
          onClick={() => {
            if (!canSend) return;
            onSend({ text: body, voiceId });
          }}
        >
          <SendHorizontal size={13} strokeWidth={2.2} />
          合成并发送
        </button>
      </footer>
    </div>
  );
}
