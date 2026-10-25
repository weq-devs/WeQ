import { act, createElement as h, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { KeyEvent } from '@weq/service';
import { LoginPanel } from '../src/renderer/src/views/bootstrap/LoginPanel';
import type { UiAccount } from '../src/renderer/src/views/bootstrap/types';

const f = vi.hoisted(() => ({
  test: vi.fn(),
  open: vi.fn(),
  openStatic: vi.fn(),
  setAuto: vi.fn(),
  clearAuto: vi.fn(),
  unsubscribe: vi.fn(),
  qr: vi.fn(),
  event: (_event: KeyEvent) => {},
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      testDatabaseKey: { mutate: f.test },
      openAccount: { mutate: f.open },
      openStaticAccount: { mutate: f.openStatic },
      setAutoEnter: { mutate: f.setAuto },
      clearAutoEnter: { mutate: f.clearAuto },
      qrLogin: {
        subscribe: (input: unknown, handlers: { onData(event: KeyEvent): void }) => {
          f.qr(input);
          f.event = handlers.onData;
          return { unsubscribe: f.unsubscribe };
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/views/bootstrap/QrDialog', () => ({
  QrDialog: ({ onClose }: { onClose(): void }) => h('button', { onClick: onClose }, '取消扫码'),
}));
const accounts: UiAccount[] = ['10001', '10002'].map((uin) => ({
  key: uin,
  configId: uin,
  uin,
  name: `合成账号${uin}`,
  hasName: true,
  avatarUrl: null,
  dbKey: '0123456789abcdef',
}));
let host: HTMLDivElement, root: Root;
const entered = vi.fn(),
  busy = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  f.test.mockResolvedValue({
    success: true,
    algo: { pageHmacAlgorithm: 'sha1', kdfHmacAlgorithm: 'sha1' },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function Harness({ mode, empty = false }: { mode: 'new' | 'existing'; empty?: boolean }) {
  const [selected, setSelected] = useState<UiAccount | null>(empty ? null : accounts[0]!);
  return h(LoginPanel, {
    mode,
    selected,
    accounts: empty ? [] : accounts,
    onSelect: setSelected,
    autoTarget: null,
    onEntered: entered,
    onBusyChange: busy,
  });
}
async function mount(mode: 'new' | 'existing', empty = false) {
  await act(async () => root.render(h(Harness, { mode, empty })));
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!button) throw new Error(`missing ${label}`);
  await act(async () => button.click());
}
function keyValue() {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="密钥与恢复"]')!.click());
  const value = document.querySelector<HTMLInputElement>('.weq-keyfield-text')?.value;
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭密钥详情"]')!.click());
  return value;
}
function qrSuccess(uin: string, key = 'abcdefghijklmnop') {
  act(() => {
    f.event({ kind: 'qrcode-state', state: 'confirmed', uin });
    f.event({ kind: 'result', result: { success: true, dbkey: key } });
  });
}
it('已保存账号一键打开，仍先验证密钥，密钥详情默认折叠', async () => {
  await mount('existing');
  expect(document.querySelector('.weq-key-recovery')).toBeNull();
  await click('打开账号');
  expect(f.test).toHaveBeenCalledWith({ uin: '10001', dbKey: accounts[0]!.dbKey });
  expect(f.open).toHaveBeenCalledWith(
    expect.objectContaining({ uin: '10001', dbKey: accounts[0]!.dbKey }),
  );
  expect(f.test.mock.invocationCallOrder[0]).toBeLessThan(f.open.mock.invocationCallOrder[0]!);
  expect(entered).toHaveBeenCalledWith('10001');
});
it('密钥失败留在当前账号并提供恢复，不打开数据库', async () => {
  f.test.mockResolvedValueOnce({ success: false, error: '合成失效密钥' });
  await mount('existing');
  await click('打开账号');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('合成失效密钥');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('重新获取密钥');
  expect(f.open).not.toHaveBeenCalled();
  expect(busy).toHaveBeenLastCalledWith(false);
});
it('没有历史账号也能发起匿名扫码；未发现对应本地库时不冒用其他账号', async () => {
  await mount('new', true);
  await click('扫码登录其他账号');
  expect(f.qr).toHaveBeenCalledWith(undefined);
  qrSuccess('99999');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('未发现扫码账号的本地记录');
  expect(f.open).not.toHaveBeenCalled();
  expect(busy).toHaveBeenLastCalledWith(false);
});
it('扫码选中另一个已发现账号时保留该账号的新密钥，不能绑到原账号', async () => {
  await mount('new');
  await click('扫码登录其他账号');
  qrSuccess('10002');
  expect(host.querySelector('.weq-open-identity h2')?.textContent).toBe('合成账号10002');
  expect(keyValue()).toBe('abcdefghijklmnop');
  await click('打开账号');
  expect(f.test).toHaveBeenCalledWith({ uin: '10002', dbKey: 'abcdefghijklmnop' });
  expect(entered).toHaveBeenCalledWith('10002');
});
it('取消扫码释放忙碌状态，旧订阅晚到回执不能改变密钥', async () => {
  await mount('new');
  await click('扫码登录其他账号');
  await click('取消扫码');
  qrSuccess('10002');
  expect(host.querySelector('.weq-open-identity h2')?.textContent).toBe('合成账号10001');
  expect(keyValue()).toBe('');
  expect(f.open).not.toHaveBeenCalled();
  expect(busy).toHaveBeenLastCalledWith(false);
});
