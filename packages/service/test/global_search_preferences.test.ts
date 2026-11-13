import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientStateStore } from '../src/bootstrap/client_state';
import { DEFAULT_SEARCH_CATEGORIES, DEFAULT_SEARCH_SOURCES } from '../src/account/search_policy';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('共享搜索偏好迁移', () => {
  it('旧 schema 首次重置全选，保存新 schema 后其他账号和客户端读取同一选择', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-search-preferences-'));
    roots.push(root);
    const path = join(root, 'state.json');
    writeFileSync(
      path,
      JSON.stringify({
        epoch: 'fixture',
        revision: 1,
        values: {
          search: {
            categories: ['assistantMessage', 'groupAlbum'],
            appEnabled: false,
            numberLookupEnabled: false,
          },
          background: 'paper',
        },
        records: {},
        drafts: {},
      }),
    );
    const first = new ClientStateStore(path);
    expect(first.snapshot().values.search).toMatchObject({
      version: 2,
      sources: DEFAULT_SEARCH_SOURCES,
      categories: DEFAULT_SEARCH_CATEGORIES,
    });
    first.patch({
      search: {
        version: 2,
        sources: ['qq', 'app'],
        categories: ['file'],
        appEnabled: true,
        numberLookupEnabled: true,
      },
    });
    expect(new ClientStateStore(path).snapshot().values).toMatchObject({
      search: { sources: ['qq', 'app'], categories: ['file'] },
      background: 'paper',
    });
    first.patch({
      search: {
        version: 2,
        sources: [],
        categories: [],
        appEnabled: false,
        numberLookupEnabled: true,
      },
    });
    expect(new ClientStateStore(path).snapshot().values.search).toMatchObject({
      sources: [],
      categories: [],
    });
  });
  it('新 schema 拒绝非来源和已移除类型，不默默降级成全选', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-search-preferences-'));
    roots.push(root);
    const path = join(root, 'state.json');
    const store = new ClientStateStore(path);
    expect(() =>
      store.patch({
        search: {
          version: 2,
          sources: ['invalid'],
          categories: [],
          appEnabled: false,
          numberLookupEnabled: true,
        },
      }),
    ).toThrow('共享偏好');
    expect(() =>
      store.patch({
        search: {
          version: 2,
          sources: ['qq'],
          categories: ['groupAlbum'],
          appEnabled: false,
          numberLookupEnabled: true,
        },
      }),
    ).toThrow('共享偏好');
  });
});
