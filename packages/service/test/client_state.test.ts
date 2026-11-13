import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientStateStore } from '../src/bootstrap/client_state';
import { preferenceDefaults } from '../src/common/client_preferences';

const roots: string[] = [];
function store() {
  const root = mkdtempSync(join(tmpdir(), 'weq-client-state-'));
  roots.push(root);
  return new ClientStateStore(join(root, 'state.json'));
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('跨端偏好与功能状态', () => {
  it.each([false, true])(
    '清理旧副本及容量记录，保留正式草稿与其他文件（分文件：%s）',
    (external) => {
      const state = store();
      const root = join(state.path, '..', 'client-state-drafts');
      mkdirSync(root);
      const file = (key: string) =>
        join(root, `${createHash('sha256').update(key).digest('hex')}.json`);
      const draft = { version: 'draft-v1', value: '正文' };
      const copy = { version: 'copy-v1', value: { content: '旧内容' } };
      const drafts = {
        'assistant:new': draft,
        'copy:old': copy,
        'copy:deleted': { version: 'v2', value: null },
      };
      for (const [key, value] of Object.entries(drafts))
        writeFileSync(file(key), JSON.stringify({ key, ...value }));
      rmSync(file('copy:deleted'));
      writeFileSync(join(root, 'unrelated.json'), 'untouched');
      writeFileSync(
        state.path,
        JSON.stringify({
          epoch: 'fixture',
          revision: 1,
          values: { background: 'grid' },
          records: { pins: { '123': true } },
          externalDrafts: external,
          drafts: external
            ? Object.fromEntries(
                Object.entries(drafts).map(([key, value]) => [key, { ...value, value: null }]),
              )
            : drafts,
          draftBytes: {
            'assistant:new': 100,
            'copy:old': 32 * 1024 * 1024,
            'copy:deleted': 50,
            'copy:orphan': 100,
          },
        }),
      );
      expect(state.draft('assistant:new')).toEqual(draft);
      const backup = state.exportState();
      expect(Object.keys(backup.drafts)).toEqual(['assistant:new']);
      expect(state.snapshot()).toMatchObject({
        values: { background: 'grid' },
        records: { pins: { '123': true } },
      });
      const persisted = JSON.parse(readFileSync(state.path, 'utf8'));
      expect(persisted.draftBytes).toEqual({ 'assistant:new': 100 });
      expect(existsSync(file('copy:old'))).toBe(false);
      expect(existsSync(file('copy:deleted'))).toBe(false);
      expect(existsSync(file('assistant:new'))).toBe(true);
      expect(readFileSync(join(root, 'unrelated.json'), 'utf8')).toBe('untouched');
      const after = readFileSync(state.path, 'utf8');
      new ClientStateStore(state.path).snapshot();
      expect(readFileSync(state.path, 'utf8')).toBe(after);
      expect(state.saveDraft('assistant:new', '继续编辑', draft.version).ok).toBe(true);
    },
  );
  it('旧客户端不能再创建副本草稿', () => {
    const state = store();
    expect(() => state.saveDraft('copy:legacy', { content: 'old' }, null)).toThrow('标识无效');
    expect(Object.keys(state.exportState().drafts)).toEqual([]);
  });
  it('悬停保持会话位置默认关闭，保存后跨端持久共享且只接受布尔值', () => {
    const state = store();
    expect(preferenceDefaults.keepConversationPositionOnHover).toBe(false);
    state.patch({ keepConversationPositionOnHover: true });
    expect(new ClientStateStore(state.path).snapshot().values.keepConversationPositionOnHover).toBe(
      true,
    );
    expect(() => state.patch({ keepConversationPositionOnHover: 'true' })).toThrow();
  });
  it('联系人更新范围与排序共用账号状态，只接受实际提供的范围值', () => {
    const state = store();
    state.records('order', { refreshRange: 'all' });
    expect(state.snapshot().records.order?.refreshRange).toBe('all');
    expect(() => state.records('order', { refreshRange: 'unknown' })).toThrow('刷新范围');
  });
  it('共享恢复回执幂等，确认重试不能覆盖恢复之后的新修改', () => {
    const state = store();
    const receipt = '11111111-1111-4111-8111-111111111111';
    state.restorePreferences({ background: 'grid', privacyMode: true }, receipt);
    state.patch({ background: 'paper' });
    state.restorePreferences({ background: 'grid', privacyMode: true }, receipt);
    expect(state.snapshot().values).toMatchObject({ background: 'paper', privacyMode: true });
  });
  it('背景由一个客户端保存后，另一个读取同一份持久值并收到通知', () => {
    const state = store();
    const events: unknown[] = [];
    const stop = state.subscribe((event) => events.push(event));
    state.patch({ background: 'grid' });
    expect(state.snapshot().values.background).toBe('grid');
    expect(new ClientStateStore(state.path).snapshot().values.background).toBe('grid');
    expect(events).toHaveLength(1);
    stop();
  });
  it('字段更新不覆盖其他字段，桌面迁移只填充缺失项', () => {
    const state = store();
    state.patch({ background: 'dots' });
    state.seed({ background: 'paper', accent: '#123456' });
    state.seed({ accent: '#ffffff' });
    expect(state.snapshot().values).toMatchObject({ background: 'dots', accent: '#123456' });
    expect(() => state.patch({ unknown: true })).toThrow();
    expect(() => state.patch({ background: 'unknown' })).toThrow();
  });
  it('旧功能状态只能补缺，不会复活已取消的置顶', () => {
    const state = store();
    state.records('pins', { '123': true }, true);
    state.records('pins', { '123': null });
    state.records('pins', { '123': true }, true);
    expect(state.snapshot().records.pins?.['123']).toBeNull();
  });
  it('已清空草稿保留版本，旧稿不能覆盖或复活', () => {
    const state = store();
    const first = state.saveDraft('chat:1', 'first', null);
    expect(first.ok).toBe(true);
    const version = state.draft('chat:1').version;
    expect(state.saveDraft('chat:1', '', version).ok).toBe(true);
    const conflict = state.saveDraft('chat:1', 'stale', version);
    expect(conflict.ok).toBe(false);
    expect(state.draft('chat:1').value).toBe('');
  });
  it('保存失败不发布成功事件', () => {
    const state = new ClientStateStore('/dev/null/weq-state.json');
    let calls = 0;
    state.subscribe(() => calls++);
    expect(() => state.patch({ background: 'grid' })).toThrow();
    expect(calls).toBe(0);
  });
  it('大草稿不进入设置与账号状态快照，备份展开正文，恢复后仍可继续保存', () => {
    const state = store();
    const text = 'synthetic-'.repeat(100_000);
    const result = state.saveDraft('assistant:large', text, null);
    expect(result.ok).toBe(true);
    expect(readFileSync(state.path, 'utf8').length).toBeLessThan(2048);
    expect(JSON.stringify(state.snapshot())).not.toContain('synthetic-');
    state.records('pins', { '123': true });
    expect(state.draft('assistant:large').value).toBe(text);
    const backup = state.exportState();
    expect(backup.drafts['assistant:large']?.value).toBe(text);
    const destination = store();
    writeFileSync(destination.path, JSON.stringify(backup));
    const restored = destination.draft('assistant:large');
    expect(destination.saveDraft('assistant:large', 'new', restored.version).ok).toBe(true);
    expect(destination.draft('assistant:large').value).toBe('new');
  });
  it('QQ 外部修改被独立重读识别，两个并发写只有一份获准覆盖', async () => {
    const state = store();
    let actual: unknown = ['QQ 原稿'];
    const base = state.observeDraft('chat:c2c:u_test', actual);
    actual = ['QQ 外部改稿'];
    const stale = await state.saveExternalDraft(
      'chat:c2c:u_test',
      ['旧端'],
      base.version,
      async () => actual,
      async () => {
        actual = ['旧端'];
      },
    );
    expect(stale.ok).toBe(false);
    expect(actual).toEqual(['QQ 外部改稿']);
    const current = state.draft('chat:c2c:u_test').version;
    const results = await Promise.all(
      ['A', 'B'].map((value) =>
        state.saveExternalDraft(
          'chat:c2c:u_test',
          [value],
          current,
          async () => actual,
          async () => {
            actual = [value];
          },
        ),
      ),
    );
    expect(results.map((result) => result.ok)).toEqual([true, false]);
    expect(actual).toEqual(['A']);
  });
  it('外部草稿写入失败时保留原版本，不宣称新稿已保存', async () => {
    const state = store();
    const before = state.observeDraft('chat:1', ['original']);
    await expect(
      state.saveExternalDraft(
        'chat:1',
        ['new'],
        before.version,
        async () => ['original'],
        async () => {
          throw new Error('locked');
        },
      ),
    ).rejects.toThrow('locked');
    expect(state.draft('chat:1')).toEqual(before);
  });
});
