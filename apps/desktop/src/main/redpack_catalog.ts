/**
 * 红包皮肤目录（离线内存索引）。
 *
 * 抓取脚本（`scripts/fetch_red_pack_skins.ts`）把红包皮肤元数据落在
 * `resources/redpack/skins.json`（入库）。首次访问时解析进模块级 Map 并缓存，
 * 之后查封面就是纯内存 —— 不碰网络也不经账号会话。
 *
 * 用于 `weq-media://redbag?id=<skinId>`：优先用这里记的封面 URL，比「按 id 硬拼
 * `redpackSkin/<id>/aio.png`」更准 —— 不少皮肤的封面并不在那个固定路径下
 * （如「生日祝福」的封面在 `img/202604/…`），硬拼会 404。
 */

import { readFileSync } from 'node:fs';
import { resolveResource } from './resource';

/**
 * 皮肤 id → 卡片封面 URL。
 *
 * 用 `preview`（wire f4.9）而不是别的图字段：它就是 QQ 卡片上那张封面
 * （280×420，与旧客户端 `aio.png` 同款同比例；对多数皮肤 `preview` 本身就等于
 * `redpackSkin/<id>/aio.png`）。
 */
let covers: Map<number, string> | null = null;

/** 懒加载 + 解析 skins.json，缓存 id→preview。找不到文件 / 解析失败返回空表。 */
function load(): Map<number, string> {
  if (covers) return covers;
  covers = new Map();
  const path = resolveResource('redpack', 'skins.json');
  if (!path) return covers;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      skins?: Array<{ id?: unknown; preview?: unknown }>;
    };
    for (const s of parsed.skins ?? []) {
      const id = Number(s?.id);
      const preview = typeof s?.preview === 'string' ? s.preview : '';
      if (Number.isInteger(id) && id > 0 && preview) covers.set(id, preview);
    }
  } catch {
    /* 文件缺失 / 损坏时退化成空表：调用方会继续走在线 / aio 回退 */
  }
  return covers;
}

/** 取某皮肤的离线封面 URL；没有记录时返回 null。 */
export function resourceSkinCover(skinId: string | number): string | null {
  const id = typeof skinId === 'number' ? skinId : Number(skinId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return load().get(id) ?? null;
}
