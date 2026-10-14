import { mkdtempSync, writeFileSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NtHelperBinding, AppidInfo } from '@weq/native';
import {
  registerSsoSession,
  registerSsoSessionInTurn,
  resolveSsoClientSnapshot,
} from '../src/account/sso_session';

const roots: string[] = [];
const identity = { uin: '10001', uid: 'u_fixture', guid: 'ab'.repeat(16) };
const material = { a2: 'aa', d2: 'bb', d2Key: 'cc'.repeat(16) };
const first = { appid: '123', version: '7.0.1', build: '100' };
const second = { appid: '123', version: '7.0.2', build: '200' };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-sso-snapshot-'));
  roots.push(root);
  const major = join(root, 'major.node'),
    wrapper = join(root, 'wrapper.node');
  writeFileSync(major, JSON.stringify(first));
  writeFileSync(wrapper, 'synthetic signer');
  const resolveAppidFromMajor = vi.fn(
    (path: string) => JSON.parse(readFileSync(path, 'utf8')) as AppidInfo,
  );
  const setSsoSession = vi.fn(async () => {});
  const nt = { resolveAppidFromMajor, setSsoSession } as unknown as NtHelperBinding;
  const platform = { qqMajorNodePath: () => major, qqWrapperNodePath: () => wrapper };
  const replace = () => {
    const next = join(root, 'next.node');
    writeFileSync(next, JSON.stringify(second));
    renameSync(next, major);
  };
  return { nt, platform, major, resolveAppidFromMajor, setSsoSession, replace };
}

describe('running-client registration snapshots', () => {
  it('takes App ID and version from one scan instead of mixing sequential results', async () => {
    const f = fixture();
    f.resolveAppidFromMajor
      .mockReturnValueOnce(first)
      .mockReturnValueOnce({ ...second, appid: '456' });
    expect(await registerSsoSession(f.nt, f.platform, 42, identity, material)).toBe(true);
    expect(f.resolveAppidFromMajor).toHaveBeenCalledOnce();
    expect(f.setSsoSession.mock.calls[0]?.[1]).toMatchObject({
      subAppId: 123,
      clientVersion: '7.0.1-100',
    });
  });
  it('caches unchanged files but refreshes replacement files and different PIDs', () => {
    const f = fixture();
    expect(resolveSsoClientSnapshot(f.nt, f.platform, 42, identity).identity.clientVersion).toBe(
      '7.0.1-100',
    );
    resolveSsoClientSnapshot(f.nt, f.platform, 42, identity);
    expect(f.resolveAppidFromMajor).toHaveBeenCalledOnce();
    f.replace();
    expect(resolveSsoClientSnapshot(f.nt, f.platform, 42, identity).identity.clientVersion).toBe(
      '7.0.2-200',
    );
    expect(f.resolveAppidFromMajor).toHaveBeenCalledTimes(2);
    resolveSsoClientSnapshot(f.nt, f.platform, 43, identity);
    expect(f.resolveAppidFromMajor).toHaveBeenCalledTimes(3);
  });
  it('rejects replacement during a metadata scan and does not cache the mixed snapshot', async () => {
    const f = fixture();
    f.resolveAppidFromMajor.mockImplementationOnce(() => {
      f.replace();
      return first;
    });
    expect(await registerSsoSession(f.nt, f.platform, 42, identity, material)).toBe(false);
    expect(f.setSsoSession).not.toHaveBeenCalled();
    expect(await registerSsoSession(f.nt, f.platform, 42, identity, material)).toBe(true);
    expect(f.setSsoSession.mock.calls[0]?.[1]).toMatchObject({
      subAppId: 123,
      clientVersion: '7.0.2-200',
    });
  });
  it('rejects a snapshot belonging to another process or account', async () => {
    const f = fixture();
    const snapshot = resolveSsoClientSnapshot(f.nt, f.platform, 42, identity);
    expect(
      await registerSsoSessionInTurn(
        f.nt,
        f.platform,
        43,
        identity,
        material,
        () => true,
        snapshot,
      ),
    ).toBe(false);
    expect(
      await registerSsoSessionInTurn(
        f.nt,
        f.platform,
        42,
        { ...identity, uin: '10002' },
        material,
        () => true,
        snapshot,
      ),
    ).toBe(false);
    expect(f.setSsoSession).not.toHaveBeenCalled();
  });
  it('does not reuse metadata from a module which is no longer readable', async () => {
    const f = fixture();
    resolveSsoClientSnapshot(f.nt, f.platform, 42, identity);
    unlinkSync(f.major);
    expect(await registerSsoSession(f.nt, f.platform, 42, identity, material)).toBe(false);
    expect(f.setSsoSession).not.toHaveBeenCalled();
  });
});
