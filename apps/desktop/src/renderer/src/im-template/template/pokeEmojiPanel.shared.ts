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
 *   - 底部只有一枚发送按钮，按当前选中是「戳一戳」还是「随机表情」决定发什么。
 *
 * ⚠️ 元素用的是草稿 token 形状（`{ kind:'pokeEmoji', pokeId, combo }` /
 * `{ kind:'face', superSticker:{ resultId } }`），由 `composerSend` 翻成
 * `@weq/protocol` 的发送元素。
 */

import { clampPokeCombo } from '../../lib/pokeFace';
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
