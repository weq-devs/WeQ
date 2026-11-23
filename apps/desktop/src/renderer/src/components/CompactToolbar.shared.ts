import '../styles/compact-toolbar.css';

/** Recheck with the full labels whenever the available width or visible actions change. */
export function observeCompactToolbar(toolbar: HTMLElement | null) {
  const view = toolbar?.ownerDocument.defaultView;
  if (!toolbar || !view) return;

  let frame = 0;
  const updateLayout = () => {
    frame = 0;
    if (!toolbar.clientWidth) return;
    toolbar.setAttribute('data-toolbar-measuring', '');
    toolbar.removeAttribute('data-toolbar-overflow');
    const compact =
      toolbar.querySelector('.weq-toolbar-label') !== null &&
      toolbar.scrollWidth > toolbar.clientWidth;
    toolbar.toggleAttribute('data-toolbar-compact', compact);
    toolbar.removeAttribute('data-toolbar-measuring');
    if (compact && toolbar.querySelector('[data-toolbar-overflow-trigger]')) {
      toolbar.toggleAttribute('data-toolbar-overflow', toolbar.scrollWidth > toolbar.clientWidth);
    }
  };
  const schedule = () => {
    if (!frame) frame = view.requestAnimationFrame(updateLayout);
  };

  const resize = view.ResizeObserver ? new view.ResizeObserver(schedule) : undefined;
  resize?.observe(toolbar);
  if (!resize) view.addEventListener('resize', schedule);
  const content = new view.MutationObserver(schedule);
  content.observe(toolbar, { childList: true, characterData: true, subtree: true });
  const fonts = toolbar.ownerDocument.fonts;
  fonts?.addEventListener('loadingdone', schedule);
  updateLayout();

  return () => {
    resize?.disconnect();
    if (!resize) view.removeEventListener('resize', schedule);
    content.disconnect();
    fonts?.removeEventListener('loadingdone', schedule);
    view.cancelAnimationFrame(frame);
    toolbar.removeAttribute('data-toolbar-compact');
    toolbar.removeAttribute('data-toolbar-overflow');
  };
}
