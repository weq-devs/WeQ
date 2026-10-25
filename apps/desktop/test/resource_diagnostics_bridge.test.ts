import { expect, it } from 'vitest';
import { installResourceDiagnostics } from '../src/renderer/src/lib/resourceDiagnostics';
import {
  RESOURCE_DIAGNOSTIC_ID,
  RESOURCE_DIAGNOSTIC_REQUEST,
  normalizeResourceSample,
} from '../src/shared/renderer_diagnostics';

it('按需提供固定数值，不记录样式正文，停止后移除监听和节点', () => {
  const style = document.createElement('style');
  style.dataset.weqMsgDecoration = 'secret-id';
  style.textContent = '.secret { color: red; }';
  document.head.appendChild(style);
  const stop = installResourceDiagnostics();
  try {
    document.dispatchEvent(new Event(RESOURCE_DIAGNOSTIC_REQUEST));
    const raw = document.getElementById(RESOURCE_DIAGNOSTIC_ID)!.getAttribute('content')!;
    expect(raw.length).toBeLessThan(2048);
    expect(raw).not.toContain('secret');
    expect(normalizeResourceSample(JSON.parse(raw))).toMatchObject({
      decorationStyles: 1,
      decorationRules: 1,
      totalPendingImages: 0,
    });
  } finally {
    stop();
    style.remove();
  }
  document.dispatchEvent(new Event(RESOURCE_DIAGNOSTIC_REQUEST));
  expect(document.getElementById(RESOURCE_DIAGNOSTIC_ID)).toBeNull();
});
