import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportFriends,
  exportGroupMembers,
  normaliseContactsFormats,
  type ContactsExportDeps,
} from '../src/account/export/contacts_export';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';

const roots: string[] = [];
function output() {
  const root = mkdtempSync(join(tmpdir(), 'weq-exact-contacts-'));
  roots.push(root);
  return join(root, 'contacts.json');
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const friends = ['a', 'b', 'c'].map((uid, index) => ({
    uid,
    uin: `${10001 + index}`,
    qid: '',
    categoryId: index === 2 ? 2 : 1,
  }));
  const profiles = vi.fn(async () => []);
  const deps: ContactsExportDeps = {
    listBuddies: async (limit, offset) => friends.slice(offset, offset + limit),
    profilesByUids: profiles,
    listCategories: async () => [],
    groupOwnerUid: async () => null,
    listGroupMembers: async (_group, limit, offset) =>
      friends
        .map((item) => ({
          uid: item.uid,
          uin: item.uin,
          nick: item.uid,
          card: '',
          adminFlag: 0,
          customTitle: '',
          memberLevel: 1,
          joinTime: 1,
          lastSpeakTime: 1,
        }))
        .slice(offset, offset + limit),
  };
  return { deps, profiles };
}

describe('联系人精确条目导出', () => {
  it('单文件任务另存后记录真实路径，后续另存失败保留已生成结果和上次保存位置', async () => {
    const { deps } = fixture(),
      cache = dirname(output());
    const manager = new ExportTaskManager({} as MsgService, cache, { contacts: deps });
    const id = await manager.startTask({
      kind: 'c2c',
      conv: '',
      name: '合成名单',
      format: 'json',
      total: 0,
      contacts: { scope: 'friends', uids: ['b'] },
    });
    await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
    const target = join(cache, '用户选择.json');
    expect(await manager.saveTaskOutput(id, undefined, target)).toBe(realpathSync(target));
    expect(manager.getTask(id)?.save).toMatchObject({
      status: 'saved',
      path: realpathSync(target),
    });
    await expect(manager.saveTaskOutput(id, join(cache, 'missing-directory'))).rejects.toThrow();
    const task = manager.getTask(id)!;
    expect(task.status).toBe('completed');
    expect(task.save).toMatchObject({ status: 'failed', path: realpathSync(target) });
    expect(existsSync(task.filePath!)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
  it('成员时间显示固定使用北京时间，不修改原始秒数或依赖服务器时区', async () => {
    vi.stubEnv('TZ', 'UTC');
    const { deps } = fixture();
    const joinTime = Date.parse('2026-10-17T17:02:03Z') / 1000;
    const row = {
      uid: 'b',
      uin: '10002',
      nick: '合成成员',
      card: '',
      adminFlag: 0,
      customTitle: '',
      memberLevel: 1,
      joinTime,
      lastSpeakTime: joinTime + 60,
    };
    deps.listGroupMembers = async () => [row];
    const outputPath = output();
    await exportGroupMembers({ groupCode: '10001', format: 'json', outputPath, uids: ['b'] }, deps);
    const result = JSON.parse(readFileSync(outputPath, 'utf8'))[0];
    expect(result.joinTime).toBe('2026-10-18 01:02');
    expect(result.lastSpeakTime).toBe('2026-10-18 01:03');
    expect(row.joinTime).toBe(joinTime);
  });
  it('超出日历范围的原始时间不导致整批导出失败，也不伪造有效日期', async () => {
    const { deps } = fixture();
    deps.listGroupMembers = async () => [
      {
        uid: 'b',
        uin: '10002',
        nick: '合成成员',
        card: '',
        adminFlag: 0,
        customTitle: '',
        memberLevel: 1,
        joinTime: Number.MAX_SAFE_INTEGER,
        lastSpeakTime: 0,
      },
    ];
    const outputPath = output();
    await exportGroupMembers({ groupCode: '10001', format: 'json', outputPath, uids: ['b'] }, deps);
    const result = JSON.parse(readFileSync(outputPath, 'utf8'))[0];
    expect(result.joinTime).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(result.lastSpeakTime).toBe('');
  });
  it('写入阶段通知触发取消时，不再启动文件写入', async () => {
    const { deps } = fixture();
    const cache = dirname(output());
    const manager = new ExportTaskManager({} as MsgService, cache, { contacts: deps });
    manager.on('progress', (progress) => {
      if (progress.message.startsWith('正在写入')) manager.cancelTask(progress.taskId);
    });
    const id = await manager.startTask({
      kind: 'c2c',
      conv: '',
      name: '合成阶段取消',
      format: 'json',
      total: 1,
      contacts: { scope: 'friends', uids: ['b'] },
    });
    await (manager as unknown as { queue: Promise<void> }).queue;
    expect(manager.getTask(id)?.status).toBe('cancelled');
    expect(existsSync(join(cache, `${id}.json`))).toBe(false);
  });
  it('格式去重并统一群成员 vCard 回退，不接受无法生成的格式', () => {
    expect(normaliseContactsFormats(['json', 'json', 'csv'], false)).toEqual(['json', 'csv']);
    expect(normaliseContactsFormats(['vcard', 'csv'], true)).toEqual(['csv']);
    expect(() => normaliseContactsFormats(['html'], false)).toThrow('不支持 html');
  });
  it('群成员 vCard 回退后的任务、产物与报告格式一致，保留所属群号', async () => {
    const { deps } = fixture();
    const manager = new ExportTaskManager({} as MsgService, dirname(output()), { contacts: deps });
    const id = await manager.startTask({
      kind: 'c2c',
      conv: '10001',
      name: '合成群成员',
      format: 'vcard',
      formats: ['vcard', 'csv'],
      total: 2,
      contacts: { scope: 'group', uids: ['a', 'c'] },
    });
    await (manager as unknown as { queue: Promise<void> }).queue;
    const task = manager.getTask(id)!;
    expect(task.status).toBe('completed');
    expect(task.format).toBe('csv');
    expect(task.formats).toEqual(['csv']);
    expect(task.current).toBe(2);
    expect(task.filePath).toMatch(/\.csv$/);
    expect(JSON.parse(readFileSync(task.reportPath!, 'utf8')).contacts).toEqual({
      scope: 'group',
      groupCode: '10001',
      uids: ['a', 'c'],
    });
  });
  it('多格式共用一次联系人数据，不重复计数或被后续源变化改写', async () => {
    const { deps } = fixture();
    const list = vi.fn(async () => [{ uid: 'b', uin: '10002', qid: '', categoryId: 1 }]);
    list
      .mockResolvedValueOnce([{ uid: 'b', uin: '10002', qid: '', categoryId: 1 }])
      .mockResolvedValue([{ uid: 'a', uin: '10001', qid: '', categoryId: 1 }]);
    deps.listBuddies = list;
    const cache = dirname(output());
    const manager = new ExportTaskManager({} as MsgService, cache, { contacts: deps });
    const id = await manager.startTask({
      kind: 'c2c',
      conv: '',
      name: '合成多格式',
      format: 'json',
      formats: ['json', 'txt'],
      total: 1,
      contacts: { scope: 'friends', uids: ['b'] },
    });
    await (manager as unknown as { queue: Promise<void> }).queue;
    const task = manager.getTask(id)!;
    expect(task.error).toBeUndefined();
    expect(task.status).toBe('completed');
    expect(list).toHaveBeenCalledOnce();
    expect(task.current).toBe(1);
    expect(task.total).toBe(1);
    expect(task.formatCounts).toEqual({ json: 1, txt: 1 });
    expect(existsSync(join(task.bundleDir!, '合成多格式.txt'))).toBe(true);
  });
  it('暂停后可在重启读取记录后按原精确目标重新执行，不冒充断点继续', async () => {
    const { deps } = fixture();
    const cache = dirname(output());
    let release!: () => void;
    let reading = false,
      first = true;
    deps.listBuddies = async () => {
      if (first) {
        first = false;
        reading = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return [{ uid: 'b', uin: '10002', qid: '', categoryId: 1 }];
    };
    const manager = new ExportTaskManager({} as MsgService, cache, { contacts: deps });
    const id = await manager.startTask({
      kind: 'c2c',
      conv: '',
      name: '合成暂停重启',
      format: 'json',
      total: 1,
      contacts: { scope: 'friends', uids: ['b'] },
    });
    await vi.waitFor(() => expect(reading).toBe(true));
    expect(manager.pauseTask(id)).toBe(true);
    release();
    await (manager as unknown as { queue: Promise<void> }).queue;
    expect(manager.getTask(id)?.status).toBe('paused');
    const restored = new ExportTaskManager({} as MsgService, cache, { contacts: deps });
    expect(restored.listTasks()[0]).toMatchObject({ canResume: true, resumeMode: 'restart' });
    expect(restored.resumeTask(id)).toBe(true);
    await (restored as unknown as { queue: Promise<void> }).queue;
    expect(restored.getTask(id)?.status).toBe('completed');
    expect(
      JSON.parse(readFileSync(restored.getTask(id)!.filePath!, 'utf8')).map(
        (row: { uid: string }) => row.uid,
      ),
    ).toEqual(['b']);
  });
  it('相同名称的联系人任务各自保留产物，不覆盖先前文件', async () => {
    const { deps } = fixture();
    const cache = dirname(output());
    const manager = new ExportTaskManager({} as MsgService, cache, { contacts: deps });
    const first = await manager.startTask({
      kind: 'c2c',
      conv: '',
      name: '同名联系人',
      format: 'json',
      total: 1,
      contacts: { scope: 'friends', uids: ['b'] },
    });
    await vi.waitFor(() => expect(manager.getTask(first)?.status).toBe('completed'), {
      timeout: 5000,
    });
    const firstPath = manager.getTask(first)!.filePath!;
    const before = readFileSync(firstPath, 'utf8');
    const second = await manager.startTask({
      kind: 'c2c',
      conv: '',
      name: '同名联系人',
      format: 'json',
      total: 1,
      contacts: { scope: 'friends', uids: ['a'] },
    });
    await vi.waitFor(() => expect(manager.getTask(second)?.status).toBe('completed'), {
      timeout: 5000,
    });
    expect(manager.getTask(second)!.filePath).not.toBe(firstPath);
    expect(readFileSync(firstPath, 'utf8')).toBe(before);
    expect(
      JSON.parse(readFileSync(manager.getTask(second)!.filePath!, 'utf8')).map(
        (row: { uid: string }) => row.uid,
      ),
    ).toEqual(['a']);
  });
  it.each(['b', 'missing'])(
    '读取目标 %s 期间取消不记为身份缺失失败，不继续补资料或写联系人文件',
    async (uid) => {
      const { deps, profiles } = fixture();
      const cache = dirname(output());
      let release!: () => void;
      let reading = false;
      deps.listBuddies = async () => {
        reading = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [{ uid: 'b', uin: '10002', qid: '', categoryId: 1 }];
      };
      const manager = new ExportTaskManager({} as MsgService, cache, { contacts: deps });
      const id = await manager.startTask({
        kind: 'c2c',
        conv: '',
        name: '合成等待取消',
        format: 'json',
        total: 1,
        contacts: { scope: 'friends', uids: [uid] },
      });
      await vi.waitFor(() => expect(reading).toBe(true));
      manager.cancelTask(id);
      release();
      await (manager as unknown as { queue: Promise<void> }).queue;
      expect(manager.getTask(id)?.status).toBe('cancelled');
      expect(manager.getTask(id)?.error).toBeUndefined();
      expect(profiles).not.toHaveBeenCalled();
      expect(existsSync(join(cache, `${id}.json`))).toBe(false);
      const report = manager.getTask(id)!.reportPath!;
      expect(manager.deleteTask(id)).toBe(true);
      expect(existsSync(report)).toBe(false);
    },
  );
  it('任务快照与重启后记录保留精确 UID，创建后的调用方修改不影响产物', async () => {
    const { deps } = fixture();
    const cache = dirname(output());
    const manager = new ExportTaskManager({} as MsgService, cache, { contacts: deps });
    const target = { scope: 'friends' as const, uids: ['b'] };
    const formats: Array<'json' | 'txt'> = ['json'];
    const id = await manager.startTask({
      kind: 'c2c',
      conv: '',
      name: '合成精确联系人',
      format: 'json',
      formats,
      total: 1,
      contacts: target,
    });
    target.uids[0] = 'c';
    formats[0] = 'txt';
    expect(manager.getTask(id)?.contacts?.uids).toEqual(['b']);
    expect(manager.getTask(id)?.formats).toEqual(['json']);
    await vi.waitFor(
      () => expect(['completed', 'failed', 'cancelled']).toContain(manager.getTask(id)?.status),
      { timeout: 5000 },
    );
    const task = manager.getTask(id)!;
    expect(task.error).toBeUndefined();
    expect(task.status).toBe('completed');
    expect(
      JSON.parse(readFileSync(task.filePath!, 'utf8')).map((row: { uid: string }) => row.uid),
    ).toEqual(['b']);
    expect(JSON.parse(readFileSync(task.reportPath!, 'utf8')).contacts).toEqual({
      scope: 'friends',
      uids: ['b'],
    });
    expect(new ExportTaskManager({} as MsgService, cache).getTask(id)?.contacts?.uids).toEqual([
      'b',
    ]);
    expect(manager.deleteTask(id)).toBe(true);
    expect(existsSync(task.filePath!)).toBe(false);
    expect(existsSync(task.reportPath!)).toBe(false);
  });
  it('只导出选定好友，补资料与头像集合不带出未选对象', async () => {
    const { deps, profiles } = fixture();
    const outputPath = output();
    const uins = new Set<string>();
    expect(
      await exportFriends({ format: 'json', outputPath, uids: ['b'], collectUins: uins }, deps),
    ).toMatchObject({ count: 1 });
    expect(
      JSON.parse(readFileSync(outputPath, 'utf8')).map((row: { uid: string }) => row.uid),
    ).toEqual(['b']);
    expect(profiles).toHaveBeenCalledWith(['b']);
    expect([...uins]).toEqual(['10002']);
  });
  it('好友分组与精确集合取交集，空集合不表示全部', async () => {
    const { deps } = fixture();
    await expect(
      exportFriends({ format: 'json', outputPath: output(), categoryIds: [2], uids: ['b'] }, deps),
    ).rejects.toThrow('部分选中的联系人');
    const path = output();
    expect(await exportFriends({ format: 'json', outputPath: path, uids: [] }, deps)).toMatchObject(
      { count: 0 },
    );
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([]);
  });
  it('群成员支持不连续的 UID 集合，不导出中间成员', async () => {
    const { deps } = fixture();
    const outputPath = output();
    const result = await exportGroupMembers(
      { groupCode: '10001', format: 'json', outputPath, uids: ['a', 'c'] },
      deps,
    );
    expect(result.count).toBe(2);
    expect(
      JSON.parse(readFileSync(outputPath, 'utf8')).map((row: { uid: string }) => row.uid),
    ).toEqual(['a', 'c']);
  });
  it('选中项已消失时明确失败，不产生看似成功的空文件或扩大范围', async () => {
    const { deps } = fixture();
    await expect(
      exportFriends({ format: 'json', outputPath: output(), uids: ['missing'] }, deps),
    ).rejects.toThrow('部分选中的联系人');
    await expect(
      exportGroupMembers(
        { groupCode: '10001', format: 'json', outputPath: output(), uids: ['a', 'missing'] },
        deps,
      ),
    ).rejects.toThrow('部分选中的联系人');
  });
});
