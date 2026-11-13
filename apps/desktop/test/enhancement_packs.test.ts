// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  EnhancementPacks,
  type EnhancementComponent,
  type EnhancementComponentState,
} from '../src/main/enhancements/packs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weq-packs-'));
  roots.push(root);
  const state = new Map<string, EnhancementComponentState>();
  const components = new Map<string, EnhancementComponent>();
  for (const [id, bytes] of [
    ['engine:onnx', 20],
    ['text-model', 100],
    ['intent-model', 200],
    ['dress-index', 30],
  ] as const) {
    state.set(id, { ready: false, sizeOnDisk: 0, downloadBytes: bytes, identity: 'absent' });
    components.set(id, {
      id,
      state: () => state.get(id)!,
      ensure: vi.fn(async () => {
        state.set(id, {
          ready: true,
          sizeOnDisk: bytes,
          downloadBytes: 0,
          identity: `present:${id}`,
        });
      }),
      remove: vi.fn(async () => {
        state.set(id, { ready: false, sizeOnDisk: 0, downloadBytes: bytes, identity: 'absent' });
      }),
    });
  }
  const validate = vi.fn(async () => {});
  const definitions = [
    {
      id: 'text' as const,
      name: '文字',
      description: '',
      components: ['engine:onnx', 'text-model'],
      validate,
    },
    {
      id: 'intent' as const,
      name: '意图',
      description: '',
      components: ['engine:onnx', 'intent-model'],
      validate,
    },
    { id: 'dress' as const, name: '装扮', description: '', components: ['dress-index'], validate },
  ];
  const packs = new EnhancementPacks(definitions, components, root);
  return { root, state, components, packs, validate, definitions };
}

it('下载全部只计算一份共享引擎；已有模型复用且实际加载后才就绪', async () => {
  const f = await fixture();
  expect(f.packs.plan(['text', 'intent'])).toEqual({ downloadBytes: 320, sizeOnDisk: 0 });
  f.state.set('text-model', { ready: true, sizeOnDisk: 100, downloadBytes: 0, identity: 'legacy' });
  expect(f.packs.plan(['text', 'intent']).downloadBytes).toBe(220);
  f.packs.start(['text', 'intent', 'text']);
  await f.packs.wait();
  expect((await f.packs.list()).slice(0, 2).every((pack) => pack.ready)).toBe(true);
  expect(f.components.get('engine:onnx')!.ensure).toHaveBeenCalledTimes(2);
  expect(f.validate).toHaveBeenCalledTimes(2);
  const restarted = new EnhancementPacks(f.definitions, f.components, f.root);
  expect((await restarted.list()).slice(0, 2).every((pack) => pack.ready)).toBe(true);
});

it('删除文字包保留意图使用的 ONNX，最后一个使用者删除后再释放引擎', async () => {
  const f = await fixture();
  f.packs.start(['text', 'intent']);
  await f.packs.wait();
  await f.packs.remove('text');
  expect(f.components.get('engine:onnx')!.remove).not.toHaveBeenCalled();
  expect((await f.packs.list()).find((pack) => pack.id === 'intent')!.ready).toBe(true);
  await f.packs.remove('intent');
  expect(f.components.get('engine:onnx')!.remove).toHaveBeenCalledTimes(1);
});

it('一个包失败仍继续其余包；实际加载失败不发布就绪，重试复用已有文件', async () => {
  const f = await fixture();
  f.validate.mockRejectedValueOnce(new Error('load failed'));
  f.packs.start(['text', 'dress']);
  await f.packs.wait();
  const list = await f.packs.list();
  expect(list.find((pack) => pack.id === 'text')).toMatchObject({
    ready: false,
    operation: { phase: 'failed', error: 'load failed' },
  });
  expect(list.find((pack) => pack.id === 'dress')!.ready).toBe(true);
  expect(f.packs.plan(['text']).downloadBytes).toBe(0);
  f.packs.start(['text']);
  await f.packs.wait();
  expect((await f.packs.list()).find((pack) => pack.id === 'text')!.ready).toBe(true);
});

it('在途准备或推理不能删除；未知 ID 不会扩大文件操作范围', async () => {
  const f = await fixture();
  let release = () => {};
  f.components.get('text-model')!.ensure = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  f.packs.start(['text']);
  await expect(f.packs.remove('text')).rejects.toThrow('正在下载或使用');
  await vi.waitFor(() => expect(f.components.get('text-model')!.ensure).toHaveBeenCalled());
  release();
  await f.packs.wait();
  f.components.get('engine:onnx')!.busy = () => true;
  await expect(f.packs.remove('text')).rejects.toThrow('正在下载或使用');
  expect(f.components.get('text-model')!.remove).not.toHaveBeenCalled();
});

it('用户自行放入的兼容模型保留共享引擎；文件身份变化要求重新检查', async () => {
  const f = await fixture();
  f.packs.start(['text']);
  await f.packs.wait();
  f.state.get('text-model')!.identity = 'changed';
  expect((await f.packs.list())[0]!.ready).toBe(false);
  f.components.get('engine:onnx')!.retained = () => true;
  await f.packs.remove('text');
  expect(f.components.get('engine:onnx')!.remove).not.toHaveBeenCalled();
});

it('旧完整资源由程序自动检查，不自动下载；校验失败也不开始网络修复', async () => {
  const f = await fixture();
  for (const [id, component] of f.components) {
    f.state.set(id, { ready: true, sizeOnDisk: 10, downloadBytes: 0, identity: 'legacy' });
    component.check = vi.fn(async () => {});
  }
  await f.packs.reconcileExisting();
  await f.packs.wait();
  expect((await f.packs.list()).every((pack) => pack.ready)).toBe(true);
  for (const component of f.components.values()) expect(component.ensure).not.toHaveBeenCalled();
  f.state.get('text-model')!.identity = 'bad';
  f.components.get('text-model')!.check = vi.fn(async () => {
    throw new Error('bad legacy file');
  });
  await f.packs.reconcileExisting();
  await f.packs.wait();
  expect((await f.packs.list()).find((pack) => pack.id === 'text')).toMatchObject({
    ready: false,
    operation: { phase: 'failed' },
  });
  expect(f.components.get('text-model')!.ensure).not.toHaveBeenCalled();
});

it('已安装能力的兼容引擎更新由程序协调，不把模型重新下载或新增人工更新步骤', async () => {
  const f = await fixture();
  f.packs.start(['text']);
  await f.packs.wait();
  f.state.get('engine:onnx')!.updateAvailable = true;
  f.state.get('engine:onnx')!.downloadBytes = 20;
  await f.packs.reconcileExisting();
  await f.packs.wait();
  expect(f.components.get('engine:onnx')!.ensure).toHaveBeenCalledTimes(2);
  expect((await f.packs.list()).find((pack) => pack.id === 'text')!.ready).toBe(true);
});
