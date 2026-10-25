import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ path: '' }));
vi.mock('../src/main/resource', () => ({ resolveResource: () => fixture.path }));
import { sampleHitokoto } from '../src/main/hitokoto';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-hitokoto-'));
  fixture.path = join(root, 'hitokoto.json');
  writeFileSync(
    fixture.path,
    JSON.stringify([
      { hitokoto: '今天也要开心', from: '日常' },
      { hitokoto: '这里包含 Spoiler', from: '作品' },
      { hitokoto: '安静看一场雨', from: '屏蔽出处' },
    ]),
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('主页一言屏蔽词', () => {
  it('抽样前过滤正文与出处，忽略大小写和空词', () => {
    expect(sampleHitokoto(40, [' spoiler ', '屏蔽', ''])).toEqual([
      { text: '今天也要开心', from: '日常' },
    ]);
  });
  it('全部屏蔽时返回空，默认采样不受主页配置污染', () => {
    expect(sampleHitokoto(40, ['今天', '这里', '安静'])).toEqual([]);
    expect(sampleHitokoto(40)).toHaveLength(3);
  });
});
