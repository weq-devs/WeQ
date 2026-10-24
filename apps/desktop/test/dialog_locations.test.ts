import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { DialogLocations } from '../src/main/dialog_locations';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('文件、文件夹和保存用途独立记忆，重启后保留，默认文件名不受旧文件名影响', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-dialog-'));
  roots.push(root);
  const a = join(root, 'a'),
    b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const file = join(root, 'locations.json');
  const store = new DialogLocations(file);
  store.remember('folder', a, true);
  store.remember('file', join(b, 'old.db'));
  store.remember('save', join(a, 'old.json'));
  const reopened = new DialogLocations(file);
  expect(reopened.directory('folder')).toBe(a);
  expect(reopened.directory('file')).toBe(b);
  expect(reopened.savePath('save', 'new.json')).toBe(join(a, 'new.json'));
  expect(reopened.directory('unseen')).toBeUndefined();
  rmSync(a, { recursive: true });
  expect(reopened.directory('folder')).toBe(root);
});
