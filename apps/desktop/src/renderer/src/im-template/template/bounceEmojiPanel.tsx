// @ts-nocheck
/**
 * 输入框工具栏「弹射表情」按钮弹出的面板（QQ 表情弹射 / FACEBUBBLE）。
 *
 * **只做前端** —— 本模块不碰任何协议，也不负责真正下发：面板把「系统表情 +
 * 弹射个数」编成一枚 `emojiBounce` 元素 token 交回上层（`onSend`），发不发得出去、
 * 怎么发由 chatPane 那一侧决定（和 linkCardPanel / aiVoicePanel 一个套路）。
 *
 * 三件事在这里落地：
 *   1. **只给系统表情**（`base_sys_emoji_table` 里非 unicode 的那部分）：弹射的是
 *      表情图本身，字符表情没有图可弹，所以 unicode 那些组整组不出现；
 *   2. **个数 1 – 2147483647**：真机实测 QQ 按 **int32** 读这个字段（见
 *      `@weq/protocol` 的 send-elements 注释：`2^31` 回绕成负数、`2^32` 变 0，
 *      0 与负数是**静默不弹**），所以面板把上界钉在 int32 上限，不让人白填一个
 *      发出去什么都不发生的数；
 *   3. **预览**：左边就是这条消息在聊天窗口里的样子 —— 表情 + 右下角 ×N 角标
 *      （跟 `QqEmojiBounce` 渲染器一致），右侧是数量控件。
 *
 * ⚠️ 元素用的是**收侧 codec 形状**（`emojiBounceId` / `emojiBounceTextSummary`…），
 * 与草稿里其它元素同一套字段；将来把发送接上时，协议层要把它翻成
 * `@weq/protocol` 的 `SendEmojiBounceElement`（`faceId` / `count` / `name`）。
 */

