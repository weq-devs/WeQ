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

// ─────────────────────── 「个性装扮 → 红包封面」展示用 ───────────────────────

/** 展柜里的一只红包封面 —— 只保留渲染需要的字段，全部来自本地 skins.json。 */
export interface RedPackSkinEntry {
  id: number;
  name: string;
  /** 卡片封面（`preview`，280×420）。缺省时前端回退到弹层图 / aio 硬拼。 */
  preview: string;
  /** 点击后的大图（`popup`）。 */
  popup: string;
  /** 装饰用背景图（`background`），可能为空。 */
  background: string;
  /** 原始竖版图（`image`），可能为空。 */
  image: string;
  /** 跳转文案 + 链接，均为空表示不可跳转。 */
  jumpText: string;
  jumpUrl: string;
  /** 皮肤状态位（0/1/2/8/9，语义未解，仅作展示用）。 */
  state: number;
}

interface RedPackCatalog {
  skins: RedPackSkinEntry[];
  /** 文件里的生成时间（unix 秒），展示「数据截至」。 */
  generatedAt: number;
}

let catalog: RedPackCatalog | null = null;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 懒加载整份 skins.json（含名称/弹层图），找不到文件时返回空目录。 */
function loadCatalog(): RedPackCatalog {
  if (catalog) return catalog;
  catalog = { skins: [], generatedAt: 0 };
  const path = resolveResource('redpack', 'skins.json');
  if (!path) return catalog;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      generatedAt?: unknown;
      skins?: unknown;
    };
    const list = Array.isArray(parsed.skins) ? parsed.skins : [];
    const skins: RedPackSkinEntry[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const skin = raw as Record<string, unknown>;
      const id = Number(skin.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const name = str(skin.name);
      const preview = str(skin.preview);
      if (!name && !preview) continue;
      skins.push({
        id,
        name: name || `红包 ${id}`,
        preview,
        popup: str(skin.popup),
        background: str(skin.background),
        image: str(skin.image),
        jumpText: str(skin.jumpText),
        jumpUrl: str(skin.jumpUrl),
        state: Number.isFinite(Number(skin.state)) ? Number(skin.state) : 0,
      });
    }
    skins.sort((a, b) => a.id - b.id);
    catalog = {
      skins,
      generatedAt: Number.isFinite(Number(parsed.generatedAt)) ? Number(parsed.generatedAt) : 0,
    };
  } catch {
    /* 文件缺失 / 损坏时返回空目录，前端显示空状态 */
  }
  return catalog;
}

/**
 * 红包封面展柜的离线目录（纯本地，不联网、不经账号会话）。
 *
 * `keyword` 对名称做去空格的子串匹配（本地目录里中文名很多带全角空格，用户不会打）。
 */
export function listRedPackSkins(keyword = ''): {
  skins: RedPackSkinEntry[];
  total: number;
  generatedAt: number;
} {
  const loaded = loadCatalog();
  const needle = keyword.replace(/\s+/g, '').toLowerCase();
  const skins = needle
    ? loaded.skins.filter((skin) => skin.name.replace(/\s+/g, '').toLowerCase().includes(needle))
    : loaded.skins;
  return { skins, total: loaded.skins.length, generatedAt: loaded.generatedAt };
}

/** 展柜支持的图字段名（与 `weq-media://redbag?v=` 的取值一致）。 */
export type RedPackSkinVariant = 'preview' | 'popup' | 'background' | 'image';

/**
 * 取某皮肤某个图字段在**本地目录**里记的 URL；没记 / 字段不认识返回 null。
 *
 * 供 `weq-media://redbag?id=…&v=…` 使用：只认 skins.json，不做在线回退。
 */
export function redPackSkinField(
  skinId: string | number,
  variant: RedPackSkinVariant,
): string | null {
  const id = typeof skinId === 'number' ? skinId : Number(skinId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const skin = loadCatalog().skins.find((entry) => entry.id === id);
  if (!skin) return null;
  return skin[variant] || null;
}
