/**
 * `withResourceRoots` — the seam that stops a static (imported) account from
 * resolving its resources against the LOCAL QQ install.
 *
 * Two properties matter and both are easy to break silently:
 *
 *   1. Redirection actually applies. A missed media key means a static account
 *      reads — and `ResourceCleanupService` deletes — the local account's files.
 *   2. Everything else passes through. `isQqLoggedIn` / `native` / `qqExePath`
 *      must keep pointing at the real machine, or online detection for a static
 *      account breaks. The passthrough test enumerates the non-resource members
 *      so adding a `Platform` method without deciding its group fails here.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Platform } from '../src/types';
import { withResourceRoots, type MediaDirKey, type ResourceRootOverrides } from '../src/resource_roots';

const MEDIA_KEYS: MediaDirKey[] = [
  'accountDir',
  'ntDataDir',
  'picDir',
  'pttDir',
  'videoDir',
  'fileDir',
  'emojiResourceDir',
  'marketFaceDir',
  'emojiRecvDir',
  'personalEmojiDir',
  'emojiRelatedDir',
];

const NATIVE_SENTINEL = { ntHelper: {} } as unknown as Platform['native'];

/** A Platform whose every path method returns a recognisable `local:<name>`. */
function fakePlatform(): Platform {
  const local =
    (name: string) =>
    (uin: string): string =>
      `local:${name}:${uin}`;
  return {
    kind: 'win32',
    native: NATIVE_SENTINEL,
    appDataRoot: () => 'local:appDataRoot',
    tencentFilesRoots: () => ['local:root'],
    loginDbPath: () => 'local:loginDb',
    ntMsgDbPath: local('ntMsgDbPath'),
    accountDir: local('accountDir'),
    ntDbDir: local('ntDbDir'),
    ntDataDir: local('ntDataDir'),
    groupInfoDbPath: local('groupInfoDbPath'),
    profileInfoDbPath: local('profileInfoDbPath'),
    miscDbPath: local('miscDbPath'),
    buddyMsgFtsDbPath: local('buddyMsgFtsDbPath'),
    groupMsgFtsDbPath: local('groupMsgFtsDbPath'),
    emojiResourceDir: local('emojiResourceDir'),
    marketFaceDir: local('marketFaceDir'),
    emojiRecvDir: local('emojiRecvDir'),
    personalEmojiDir: local('personalEmojiDir'),
    emojiRelatedDir: local('emojiRelatedDir'),
    picDir: local('picDir'),
    pttDir: local('pttDir'),
    videoDir: local('videoDir'),
    fileDir: local('fileDir'),
    qqExePath: () => 'local:qqExe',
    qqWrapperNodePath: () => 'local:wrapper',
    qqMajorNodePath: () => 'local:major',
    qqVersion: () => '9.9.9-1',
    isQqLoggedIn: () => true,
    launcherCount: () => 3,
  };
}

const tmpRoots: string[] = [];

/** A directory holding the named db files, for the `dbDir` existence check. */
function dbDirWith(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-resource-roots-'));
  tmpRoots.push(dir);
  for (const f of files) writeFileSync(join(dir, f), '');
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function wrap(overrides: ResourceRootOverrides): Platform {
  return withResourceRoots(fakePlatform(), () => overrides);
}

describe('media redirection', () => {
  it('resolves every media dir to null when unbound', () => {
    const p = wrap({ media: 'none' });
    for (const key of MEDIA_KEYS) {
      expect(p[key]('10001'), key).toBeNull();
    }
  });

  it('passes media through by default', () => {
    const p = wrap({});
    for (const key of MEDIA_KEYS) {
      expect(p[key]('10001'), key).toBe(`local:${key}:10001`);
    }
  });

  it('honours per-key paths and nulls the keys left out', () => {
    const p = wrap({ media: { picDir: '/backup/Pic', ntDataDir: '/backup' } });
    expect(p.picDir('10001')).toBe('/backup/Pic');
    expect(p.ntDataDir('10001')).toBe('/backup');
    expect(p.videoDir('10001')).toBeNull();
  });
});

describe('database redirection', () => {
  it('points ntDbDir at the imported directory', () => {
    const dir = dbDirWith();
    expect(wrap({ dbDir: dir }).ntDbDir('10001')).toBe(dir);
  });

  it('resolves db files that are present and nulls the ones that are not', () => {
    const dir = dbDirWith('group_info.db', 'profile_info.db');
    const p = wrap({ dbDir: dir });
    expect(p.groupInfoDbPath('10001')).toBe(join(dir, 'group_info.db'));
    expect(p.profileInfoDbPath('10001')).toBe(join(dir, 'profile_info.db'));
    // An imported folder often has no fts index — must be null, not a dead path.
    expect(p.buddyMsgFtsDbPath('10001')).toBeNull();
    expect(p.miscDbPath('10001')).toBeNull();
  });

  it('leaves db resolution alone when dbDir is absent', () => {
    const p = wrap({ media: 'none' });
    expect(p.ntDbDir('10001')).toBe('local:ntDbDir:10001');
    expect(p.groupInfoDbPath('10001')).toBe('local:groupInfoDbPath:10001');
  });
});

describe('passthrough', () => {
  it('leaves every non-resource member untouched', () => {
    const base = fakePlatform();
    const p = withResourceRoots(base, () => ({ dbDir: '/imported', media: 'none' }));
    expect(p.kind).toBe(base.kind);
    expect(p.native).toBe(base.native);
    expect(p.appDataRoot()).toBe(base.appDataRoot());
    expect(p.tencentFilesRoots()).toEqual(base.tencentFilesRoots());
    expect(p.loginDbPath()).toBe(base.loginDbPath());
    expect(p.qqExePath()).toBe(base.qqExePath());
    expect(p.qqWrapperNodePath()).toBe(base.qqWrapperNodePath());
    expect(p.qqMajorNodePath()).toBe(base.qqMajorNodePath());
    expect(p.qqVersion()).toBe(base.qqVersion());
    expect(p.launcherCount()).toBe(base.launcherCount());
    // The one that would silently disable online detection for static accounts.
    expect(p.isQqLoggedIn('10001')).toBe(base.isQqLoggedIn('10001'));
    // nt_msg.db is the session's own resolved path, never redirected here.
    expect(p.ntMsgDbPath('10001')).toBe(base.ntMsgDbPath('10001'));
  });
});

describe('laziness', () => {
  it('reflects an overrides change without rewrapping', () => {
    let overrides: ResourceRootOverrides = { media: 'none' };
    const p = withResourceRoots(fakePlatform(), () => overrides);
    expect(p.picDir('10001')).toBeNull();
    // The settings toggle flips the binding mid-session — no account reopen.
    overrides = { media: 'passthrough' };
    expect(p.picDir('10001')).toBe('local:picDir:10001');
  });
});
