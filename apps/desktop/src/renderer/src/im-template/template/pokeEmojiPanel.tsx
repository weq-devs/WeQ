// @ts-nocheck
/**
 * 输入框工具栏「戳一戳」按钮弹出的面板（互动表情 / `resources/pokeemoji`）。
 *
 * **只做前端**：面板把「表情编号 + 连击次数」（戳一戳）或「faceId + 目录信息 +
 * 结果编号 innerId」（随机表情）编成一枚元素 token 交回上层（`onSend` /
 * `onSendRandom`），发不发得出去、怎么发由 chatPane 那一侧决定（和弹射表情 /
 * 链接卡片一个套路）。
 *
 * 设计要点 —— **「连击」与「结果」在前端是同一个东西**：
 *   - 一个预览台：戳一戳按连击显示 `resources/pokeemoji/<id>.png`，随机表情直接
 *     复用聊天里的 `FaceEmoji` 渲染 `<faceId>_<innerId>.json` 结果片段；
 *   - 一排编号按钮：戳一戳是 `0..3` 的连击档，随机表情是 `1..n` 的结果编号，
 *     共用同一套 `.poke-combo` / `.poke-combo-btn` 控件；
 *   - 底部只有一枚发送按钮，按当前选中是「戳一戳」还是「随机表情」决定发什么。
 *
 * ⚠️ 元素用的是草稿 token 形状（`{ kind:'pokeEmoji', pokeId, combo }` /
 * `{ kind:'face', superSticker:{ resultId } }`），由 `composerSend` 翻成
 * `@weq/protocol` 的发送元素。
 */

import { useState } from 'react';
import type { RefObject } from 'react';
import { Hand, SendHorizontal, Sparkles, X } from 'lucide-react';
import { FaceEmoji } from '../../components/FaceEmoji';
import { emojiUrl, resourceUrl } from '../../lib/resourceUrl';
import {
  clampPokeCombo,
  POKE_COMBO_MAX,
  POKE_FACE_IDS,
  POKE_FACE_SUBTYPE,
} from '../../lib/pokeFace';
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

/**
 * 一个「可指定结果」的随机/互动表情（骰子 / 包剪锤 / 篮球 / 活动表情）。
 * 列表来自后端 `sysEmoji.randomFaces`，而它的源头是**本地资源目录**里的
 * `<faceId>/lottie/<faceId>_<n>.json`，所以不会硬编码任何 faceId。
 */
export type RandomFaceOption = {
  faceId: number;
  /** 外显文字（如 `/骰子`）。 */
  desc: string;
  /** 发 svc37 所需的目录三件套（来自 emoji.db base_sys_emoji_table）。 */
  packId: string;
  stickerId: string;
  stickerType: number;
  /** 可选的结果编号（innerId），如 `['1'..'6']`。 */
  innerIds: string[];
};

/** 选中的「随机表情 + 结果」草稿。 */
export type RandomFaceDraft = {
  faceId: number;
  desc: string;
  packId: string;
  stickerId: string;
  stickerType: number;
  /** 结果编号（innerId）—— 写进 QFaceExtra.resultId。 */
  innerId: string;
};

/**
 * 草稿 → 元素 token（chatPane 的 extraTokens 直接吃）。
 *
 * 与 pokeEmoji 不同，这枚走的是**普通系统表情**的 svc37 通路：把选中的结果写进
 * `superSticker.resultId`，收端就会渲染 `lottie/<faceId>_<innerId>.json`。
 */
export function randomFaceToken(draft: RandomFaceDraft): string {
  return elementToToken({
    kind: 'face',
    faceId: Number(draft.faceId) || 0,
    faceText: draft.desc,
    superSticker: {
      packId: draft.packId,
      stickerId: draft.stickerId,
      ...(draft.stickerType ? { stickerType: draft.stickerType } : {}),
      text: draft.desc,
      resultId: draft.innerId,
    },
  });
}

/** 连击档位（0..3）——四枚按钮。 */
const COMBO_STEPS = Array.from({ length: POKE_COMBO_MAX + 1 }, (_, index) => index);

/** 连击按钮里那枚小图的目标高度：越大的档位图越大。 */
function comboThumbSize(step: number): number {
  return 18 + step * 6;
}

/** 随机表情预览的目标边长（沿用聊天气泡里的「大表情」尺寸量级）。 */
const RANDOM_PREVIEW_SIZE = 150;

type Mode = 'poke' | 'random';

