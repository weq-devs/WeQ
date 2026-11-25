import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { StaticBackupPanel } from '../src/renderer/src/views/bootstrap/StaticBackupPanel';
import type { BackupScanEvent } from '../src/main/static_backup';

const f = vi.hoisted(() => ({
  pick: vi.fn(),
  scan: vi.fn(),
  test: vi.fn(),
  open: vi.fn(),
  event: (_event: BackupScanEvent) => {},
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    bootstrap: {
      pickStaticDbDir: { mutate: f.pick },
      scanStaticDirsProgress: {
        subscribe: (
          input: unknown,
          handlers: { onData(event: BackupScanEvent): void; onError(error: Error): void },
        ) => {
          let active = true;
          f.event = handlers.onData;
          void f.scan(input).then((result) => {
            if (!active) return;
            for (const candidate of result.candidates)
              handlers.onData({ kind: 'candidate', candidate });
            handlers.onData({
              kind: 'done',
              truncated: result.truncated,
              unreadable: result.unreadable,
            });
          }, handlers.onError);
          return {
            unsubscribe: () => {
              active = false;
            },
          };
        },
      },
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
  sizePending: false,
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
  const button = [...host.querySelectorAll('button')].find(
    (item) => (item.getAttribute('aria-label') ?? item.textContent) === text,
  );
  if (!button) throw new Error('missing: ' + text);
  await act(async () => button.click());
}
async function mount() {
  await act(async () =>
    root.render(
      h(StaticBackupPanel, { heading: h('h2', null, '导入 QQ 备份'), onEntered: entered }),
    ),
  );
}
function input(label: string) {
  const fieldLabel = [...host.querySelectorAll('label')].find((item) => item.textContent === label);
  return fieldLabel!.control as HTMLInputElement;
}
async function type(label: string, value: string) {
  const field = input(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function radio(index: number) {
  return host.querySelectorAll<HTMLInputElement>('input[type=radio]')[index]!;
}
it('多账号在主区域展示身份、数据库和媒体，只打开选中目录与其密钥', async () => {
  await mount();
  await click('浏览');
  expect(host.textContent).toContain('合成账号12345');
  expect(host.textContent).toContain('合成账号67890');
  expect(host.textContent).toContain('3 个数据库');
  expect(host.textContent).toContain('含本地媒体');
  expect(f.open).not.toHaveBeenCalled();
  await act(async () => radio(1).click());
  await click('进入');
  expect(f.open).toHaveBeenCalledWith({
    dirPath: candidate('67890').dirPath,
    dbKey: 'key-67890',
    preview: candidate('67890').probe.preview,
  });
  expect(entered).toHaveBeenCalledWith('67890');
});
it('输入路径可直接扫描，递归无结果后可输入新路径或浏览', async () => {
  const none = { candidates: [], truncated: false, unreadable: 0 };
  f.scan.mockResolvedValueOnce(none).mockResolvedValueOnce(none);
  await mount();
  await type('账号文件夹', ' /synthetic/带空格 文件夹 ');
  await click('扫描');
  expect(f.pick).not.toHaveBeenCalled();
  expect(f.scan).toHaveBeenCalledOnce();
  expect(f.scan).toHaveBeenCalledWith({
    dirPath: '/synthetic/带空格 文件夹',
    recursive: false,
  });
  await click('扫描子文件夹');
  expect(f.scan).toHaveBeenNthCalledWith(2, {
    dirPath: '/synthetic/带空格 文件夹',
    recursive: true,
  });
  expect(input('账号文件夹').value).toBe('');
  expect(host.textContent).toContain('未找到 QQ 备份');
  await click('浏览');
  expect(f.pick).toHaveBeenCalledOnce();
});
it('可以放弃递归并手动修改错误路径', async () => {
  f.scan.mockResolvedValueOnce({ candidates: [], truncated: false, unreadable: 0 });
  await mount();
  await click('浏览');
  await click('重新选择');
  expect(f.scan).toHaveBeenCalledOnce();
  f.scan.mockRejectedValueOnce(new Error('文件夹不存在'));
  await type('账号文件夹', '/invalid');
  await click('扫描');
  expect(input('账号文件夹').value).toBe('/invalid');
  expect(host.textContent).toContain('文件夹不存在');
});
it('单项原生探测失败仍可选其他备份，加密备份只在密钥验证成功后打开', async () => {
  f.scan.mockResolvedValueOnce({
    candidates: [
      { ...candidate('12345'), probe: { ok: false, error: '探测进程 SIGSEGV 已隔离' } },
      { ...candidate('67890'), probe: { ok: true, needKey: true } },
    ],
    truncated: false,
    unreadable: 0,
  });
  f.test
    .mockResolvedValueOnce({ ok: false, error: '密钥错误' })
    .mockResolvedValueOnce(candidate('67890').probe);
  await mount();
  await click('浏览');
  expect(host.textContent).toContain('SIGSEGV 已隔离');
  expect(f.open).not.toHaveBeenCalled();
  await act(async () => radio(1).click());
  await type('数据库密钥', 'wrong-key');
  await click('验证密钥');
  expect(host.textContent).toContain('密钥错误');
  await type('数据库密钥', 'key-67890');
  await click('验证密钥');
  expect(f.test).toHaveBeenLastCalledWith({
    dirPath: candidate('67890').dirPath,
    dbKey: 'key-67890',
  });
  await click('进入');
  expect(entered).toHaveBeenCalledWith('67890');
});
it('扫描时逐项显示目录，后续统计与探测更新保留选择', async () => {
  f.scan.mockImplementationOnce(() => new Promise(() => {}));
  await mount();
  await click('浏览');
  expect(host.textContent).toContain('扫描中');
  await act(async () => f.event({ kind: 'candidate', candidate: candidate('12345') }));
  await act(async () =>
    f.event({
      kind: 'candidate',
      candidate: {
        ...candidate('67890'),
        databaseCount: null,
        databaseBytes: null,
        sizePending: true,
        probe: null,
      },
    }),
  );
  expect(host.textContent).toContain('大小统计中');
  expect(host.textContent).not.toContain('0.0 MB');
  await act(async () => radio(1).click());
  await act(async () => f.event({ kind: 'candidate', candidate: candidate('67890') }));
  expect(radio(1).checked).toBe(true);
  await click('进入');
  expect(entered).toHaveBeenCalledWith('67890');
});
it('重新浏览取消时保留结果，换文件夹时忽略旧扫描回执', async () => {
  f.scan.mockImplementationOnce(() => new Promise(() => {}));
  await mount();
  await click('浏览');
  const late = f.event;
  await act(async () => late({ kind: 'candidate', candidate: candidate('11111') }));
  f.pick.mockResolvedValueOnce(undefined);
  await click('浏览其他文件夹');
  expect(host.textContent).toContain('合成账号11111');
  f.pick.mockResolvedValueOnce('/elsewhere');
  await click('浏览其他文件夹');
  await act(async () => late({ kind: 'candidate', candidate: candidate('22222') }));
  expect(host.textContent).not.toContain('合成账号11111');
  expect(host.textContent).not.toContain('合成账号22222');
  expect(host.textContent).toContain('合成账号67890');
  expect(f.scan).toHaveBeenLastCalledWith({ dirPath: '/elsewhere', recursive: false });
});
