import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RecentReactions, RECENT_REACTIONS_MAX } from '../src/account/recent_reactions';

it('最近回应按配置文件隔离、去重并有界持久化', () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-reactions-'));
  try {
    const path = join(root, 'a', 'recent.json');
    const store = new RecentReactions(path);
    for (let index = 0; index < 40; index++) store.record(String(index));
    store.record('14');
    store.record('bad');
    expect(store.list()).toHaveLength(RECENT_REACTIONS_MAX);
    expect(store.list()[0]).toBe('14');
    expect(new RecentReactions(path).list()).toEqual(store.list());
    expect(new RecentReactions(join(root, 'b.json')).list()).toEqual([]);
    writeFileSync(path, '{bad');
    expect(new RecentReactions(path).list()).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
