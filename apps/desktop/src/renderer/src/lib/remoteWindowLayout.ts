export type WindowCorner = { width: number; height: number };
export type RemoteWindowLayout = {
  width: number;
  height: number;
  topLeft: WindowCorner;
  topRight: WindowCorner;
};
type Rect = { left: number; top: number; right: number; bottom: number };

declare global {
  interface Window {
    weqRemoteWindowLayout?: RemoteWindowLayout;
  }
}

/** 原生点坐标转换成布局视口 CSS 像素；普通安全区由各标题栏自己处理。 */
export function windowCornerRects(value: unknown, viewportWidth: number): Rect[] {
  if (!value || typeof value !== 'object') return [];
  const layout = value as Partial<RemoteWindowLayout>;
  if (
    !Number.isFinite(layout.width) ||
    !Number.isFinite(layout.height) ||
    !layout.width ||
    !layout.height ||
    layout.width < 0 ||
    layout.height < 0 ||
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0
  )
    return [];
  const scale = viewportWidth / layout.width;
  const rects: Rect[] = [];
  for (const [side, corner] of [
    ['left', layout.topLeft],
    ['right', layout.topRight],
  ] as const) {
    if (
      !corner ||
      !Number.isFinite(corner.width) ||
      !Number.isFinite(corner.height) ||
      corner.width <= 0 ||
      corner.height <= 0
    )
      continue;
    const width = Math.min(corner.width, layout.width) * scale;
    rects.push({
      left: side === 'left' ? 0 : viewportWidth - width,
      right: side === 'left' ? width : viewportWidth,
      top: 0,
      bottom: Math.min(corner.height, layout.height) * scale,
    });
  }
  return rects;
}

export function resolveWindowChrome(
  header: Rect,
  corners: Rect[],
  safeTop = 0,
  minimumContentWidth = 240,
) {
  const overlapping = corners.filter(
    (corner) =>
      corner.left < header.right &&
      corner.right > header.left &&
      corner.top < header.bottom &&
      corner.bottom > header.top + safeTop,
  );
  let left = 0;
  let right = 0;
  for (const corner of overlapping) {
    if (corner.left <= header.left) left = Math.max(left, corner.right - header.left + 8);
    else right = Math.max(right, header.right - corner.left + 8);
  }
  const top =
    overlapping.length && header.right - header.left - left - right < minimumContentWidth
      ? Math.max(...overlapping.map((corner) => corner.bottom - header.top))
      : 0;
  return { left: top ? 0 : left, right: top ? 0 : right, top };
}

// 只观察共用操作区，正文、消息列表和普通居中弹窗不参与几何计算。
const chromeSelector = [
  '.weq-web-shell > .app-title-bar',
  '.weq-web-shell .weq-mobile-header',
  '.weq-web-shell .chat-header',
  '.weq-web-shell .sidebar-header',
  '.weq-web-shell .app-shell > .app-rail',
  '.weq-web-shell .weq-mobile-settings-header',
  '.weq-web-shell .weq-profile-page-toolbar',
  '.weq-preview-header',
].join(',');

export function observeRemoteWindowLayout(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  let frame = 0;
  let stopped = false;
  const targets = new Set<HTMLElement>();
  const write = (node: HTMLElement, property: string, value: number) => {
    const next = `${Math.ceil(value)}px`;
    if (node.style.getPropertyValue(property) !== next) node.style.setProperty(property, next);
  };
  const clear = (node: HTMLElement) => {
    delete node.dataset.weqWindowChrome;
    for (const side of ['left', 'right', 'top'])
      node.style.removeProperty(`--weq-window-chrome-${side}`);
  };
  const update = () => {
    frame = 0;
    if (stopped) return;
    const viewport = win.visualViewport;
    const corners = windowCornerRects(
      win.weqRemoteWindowLayout,
      viewport?.width || doc.documentElement.clientWidth,
    ).map((rect) => ({
      left: rect.left + (viewport?.offsetLeft || 0),
      right: rect.right + (viewport?.offsetLeft || 0),
      top: rect.top + (viewport?.offsetTop || 0),
      bottom: rect.bottom + (viewport?.offsetTop || 0),
    }));
    if (!corners.length) {
      mutation.disconnect();
      resize?.disconnect();
      for (const node of targets) clear(node);
      targets.clear();
      doc.documentElement.style.removeProperty('--weq-window-header-top');
      return;
    }
    mutation.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'data-mobile-detail', 'data-mobile-workspace'],
    });
    const current = new Set(doc.querySelectorAll<HTMLElement>(chromeSelector));
    for (const node of targets) {
      if (current.has(node)) continue;
      resize?.unobserve(node);
      clear(node);
      targets.delete(node);
    }
    let mobileTop = 0;
    // 批量读取后再写入，避免每个标题栏分别触发同步布局。
    const changes = [...current].map((node) => {
      if (!targets.has(node)) {
        targets.add(node);
        resize?.observe(node);
      }
      const rect = node.getBoundingClientRect();
      const safeTop =
        Number.parseFloat(win.getComputedStyle(node).getPropertyValue('--weq-window-safe-top')) ||
        0;
      const inset =
        rect.width && rect.height
          ? resolveWindowChrome(rect, corners, safeTop)
          : { left: 0, right: 0, top: 0 };
      if (node.matches('.weq-mobile-header, .chat-header, .weq-mobile-settings-header'))
        mobileTop = Math.max(mobileTop, inset.top);
      return { node, inset };
    });
    write(doc.documentElement, '--weq-window-header-top', mobileTop);
    for (const { node, inset } of changes) {
      if (!inset.left && !inset.right && !inset.top) {
        if (node.hasAttribute('data-weq-window-chrome')) clear(node);
        continue;
      }
      node.dataset.weqWindowChrome = '';
      for (const side of ['left', 'right', 'top'] as const)
        write(node, `--weq-window-chrome-${side}`, inset[side]);
    }
  };
  const schedule = () => {
    if (!frame && !stopped) frame = win.requestAnimationFrame(update);
  };
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
  const mutation = new MutationObserver((records) => {
    const relevant = records.some((record) => {
      if (record.type === 'attributes')
        return (
          record.target instanceof Element &&
          (record.target.matches(
            `${chromeSelector}, .app-shell-root, .weq-dialog-layer, .weq-workspace-page`,
          ) ||
            [...targets].some(
              (node) => record.target instanceof Element && record.target.contains(node),
            ))
        );
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches(chromeSelector) || node.querySelector(chromeSelector)),
      );
    });
    if (relevant) schedule();
  });
  win.addEventListener('weq-remote-window-layout', update);
  win.addEventListener('resize', schedule);
  win.visualViewport?.addEventListener('resize', schedule);
  win.visualViewport?.addEventListener('scroll', schedule);
  // useLayoutEffect 调用；先补读早到值，首个可见提交已经避让。
  update();
  return () => {
    stopped = true;
    win.cancelAnimationFrame(frame);
    resize?.disconnect();
    mutation.disconnect();
    win.removeEventListener('weq-remote-window-layout', update);
    win.removeEventListener('resize', schedule);
    win.visualViewport?.removeEventListener('resize', schedule);
    win.visualViewport?.removeEventListener('scroll', schedule);
    for (const node of targets) clear(node);
    doc.documentElement.style.removeProperty('--weq-window-header-top');
  };
}
