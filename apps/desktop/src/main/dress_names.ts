/**
 * 年度报告「最喜欢的装扮」页的款名解析 —— 由主进程注入 service 的 ReportQueries。
 *
 * 报告手里只有 40801 解出来的 itemId，而商城**没有「按 itemId 查详情」的接口**，
 * 名字只能从这台机器上已经存下来的两处凑：
 *
 *  1. 账号的「已装」清单（DressConfigService 的 *Meta）—— 用户自己装过的那几款，
 *     装的那一刻从商城卡片记了名字和预览图，最准；
 *  2. 仓库里那份静态商城榜单 `resources/dress/ranking-*.json`（就是排行榜接口的
 *     原始响应）—— 覆盖不到冷门款，但热门款基本都在，且完全离线。
 *
 * 两处都没有的 itemId **不出现在结果里**，渲染层退回 `#itemId`。刻意不联网补名字：
 * 年度报告是「打开就看」的东西，为了几个款名卡在网络往返上（还可能要在线实例）
 * 不值得，更不该因此在报告界面弹出「需要登录 QQ 客户端」之类的提示。
 */

import { readFileSync } from 'node:fs';
import type { DressKind, DressNameResolver } from '@weq/service';
import { normalizeMallItems, type DressService } from '@weq/service';
import { resolveResource } from './resource';

/** 静态榜单解析结果按类目缓存 —— 三个 json 加起来约 200KB，读一次就够。 */
const staticNames = new Map<DressKind, Map<number, string>>();

/**
 * 仓库里那份排行榜原始响应里的 `itemId → name`。文件缺失 / 损坏时回空表 ——
 * 名字是锦上添花，不该让一个坏 json 影响整页。
 */
function staticNameMap(kind: DressKind): Map<number, string> {
  const cached = staticNames.get(kind);
  if (cached) return cached;

  const map = new Map<number, string>();
  const path = resolveResource('dress', `ranking-${kind}.json`);
  if (path) {
    try {
      for (const item of normalizeMallItems(JSON.parse(readFileSync(path, 'utf-8')))) {
        if (item.name) map.set(item.itemId, item.name);
      }
    } catch {
      // 静默：回退到「只有已装清单里的名字」。
    }
  }
  staticNames.set(kind, map);
  return map;
}

/**
 * 建一个款名解析器。已装清单优先（用户自己装的那款名字最可信），静态榜单兜底。
 *
 * 每次调用都重读一遍账号的装扮清单 —— 那是一次本地 JSON 读，而这个解析器一份报告
 * 只会被调三次（气泡 / 字体 / 挂件各一次），没有缓存的必要，反倒省掉了「用户中途
 * 装了新款、报告还显示旧名字」的失效问题。
 */
export function createDressNameResolver(dress: DressService): DressNameResolver {
  return (kind: DressKind, itemIds: number[]): Record<number, string> => {
    const manifest = dress.read();
    const installed = new Map<number, string>();
    const source =
      kind === 'bubble' ? manifest.bubbles : kind === 'font' ? manifest.fonts : manifest.widgets;
    for (const entry of source) {
      if (entry.name) installed.set(entry.itemId, entry.name);
    }

    const fallback = staticNameMap(kind);
    const out: Record<number, string> = {};
    for (const itemId of itemIds) {
      const name = installed.get(itemId) ?? fallback.get(itemId);
      if (name) out[itemId] = name;
    }
    return out;
  };
}
