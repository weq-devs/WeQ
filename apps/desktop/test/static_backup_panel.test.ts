import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { StaticBackupPanel } from '../src/renderer/src/views/bootstrap/StaticBackupPanel';
import { useDialog } from '../src/renderer/src/components/Dialog';

const f = vi.hoisted(() => ({ pick: vi.fn(), scan: vi.fn(), test: vi.fn(), open: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      pickStaticDbDir: { mutate: f.pick },
      scanStaticDirs: { mutate: f.scan },
      testStaticDir: { mutate: f.test },
      openStaticAccount: { mutate: f.open },
    },
  },
}));
const candidate = (uin: string) => ({
  dirPath: `/synthetic/${uin}`,
  dbDir: `/synthetic/${uin}/nt_db`,
  databaseCount: 3,
  databaseBytes: 1048576,
  mediaDir: `/synthetic/${uin}/nt_data`,
  probe: {
    ok: true,
    needKey: false,
    derivedKey: `key-${uin}`,
    mobile: false,
    preview: { uin, uid: `u_${uin}`, displayName: `合成账号${uin}`, avatarUrl: '' },
  },
});
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const entered = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  f.pick.mockResolvedValue('/synthetic');
  f.scan.mockResolvedValue({
    candidates: [candidate('12345'), candidate('67890')],
    truncated: false,
    unreadable: 0,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  const b = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!b) throw new Error(`missing: ${text}`);
  await act(async () => b.click());
}
async function mount() {
  await act(async () => root.render(h(StaticBackupPanel, { onEntered: entered })));
}
it('多账号逐项展示身份、数据库和媒体，选择后只打开该目录与密钥', async () => {
  await mount();
  await click('浏览…');
  const dialog = document.querySelector('[role=dialog]');
  expect(dialog).not.toBeNull();
  expect(host.querySelectorAll('input[type=radio]')).toHaveLength(0);
  expect(dialog!.querySelectorAll('input[type=radio]')).toHaveLength(2);
  expect(dialog!.textContent).toContain('合成账号12345');
  expect(dialog!.textContent).toContain('合成账号67890');
  expect(dialog!.textContent).toContain('3 个数据库');
  expect(dialog!.textContent).toContain('含本地媒体');
  expect(f.open).not.toHaveBeenCalled();
  await act(async () =>
    dialog!.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]!.click(),
  );
  await click('使用此目录');
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await click('进入');
  expect(f.open).toHaveBeenCalledWith({
    dirPath: candidate('67890').dirPath,
    dbKey: 'key-67890',
    preview: candidate('67890').probe.preview,
  });
  expect(entered).toHaveBeenCalledWith('67890');
});
it('浅层无结果才确认递归，确认后继续同一个选择路径，不重开弹窗', async () => {
  const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
  f.scan.mockResolvedValueOnce({ candidates: [], truncated: false, unreadable: 0 });
  await mount();
  await click('浏览…');
  expect(confirm).toHaveBeenCalledOnce();
  expect(f.scan).toHaveBeenNthCalledWith(2, { dirPath: '/synthetic', recursive: true });
  expect(f.pick).toHaveBeenCalledOnce();
});
it('取消递归不扫描；加密账号保留密钥验证入口', async () => {
  vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(false);
  f.scan.mockResolvedValueOnce({ candidates: [], truncated: false, unreadable: 0 });
  await mount();
  await click('浏览…');
  expect(f.scan).toHaveBeenCalledOnce();
  f.scan.mockResolvedValueOnce({
    candidates: [{ ...candidate('12345'), probe: { ok: true, needKey: true } }],
    truncated: false,
    unreadable: 0,
  });
  await click('浏览…');
  expect(host.textContent).toContain('验证密钥');
  await click('切换账号目录（1）');
  expect(document.querySelector('[role=dialog]')!.textContent).toContain('加密账号（待验证）');
});
it('单项原生探测失败仍保留其它账号可选，不误进入失败项', async () => {
  f.scan.mockResolvedValueOnce({
    candidates: [
      { ...candidate('12345'), probe: { ok: false, error: '探测进程 SIGSEGV 已隔离' } },
      candidate('67890'),
    ],
    truncated: false,
    unreadable: 0,
  });
  await mount();
  await click('浏览…');
  await act(async () =>
    document.querySelectorAll<HTMLInputElement>('input[type=radio]')[0]!.click(),
  );
  await click('使用此目录');
  expect(host.textContent).toContain('SIGSEGV 已隔离');
  expect(f.open).not.toHaveBeenCalled();
  await click('切换账号目录（2）');
  await act(async () =>
    document.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]!.click(),
  );
  await click('使用此目录');
  await click('进入');
  expect(entered).toHaveBeenCalledWith('67890');
});
it('弹窗切换是草稿，取消和 Escape 保留原目录；重新打开不重扫', async () => {
  await mount();
  await click('浏览…');
  await click('使用此目录');
  await click('切换账号目录（2）');
  await act(async () =>
    document.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]!.click(),
  );
  await click('取消');
  expect(host.querySelector<HTMLInputElement>('.weq-static-input')!.value).toBe(
    candidate('12345').dirPath,
  );
  await click('切换账号目录（2）');
  expect(document.querySelectorAll<HTMLInputElement>('input[type=radio]')[0]!.checked).toBe(true);
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    ),
  );
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(f.scan).toHaveBeenCalledOnce();
});
