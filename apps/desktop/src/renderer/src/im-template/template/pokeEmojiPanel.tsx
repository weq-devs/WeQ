// @ts-nocheck
/**
 * 输入框「表情 → 互动表情」面板（`resources/pokeemoji`）。
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
 *   - 预览旁共用一个发送按钮，按当前选中的表情决定发什么。
 *
 * ⚠️ 元素用的是草稿 token 形状（`{ kind:'pokeEmoji', pokeId, combo }` /
 * `{ kind:'face', superSticker:{ resultId } }`），由 `composerSend` 翻成
 * `@weqbot/protocol` 的发送元素。
 */

import { useState } from 'react';
import type { RefObject } from 'react';
import { SendHorizontal } from 'lucide-react';
import { FaceEmoji } from '../../components/FaceEmoji';
import { emojiUrl, resourceUrl } from '../../lib/resourceUrl';
import { POKE_COMBO_MAX, POKE_FACE_IDS, POKE_FACE_SUBTYPE } from '../../lib/pokeFace';
import { cn } from './classNames';
import type { PokeEmojiDraft, RandomFaceDraft } from './pokeEmojiPanel.shared';

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

/** 连击档位（0..3）——四枚按钮。 */
const COMBO_STEPS = Array.from({ length: POKE_COMBO_MAX + 1 }, (_, index) => index);

/** 连击按钮里那枚小图的目标高度：越大的档位图越大。 */
function comboThumbSize(step: number): number {
  return 11 + step * 3;
}

type Mode = 'poke' | 'random';

export function PokeEmojiPanel({
  panelRef,
  disabled,
  disabledHint,
  onSend,
  randomFaces = [],
  onSendRandom,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  /** QQ 未在线 / 完全离线等：面板照常挑，只是发不出去。 */
  disabled: boolean;
  disabledHint: string;
  onSend: (draft: PokeEmojiDraft) => void;
  /** 可指定结果的随机表情（来自本地资源）；缺省时不渲染这一段。 */
  randomFaces?: RandomFaceOption[];
  onSendRandom?: (draft: RandomFaceDraft) => void;
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
    : { faceId: pokeId, subType: POKE_FACE_SUBTYPE };

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
      aria-label="互动表情"
    >
      <div className={cn('poke-body')}>
        <div className={cn('poke-stage')}>
          <div className={cn('poke-preview')}>
            <FaceEmoji
              key={random ? selectedRandom.faceId : `poke-${pokeId}`}
              element={previewElement}
              size={`calc(var(--poke-preview-edge) - ${random ? 12 : 28 - combo * 5}px)`}
              className={cn('poke-preview-face')}
            />
          </div>

          <div className={cn('poke-controls')}>
            <div className="poke-choice-row">
              <span className={cn('poke-label')}>{random ? '随机结果' : '连击'}</span>
              {/* 同一排编号按钮：戳一戳 = 连击档（0..3，图随档变大）；随机表情 = 结果编号。 */}
              <div
                className={cn('poke-combo')}
                role="radiogroup"
                aria-label={random ? '随机结果' : '连击次数'}
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
            <button
              type="button"
              className={cn('poke-btn', 'primary')}
              title={disabled ? disabledHint : random ? '发送随机表情' : '发送戳一戳'}
              disabled={random ? !canSendRandom : !canSend}
              onClick={submit}
            >
              <SendHorizontal size={13} strokeWidth={2.2} />
              发送
            </button>
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
          {onSendRandom &&
            randomFaces.map((face) => {
              const active = random && face.faceId === randomFaceId;
              const label = face.desc.replace(/^\//, '') || `表情${face.faceId}`;
              return (
                <button
                  key={`random-${face.faceId}`}
                  type="button"
                  className={cn('poke-cell', active && 'is-active')}
                  role="radio"
                  aria-checked={active}
                  aria-label={label}
                  title={label}
                  onClick={() => selectRandomFace(face)}
                >
                  <img
                    src={emojiUrl(String(face.faceId), 'apng', `${face.faceId}.png`)}
                    alt=""
                    draggable={false}
                  />
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}
export type { PokeEmojiDraft, RandomFaceDraft } from './pokeEmojiPanel.shared';
