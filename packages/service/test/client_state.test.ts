import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientStateStore } from '../src/bootstrap/client_state';
import {
  directoryUnreadKey,
  generatedMuteKey,
  preferenceDefaults,
} from '../src/common/client_preferences';

const failure = vi.hoisted(() => ({ path: '', body: false }));
vi.mock('../src/common/atomic_write', async (original) => {
  const actual = await original<typeof import('../src/common/atomic_write')>();
  return {
    ...actual,
    writeFileAtomicSync: (path: string, data: string | Uint8Array) => {
      if (path === failure.path || (failure.body && path.includes('client-state-drafts')))
        throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
      actual.writeFileAtomicSync(path, data);
    },
  };
});

const roots: string[] = [];
function store() {
  const root = mkdtempSync(join(tmpdir(), 'weq-client-state-'));
  roots.push(root);
  return new ClientStateStore(join(root, 'state.json'));
}
afterEach(() => {
  failure.path = '';
  failure.body = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('跨端偏好与功能状态', () => {
  it('生成会话的免打扰与其他通知范围独立持久化', () => {
    const state = store();
    const key = generatedMuteKey('virtual:persona:one');
    const mentionMe = { mode: 'selected', targets: ['group:10001'] };
    state.records('notifications', { [key]: true });
    state.records('notifications', { mentionMe });
    expect(new ClientStateStore(state.path).snapshot().records.notifications).toEqual({
      [key]: true,
      mentionMe,
    });
    state.records('notifications', { [key]: false });
    expect(state.snapshot().records.notifications).toEqual({ [key]: false, mentionMe });
  });
  it('专类会话手动未读不倒退水位，迟到自动阅读和撤销不覆盖较新的状态', () => {
    const state = store();
    const assistant = { key: 'assistant:one', position: '20' };
    const feed = { key: 'official:two', position: '9:5:-1' };
    const marker = directoryUnreadKey(assistant.key);
    state.records('reads', { [assistant.key]: '20', [feed.key]: '8:1:-1' });
    const reminder = state.setDirectoryReadState([assistant], true);
    state.records('reads', { [assistant.key]: '20' });
    const reopened = new ClientStateStore(state.path);
    expect(reopened.snapshot().records.reads).toMatchObject({
      [assistant.key]: '20',
      [marker]: reminder[0]?.after.marker,
    });
    reopened.records('reads', {
      [assistant.key]: { position: '20', marker: reminder[0]?.after.marker },
    });
    expect(reopened.undoDirectoryReadState(reminder)).toBe(0);
    expect(reopened.snapshot().records.reads?.[marker]).toBeUndefined();
    const cleared = reopened.setDirectoryReadState([{ ...assistant, position: '30' }, feed], false);
    reopened.records('reads', { [assistant.key]: '31' });
    expect(reopened.undoDirectoryReadState(cleared)).toBe(1);
    expect(reopened.snapshot().records.reads).toMatchObject({
      [assistant.key]: '31',
      [feed.key]: '8:1:-1',
    });
  });
  it('阅读水位单调递增，迟到写入及初始化不能覆盖较新阅读位置，重开后保留', () => {
    const state = store();
    state.records('reads', { 'guild:1': '9007199254740993', 'assistant:one': '10' });
    state.records('reads', { 'guild:1': '9007199254740992', 'assistant:one': '12' });
    state.records('reads', { 'assistant:one': '20' }, true);
    expect(new ClientStateStore(state.path).snapshot().records.reads).toEqual({
      'guild:1': '9007199254740993',
      'assistant:one': '12',
    });
    expect(() => state.records('reads', { 'guild:1': '-1' })).toThrow('阅读位置');
    expect(() => state.records('reads', { 'guild:1': null })).toThrow('阅读位置');
    state.records('reads', { 'guild:two': '0:10:-5' });
    state.records('reads', { 'guild:two': '0:10:-4' });
    state.records('reads', { 'guild:two': '0:9:100' });
    expect(state.snapshot().records.reads?.['guild:two']).toBe('0:10:-4');
  });
  it('连续保存只保留当前正文，通知失败不破坏已成功提交的版本', () => {
    const state = store();
    state.subscribe(() => {
      throw new Error('synthetic subscriber failure');
    });
    let version: string | null = null;
    for (let i = 0; i < 20; i++)
      version = state.saveDraft('assistant:gc', `value-${i}`, version).current.version;
    expect(new ClientStateStore(state.path).draft('assistant:gc')).toEqual({
      version,
      value: 'value-19',
    });
    expect(readdirSync(join(state.path, '..', 'client-state-drafts'))).toHaveLength(1);
  });
  it('旧分文件迁移的索引失败保留原路径，成功后才清理旧正文', () => {
    const state = store();
    const key = 'assistant:legacy';
    const dir = join(state.path, '..', 'client-state-drafts');
    mkdirSync(dir);
    const path = join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
    const draft = { version: 'legacy', value: 'original' };
    writeFileSync(path, JSON.stringify({ key, ...draft }));
    writeFileSync(
      state.path,
      JSON.stringify({
        revision: 1,
        records: {},
        values: {},
        externalDrafts: true,
        drafts: { [key]: { version: draft.version, value: null } },
      }),
    );
    failure.path = state.path;
    expect(() => state.patch({ background: 'grid' })).toThrow('ENOSPC');
    expect(existsSync(path)).toBe(true);
    expect(state.draft(key)).toEqual(draft);
    failure.path = '';
    state.patch({ background: 'grid' });
    expect(existsSync(path)).toBe(false);
    expect(new ClientStateStore(state.path).draft(key)).toEqual(draft);
  });
  it.each(['new', 'update', 'clear'] as const)('索引提交失败后重开仍是上次成功态：%s', (kind) => {
    const state = store();
    const key = 'assistant:atomic';
    const old =
      kind === 'new' ? { version: null, value: null } : state.saveDraft(key, 'old', null).current;
    const before = state.snapshot();
    const listener = vi.fn();
    state.subscribe(listener);
    failure.path = state.path;
    expect(() => state.saveDraft(key, kind === 'clear' ? null : 'new', old.version)).toThrow(
      'ENOSPC',
    );
    failure.path = '';
    const reopened = new ClientStateStore(state.path);
    expect(reopened.snapshot()).toEqual(before);
    expect(reopened.draft(key)).toEqual(old);
    expect(listener).not.toHaveBeenCalled();
    expect(state.saveDraft(key, 'retry', old.version).ok).toBe(true);
  });
  it('正文保存失败不改变已确认的草稿和索引', () => {
    const state = store();
    const old = state.saveDraft('assistant:atomic', 'old', null).current;
    const before = readFileSync(state.path, 'utf8');
    failure.body = true;
    expect(() => state.saveDraft('assistant:atomic', 'new', old.version)).toThrow('ENOSPC');
    expect(readFileSync(state.path, 'utf8')).toBe(before);
    expect(new ClientStateStore(state.path).draft('assistant:atomic')).toEqual(old);
  });
  it.each([
    ['showGroupMemberName', true],
    ['showGroupMemberLevel', true],
    ['showGroupMemberTitle', true],
    ['autoMentionOnQuote', false],
    ['backspaceRemovesQuote', true],
  ] as const)('%s 使用统一默认值、持久共享且只接受布尔值', (key, defaultValue) => {
    const state = store();
    expect(preferenceDefaults[key]).toBe(defaultValue);
    state.patch({ [key]: !defaultValue });
    expect(new ClientStateStore(state.path).snapshot().values[key]).toBe(!defaultValue);
    expect(() => state.patch({ [key]: 'true' })).toThrow();
  });
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
