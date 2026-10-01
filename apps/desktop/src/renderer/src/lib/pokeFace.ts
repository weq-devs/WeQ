/**
 * 戳一戳互动表情（`resources/pokeemoji/<id>.png`）的共享常量与尺寸规则。
 *
 * 收到的戳一戳在本地库里是 `subType=5` 的 FACE 元素：`faceId` 就是表情编号
 * （0..6），`interactiveFaceCombo`（tag 47617）是**连击次数**（0..3）—— 连击越高，
 * 聊天窗口里那枚表情越大。发送侧的协议元素见 `@weq/protocol` 的 pokeEmoji。
 */

/** 戳一戳表情的 FACE subType。 */
export const POKE_FACE_SUBTYPE = 5;

/** `resources/pokeemoji/` 里可用的最大编号（0..6）。 */
export const POKE_FACE_MAX_ID = 6;

/** 发送面板里可选的表情：0 与 1 是同一张图，去重后只留 0。 */
export const POKE_FACE_IDS = [0, 2, 3, 4, 5, 6] as const;

/** 连击次数的上限（QQ 一般最多三连击，即 combo 到 3）。 */
export const POKE_COMBO_MAX = 3;

/**
 * 收到别人戳时**不镜像**的表情：5 的动画方向反过来会显得别扭，其余正常镜像。
 * 自己发的永远不镜像（`isSender`）。
 */
const POKE_FACE_NO_MIRROR = new Set<number>([5]);

/** 这条表情该不该水平镜像（只有「收到 + 不在免镜像名单」才镜像）。 */
export function pokeFaceMirror(pokeId: number, isSender: boolean): boolean {
  return !isSender && !POKE_FACE_NO_MIRROR.has(pokeId);
}

/** 连击次数归一到 0..3（越界收敛、NaN/undefined → 0）。 */
export function clampPokeCombo(value: number | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.trunc(n), 0), POKE_COMBO_MAX);
}

/**
 * 连击 0..3 → 聊天窗口里的显示尺寸（px）。
 *
 * 2 连击 = 历史上那个固定的 135px（`QqMessageContent.STICKER_SIZE`），0 最小、
 * 3 最大。
 */
export const POKE_FACE_SIZES = [98, 116, 135, 160] as const;

/** 连击 → 显示尺寸。 */
export function pokeFaceSize(combo: number | undefined): number {
  // clampPokeCombo 保证落在 0..3，这里的 ?? 只是满足 noUncheckedIndexedAccess。
  return POKE_FACE_SIZES[clampPokeCombo(combo)] ?? POKE_FACE_SIZES[2];
}
