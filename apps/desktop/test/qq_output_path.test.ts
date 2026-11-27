// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  assertQqDatabaseWritesIdle,
  assertQqFileWriteAllowed,
  configureQqDatabaseReadOnly,
  configureQqFileWriteRoots,
  withQqFileWrite,
} from '@weq/db';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { ResourceCleanupService, saveExportOutput, UserConfigService } from '@weq/service';
import { writeFileAtomic } from '@weq/service/atomic-write';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveQqCapabilityPreference } from '../src/main/qq_output_path';
import { configureStartupQqFilePolicy } from '../src/main/context/startup_qq_file_policy';

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

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
        cacheBaseDir: () => join(state.root, 'cache'),
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
  configureQqFileWriteRoots(() => [join(state.root, 'QQ'), join(state.root, 'imported')]);
  mkdirSync(join(state.root, 'QQ'));
  symlinkSync(join(state.root, 'QQ'), join(state.root, 'alias'), 'junction');
});

afterEach(() => {
  configureQqDatabaseReadOnly(() => false);
  configureQqFileWriteRoots(() => []);
  rmSync(state.root, { recursive: true, force: true });
});

it('rejects new output under native, imported and linked QQ directories', async () => {
  for (const root of ['QQ', 'imported', 'alias']) {
    const target = join(state.root, root, 'new', 'export.db');
    expect(() => assertQqFileWriteAllowed(target)).toThrow('只读模式');
    const write = vi.fn(async () => undefined);
    await expect(withQqFileWrite(target, write)).rejects.toThrow('只读模式');
    expect(write).not.toHaveBeenCalled();
  }
  await expect(
    withQqFileWrite(join(state.root, 'QQ archives', 'out'), async () => 'ok'),
  ).resolves.toBe('ok');
});

it('blocks changing modes while an already allowed write to QQ is in flight', async () => {
  state.readOnly = false;
  let finish: () => void = () => undefined;
  const pending = new Promise<void>((done) => {
    finish = done;
  });
  const write = withQqFileWrite(join(state.root, 'alias', 'out'), () => pending);
  expect(assertQqDatabaseWritesIdle).toThrow('正在修改 QQ 数据');
  finish();
  await write;
  expect(assertQqDatabaseWritesIdle).not.toThrow();
});

it('uses the WeQ cache on startup if the persisted read-only cache points into QQ', () => {
  const qq = join(state.root, 'QQ');
  const home = join(state.root, 'weq');
  mkdirSync(home);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      tencentFilesRootOverride: qq,
      cacheDirOverride: join(qq, 'old-cache'),
      settings: { qqCapabilityMode: 'read-only' },
    }),
  );
  configureStartupQqFilePolicy(home);
  const config = new UserConfigService({ appDataRoot: () => home });
  expect(config.cacheDir('media')).toBe(join(home, 'cache', 'media'));
  expect(config.getCacheDirInfo().override).toBe(join(qq, 'old-cache'));
  expect(existsSync(join(qq, 'old-cache'))).toBe(false);
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

it('preserves the QQ fixture across a mode change, save, rename and cleanup', async () => {
  const qq = join(state.root, 'QQ');
  const data = join(qq, 'nt_data');
  const pic = join(data, 'Pic');
  mkdirSync(pic, { recursive: true });
  const image = join(pic, 'fixture.jpg');
  const db = join(qq, 'fixture.db');
  const attachment = join(state.root, 'staged.txt');
  writeFileSync(image, 'QQ fixture');
  using writer = new DatabaseSync(db);
  writer.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE messages(body TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO messages VALUES ('from WAL')",
  );
  using reader = new DatabaseSync(db, { readOnly: true });
  const read = () => reader.prepare('SELECT body FROM messages').get()?.body;
  expect(read()).toBe('from WAL');
  const dbFiles = () => ['', '-wal', '-shm'].map((suffix) => readFileSync(db + suffix));
  const beforeDb = dbFiles();
  writeFileSync(attachment, 'WeQ export');
  const cleanup = new ResourceCleanupService(
    { context: { uin: 'fixture' } } as AccountSession,
    {
      ntDataDir: () => data,
      picDir: () => pic,
      marketFaceDir: () => null,
      emojiRelatedDir: () => null,
      videoDir: () => null,
      pttDir: () => null,
      emojiRecvDir: () => null,
      personalEmojiDir: () => null,
      fileDir: () => null,
    } as unknown as Platform,
  );
  const before = readdirSync(qq, { recursive: true }).sort();

  state.readOnly = false;
  state.configure.mockReturnValue(true);
  state.save.mockImplementation(({ qqCapabilityMode }) => {
    state.readOnly = qqCapabilityMode === 'read-only';
  });
  const configured = withQqFileWrite(join(qq, 'held'), async () => {
    expect(() => saveQqCapabilityPreference('read-only')).toThrow('正在修改 QQ 数据');
  });
  await configured;
  saveQqCapabilityPreference('read-only');
  expect(read()).toBe('from WAL');
  expect((await cleanup.listTargets()).find(({ id }) => id === 'pic')?.files).toBe(1);

  const unsafe = join(state.root, 'alias', 'save.txt');
  await expect(
    saveExportOutput({ name: 'result', filePath: attachment }, { filePath: unsafe }),
  ).rejects.toThrow('只读模式');
  await expect(
    writeFileAtomic(join(state.root, 'alias', 'new', 'report.json'), '{}'),
  ).rejects.toThrow('只读模式');
  await expect(cleanup.cleanup([{ id: 'pic', variant: 'all' }])).rejects.toThrow('只读模式');
  const moved = join(state.root, 'moved.db');
  await expect(withQqFileWrite([db, moved], async () => renameSync(db, moved))).rejects.toThrow(
    '只读模式',
  );
  expect(() => assertQqFileWriteAllowed({ path: state.root, tree: true })).toThrow('只读模式');
  expect(existsSync(moved)).toBe(false);

  const allowed = join(state.root, 'saved.txt');
  const saved = await saveExportOutput(
    { name: 'result', filePath: attachment },
    {
      filePath: allowed,
    },
  );
  expect(saved).toBe(realpathSync(allowed));
  expect(readFileSync(allowed, 'utf8')).toBe('WeQ export');
  expect(readdirSync(qq, { recursive: true }).sort()).toEqual(before);
  expect(dbFiles()).toEqual(beforeDb);
  expect(readFileSync(image, 'utf8')).toBe('QQ fixture');
});
