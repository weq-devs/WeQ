import type { SettingsTarget } from './navigation';

// 与 app-search.css 的淡出动画时长保持一致。
export const SETTINGS_SEARCH_HIGHLIGHT_MS = 2000;

export interface SettingsSearchTarget extends SettingsTarget {
  revision: number;
}

/** 只在当前设置正文内按界面标签定位，不匹配配置值，不触发按钮。 */
export function findSettingElement(
  root: HTMLElement,
  target: string | Pick<SettingsTarget, 'item' | 'settingId'>,
): HTMLElement | null {
  const { item, settingId } = typeof target === 'string' ? { item: target } : target;
  if (settingId) {
    for (const node of root.querySelectorAll<HTMLElement>('[data-setting-id]')) {
      if (node.dataset.settingId === settingId) return node;
    }
    for (const node of root.querySelectorAll<HTMLElement>('[data-setting-fallback]')) {
      if (node.dataset.settingFallback?.split(' ').includes(settingId))
        return node.closest<HTMLElement>('.weq-set-row') ?? node;
    }
  }
  if (!item) return null;
  const nodes = root.querySelectorAll<HTMLElement>(
    '[aria-label], .weq-set-row-label, .weq-set-card-title, strong, h3, h4, .weq-maintenance-entry span',
  );
  for (const node of nodes) {
    if (node.getAttribute('aria-label') !== item && node.textContent?.trim() !== item) continue;
    return (
      node.closest<HTMLElement>(
        '.weq-set-row, .weq-settings-appearance-card, .weq-maintenance-entry, .weq-set-card',
      ) ?? node
    );
  }
  return null;
}

/** 异步设置加载后仍可定位；切页或关闭时撤销观察与高亮。 */
export function revealSetting(
  root: HTMLElement,
  target: string | Pick<SettingsTarget, 'item' | 'settingId'>,
  { navigate = true, onLocated }: { navigate?: boolean; onLocated?: () => void } = {},
): () => void {
  let highlighted: HTMLElement | null = null;
  let focused: HTMLElement | null = null;
  let addedTabIndex = false;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  const locate = () => {
    const element = findSettingElement(root, target);
    if (!element) return;
    for (
      let parent = element.parentElement;
      navigate && parent && parent !== root;
      parent = parent.parentElement
    ) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    highlighted = element;
    element.setAttribute('data-search-highlight', 'true');
    highlightTimer = setTimeout(() => {
      element.removeAttribute('data-search-highlight');
      highlightTimer = undefined;
    }, SETTINGS_SEARCH_HIGHLIGHT_MS);
    const interactive = (node: HTMLElement): boolean =>
      node.matches('button, input, select, textarea, a[href], summary, [tabindex]');
    // 命中的通常是行/卡片容器，可操作控件在它内部；向容器内找，而不是向上找。
    const primaryControl =
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="switch"]:not([disabled]), button:not([disabled]), a[href], summary';
    const enabled = (node: HTMLElement | null): node is HTMLElement =>
      Boolean(node) && !node?.matches(':disabled');
    // 顺序：元素本身 → 行内控件 → 最近的控件祖先（标签在按钮里时定位到按钮）
    // → 自定义 tabindex 元素 → 容器。
    const control = interactive(element)
      ? enabled(element)
        ? element
        : null
      : enabled(element.querySelector<HTMLElement>(primaryControl))
        ? element.querySelector<HTMLElement>(primaryControl)
        : enabled(element.closest<HTMLElement>(primaryControl))
          ? element.closest<HTMLElement>(primaryControl)
          : (element.querySelector<HTMLElement>('[tabindex="0"]') ??
            element.closest<HTMLElement>('[tabindex="0"]'));
    focused = control ?? element.closest<HTMLElement>('.weq-set-row, .weq-set-card') ?? element;
    if (focused && !interactive(focused)) {
      focused.setAttribute('tabindex', '-1');
      addedTabIndex = true;
    }
    if (navigate) {
      element.scrollIntoView?.({ block: 'center', behavior: 'instant' });
      focused?.focus({ preventScroll: true });
    }
    onLocated?.();
    observer.disconnect();
  };
  const observer = new MutationObserver(locate);
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'data-setting-id'],
  });
  locate();
  return () => {
    observer.disconnect();
    clearTimeout(highlightTimer);
    if (!highlighted) return;
    highlighted.removeAttribute('data-search-highlight');
    if (addedTabIndex && focused?.getAttribute('tabindex') === '-1')
      focused.removeAttribute('tabindex');
  };
}
