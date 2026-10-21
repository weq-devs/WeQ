/**
 * 装扮字体 face 按 itemId 复用；排印令牌只写入当前报告根节点和浮层宿主。
 * 节点版本隔离晚到下载，关闭或重置一个报告不会改变其它报告。
 * 数字保留 --rp-serif-base，避免子集字体缺少数字时引起里程表抖动。
 */

import { dressFontUrl } from '../../lib/resourceUrl';

const revisions = new WeakMap<HTMLElement, number>();

/** itemId → 该款是否成功注册过 face。null 表示正在加载。 */
const faces = new Map<number, Promise<boolean>>();

/** 报告内引用某款装扮字体的 CSS family 名。 */
export function reportFontFamily(itemId: number): string {
  return `weq-report-dress-${itemId}`;
}

/**
 * 确保某款装扮字体的 face 已注册进 `document.fonts`，返回是否可用。
 *
 * 失败（ttf 坏了 / 被 Chromium 的 OTS 拒了 / 本地没缓存又没在线实例）时返回 false
 * 而不抛 —— 调用方退回默认字形，报告界面不出任何提示。结果按 itemId 记忆，
 * 同一款不会重复下载，失败的也不会反复重试。
 */
export function ensureReportFontFace(itemId: number): Promise<boolean> {
  if (itemId <= 0) return Promise.resolve(false);
  let pending = faces.get(itemId);
  if (!pending) {
    pending = new FontFace(reportFontFamily(itemId), `url("${dressFontUrl(itemId)}")`)
      .load()
      .then((face) => {
        document.fonts.add(face);
        return true;
      })
      .catch(() => false);
    faces.set(itemId, pending);
  }
  return pending;
}

/**
 * 把某款装扮字体设为报告主字体。`itemId` 传 0 / null 表示恢复默认排印。
 *
 * 字体加载不成功时静默恢复默认。返回是否真的换成了，调用方据此决定要不要把
 * 选择记下来（以及要不要显示「已换」的状态）。
 */
export async function applyReportFont(
  itemId: number | null,
  targets: readonly (HTMLElement | null)[],
): Promise<boolean> {
  const nodes = targets.filter((node): node is HTMLElement => Boolean(node));
  if (!itemId || itemId <= 0) {
    clearReportFont(nodes);
    return false;
  }
  const requests = nodes.map((node) => {
    const revision = (revisions.get(node) ?? 0) + 1;
    revisions.set(node, revision);
    return { node, revision };
  });
  const loaded = await ensureReportFontFace(itemId);
  const current = requests
    .filter(({ node, revision }) => node.isConnected && revisions.get(node) === revision)
    .map(({ node }) => node);
  if (!loaded) {
    clearReportFont(current);
    return false;
  }
  const family = reportFontFamily(itemId);
  for (const node of current) {
    node.style.setProperty(
      '--rp-serif',
      `"${family}", "Playfair Display", Georgia, "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, "Times New Roman", serif`,
      'important',
    );
    node.style.setProperty(
      '--rp-sans',
      `"${family}", var(--font-sans, ui-sans-serif, system-ui, sans-serif)`,
      'important',
    );
    node.dataset.reportFont = 'yes';
  }
  return current.length > 0;
}

/** 只清理指定报告，face 留在 document.fonts 中供其它报告复用。 */
export function clearReportFont(targets: readonly (HTMLElement | null)[]): void {
  for (const node of targets) {
    if (!node) continue;
    revisions.set(node, (revisions.get(node) ?? 0) + 1);
    node.style.removeProperty('--rp-serif');
    node.style.removeProperty('--rp-sans');
    delete node.dataset.reportFont;
  }
}
