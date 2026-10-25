import type { SettingsTarget } from './navigation';

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
  let previousTabIndex: string | null = null;
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
    previousTabIndex = element.getAttribute('tabindex');
    element.setAttribute('data-search-highlight', 'true');
    element.setAttribute('tabindex', '-1');
    if (navigate) {
      element.scrollIntoView?.({ block: 'center', behavior: 'instant' });
      element.focus({ preventScroll: true });
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
    if (!highlighted) return;
    highlighted.removeAttribute('data-search-highlight');
    if (previousTabIndex === null) highlighted.removeAttribute('tabindex');
    else highlighted.setAttribute('tabindex', previousTabIndex);
  };
}
