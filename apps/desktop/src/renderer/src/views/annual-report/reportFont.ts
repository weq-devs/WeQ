/**
 * 装扮字体 face 按 itemId 复用；排印令牌只写入当前报告根节点和浮层宿主。
 * 节点版本隔离晚到下载，关闭或重置一个报告不会改变其它报告。
 * 数字保留 --rp-serif-base，避免子集字体缺少数字时引起里程表抖动。
 */

import { dressFontUrl } from '../../lib/resourceUrl';
import { fontFaces, type FontLease } from '../../lib/fontFaces';

const revisions = new WeakMap<HTMLElement, number>();

/** 每个报告根节点只持有自己使用的字体。 */
const leases = new WeakMap<HTMLElement, FontLease>();

/** 报告内引用某款装扮字体的 CSS family 名。 */
export function reportFontFamily(itemId: number): string {
  return `weq-report-dress-${itemId}`;
}

/**
 * 确保某款装扮字体的 face 已注册进 `document.fonts`，返回是否可用。
 *
 * 同一款共享在途加载，调用方关闭或换款时归还；失败使用原来的默认字形。
 */
export function acquireReportFontFace(itemId: number): FontLease {
  return fontFaces.acquire(reportFontFamily(itemId), dressFontUrl(itemId));
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
    const font = acquireReportFontFace(itemId);
    leases.get(node)?.release();
    leases.set(node, font);
    return { node, revision, font };
  });
  const loaded = (await Promise.all(requests.map(({ font }) => font.ready))).every(Boolean);
  for (const { node, revision, font } of requests) {
    if (!node.isConnected || revisions.get(node) !== revision) {
      font.release();
      if (leases.get(node) === font) leases.delete(node);
    }
  }
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

/** 只清理指定报告，其它报告仍持有的同款 face 不受影响。 */
export function clearReportFont(targets: readonly (HTMLElement | null)[]): void {
  for (const node of targets) {
    if (!node) continue;
    leases.get(node)?.release();
    leases.delete(node);
    revisions.set(node, (revisions.get(node) ?? 0) + 1);
    node.style.removeProperty('--rp-serif');
    node.style.removeProperty('--rp-sans');
    delete node.dataset.reportFont;
  }
}
