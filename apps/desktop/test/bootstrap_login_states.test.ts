import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SelectScreen } from '../src/renderer/src/views/bootstrap/SelectScreen';
import { useViewState } from '../src/renderer/src/state/view';
import type { GlobalInstallInfo } from '@weq/service';

const api = vi.hoisted(() => ({ mode: 'empty', retry: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => {}, {
      get(_target, key) {
        if (key === 'useUtils') return () => proxy('utils');
        if (key === 'useQuery')
          return () => ({
            data: path.endsWith('listAccountConfigs')
              ? api.mode === 'stale'
                ? [
                    {
                      configId: 'synthetic',
                      uin: '10001',
                      displayName: '合成缓存账号',
                      dbKey: '0123456789abcdef',
                    },
                  ]
                : []
              : path.endsWith('listAccounts') || path.endsWith('dbFileSizes')
                ? []
                : null,
            isLoading: path.endsWith('listAccounts') && api.mode === 'loading',
            isFetching: false,
            error:
              ['error', 'stale'].includes(api.mode) &&
              (path.endsWith('listAccounts') || path.endsWith('listAccountConfigs'))
                ? Error('合成账号读取失败')
                : null,
            refetch: api.retry,
          });
        if (key === 'subscribe') return () => ({ unsubscribe() {} });
        return proxy(`${path}.${String(key)}`);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
const install: GlobalInstallInfo = {
  qqExePath: null,
  wrapperNodePath: null,
  loginDbPath: null,
  tencentFilesRoot: null,
  version: '合成版本',
  userDataPath: null,
  hasQqExe: false,
  hasWrapper: false,
  hasUserData: false,
  hasLoginDb: false,
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.mode = 'empty';
  api.retry.mockClear();
  useViewState.getState().enterSelect('new');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function render() {
  act(() => root.render(createElement(SelectScreen, { install })));
}
it('未发现在线账号时仍能切到已有的本地备份入口，不显示无效的密钥操作', () => {
  render();
  expect(host.querySelector('.weq-keyfield-action')).toBeNull();
  const backup = host.querySelector<HTMLButtonElement>('[role="tab"]:last-child');
  expect(backup).not.toBeNull();
  act(() => backup!.click());
  expect(host.querySelector('.weq-static-backup')).not.toBeNull();
  expect(host.textContent).toContain('导入本地数据库');
});
it.each(['new', 'existing'] as const)('%s 读取失败不冒充空配置，并能重试', (mode) => {
  api.mode = 'error';
  useViewState.getState().enterSelect(mode);
  render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成账号读取失败');
  expect(host.textContent).not.toContain('暂无保存的账号配置');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="重新读取账号"]')!.click());
  expect(api.retry).toHaveBeenCalledOnce();
});
it('已有配置确实为空时保留空提示，没有错误提示', () => {
  useViewState.getState().enterSelect('existing');
  render();
  expect(host.textContent).toContain('暂无保存的账号配置');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it('账号查询进行中仍显示加载态，不冒充空或失败', () => {
  api.mode = 'loading';
  render();
  expect(host.textContent).toContain('正在准备账号');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('重新读取失败时仍保留已有账号，不隐藏密钥入口', () => {
  api.mode = 'stale';
  useViewState.getState().enterSelect('existing');
  render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成账号读取失败');
  expect(host.querySelector('.weq-acct-name')?.textContent).toBe('合成缓存账号');
  expect(host.querySelector<HTMLInputElement>('.weq-keyfield-text')?.value).toBe(
    '0123456789abcdef',
  );
});
