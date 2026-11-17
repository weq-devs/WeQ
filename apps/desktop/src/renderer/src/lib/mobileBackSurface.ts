import type { MobileBackEntry } from './mobileNavigation';
import { compareSurfaceLayers } from './surfaceOrder';

const SURFACES =
  '.weq-workspace-page-fallback, .weq-dialog-layer, .weq-overlay-layer, .weq-window-layer, .weq-forward-window, .weq-lightbox-layer, .weq-redbag-detail-layer, .weq-redbag-qr-layer';

/** 先按实际承载层返回；同一页面内再按分类、详情等业务优先级逐层退出。 */
export function compareMobileBackEntries(left: MobileBackEntry, right: MobileBackEntry): number {
  const leftTarget = left.target?.();
  const rightTarget = right.target?.();
  if (leftTarget?.isConnected && rightTarget?.isConnected) {
    const leftSurface = leftTarget.closest<HTMLElement>(SURFACES) ?? leftTarget.ownerDocument.body;
    const rightSurface =
      rightTarget.closest<HTMLElement>(SURFACES) ?? rightTarget.ownerDocument.body;
    if (leftSurface !== rightSurface) {
      const layer = compareSurfaceLayers(leftSurface, rightSurface);
      if (layer) return layer;
      // 同层独立页面按绘制顺序处理，不能由背后页面的子级优先级抢走返回。
      if (!leftSurface.contains(rightSurface) && !rightSurface.contains(leftSurface)) {
        const order = leftSurface.compareDocumentPosition(rightSurface);
        if (order & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (order & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      }
    }
  }
  return left.priority - right.priority;
}