export function PokeEmojiPanel({
  panelRef,
  disabled,
  disabledHint,
  onSend,
  randomFaces = [],
  onSendRandom,
  onClose,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  /** QQ 未在线 / 完全离线等：面板照常挑，只是发不出去。 */
  disabled: boolean;
  disabledHint: string;
  onSend: (draft: PokeEmojiDraft) => void;
  /** 可指定结果的随机表情（来自本地资源）；缺省时不渲染这一段。 */
  randomFaces?: RandomFaceOption[];
  onSendRandom?: (draft: RandomFaceDraft) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('poke');
  const [pokeId, setPokeId] = useState<number>(POKE_FACE_IDS[0]);
  const [combo, setCombo] = useState(0);
  const [randomFaceId, setRandomFaceId] = useState<number | null>(null);
  const [randomInner, setRandomInner] = useState<string>('');

  const pokeSrc = resourceUrl('pokeemoji', `${pokeId}.png`);
  const selectedRandom = randomFaces.find((f) => f.faceId === randomFaceId) ?? null;
  const random = mode === 'random' && selectedRandom !== null;

  // 预览台：连击走戳一戳图（尺寸随档位），随机表情直接复用 FaceEmoji 播结果片段。
  const previewElement = random
    ? { faceId: selectedRandom.faceId, innerId: randomInner, faceText: selectedRandom.desc }
    : { faceId: pokeId, subType: POKE_FACE_SUBTYPE, interactiveFaceCombo: combo };

  const canSend = !disabled && !random;
  const canSendRandom = !disabled && random && randomInner !== '';

  function selectPokeFace(id: number): void {
    setPokeId(id);
    setMode('poke');
  }

  function selectRandomFace(face: RandomFaceOption): void {
    setRandomFaceId(face.faceId);
    setRandomInner(face.innerIds[0] ?? '');
    setMode('random');
  }

  function submit(): void {
    if (disabled) return;
    if (random) {
      if (!selectedRandom || randomInner === '') return;
      onSendRandom?.({
        faceId: selectedRandom.faceId,
        desc: selectedRandom.desc,
        packId: selectedRandom.packId,
        stickerId: selectedRandom.stickerId,
        stickerType: selectedRandom.stickerType,
        innerId: randomInner,
      });
      return;
    }
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
        <span className={cn('poke-head-tag')}>{random ? '随机表情' : '单独发送'}</span>
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
            {/* 预览就是这条消息在聊天窗口里的样子（连击越高越大 / 随机表情播结果片段）。 */}
            <FaceEmoji
              element={previewElement}
              size={RANDOM_PREVIEW_SIZE}
              className={cn('poke-preview-face')}
            />
          </div>

          <div className={cn('poke-controls')}>
            <span className={cn('poke-label')}>{random ? '结果' : '连击'}</span>
            {/* 同一排编号按钮：戳一戳 = 连击档（0..3，图随档变大）；随机表情 = 结果编号。 */}
            <div
              className={cn('poke-combo', random && 'is-random')}
              role="radiogroup"
              aria-label={random ? '选择结果' : '连击次数'}
            >
              {random
                ? selectedRandom.innerIds.map((id) => {
                    const active = id === randomInner;
                    return (
                      <button
                        key={id}
                        type="button"
                        className={cn('poke-combo-btn', 'is-number', active && 'is-active')}
                        role="radio"
                        aria-checked={active}
                        aria-label={`结果 ${id}`}
                        title={`结果 ${id}`}
                        onClick={() => setRandomInner(id)}
                      >
                        {id}
                      </button>
                    );
                  })
                : COMBO_STEPS.map((step) => {
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
                          src={pokeSrc}
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
            const active = !random && id === pokeId;
            return (
              <button
                key={id}
                type="button"
                className={cn('poke-cell', active && 'is-active')}
                role="radio"
                aria-checked={active}
                aria-label={`戳一戳表情 ${id}`}
                title="戳一戳"
                onClick={() => selectPokeFace(id)}
              >
                <img src={resourceUrl('pokeemoji', `${id}.png`)} alt="" draggable={false} />
              </button>
            );
          })}
        </div>

        {/* 随机表情：本地资源里带结果片段的表情，选中即切换预览台与编号按钮。 */}
        {randomFaces.length > 0 && onSendRandom ? (
          <div className={cn('poke-random')}>
            <div className={cn('poke-random-head')}>
              <span className={cn('poke-label')}>随机表情</span>
              <span className={cn('poke-random-tip')}>挑一个结果单独发送</span>
            </div>
            <div className={cn('poke-random-grid')} role="radiogroup" aria-label="选择随机表情">
              {randomFaces.map((face) => {
                const active = random && face.faceId === randomFaceId;
                return (
                  <button
                    key={face.faceId}
                    type="button"
                    className={cn('poke-random-cell', active && 'is-active')}
                    role="radio"
                    aria-checked={active}
                    title={face.desc || `表情${face.faceId}`}
                    onClick={() => selectRandomFace(face)}
                  >
                    <img
                      src={emojiUrl(String(face.faceId), 'apng', `${face.faceId}.png`)}
                      alt=""
                      draggable={false}
                    />
                    <span className={cn('poke-random-name')}>
                      {(face.desc || String(face.faceId)).replace(/^\//, '')}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <footer className={cn('poke-foot')}>
        <span className={cn('poke-hint')}>
          {disabled ? (
            disabledHint
          ) : (
            <>
              <Sparkles size={11} strokeWidth={2.2} />
              {random ? `结果 ${randomInner}，单独发送` : '单独发送，不带输入框里的文字'}
            </>
          )}
        </span>
        <button
          type="button"
          className={cn('poke-btn', 'primary')}
          title={disabled ? disabledHint : random ? '发送随机表情' : '发送戳一戳'}
          disabled={random ? !canSendRandom : !canSend}
          onClick={submit}
        >
          <SendHorizontal size={13} strokeWidth={2.2} />
          {random ? '发送' : '戳一下'}
        </button>
      </footer>
    </div>
  );
}
