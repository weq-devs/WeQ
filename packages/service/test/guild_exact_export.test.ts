import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { GuildExportTaskMeta } from '../src/account/export/guild_source';
import type { GuildDirectService, RenderGuildDirectMsg } from '../src/account/guild_direct';
import type { MsgService } from '../src/account/msg';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const meta: GuildExportTaskMeta = {
  nodeId: '100',
  peerTinyId: '200',
  guildId: '300',
  guildName: '测试频道',
  peerNick: '测试好友',
  peerAvatarUrl: null,
  selfTinyId: '400',
  selfNick: '自己',
  selfUin: '',
  selfUid: '',
  selfAvatarUrl: null,
};

it.each([{ ids: ['9007199254740993', '5'] }, { ids: [] as string[] }])(
  '频道精确集合 $ids 贯穿实际多格式任务和持久恢复',
  async ({ ids: input }) => {
    const ids = [...input];
    const root = mkdtempSync(join(tmpdir(), 'weq-guild-exact-'));
    dirs.push(root);
    const rows = ['9007199254740993', '2', '5'].map((id, i) => ({
      msgId: BigInt(id),
      msgSeq: BigInt(i + 1),
      sendTime: BigInt(1700000000 + i),
      senderTinyId: 200n,
      sendType: 0n,
      nodeId: 100n,
      elements: [{ type: 'text', data: { textContent: `fixture-${id}` } }],
    })) as RenderGuildDirectMsg[];
    const guild = {
      getAfter: async (node: string, after: bigint, limit: number) => {
        expect(node).toBe(meta.nodeId);
        return rows.filter((row) => row.msgSeq > after).slice(0, limit);
      },
      countMessages: async () => rows.length,
    } as unknown as GuildDirectService;
    const deps = { guildDirect: guild };
    const manager = new ExportTaskManager({} as MsgService, root, deps);
    const expected = [...ids];
    const id = await manager.startTask({
      kind: 'c2c',
      conv: meta.peerTinyId,
      name: '频道精确选择',
      format: 'txt',
      formats: ['txt', 'json', 'csv'],
      total: ids.length,
      guild: meta,
      filter: { messageIds: ids },
    });
    ids.push('2');
    for (let i = 0; i < 500 && !['completed', 'failed'].includes(manager.getTask(id)!.status); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const task = manager.getTask(id)!;
    expect(task.error).toBeUndefined();
    expect(task.status).toBe('completed');
    expect(task.formatCounts).toEqual({
      txt: expected.length,
      json: expected.length,
      csv: expected.length,
    });
    const text = readFileSync(task.filePath!, 'utf8');
    expect(text).not.toContain('fixture-2');
    for (const selected of expected) expect(text).toContain(`fixture-${selected}`);
    const restored = new ExportTaskManager({} as MsgService, root, deps).getTask(id)!;
    expect(restored.filter?.messageIds).toEqual(expected);
    expect(restored.guild?.nodeId).toBe(meta.nodeId);
  },
);
