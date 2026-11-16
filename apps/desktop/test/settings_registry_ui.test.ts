import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Card, Row } from '../src/renderer/src/components/settings/controls';
import { settingDefinition } from '@weq/service/settings-catalog';

vi.mock('../src/renderer/src/trpc/client', () => ({ client: {}, trpc: {} }));
afterEach(() => vi.unstubAllGlobals());

it('设置行名称和卡片定位直接使用注册表，保留显式上下文名称', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(
          Card,
          { resetId: 'theme-mode' },
          h(Row, { settingId: 'theme-mode', control: h('button', null, '合成操作') }),
          h(Row, { settingId: 'theme-accent', label: '上下文专用名称', control: null }),
        ),
      ),
    );
    expect(host.querySelector('.weq-set-card')?.getAttribute('data-setting-id')).toBe('theme-mode');
    expect(host.querySelector('.weq-set-card-title')?.textContent).toBe(
      settingDefinition('theme-mode').label,
    );
    expect(host.querySelector('.weq-set-row-label')?.textContent).toBe(
      settingDefinition('theme-mode').label,
    );
    expect(
      host.querySelector('[data-setting-id="theme-accent"] .weq-set-row-label')?.textContent,
    ).toBe('上下文专用名称');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
