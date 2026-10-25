// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { electronHost } from '../src/main/host';

const f = vi.hoisted(() => ({
  root: '',
  defaultDirectory: null as string | null,
  open: vi.fn(async (_options: unknown) => ({ canceled: true, filePaths: [] as string[] })),
  save: vi.fn(async (_options: unknown) => ({
    canceled: true,
    filePath: undefined as string | undefined,
  })),
}));
vi.mock('electron', () => ({
  app: { getPath: () => f.root, isPackaged: false },
  dialog: { showOpenDialog: f.open, showSaveDialog: f.save },
  shell: {},
  nativeImage: {},
  net: {},
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    bootstrap: { userConfig: { getSettings: () => ({ defaultExportDir: f.defaultDirectory }) } },
  }),
}));
beforeEach(() => {
  f.root = mkdtempSync(join(tmpdir(), 'weq-host-dialog-'));
  vi.clearAllMocks();
  f.defaultDirectory = null;
});
it('保存位置优先同类历史，其次默认目录，最后桌面；不同用途相互独立', async () => {
  const configured = join(f.root, 'configured');
  const previous = join(f.root, 'previous');
  mkdirSync(configured);
  mkdirSync(previous);
  await electronHost.pickSaveTarget({ defaultName: 'first.png', locationKey: 'image' });
  expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({ defaultPath: join(f.root, 'first.png') });
  f.defaultDirectory = configured;
  await electronHost.pickSaveTarget({ defaultName: 'second.png', locationKey: 'image' });
  expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({
    defaultPath: join(configured, 'second.png'),
  });
  f.save.mockResolvedValueOnce({ canceled: false, filePath: join(previous, 'old.png') });
  await electronHost.pickSaveTarget({ defaultName: 'old.png', locationKey: 'image' });
  await electronHost.pickSaveTarget({ defaultName: 'new.png', locationKey: 'image' });
  expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({ defaultPath: join(previous, 'new.png') });
  await electronHost.pickSaveTarget({ defaultName: 'report.png', locationKey: 'report' });
  expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({
    defaultPath: join(configured, 'report.png'),
  });
  await electronHost.pickDirectory({ title: '保存', locationKey: 'bundle' });
  expect(f.open.mock.calls.at(-1)?.[0]).toMatchObject({ defaultPath: configured });
  f.open.mockResolvedValueOnce({ canceled: false, filePaths: [previous] });
  await electronHost.pickDirectory({ title: '保存', locationKey: 'bundle' });
  await electronHost.pickDirectory({ title: '另一个显示标题', locationKey: 'bundle' });
  expect(f.open.mock.calls.at(-1)?.[0]).toMatchObject({ defaultPath: previous });
});
afterEach(() => rmSync(f.root, { recursive: true, force: true }));
it('原生文件和文件夹选择按用途恢复位置，取消不改变记忆', async () => {
  const a = join(f.root, 'a'),
    b = join(f.root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  f.open.mockResolvedValueOnce({ canceled: false, filePaths: [a] });
  await electronHost.pickDirectory({ title: '导出' });
  f.open.mockResolvedValueOnce({ canceled: false, filePaths: [join(b, 'input.db')] });
  await electronHost.pickFile({ title: '数据库', extensions: ['db'] });
  const original = readFileSync(join(f.root, 'dialog-locations.json'), 'utf8');
  await electronHost.pickDirectory({ title: '导出' });
  expect(f.open.mock.calls.at(-1)?.[0]).toMatchObject({ defaultPath: a });
  await electronHost.pickFile({ title: '数据库', extensions: ['db'] });
  expect(f.open.mock.calls.at(-1)?.[0]).toMatchObject({ defaultPath: b });
  await electronHost.pickDirectory({ title: '备份' });
  expect(f.open.mock.calls.at(-1)?.[0]).toMatchObject({ defaultPath: undefined });
  expect(readFileSync(join(f.root, 'dialog-locations.json'), 'utf8')).toBe(original);
});
it('同扩展名的不同保存用途隔离，保留新的默认文件名', async () => {
  const a = join(f.root, 'a'),
    b = join(f.root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  f.save.mockResolvedValueOnce({ canceled: false, filePath: join(a, 'old.json') });
  await electronHost.pickSaveTarget({
    defaultName: 'old.json',
    extension: 'json',
    locationKey: 'chat',
  });
  f.save.mockResolvedValueOnce({ canceled: false, filePath: join(b, 'capture.json') });
  await electronHost.pickSaveTarget({
    defaultName: 'capture.json',
    extension: 'json',
    locationKey: 'capture',
  });
  await electronHost.pickSaveTarget({
    defaultName: 'new.json',
    extension: 'json',
    locationKey: 'chat',
  });
  expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({ defaultPath: join(a, 'new.json') });
  await electronHost.pickSaveTarget({
    defaultName: 'next.json',
    extension: 'json',
    locationKey: 'capture',
  });
  expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({ defaultPath: join(b, 'next.json') });
});
