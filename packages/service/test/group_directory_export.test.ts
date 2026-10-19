import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectGroupDirectory,
  GROUP_DIRECTORY_PAGE,
  type ContactsExportDeps,
  type GroupDirectoryRow,
} from '../src/account/export/contacts_export';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(count = 3) {
  const rows: GroupDirectoryRow[] = Array.from({ length: count }, (_, i) => ({
    groupCode: String(10001 + i),
    groupName: `合成群${i}`,
    remark: i ? '' : '群备注',
    ownerUid: 'u_owner',
    memberCount: 3,
    maxMemberCount: 100,
    createTime: 1792256523,
    leaveFlag: 0,
  }));
  const listGroups = vi.fn(async (limit: number, offset: number) =>
    rows.slice(offset, offset + limit),
  );
  const listGroupMembers = vi.fn(async () => []),
    listBuddies = vi.fn(async () => []);
  const deps: ContactsExportDeps = {
    listGroups,
    listGroupMembers,
    listBuddies,
    listCategories: async () => [],
    profilesByUids: async () => [],
    groupOwnerUid: async () => null,
  };
  return { deps, rows, listGroups, listGroupMembers, listBuddies };
}
describe('群聊名单导出', () => {
  it('读取全部页，精确选择不混入成员或好友名单，空选择不回退全部', async () => {
    const count = 2 * GROUP_DIRECTORY_PAGE + 5;
    const f = fixture(count);
    expect(await collectGroupDirectory({}, f.deps)).toHaveLength(count);
    expect(f.listGroups.mock.calls).toEqual([
      [GROUP_DIRECTORY_PAGE, 0],
      [GROUP_DIRECTORY_PAGE, GROUP_DIRECTORY_PAGE],
      [GROUP_DIRECTORY_PAGE, 2 * GROUP_DIRECTORY_PAGE],
    ]);
    expect(
      (await collectGroupDirectory({ groupIds: [f.rows.at(-1)!.groupCode] }, f.deps)).map(
        (r) => r.groupCode,
      ),
    ).toEqual([f.rows.at(-1)!.groupCode]);
    expect(await collectGroupDirectory({ groupIds: [] }, f.deps)).toEqual([]);
    await expect(collectGroupDirectory({ groupIds: ['99999'] }, f.deps)).rejects.toThrow(
      /不在本地目录/,
    );
    expect(f.listGroupMembers).not.toHaveBeenCalled();
    expect(f.listBuddies).not.toHaveBeenCalled();
  });
  it.each([3, GROUP_DIRECTORY_PAGE + 1])(
    '取消读取不返回部分结果或开始下一页，条数 %s',
    async (count) => {
      const f = fixture(count),
        abort = new AbortController();
      await expect(
        collectGroupDirectory({ signal: abort.signal, onProgress: () => abort.abort() }, f.deps),
      ).rejects.toThrow();
      expect(f.listGroups).toHaveBeenCalledOnce();
      delete f.deps.listGroups;
      await expect(collectGroupDirectory({}, f.deps)).rejects.toThrow(/能力不可用/);
    },
  );
  it('群聊名单经现有任务管线导出多格式，群号保留字符串且选择快照不被改写', async () => {
    const f = fixture();
    const root = mkdtempSync(join(tmpdir(), 'weq-group-directory-'));
    roots.push(root);
    const manager = new ExportTaskManager({} as MsgService, root, { contacts: f.deps });
    const groupIds = ['10001'];
    const id = await manager.startTask({
      kind: 'c2c',
      conv: '',
      name: '合成群聊名单',
      format: 'json',
      formats: ['json', 'csv'],
      total: 0,
      contacts: { scope: 'groups', groupIds },
    });
    groupIds.push('10002');
    await vi.waitFor(() => expect(['completed', 'failed']).toContain(manager.getTask(id)?.status));
    const task = manager.getTask(id)!;
    expect(task.error).toBeUndefined();
    expect(task.status).toBe('completed');
    expect(task.formatCounts).toEqual({ json: 1, csv: 1 });
    const rows = JSON.parse(readFileSync(task.filePath!, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      groupCode: '10001',
      groupName: '合成群0',
      remark: '群备注',
      ownerUid: 'u_owner',
    });
    expect(readFileSync(join(task.bundleDir!, '合成群聊名单.csv'), 'utf8')).toContain('群号');
    expect(f.listGroups).toHaveBeenCalledOnce();
    expect(f.listGroupMembers).not.toHaveBeenCalled();
    expect(f.listBuddies).not.toHaveBeenCalled();
  });
});
