/**
 * 克隆群聊的合成头像：把成员头像拼成九宫格。
 *
 * 会话列表、克隆工作区左栏、对话头部、导出会话列表统一走这里，避免各处各写一套
 * 拼格逻辑。布局按人数铺满，不留空格：
 *   1 人 → 单图；2 人 → 左右各半；3 人 → 左一占满整列 + 右侧上下两格；
 *   4 人 → 2×2；5 人以上 → 三列（最多 9 格）。
 * 5/7/8 人时末行按人数自然留白，与 QQ 群头像一致。
 */

import '../styles/group-mosaic-avatar.css';

/** 单个格子的列/行数。导出成纯函数方便单测覆盖 2/3/4 这些少人数情况。 */
export function mosaicLayout(count: number): { columns: number; rows: number } {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  if (count <= 4) return { columns: 2, rows: 2 };
  return { columns: 3, rows: Math.min(3, Math.ceil(count / 3)) };
}
