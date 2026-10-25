import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { setHost, type HostBridge } from '@weq/service';
import { exportViewerRouter } from '../src/main/ipc/routers/export_viewer';
import { closeViewerSources } from '../src/main/export_viewer';

vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => ({ services: null }) }));
const roots: string[] = [],
  ids: string[] = [];
afterEach(() => {
  closeViewerSources(ids.splice(0));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const caller = exportViewerRouter.createCaller({});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-viewer-scan-'));
  roots.push(root);
  setHost({ pickDirectory: async () => root } as unknown as HostBridge);
  return root;
}
const message = {
  msgId: '1',
  sendTime: 1,
  elements: [{ type: 'text', data: { textContent: '合成消息' } }],
};
function oldChat(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'chat.json'), JSON.stringify([message]));
}
it('混合新基线与旧 JSON 的一级目录全部列出，不因先发现基线而漏掉其他目录', async () => {
  const root = fixture();
  const baseline = join(root, 'new', '.weq-export');
  mkdirSync(baseline, { recursive: true });
  const selection = 'a'.repeat(64),
    journal = `messages-${selection}.jsonl`;
  writeFileSync(join(baseline, journal), `${JSON.stringify(message)}\n`);
  writeFileSync(
    join(baseline, 'baseline.json'),
    JSON.stringify({ version: 1, kind: 'group', conv: '777', selection, journal }),
  );
  oldChat(join(root, 'old'));
  const result = await caller.pick({ directory: true });
  ids.push(...result!.sources.map((s) => s.id));
  expect(result!.sources).toHaveLength(2);
  expect(result!.scanToken).toBeNull();
});
it('深层未确认前不注册来源，确认后使用一次性目录授权扫描', async () => {
  const root = fixture();
  oldChat(join(root, 'archive', 'chat'));
  const result = await caller.pick({ directory: true });
  expect(result!.sources).toHaveLength(0);
  expect(result!.scanToken).toBeTruthy();
  const scanned = await caller.scan({ token: result!.scanToken!, recursive: true });
  ids.push(...scanned!.sources.map((s) => s.id));
  expect(scanned!.sources).toHaveLength(1);
  await expect(caller.scan({ token: result!.scanToken!, recursive: true })).rejects.toThrow('过期');
});
it('取消递归撤销授权，不读取深层文件', async () => {
  const root = fixture();
  oldChat(join(root, 'archive', 'chat'));
  const result = await caller.pick({ directory: true });
  expect(await caller.scan({ token: result!.scanToken!, recursive: false })).toBeNull();
  await expect(caller.scan({ token: result!.scanToken!, recursive: true })).rejects.toThrow('过期');
});
