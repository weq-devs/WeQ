import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  ClientDocumentPreview,
  presentClientDocument,
} from '../src/renderer/src/components/ClientDocumentPreview';

vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
}));

it('报告回包产生可读预览及设备下载入口，关闭后移除', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(ClientDocumentPreview)));
    act(() => presentClientDocument({ openUrl: '/_download/report-fixture' }, '合成报告'));
    const frame = host.querySelector('iframe')!;
    expect(frame.src).toContain('/_download/report-fixture?preview=1');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(host.querySelector('a[download]')?.getAttribute('href')).toContain(
      '/_download/report-fixture',
    );
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.querySelector('iframe')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
