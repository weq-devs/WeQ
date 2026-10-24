import {
  RESOURCE_DIAGNOSTIC_ID,
  RESOURCE_DIAGNOSTIC_REQUEST,
} from '../../../shared/renderer_diagnostics';
import { decorationImageCache } from './decodedImageCache';
import { fontFaces } from './fontFaces';

/** 与隔离 preload 只交换固定数值；不读取样式正文、URL、账号或聊天内容。 */
export function installResourceDiagnostics(): () => void {
  const meta = document.createElement('meta');
  meta.id = RESOURCE_DIAGNOSTIC_ID;
  document.head.appendChild(meta);
  const sample = () => {
    const styles = document.querySelectorAll<HTMLStyleElement>(
      '[data-weq-msg-decoration], #weq-dress-skin',
    );
    let rules = 0;
    for (const style of [...styles].slice(0, 512)) rules += style.sheet?.cssRules.length ?? 0;
    meta.content = JSON.stringify({
      ...decorationImageCache.stats(),
      managedFonts: fontFaces.count(),
      loadingFonts: fontFaces.loading(),
      documentFonts: document.fonts?.size,
      decorationStyles: styles.length,
      decorationRules: rules,
      omittedStyles: Math.max(0, styles.length - 512),
    });
  };
  document.addEventListener(RESOURCE_DIAGNOSTIC_REQUEST, sample);
  return () => {
    document.removeEventListener(RESOURCE_DIAGNOSTIC_REQUEST, sample);
    meta.remove();
  };
}
