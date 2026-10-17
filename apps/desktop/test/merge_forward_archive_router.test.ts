import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeForwardRouter } from '../src/main/ipc/routers/merge_forward';

const state = vi.hoisted(() => ({
  root: '',
  uin: '10001',
  configId: 'synthetic-a',
  allowed: false,
  trusted: [] as string[],
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: state.uin ? { context: { uin: state.uin } } : null,
    services: {
      accountConfig: { getRecord: () => ({ configId: state.configId }) },
      fileResource: {
        resolveLocalFile: async (path: string) => (state.allowed ? path : null),
        trustPath: (path: string) => state.trusted.push(path),
      },
    },
  }),
  requireBootstrap: () => ({ userConfig: { cacheDir: () => join(state.root, 'cache') } }),
  requirePlatform: () => ({ appDataRoot: () => state.root }),
}));

afterEach(() => {
  if (state.root) rmSync(state.root, { recursive: true, force: true });
  state.root = '';
  state.uin = '10001';
  state.configId = 'synthetic-a';
  state.allowed = false;
  state.trusted = [];
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic-a' };
const draft = {
  id: 'draft-fixture',
  nodes: [
    {
      id: 'node-fixture',
      sender: { uid: 'u_fixture', uin: '10001', name: '合成作者' },
      time: 1,
      segs: [{ t: 'text', text: '合成内容' }],
    },
  ],
};
function caller() {
  state.root = mkdtempSync(join(tmpdir(), 'weq-mf-router-'));
  return mergeForwardRouter.createCaller({});
}

describe('合成归档路由账号边界', () => {
  it('绑定创建账号和配置，切号或切到同号不同来源后不读写其它归档', async () => {
    const api = caller();
    await expect(
      api.archiveList({ expectedAccountUin: '10001', kind: 'history' } as never),
    ).rejects.toThrow('expectedAccountConfigId');
    const saved = await api.archiveAppend({ ...binding, kind: 'history', draft });
    state.uin = '10002';
    await expect(api.archiveList({ ...binding, kind: 'history' })).rejects.toThrow(
      '所属账号已切换',
    );
    await expect(api.archiveAppend({ ...binding, kind: 'material', draft })).rejects.toThrow(
      '所属账号已切换',
    );
    await expect(api.archiveRemove({ ...binding, kind: 'history', id: saved.id })).rejects.toThrow(
      '所属账号已切换',
    );
    state.uin = '10001';
    state.configId = 'synthetic-static';
    await expect(api.archiveList({ ...binding, kind: 'history' })).rejects.toThrow(
      '所属账号已切换',
    );
    state.configId = binding.expectedAccountConfigId;
    expect(await api.archiveList({ ...binding, kind: 'history' })).toHaveLength(1);
    state.uin = '';
    await expect(api.list()).rejects.toThrow('尚未打开账号');
  });

  it('归档前验证媒体访问，永久副本不落在可清理缓存中', async () => {
    const api = caller();
    const source = join(state.root, 'synthetic.png');
    writeFileSync(source, 'synthetic-image');
    const mediaDraft = {
      ...draft,
      nodes: [{ ...draft.nodes[0]!, segs: [{ t: 'image', path: source }] }],
    };
    await expect(
      api.archiveAppend({ ...binding, kind: 'material', draft: mediaDraft }),
    ).rejects.toThrow('媒体访问未授权');
    state.allowed = true;
    const saved = await api.archiveAppend({ ...binding, kind: 'material', draft: mediaDraft });
    const path = (saved.nodes[0]!.segs[0] as { path: string }).path;
    expect(path).toContain(join(state.root, 'merge-forward', state.configId, 'archive', 'media'));
    expect(path).not.toContain(join(state.root, 'cache'));
    expect(state.trusted).toContain(path);
    state.allowed = false;
    const reused = await api.archiveAppend({ ...binding, kind: 'history', draft: saved });
    expect(reused.nodes).toEqual(saved.nodes);
    expect(await api.archiveRemove({ ...binding, kind: 'material', id: saved.id })).toBe(true);
    expect(await api.archiveList({ ...binding, kind: 'history' })).toHaveLength(1);
  });

  it('非媒体分段不能借任意 path 字段扩大预览信任名单', async () => {
    const api = caller();
    await api.archiveAppend({
      ...binding,
      kind: 'material',
      draft: {
        ...draft,
        nodes: [
          {
            ...draft.nodes[0]!,
            segs: [{ t: 'text', text: '正文', path: '/synthetic/private-file' }],
          },
        ],
      },
    });
    expect(state.trusted).not.toContain('/synthetic/private-file');
  });
});
