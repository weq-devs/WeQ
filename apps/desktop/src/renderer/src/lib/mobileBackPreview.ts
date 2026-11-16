/** 设置分类已在 DOM 内；仅复制轻量目录，不挂载第二套设置或读取业务数据。 */
export function createMobileBackPreview(target: HTMLElement) {
  if (!target.matches('.weq-mobile-settings[data-mobile-category]')) return undefined;
  const parent = target.parentElement;
  const header = target.querySelector<HTMLElement>('.weq-mobile-settings-header');
  const nav = target.querySelector<HTMLElement>('.weq-settings-nav');
  if (!parent || !header || !nav) return undefined;
  const preview = target.cloneNode(false) as HTMLElement;
  preview.removeAttribute('data-mobile-category');
  preview.dataset.mobileBackPreview = 'true';
  preview.inert = true;
  preview.setAttribute('aria-hidden', 'true');
  preview.append(header.cloneNode(true), nav.cloneNode(true));
  for (const node of [preview, ...preview.querySelectorAll<HTMLElement>('*')])
    node.removeAttribute('id');
  const title = preview.querySelector('.weq-mobile-settings-header strong');
  if (title) title.textContent = nav.querySelector('h2')?.textContent ?? '';
  Object.assign(preview.style, {
    position: 'absolute',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '1',
    border: '0',
    borderRadius: '0',
    boxShadow: 'none',
    background: 'var(--weq-bg-surface)',
  });
  const position = parent.style.position;
  const layer = target.style.zIndex;
  const background = target.style.backgroundColor;
  const positioned = getComputedStyle(parent).position;
  if (!positioned || positioned === 'static') parent.style.position = 'relative';
  target.style.zIndex = '2';
  target.style.backgroundColor = 'var(--weq-bg-surface)';
  parent.append(preview);
  return () => {
    preview.remove();
    parent.style.position = position;
    target.style.zIndex = layer;
    target.style.backgroundColor = background;
  };
}
