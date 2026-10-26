import { usePrivacyStore } from '../state/privacy';

/** 两帧之间经过一次绘制；隐藏页的 rAF 可能暂停，必须可取消且有界等待。 */
function waitForCapturePaint(document: Document): Promise<void> {
  const view = document.defaultView;
  if (!view || view.closed || document.visibilityState === 'hidden')
    return Promise.reject(new Error('窗口已隐藏或关闭，已取消截图。'));
  return new Promise((resolve, reject) => {
    let frame: number | null = null;
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      view.clearTimeout(timer);
      document.removeEventListener('visibilitychange', hidden);
      view.removeEventListener('pagehide', cancelled);
      if (error) reject(error);
      else resolve();
    };
    const cancelled = () => finish(new Error('窗口已隐藏或关闭，已取消截图。'));
    const hidden = () => {
      if (document.visibilityState === 'hidden') cancelled();
    };
    const timer = view.setTimeout(() => finish(new Error('截图绘制未完成，请重试。')), 3000);
    document.addEventListener('visibilitychange', hidden);
    view.addEventListener('pagehide', cancelled, { once: true });
    frame = view.requestAnimationFrame(() => {
      frame = view.requestAnimationFrame(() => finish());
    });
  });
}

export async function captureMenuScreenshot<T>(
  capture: () => Promise<T>,
  closeMenu: () => void,
  document: Document = window.document,
): Promise<T> {
  if (!usePrivacyStore.getState().capturePrivacy) return capture();
  const release = usePrivacyStore.getState().beginTemporary();
  try {
    closeMenu();
    await waitForCapturePaint(document);
    if (document.visibilityState === 'hidden' || document.defaultView?.closed)
      throw new Error('窗口已隐藏或关闭，已取消截图。');
    return await capture();
  } finally {
    release();
  }
}
