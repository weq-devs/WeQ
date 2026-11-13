import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  dataSaverEnabled,
  networkCost,
  UNKNOWN_NETWORK,
  TransferGate,
  LARGE_TRANSFER_BYTES,
  shouldPauseTransfer,
} from '../src/common/data_saver';
import { validatePreferencePatch } from '../src/common/client_preferences';
import {
  updateTransferPolicy,
  updateClientNetwork,
  transferRestricted,
} from '../src/common/transfer_policy';
import { networkScope } from '../src/common/network_scope';
import { ManagedDownload } from '../src/common/managed_download';
import { ModelStore } from '../src/common/model_store';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  updateTransferPolicy('auto', UNKNOWN_NETWORK);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('共享偏好仅接受三种模式；未知状态不冒充已检测的不受限', () => {
  for (const dataSaverMode of ['auto', 'always', 'never'])
    expect(() => validatePreferencePatch({ dataSaverMode })).not.toThrow();
  expect(() => validatePreferencePatch({ dataSaverMode: 'wifi' })).toThrow();
  const restricted = networkCost(false, true, 'synthetic');
  expect(dataSaverEnabled('auto', UNKNOWN_NETWORK)).toBe(false);
  expect(UNKNOWN_NETWORK.state).toBe('unknown');
  expect(dataSaverEnabled('auto', UNKNOWN_NETWORK, restricted)).toBe(true);
  expect(dataSaverEnabled('never', restricted)).toBe(false);
  expect(dataSaverEnabled('always', UNKNOWN_NETWORK)).toBe(true);
});
it('客户端状态互不接管；宿主限制与全局设置分别生效', () => {
  updateClientNetwork('phone-a', networkCost(true, false, 'synthetic'));
  updateClientNetwork('phone-b', networkCost(false, false, 'synthetic'));
  expect(transferRestricted('phone-a')).toBe(true);
  expect(transferRestricted('phone-b')).toBe(false);
  expect(transferRestricted()).toBe(false);
  updateTransferPolicy('auto', networkCost(false, true, 'host'));
  expect(transferRestricted('phone-b')).toBe(true);
  updateTransferPolicy('never', UNKNOWN_NETWORK);
  expect(transferRestricted('phone-a')).toBe(false);
});
it('阈值为至少 10 MiB；批量联网任务暂停，纯本地工作不使用传输门禁', () => {
  expect(shouldPauseTransfer(true, false, LARGE_TRANSFER_BYTES - 1)).toBe(false);
  expect(shouldPauseTransfer(true, false, LARGE_TRANSFER_BYTES)).toBe(true);
  expect(shouldPauseTransfer(true, false, 0, LARGE_TRANSFER_BYTES)).toBe(true);
  expect(shouldPauseTransfer(true, true)).toBe(true);
  expect(shouldPauseTransfer(false, true)).toBe(false);
});
it('多来源限制全部解除才恢复；用户暂停不会被网络恢复解除，逐任务继续不更改其他任务', async () => {
  const gate = new TransferGate();
  gate.restrict('host', true);
  gate.restrict('phone', true);
  const resumed = vi.fn();
  const work = gate.wait().then(resumed);
  gate.restrict('host', false);
  await Promise.resolve();
  expect(resumed).not.toHaveBeenCalled();
  gate.pause();
  gate.restrict('phone', false);
  await Promise.resolve();
  expect(resumed).not.toHaveBeenCalled();
  gate.continue();
  await work;
  expect(resumed).toHaveBeenCalledOnce();
  gate.restrict('host', true);
  expect(gate.paused).toBe(false);
  const other = new TransferGate();
  other.restrict('host', true);
  expect(other.paused).toBe(true);
});
it('真实取消在途请求并保留分段，恢复时校验 Range 和资源身份后续写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-transfer-'));
  roots.push(root);
  let paused!: () => void;
  const reachedPause = new Promise<void>((resolve) => {
    paused = resolve;
  });
  let aborted = false;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (fetcher.mock.calls.length === 1)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('ab'));
            init?.signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                controller.error(init.signal?.reason);
              },
              { once: true },
            );
          },
        }),
        { headers: { 'Content-Length': '4', ETag: '"v1"' } },
      );
    expect(new Headers(init?.headers).get('range')).toBe('bytes=2-');
    expect(new Headers(init?.headers).get('if-range')).toBe('"v1"');
    return new Response('cd', {
      status: 206,
      headers: { 'Content-Range': 'bytes 2-3/4', 'Content-Length': '2', ETag: '"v1"' },
    });
  });
  const download = new ManagedDownload({
    batch: true,
    fetcher,
    state: (state) => {
      if (state.paused) paused();
    },
  });
  let switched = false;
  const work = download.file('https://synthetic.invalid/file', join(root, 'file'), {}, () => {
    if (!switched) {
      switched = true;
      updateTransferPolicy('auto', networkCost(true, false, 'test'));
    }
  });
  await reachedPause;
  expect(aborted).toBe(true);
  updateTransferPolicy('auto', UNKNOWN_NETWORK);
  await Promise.resolve();
  expect(fetcher).toHaveBeenCalledOnce();
  updateTransferPolicy('auto', networkCost(false, false, 'test'));
  await work;
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('abcd');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('任务拥有发起客户端身份；受限手机任务不发请求，其他端不受影响', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-transfer-owner-'));
  roots.push(root);
  updateClientNetwork('limited-phone', networkCost(false, true, 'phone'));
  const fetcher = vi.fn<typeof fetch>(async () => new Response('ok'));
  const transfer = networkScope.run(
    { clientId: 'limited-phone', restricted: true, intent: 'interactive' },
    () => new ManagedDownload({ batch: true, fetcher }),
  );
  const work = transfer.file('https://synthetic.invalid/file', join(root, 'file'));
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalled();
  transfer.continue();
  await work;
  expect(await readFile(join(root, 'file'), 'utf8')).toBe('ok');
  expect(transferRestricted('limited-phone')).toBe(true);
});
it('宿主已有大文件仍暂停到受限客户端的字节传输，单任务继续后正常交付', async () => {
  updateClientNetwork('stream-phone', networkCost(false, true, 'phone'));
  const transfer = networkScope.run(
    { clientId: 'stream-phone', restricted: true, intent: 'interactive' },
    () => new ManagedDownload(),
  );
  const response = transfer.response(
    new Response('cached bytes', { headers: { 'Content-Length': String(LARGE_TRANSFER_BYTES) } }),
  );
  let completed = false;
  const work = response.text().then((text) => {
    completed = true;
    return text;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(completed).toBe(false);
  transfer.continue();
  expect(await work).toBe('cached bytes');
});
it('模型任务真实等待策略解除，用户暂停不会被自动恢复，完整文件可复用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-model-policy-'));
  roots.push(root);
  class FixtureModels extends ModelStore<import('../src/common/model_store').ModelEntry> {
    constructor() {
      super(root, [
        {
          id: 'fixture',
          sizeBytes: 4,
          files: [
            { key: 'model', name: 'model.bin', url: 'https://synthetic.invalid/model', weight: 1 },
          ],
        },
      ]);
    }
  }
  const store = new FixtureModels();
  const fetcher = vi.fn(async () => new Response('data', { headers: { 'Content-Length': '4' } }));
  vi.stubGlobal('fetch', fetcher);
  updateTransferPolicy('always', UNKNOWN_NETWORK);
  let paused = false;
  store.on('progress', (state) => {
    if (state.paused) paused = true;
  });
  const work = store.downloadModel('fixture');
  await vi.waitFor(() => expect(paused).toBe(true));
  expect(fetcher).not.toHaveBeenCalled();
  store.pauseDownload('fixture');
  updateTransferPolicy('auto', UNKNOWN_NETWORK);
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalled();
  store.continueDownload('fixture');
  expect(await work).toEqual({ success: true });
  expect(await readFile(join(root, 'fixture', 'model.bin'), 'utf8')).toBe('data');
  await store.downloadModel('fixture');
  expect(fetcher).toHaveBeenCalledOnce();
});