import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { Rocket, Search, SendHorizontal, Smile, Sparkles, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { cn } from './classNames';
import { elementToToken } from './draftElements';
import { systemFaceItem } from './emojiPacks';

/**
 * 弹射个数上限 —— QQ 把 `count` 当 **int32** 读，`2^31` 起回绕成负数（收端静默
 * 不弹），所以面板只允许到 int32 上限。
 */
export const BOUNCE_COUNT_MAX = 2147483647;

/** 面板里的快捷数量。最后一条直接顶到 int32 上限，省得手敲十个数字。 */
const COUNT_PRESETS: number[] = [1, 3, 10, 99, BOUNCE_COUNT_MAX];

export type BounceEmojiDraft = {
  /** 小黄脸 faceId（与系统表情目录同一套 id）。 */
  faceId: number;
  /** 表情名，**不带**方括号（如 `笑哭`）—— 真机样本的 `name` 就是这个形状。 */
  name: string;
  /** 弹射个数（1 – {@link BOUNCE_COUNT_MAX}）。 */
  count: number;
};

/** `[笑哭]` → `笑哭`：`name` 字段不带方括号。 */
function bareFaceName(desc: string, faceId: string): string {
  const trimmed = desc.trim();
  const inner = /^\[(.*)\]$/.exec(trimmed)?.[1];
  return (inner ?? trimmed) || faceId;
}

/**
 * 数字的紧凑写法 —— 角标只有十几个字符宽，`2,147,483,647` 放不下，
 * 用 `21.47亿` / `1.5万` 这种。
 */
export function formatBounceCount(count: number): string {
  if (!Number.isFinite(count)) return '—';
  if (count < 10000) return String(count);
  if (count >= 100000000) {
    const text = Math.round((count / 100000000) * 100) / 100;
    return `${text}亿`;
  }
  const text = Math.round((count / 10000) * 100) / 100;
  return `${text}万`;
}

/**
 * 草稿 → codec 元素（`kind: 'emojiBounce'`）。
 *
 * 字段与 `docs/database/nt_msg/elements/emoji-bounce.md` 一一对应：
 *   - 52132 `emojiBounceId` / 52134 `emojiBounceName`；
 *   - 52138 `emojiBounceTextSummary` 是**带个数的文本总结**（真机样本
 *     「你弹射了3个[大笑]」），`QqEmojiBounce` 就是从它里面读 ×N 角标的；
 *   - 52139 `emojiBouncePcText` 给桌面端兜底显示；
 *   - 52137 `emojiBounceDetail` 冗余一份名字与总结。
 */
export function bounceEmojiElement(draft: BounceEmojiDraft): Record<string, unknown> {
  const count = Math.min(Math.max(Math.trunc(draft.count) || 1, 1), BOUNCE_COUNT_MAX);
  const name = draft.name.trim();
  const summary = `你弹射了${count}个[${name}]`;
  return {
    kind: 'emojiBounce',
    emojiBounceId: draft.faceId,
    emojiBounceFlag52133: false,
    emojiBounceName: name,
    emojiBounceDetail: { flag52142: 0, name, textSummary: summary },
    emojiBounceTextSummary: summary,
    emojiBouncePcText: summary,
  };
}

/** 草稿 → 元素 token（chatPane 的 extraTokens 直接吃）。 */
export function bounceEmojiToken(draft: BounceEmojiDraft): string {
  return elementToToken(bounceEmojiElement(draft));
}

/** 输入框里的原始文本 → 合法个数；非法时给出给人看的错误文案。 */
function parseCount(text: string): { count: number | null; error: string | null } {
  const digits = text.trim();
  if (!digits) return { count: null, error: '请输入弹射个数' };
  if (!/^\d+$/.test(digits)) return { count: null, error: '个数只能是数字' };
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return { count: null, error: '这个数字太大了' };
  if (value < 1) return { count: null, error: '至少弹射 1 个' };
  if (value > BOUNCE_COUNT_MAX) {
    return { count: null, error: `最多 ${BOUNCE_COUNT_MAX.toLocaleString('en-US')}（int32 上限）` };
  }
  return { count: value, error: null };
}

export function BounceEmojiPanel({
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
  onSend: (draft: BounceEmojiDraft) => void;
  onClose: () => void;
}) {
  const overview = trpc.account.emojiPanel.overview.useQuery(undefined, { staleTime: 30_000 });
  const [pick, setPick] = useState<{ id: string; desc: string } | null>(null);
  const [countText, setCountText] = useState('1');
  const [touched, setTouched] = useState(false);
  const [query, setQuery] = useState('');

  /** 弹射只对系统表情有意义（字符表情没有图可弹），unicode 那些组整组排除。 */
  const groups = useMemo(
    () =>
      (overview.data?.faces ?? [])
        .map((group) => ({
          key: group.key,
          label: group.label,
          items: group.items.filter((item) => !item.unicode),
        }))
        .filter((group) => group.items.length > 0),
    [overview.data],
  );

  const keyword = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!keyword) return groups;
    return groups
      .map((group) => ({
        ...group,
        // 表情名（`[笑哭]`）与分组名（`小黄脸表情`）都参与匹配 —— 想按分类翻的时候
        // 不用一个个点。
        items: group.items.filter(
          (item) =>
            item.desc.toLowerCase().includes(keyword) ||
            group.label.toLowerCase().includes(keyword),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, keyword]);

  const firstItem = groups[0]?.items[0];

  // 首次拿到目录时先替用户选中第一枚，预览区不至于空着；用户点别的就按他选的。
  useEffect(() => {
    if (pick || !firstItem) return;
    setPick({ id: firstItem.id, desc: firstItem.desc });
  }, [pick, firstItem]);

  // 选中的那枚不在目录里了（换账号 / 目录重载）就别把它留在预览与发送里。
  useEffect(() => {
    if (!pick || groups.length === 0) return;
    const alive = groups.some((group) => group.items.some((item) => item.id === pick.id));
    if (!alive) setPick(null);
  }, [groups, pick]);

  const parsed = parseCount(countText);
  const name = pick ? bareFaceName(pick.desc, pick.id) : '';
  const canSend = Boolean(pick) && parsed.count !== null && !disabled;
  const summary =
    pick && parsed.count !== null ? `你弹射了${parsed.count}个[${name}]` : '选一枚表情、填个数量';
  const previewItem = pick ? systemFaceItem(pick.id, pick.desc) : null;

  /** 输入框只留数字，顺手卡在 10 位（int32 上限就是 10 位数）。 */
  function commit(next: string) {
    setCountText(next.replace(/\D+/g, '').slice(0, 10));
    setTouched(true);
  }

  function step(delta: number) {
    const base = parsed.count ?? 1;
    setCountText(String(Math.min(Math.max(base + delta, 1), BOUNCE_COUNT_MAX)));
    setTouched(true);
  }

  function submit() {
    setTouched(true);
    if (!pick || parsed.count === null || disabled) return;
    onSend({ faceId: Number(pick.id) || 0, name, count: parsed.count });
  }

  return (
    <div
      className={cn('bounce-panel')}
      ref={(node) => {
        if (panelRef) panelRef.current = node;
      }}
      role="dialog"
      aria-label="弹射表情"
    >
      <header className={cn('bounce-head')}>
        <span className={cn('bounce-head-title')}>
          <Rocket size={14} strokeWidth={2.1} />
          弹射表情
        </span>
        <span className={cn('bounce-head-tag')}>单独发送</span>
        <button
          type="button"
          className={cn('bounce-close')}
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={15} strokeWidth={2.4} />
        </button>
      </header>

      <div className={cn('bounce-body')}>
        <div className={cn('bounce-stage')}>
          <div className={cn('bounce-preview')} title={summary}>
            {previewItem?.src ? (
              <img
                className={cn('bounce-preview-face')}
                src={previewItem.src}
                alt={summary}
                draggable={false}
              />
            ) : (
              <span className={cn('bounce-preview-empty')}>
                <Smile size={26} strokeWidth={1.4} />
              </span>
            )}
            {/* 与聊天窗口里的渲染对齐：只弹 1 个时 QQ 不画角标（见 QqEmojiBounce）。 */}
            {pick && parsed.count !== null && parsed.count > 1 ? (
              <span className={cn('bounce-preview-count')}>×{formatBounceCount(parsed.count)}</span>
            ) : null}
          </div>

          <div className={cn('bounce-controls')}>
            <span className={cn('bounce-label')}>
              弹射个数
              <em className={cn('bounce-range')}>1 – {BOUNCE_COUNT_MAX.toLocaleString('en-US')}</em>
            </span>
            <div className={cn('bounce-count-row')}>
              <button
                type="button"
                className={cn('bounce-step')}
                title="减一个"
                aria-label="减一个"
                disabled={(parsed.count ?? 1) <= 1}
                onClick={() => step(-1)}
              >
                −
              </button>
              <input
                className={cn('bounce-input', touched && parsed.error && 'is-invalid')}
                value={countText}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                aria-label="弹射个数"
                onChange={(event) => commit(event.target.value)}
                onBlur={() => setTouched(true)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              <button
                type="button"
                className={cn('bounce-step')}
                title="加一个"
                aria-label="加一个"
                disabled={(parsed.count ?? 0) >= BOUNCE_COUNT_MAX}
                onClick={() => step(1)}
              >
                +
              </button>
            </div>
            <div className={cn('bounce-presets')}>
              {COUNT_PRESETS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cn('bounce-preset', parsed.count === value && 'is-active')}
                  title={
                    value === BOUNCE_COUNT_MAX
                      ? `int32 上限 ${BOUNCE_COUNT_MAX.toLocaleString('en-US')}`
                      : `弹射 ${value} 个`
                  }
                  onClick={() => {
                    setCountText(String(value));
                    setTouched(true);
                  }}
                >
                  {value === BOUNCE_COUNT_MAX ? '最大' : value}
                </button>
              ))}
            </div>
            {touched && parsed.error ? (
              <span className={cn('bounce-error')}>{parsed.error}</span>
            ) : (
              <span className={cn('bounce-summary')} title={summary}>
                {summary}
              </span>
            )}
          </div>
        </div>

        <div className={cn('bounce-search')}>
          <Search size={13} strokeWidth={2} />
          <input
            value={query}
            placeholder="搜索表情名，如 笑哭"
            aria-label="搜索系统表情"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className={cn('bounce-search-clear')}
              title="清空搜索"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
            >
              <X size={12} strokeWidth={2.6} />
            </button>
          ) : null}
        </div>

        <div className={cn('bounce-picker')}>
          {overview.isLoading && groups.length === 0 ? (
            <div className={cn('bounce-state')}>加载中…</div>
          ) : groups.length === 0 ? (
            <div className={cn('bounce-state')}>这个账号还没有可用的系统表情</div>
          ) : filtered.length === 0 ? (
            <div className={cn('bounce-state')}>没有匹配「{query.trim()}」的表情</div>
          ) : (
            filtered.map((group) => (
              <section className={cn('bounce-group')} key={group.key}>
                <h4>{group.label}</h4>
                <div className={cn('bounce-grid')}>
                  {group.items.map((item) => {
                    const face = systemFaceItem(item.id, item.desc);
                    const active = pick?.id === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={cn('bounce-cell', active && 'is-active')}
                        title={`${item.desc}（弹射）`}
                        aria-pressed={active}
                        onClick={() => setPick({ id: item.id, desc: item.desc })}
                      >
                        {face.src ? (
                          <img src={face.src} alt={item.desc} draggable={false} />
                        ) : (
                          <Smile size={20} strokeWidth={1.4} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </div>
      </div>

      <footer className={cn('bounce-foot')}>
        <span className={cn('bounce-hint')}>
          {disabled ? (
            disabledHint
          ) : (
            <>
              <Sparkles size={11} strokeWidth={2.2} />
              单独发送，不带输入框里的文字
            </>
          )}
        </span>
        <button
          type="button"
          className={cn('bounce-btn', 'primary')}
          title={disabled ? disabledHint : '发送弹射表情'}
          disabled={!canSend}
          onClick={submit}
        >
          <SendHorizontal size={13} strokeWidth={2.2} />
          发射
        </button>
      </footer>
    </div>
  );
}
