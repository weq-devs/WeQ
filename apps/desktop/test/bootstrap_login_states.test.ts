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
        if (key === 'useMutation') return () => ({ mutate() {}, isLoading: false });
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
  const back = host.querySelector<HTMLButtonElement>('[aria-label="返回账号主页"]');
  act(() => back!.click());
  const backup = host.querySelector<HTMLButtonElement>('[data-mode="backup"]');
  expect(backup).not.toBeNull();
  act(() => backup!.click());
  expect(host.querySelector('.weq-static-backup')).not.toBeNull();
  expect(host.textContent).toContain('导入本地数据库');
});
it('最近账号和添加、导入入口直接可见，诊断默认不扫描账号目录', () => {
  api.mode = 'stale';
  useViewState.getState().enterSelect('existing');
  render();
  expect(host.querySelector('.weq-account-list')?.textContent).toContain('合成缓存账号');
  expect(host.querySelector('[data-mode="new"]')?.textContent).toContain('添加账号');
  expect(host.querySelector('[data-mode="backup"]')?.textContent).toContain('导入备份');
  expect(host.querySelector('.weq-stats')).toBeNull();
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  expect(document.querySelector('.weq-key-recovery')).toBeNull();
});
it('添加与导入是独立子页面，可返回主页且不丢失账号选择', () => {
  api.mode = 'stale';
  useViewState.getState().enterSelect('existing');
  render();
  act(() => host.querySelector<HTMLButtonElement>('[data-mode="new"]')!.click());
  expect(host.querySelector('h1')?.textContent).toBe('添加账号');
  expect(host.querySelector('.weq-account-head [aria-label="返回账号主页"]')).toBeNull();
  expect(host.querySelector('.weq-account-actions')?.textContent).toContain('返回');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="返回账号主页"]')!.click());
  expect(host.querySelector('.weq-open-identity h2')?.textContent).toBe('合成缓存账号');
});
it.each(['new', 'backup'] as const)('%s 页仅在底部显示图标文字返回入口', (mode) => {
  useViewState.getState().enterSelect(mode);
  render();
  const back = host.querySelector<HTMLButtonElement>('[aria-label="返回账号主页"]')!;
  expect(back.closest('.weq-account-actions')).not.toBeNull();
  expect(back.textContent).toBe('返回');
  expect(back.querySelector('svg')).not.toBeNull();
  expect(back.classList.contains('weq-icon-button')).toBe(false);
  act(() => back.click());
  expect(host.querySelector('h1')?.textContent).toBe('打开账号');
});
it.each(['new', 'existing'] as const)('%s 读取失败不冒充空配置，并能重试', (mode) => {
  api.mode = 'error';
  useViewState.getState().enterSelect(mode);
  render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成账号读取失败');
  expect(host.textContent).not.toContain('还没有保存的账号');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="重新读取账号"]')!.click());
  expect(api.retry).toHaveBeenCalledOnce();
});
it('已有配置确实为空时保留空提示，没有错误提示', () => {
  useViewState.getState().enterSelect('existing');
  render();
  expect(host.textContent).toContain('还没有保存的账号');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it('账号查询进行中仍显示加载态，不冒充空或失败', () => {
  api.mode = 'loading';
  render();
  expect(host.textContent).toContain('正在准备账号');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('重新读取失败时仍保留已有账号，账号主页没有密钥或诊断按钮', () => {
  api.mode = 'stale';
  useViewState.getState().enterSelect('existing');
  render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成账号读取失败');
  expect(host.querySelector('.weq-open-identity h2')?.textContent).toBe('合成缓存账号');
  expect(host.querySelector('[aria-label="密钥与恢复"]')).toBeNull();
  expect(host.querySelector('[aria-label="环境诊断"]')).toBeNull();
});
it('环境诊断仅在添加页提供，点击后在弹窗挂载而非撑长登录页', () => {
  render();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="环境诊断"]')!.click());
  expect(document.querySelector('[role="dialog"] .weq-stats')).not.toBeNull();
  expect(host.querySelector('.weq-stats')).toBeNull();
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭环境诊断"]')!.click());
  expect(document.querySelector('.weq-stats')).toBeNull();
});
