import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { GlobalInstallInfo } from '@weq/service';
import { StatsPanel } from '../src/renderer/src/views/bootstrap/StatsPanel';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      dbFileSizes: {
        useQuery: () => ({
          data: [
            { name: 'nt_msg.db', bytes: 2048 },
            { name: 'profile_info.db', bytes: 1024 },
          ],
          isLoading: false,
        }),
      },
    },
  },
  client: { bootstrap: { accountDirSizeProgress: { subscribe: () => ({ unsubscribe() {} }) } } },
}));

it('数据库条形和图例共用主题取色，不改变名称、大小或比例', () => {
  const install: GlobalInstallInfo = {
    qqExePath: null,
    wrapperNodePath: null,
    loginDbPath: null,
    tencentFilesRoot: null,
    version: '测试版本',
    userDataPath: null,
    hasQqExe: false,
    hasWrapper: false,
    hasUserData: false,
    hasLoginDb: false,
  };
  const host = document.createElement('div');
  // happy-dom 尚不解析 color-mix；校验实际输出的声明，颜色渲染另由浏览器验收。
  host.innerHTML = renderToStaticMarkup(
    h(StatsPanel, {
      install,
      selectedUin: '10001',
      counts: { userData: 2, online: 1 },
      onPickRoot: vi.fn(),
    }),
  );
  const bars = [...host.querySelectorAll<HTMLElement>('.weq-langbar-seg')];
  const dots = [...host.querySelectorAll<HTMLElement>('.weq-legend-dot')];
  expect(bars).toHaveLength(2);
  expect(dots).toHaveLength(2);
  for (const [index, bar] of bars.entries()) {
    const style = bar.getAttribute('style');
    expect(style).toContain('var(--weq-accent-effective)');
    expect(style).toContain(dots[index].getAttribute('style'));
  }
  expect(Number.parseFloat(bars[0].style.width)).toBeCloseTo((100 * 2) / 3);
  expect(Number.parseFloat(bars[1].style.width)).toBeCloseTo(100 / 3);
  expect(host.textContent).toContain('nt_msg.db');
  expect(host.textContent).toContain('profile_info.db');
  expect(host.textContent).toContain('2.0 KB');
  expect(host.textContent).toContain('1.0 KB');
});
