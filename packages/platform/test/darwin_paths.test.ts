/**
 * Darwin path-resolution tests — pure filesystem helpers.
 *
 * The QQ data root is the sandboxed container path; the per-account layout is
 * identical to linux (hashed `nt_qq_<hash>` dirs, two login.db locations).
 * QQ install paths are the app-bundle layout (`…/Contents/Resources/app`).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  accountDirName,
  candidateQqRoots,
  defaultQqDataRoot,
  findLoginDbs,
  findNtMsgDb,
  findQqMajorNode,
  findQqWrapperNode,
} from '../src/darwin/paths';

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-darwin-paths-'));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

describe('data root', () => {
  it('derives the sandboxed container path from home', () => {
    expect(defaultQqDataRoot('/Users/test')).toBe(
      join(
        '/Users/test',
        'Library',
        'Containers',
        'com.tencent.qq',
        'Data',
        'Library',
        'Application Support',
        'QQ',
      ),
    );
  });

  it('prepends an existing override and dedupes', () => {
    const override = tmpRoot();
    const roots = candidateQqRoots('/Users/test', override);
    expect(roots[0]).toBe(override);
    expect(roots).toContain(defaultQqDataRoot('/Users/test'));
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe('login.db (same two-location list as linux)', () => {
  it('finds primary then supplementary in merge-priority order', () => {
    const root = tmpRoot();
    const primary = join(root, 'global', 'nt_db');
    const secondary = join(root, 'nt_qq', 'global', 'nt_db');
    mkdirSync(primary, { recursive: true });
    mkdirSync(secondary, { recursive: true });
    writeFileSync(join(primary, 'login.db'), '');
    writeFileSync(join(secondary, 'login.db'), '');

    const dbs = findLoginDbs('/Users/test', root);
    expect(dbs).toEqual([join(primary, 'login.db'), join(secondary, 'login.db')]);
  });

  it('returns only the locations that exist', () => {
    const root = tmpRoot();
    const primary = join(root, 'global', 'nt_db');
    mkdirSync(primary, { recursive: true });
    writeFileSync(join(primary, 'login.db'), '');
    expect(findLoginDbs('/Users/test', root)).toEqual([join(primary, 'login.db')]);
  });
});

describe('per-account databases (hashed dir, same as linux)', () => {
  it('resolves nt_msg.db under nt_qq_<hash>', () => {
    const root = tmpRoot();
    const uid = 'u_LKt3AdAIMP-CUfn6ydzDzw';
    const db = join(root, accountDirName(uid), 'nt_db');
    mkdirSync(db, { recursive: true });
    writeFileSync(join(db, 'nt_msg.db'), '');
    expect(findNtMsgDb(uid, '/Users/test', root)).toBe(join(db, 'nt_msg.db'));
  });

  it('returns null when the uid is empty', () => {
    expect(findNtMsgDb('', '/Users/test', tmpRoot())).toBeNull();
  });
});

describe('QQ install (app bundle layout)', () => {
  it('resolves wrapper.node / major.node under Contents/Resources/app', () => {
    const app = join(tmpRoot(), 'QQ.app');
    const resourcesApp = join(app, 'Contents', 'Resources', 'app');
    mkdirSync(resourcesApp, { recursive: true });
    writeFileSync(join(resourcesApp, 'wrapper.node'), '');
    writeFileSync(join(resourcesApp, 'major.node'), '');

    const exe = join(app, 'Contents', 'MacOS', 'QQ');
    expect(findQqWrapperNode(exe)).toBe(join(resourcesApp, 'wrapper.node'));
    expect(findQqMajorNode(exe)).toBe(join(resourcesApp, 'major.node'));
  });

  it('returns null when the companion file is missing', () => {
    const app = join(tmpRoot(), 'QQ.app');
    mkdirSync(join(app, 'Contents', 'Resources', 'app'), { recursive: true });
    expect(findQqWrapperNode(join(app, 'Contents', 'MacOS', 'QQ'))).toBeNull();
  });
});
