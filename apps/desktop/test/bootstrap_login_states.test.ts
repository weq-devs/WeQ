import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SelectScreen } from '../src/renderer/src/views/bootstrap/SelectScreen';
import { useViewState } from '../src/renderer/src/state/view';
import type { GlobalInstallInfo } from '@weq/service';

const api = vi.hoisted(() => ({ mode: 'empty', retry: vi.fn(), scanSizes: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => {}, {
      get(_target, key) {
        if (key === 'useUtils') return () => proxy('utils');
        if (key === 'useQuery')
          return () => ({
            data: path.endsWith('listAccountConfigs')
              ? ['stale', 'both'].includes(api.mode)
                ? [
                    {
                      configId: 'synthetic',
                      uin: '10001',
                      displayName: '合成缓存账号',
                      dbKey: '0123456789abcdef',
                    },
                  ]
                : []
              : path.endsWith('listAccounts') && api.mode === 'both'
                ? [
                    { uin: '10002', userName: '本机账号二' },
                    { uin: '10003', userName: '本机账号三' },
                  ]
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
        if (key === 'subscribe')
          return (input: unknown) => {
            if (path.endsWith('accountDirSizeProgress')) api.scanSizes(input);
            return { unsubscribe() {} };
          };
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
  api.scanSizes.mockClear();
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
function button(name: string) {
  return host.querySelector<HTMLButtonElement>('[aria-label="' + name + '"]')!;
}
it('未发现在线账号时仍能切到已有的本地备份入口，不显示无效的密钥操作', () => {
  render();
  expect(host.querySelector('.weq-keyfield-action')).toBeNull();
  act(() => button('返回账号主页').click());
  act(() => button('导入 QQ 备份').click());
  expect(host.querySelector('.weq-static-backup')).not.toBeNull();
  expect(host.textContent).toContain('账号文件夹');
});
it('最近账号和添加、导入入口直接可见，诊断默认不扫描账号目录', () => {
  api.mode = 'stale';
  useViewState.getState().enterSelect('existing');
  render();
  expect(host.querySelector('.weq-account-list')?.textContent).toContain('合成缓存账号');
  expect(button('添加本机 QQ 账号').disabled).toBe(false);
  expect(button('导入 QQ 备份').disabled).toBe(false);
  expect(host.querySelector('.weq-stats')).toBeNull();
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  expect(document.querySelector('.weq-key-recovery')).toBeNull();
});
it('切换下半区可返回最近使用，导入期间保留上半区账号', () => {
  api.mode = 'both';
  useViewState.getState().enterSelect('existing');
  render();
  const upper = host.querySelector('.weq-account-detail');
  const card = upper?.querySelector('.weq-open-identity');
  act(() => button('添加本机 QQ 账号').click());
  expect(host.querySelector('#account-section-title')?.textContent).toBe('添加本机 QQ 账号');
  expect(button('扫码登录其他账号').disabled).toBe(false);
  expect(upper?.querySelector('.weq-open-identity')).toBe(card);
  expect(card?.querySelector('h2')?.textContent).toBe('合成缓存账号');
  act(() => host.querySelector<HTMLButtonElement>('.weq-account-select')!.click());
  expect(card?.querySelector('h2')?.textContent).toBe('本机账号二');
  act(() => button('返回账号主页').click());
  expect(host.querySelector('.weq-open-identity h2')?.textContent).toBe('合成缓存账号');
  act(() => button('导入 QQ 备份').click());
  expect(host.querySelector('.weq-open-identity h2')?.textContent).toBe('合成缓存账号');
  expect(host.querySelector('#account-section-title')?.textContent).toBe('导入 QQ 备份');
  act(() => button('返回账号主页').click());
  expect(host.querySelector('#account-section-title')?.textContent).toBe('最近使用');
});
it.each(['new', 'existing'] as const)('%s 读取失败不冒充空配置，并能重试', (mode) => {
  api.mode = 'error';
  useViewState.getState().enterSelect(mode);
  render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('读取账号失败');
  expect(host.textContent).not.toContain('还没有保存的账号');
  const alert = host.querySelector('[role="alert"]')!;
  expect(host.querySelector('[aria-label="重新读取账号"]')).toBeNull();
  act(() => alert.querySelector<HTMLButtonElement>('button')!.click());
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

it('重新读取失败时仍保留已有账号，账号主页没有独立密钥按钮', () => {
  api.mode = 'stale';
  useViewState.getState().enterSelect('existing');
  render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('读取账号失败');
  expect(host.querySelector('.weq-open-identity h2')?.textContent).toBe('合成缓存账号');
  expect(host.querySelector('[aria-label="密钥与恢复"]')).toBeNull();
});
it('从账号卡片打开环境诊断，只诊断点击的账号并保留上方账号', () => {
  api.mode = 'both';
  render();
  expect(api.scanSizes).not.toHaveBeenCalled();
  act(() => button('环境诊断：本机账号三（10003）').click());
  expect(document.querySelector('[role="dialog"] .weq-stats')).not.toBeNull();
  expect(host.querySelector('.weq-stats')).toBeNull();
  expect(api.scanSizes).toHaveBeenLastCalledWith({ uin: '10003' });
  expect(host.querySelector('.weq-open-identity h2')?.textContent).toBe('合成缓存账号');
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭环境诊断"]')!.click());
  expect(document.querySelector('.weq-stats')).toBeNull();
});
