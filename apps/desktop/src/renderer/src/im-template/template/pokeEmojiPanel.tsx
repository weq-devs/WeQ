// @ts-nocheck
/**
 * 输入框工具栏「戳一戳」按钮弹出的面板（互动表情 / `resources/pokeemoji`）。
 *
 * **只做前端**：面板把「表情编号 + 连击次数」编成一枚 `pokeEmoji` 元素 token 交回
 * 上层（`onSend`），发不发得出去、怎么发由 chatPane 那一侧决定（和弹射表情 /
 * 链接卡片一个套路）。
 *
 * 三件事在这里落地：
 *   1. **表情**：`resources/pokeemoji/<id>.png` 的 0/2/3/4/5/6（0 与 1 是同一张图，
 *      去重后只留 0）；
 *   2. **连击**：只有 0..3 四档，所以用四枚**按钮**（不是输入框 / 滑块），每枚按
 *      档位逐渐变大 —— 点一下预览区立刻跟着变大，所见即所发；
 *   3. **预览**：左边就是这条消息在聊天窗口里的样子（连击越高越大）。
 *
 * ⚠️ 元素用的是草稿 token 形状（`{ kind:'pokeEmoji', pokeId, combo }`），由
 * `composerSend` 翻成 `@weq/protocol` 的 `SendPokeEmojiElement`。
 */

import { useState } from 'react';
import type { RefObject } from 'react';
import { Hand, SendHorizontal, Sparkles, X } from 'lucide-react';
import { resourceUrl } from '../../lib/resourceUrl';
import { clampPokeCombo, POKE_COMBO_MAX, POKE_FACE_IDS, pokeFaceSize } from '../../lib/pokeFace';
import { cn } from './classNames';
import { elementToToken } from './draftElements';

export type PokeEmojiDraft = {
  /** 表情编号（0..6）。 */
  pokeId: number;
  /** 连击次数（0..3）。 */
  combo: number;
};

/** 草稿 → 元素 token（chatPane 的 extraTokens 直接吃）。 */
export function pokeEmojiToken(draft: PokeEmojiDraft): string {
  return elementToToken({
    kind: 'pokeEmoji',
    pokeId: Number(draft.pokeId) || 0,
    combo: clampPokeCombo(draft.combo),
  });
}

/** 连击档位（0..3）——四枚按钮。 */
const COMBO_STEPS = Array.from({ length: POKE_COMBO_MAX + 1 }, (_, index) => index);

/** 连击按钮里那枚小图的目标高度：越大的档位图越大。 */
function comboThumbSize(step: number): number {
  return 18 + step * 6;
}

export function PokeEmojiPanel({
  panelRef,
  disabled,
  disabledHint,
  onSend,
  onClose,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  /** QQ 未在线 / 完全离线等：面板照常挑，只是发不出去。 */
  disabled: boolean;
  disabledHint: string;
  onSend: (draft: PokeEmojiDraft) => void;
  onClose: () => void;
}) {
  const [pokeId, setPokeId] = useState<number>(POKE_FACE_IDS[0]);
  const [combo, setCombo] = useState(0);

  const src = resourceUrl('pokeemoji', `${pokeId}.png`);
  const size = pokeFaceSize(combo);
  const canSend = !disabled;

  function submit() {
    if (disabled) return;
    onSend({ pokeId, combo });
  }

  return (
    <div
      className={cn('poke-panel')}
      ref={(node) => {
        if (panelRef) panelRef.current = node;
      }}
      role="dialog"
      aria-label="戳一戳"
    >
      <header className={cn('poke-head')}>
        <span className={cn('poke-head-title')}>
          <Hand size={14} strokeWidth={2.1} />
          戳一戳
        </span>
        <span className={cn('poke-head-tag')}>单独发送</span>
        <button
          type="button"
          className={cn('poke-close')}
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={15} strokeWidth={2.4} />
        </button>
      </header>

      <div className={cn('poke-body')}>
        <div className={cn('poke-stage')}>
          <div className={cn('poke-preview')}>
            {/* 预览按当前连击的真实尺寸画（98..160px），容器留到 176px，3 连击也装得下。 */}
            <img
              className={cn('poke-preview-face')}
              style={{ width: size, height: size }}
              src={src}
              alt=""
              draggable={false}
            />
          </div>

          <div className={cn('poke-controls')}>
            <span className={cn('poke-label')}>连击</span>
            <div className={cn('poke-combo')} role="radiogroup" aria-label="连击次数">
              {COMBO_STEPS.map((step) => {
                const active = step === combo;
                const thumb = comboThumbSize(step);
                return (
                  <button
                    key={step}
                    type="button"
                    className={cn('poke-combo-btn', active && 'is-active')}
                    role="radio"
                    aria-checked={active}
                    aria-label={`连击 ${step}`}
                    title={`连击 ${step}`}
                    onClick={() => setCombo(step)}
                  >
                    <img
                      src={src}
                      alt=""
                      style={{ width: thumb, height: thumb }}
                      draggable={false}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className={cn('poke-grid')} role="radiogroup" aria-label="选择表情">
          {POKE_FACE_IDS.map((id) => {
            const active = id === pokeId;
            return (
              <button
                key={id}
                type="button"
                className={cn('poke-cell', active && 'is-active')}
                role="radio"
                aria-checked={active}
                aria-label={`戳一戳表情 ${id}`}
                title="戳一戳"
                onClick={() => setPokeId(id)}
              >
                <img src={resourceUrl('pokeemoji', `${id}.png`)} alt="" draggable={false} />
              </button>
            );
          })}
        </div>
      </div>

      <footer className={cn('poke-foot')}>
        <span className={cn('poke-hint')}>
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
          className={cn('poke-btn', 'primary')}
          title={disabled ? disabledHint : '发送戳一戳'}
          disabled={!canSend}
          onClick={submit}
        >
          <SendHorizontal size={13} strokeWidth={2.2} />
          戳一下
        </button>
      </footer>
    </div>
  );
}
