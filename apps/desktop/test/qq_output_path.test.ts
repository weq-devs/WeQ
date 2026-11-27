// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertQqDatabaseWritesIdle, configureQqDatabaseReadOnly } from '@weq/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  assertQqOutputPathAllowed,
  saveQqCapabilityPreference,
  withQqOutputWrite,
} from '../src/main/qq_output_path';

const state = vi.hoisted(() => ({
  root: '',
  readOnly: false,
  configure: vi.fn(),
  save: vi.fn(),
  native: {} as { configureQqReadOnlyRoots?: (roots: string[]) => boolean },
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    platform: {
      tencentFilesRoots: () => [join(state.root, 'QQ')],
      qqDataRoot: () => null,
      accountDir: () => null,
      native: { ntHelper: state.native },
    },
    bootstrap: {
      userConfig: {
        listAccountConfigs: () => [{ dataDir: join(state.root, 'imported') }],
        getSetting: () => (state.readOnly ? 'read-only' : 'local'),
        setSettings: state.save,
      },
    },
  }),
}));

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'weq-save-targets-'));
  state.readOnly = true;
  state.configure.mockReset();
  state.save.mockReset();
  state.native.configureQqReadOnlyRoots = state.configure;
  configureQqDatabaseReadOnly(() => state.readOnly);
  mkdirSync(join(state.root, 'QQ'));
  symlinkSync(join(state.root, 'QQ'), join(state.root, 'alias'), 'junction');
});

afterEach(() => {
  configureQqDatabaseReadOnly(() => false);
  rmSync(state.root, { recursive: true, force: true });
});

it('rejects new output under native, imported and linked QQ directories', async () => {
  for (const root of ['QQ', 'imported', 'alias']) {
    const target = join(state.root, root, 'new', 'export.db');
    expect(() => assertQqOutputPathAllowed(target)).toThrow('只读模式');
    const write = vi.fn(async () => undefined);
    await expect(withQqOutputWrite(target, write)).rejects.toThrow('只读模式');
    expect(write).not.toHaveBeenCalled();
  }
  await expect(
    withQqOutputWrite(join(state.root, 'QQ archives', 'out'), async () => 'ok'),
  ).resolves.toBe('ok');
});

it('blocks changing modes while an already allowed write to QQ is in flight', async () => {
  state.readOnly = false;
  let finish: () => void = () => undefined;
  const pending = new Promise<void>((done) => {
    finish = done;
  });
  const write = withQqOutputWrite(join(state.root, 'alias', 'out'), () => pending);
  expect(assertQqDatabaseWritesIdle).toThrow('正在修改 QQ 数据');
  finish();
  await write;
  expect(assertQqDatabaseWritesIdle).not.toThrow();
});

it('preserves the current tier until native protection is active', () => {
  state.readOnly = false;
  state.configure.mockReturnValueOnce(false).mockReturnValueOnce(true);
  expect(() => saveQqCapabilityPreference('read-only')).toThrow('正在读取 QQ 数据');
  expect(state.save).not.toHaveBeenCalled();

  saveQqCapabilityPreference('read-only');
  expect(state.configure).toHaveBeenLastCalledWith([
    join(state.root, 'QQ'),
    join(state.root, 'imported'),
  ]);
  expect(state.save).toHaveBeenCalledWith({ qqCapabilityMode: 'read-only' });
});
