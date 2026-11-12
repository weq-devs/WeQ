// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const script = readFileSync('src/renderer/public/startup-theme.js', 'utf8');
function render(values: Record<string, string>, systemDark: boolean) {
  const root = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: '', setProperty: vi.fn() },
  };
  runInNewContext(script, {
    document: { documentElement: root },
    localStorage: { getItem: (key: string) => values[key] ?? null },
    matchMedia: () => ({ matches: systemDark }),
  });
  return root;
}
it.each(['light', 'dark'])('最早首屏读取显式 %s 偏好，不跟相反的系统主题闪烁', (theme) => {
  const root = render(
    { 'weq.theme-preference': theme, 'weq.theme-accent': '#198754' },
    theme === 'light',
  );
  expect(root.dataset.theme).toBe(theme);
  expect(root.style.setProperty).toHaveBeenCalledWith('--weq-accent-custom', '#198754');
});
it('共享快照优先于旧本地值，显式空主题色不回灌旧值', () => {
  const root = render(
    {
      'weq.sync.v1:server': '"fixture"',
      'weq.sync.v1:fixture:shared': JSON.stringify({
        revision: 1,
        values: { preference: 'dark', accent: '' },
      }),
      'weq.theme-preference': 'light',
      'weq.theme-accent': '#198754',
    },
    false,
  );
  expect(root.dataset.theme).toBe('dark');
  expect(root.style.setProperty).not.toHaveBeenCalled();
});
it('没有偏好或缓存损坏都跟随系统，不中止启动', () => {
  expect(render({}, true).dataset.theme).toBe('dark');
  expect(render({ 'weq.sync.v1:server': '{broken' }, false).dataset.theme).toBe('light');
});
