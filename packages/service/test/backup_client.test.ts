import { expect, it } from 'vitest';
import {
  applyWeqClientSettings,
  snapshotWeqClientSettings,
  validateWeqClientSettings,
  WEQ_CLIENT_RESTORE_RECEIPT,
  WEQ_MENU_CAPTURE_PRIVACY_KEY,
} from '../src/common/backup_client';

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const value: Storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, item) => {
      values.set(key, item);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  return { value, values };
}

it('恢复默认覆盖所有账号显示设置，只移除页面快照中的偏好项，保留数据与会话整理', () => {
  const snapshot = (name: string) => `weq:page-snapshot:v1:${JSON.stringify(['10001', name])}`;
  const reset = {
    'weq.contacts.order.10001.10001.friends': '{"sort":"qq"}',
    'weq.contacts.order.10002.10002.groups': '{"grouping":"size"}',
    'weq.global-search.preferences': '{}',
    'weq.calendar.kinds': '[]',
    'weq.theme-density': 'compact',
    [snapshot('workspace:conversation-scope')]: '"real"',
  };
  const data = {
    'chat-template:conversation-preferences': '{"peer":{"pinned":true}}',
    'weq:group-assistant-pins:10001': '{"123":true}',
    [snapshot('messages')]: '合成消息数据',
    [`weq:page-draft:v1:${JSON.stringify(['10001', 'export:options:chat:peer'])}`]: '未提交草稿',
    'weq.backup-client-id': 'synthetic-client',
    'weq.message-clipboard': '合成剪贴板',
  };
  const source = storage({ ...reset, ...data });
  applyWeqClientSettings(source.value, {}, true, undefined, true);
  expect(Object.fromEntries(source.values)).toEqual(data);
  applyWeqClientSettings(source.value, {}, true, undefined, true);
  expect(Object.fromEntries(source.values)).toEqual(data);
});

it('恢复默认删除偏好失败时回滚全部设置与回执，会话数据始终保留', () => {
  const initial = {
    'weq.theme-density': 'compact',
    'weq.calendar.kinds': '[]',
    'chat-template:conversation-preferences': '合成会话整理',
  };
  const source = storage(initial);
  const remove = source.value.removeItem;
  source.value.removeItem = (key) => {
    if (key === 'weq.calendar.kinds') throw Error('合成删除失败');
    remove(key);
  };
  expect(() => applyWeqClientSettings(source.value, {}, true, undefined, true)).toThrow(
    '合成删除失败',
  );
  expect(Object.fromEntries(source.values)).toEqual(initial);
});

it('菜单截图临时隐私只备份设备偏好，恢复/默认重置不引入运行覆盖', () => {
  const source = storage({
    [WEQ_MENU_CAPTURE_PRIVACY_KEY]: '1',
    'weq.privacy-mode': '0',
    'weq.manual-full-mode': '1',
  });
  const snapshot = snapshotWeqClientSettings(source.value);
  expect(snapshot[WEQ_MENU_CAPTURE_PRIVACY_KEY]).toBe('1');
  expect(snapshot).not.toHaveProperty('weq.manual-full-mode');
  for (const value of ['true', 'false', '2', ''])
    expect(() => validateWeqClientSettings({ [WEQ_MENU_CAPTURE_PRIVACY_KEY]: value })).toThrow();
  const target = storage();
  applyWeqClientSettings(target.value, snapshot);
  expect(target.value.getItem(WEQ_MENU_CAPTURE_PRIVACY_KEY)).toBe('1');
  applyWeqClientSettings(target.value, {});
  expect(target.value.getItem(WEQ_MENU_CAPTURE_PRIVACY_KEY)).toBeNull();
});

it('恢复回执与偏好一起提交，回执写入失败时回滚偏好与旧回执', () => {
  const source = storage({
    'weq.theme-preference': 'dark',
    [WEQ_CLIENT_RESTORE_RECEIPT]: 'old-receipt',
  });
  const set = source.value.setItem;
  let fail = true;
  source.value.setItem = (key, value) => {
    if (key === WEQ_CLIENT_RESTORE_RECEIPT && fail) {
      fail = false;
      throw Error('合成回执写入失败');
    }
    set(key, value);
  };
  const incoming = { 'weq.theme-preference': 'light' };
  const id = '11111111-1111-4111-8111-111111111111';
  expect(() => applyWeqClientSettings(source.value, incoming, true, id)).toThrow('回执写入失败');
  expect(source.value.getItem('weq.theme-preference')).toBe('dark');
  expect(source.value.getItem(WEQ_CLIENT_RESTORE_RECEIPT)).toBe('old-receipt');
  applyWeqClientSettings(source.value, incoming, true, id);
  expect(source.value.getItem(WEQ_CLIENT_RESTORE_RECEIPT)).toBe(id);
  expect(snapshotWeqClientSettings(source.value)).toEqual(incoming);
  expect(incoming).toEqual({ 'weq.theme-preference': 'light' });
});

it('只快照真实界面偏好，不混入令牌、草稿或恢复现场', () => {
  const source = storage({
    'weq.theme-preference': 'dark',
    'weq.theme-accent': '#123456',
    'weq:group-assistant-pins:10001': '{"12345":true}',
    'weq.group-badge-display.v1': JSON.stringify({
      '["10001","12345"]': { showTitle: false, showLevel: true },
    }),
    'weq-bot-key': 'synthetic-private-key',
    draft: '合成草稿',
    'weq-ui-recovery': '合成现场',
  });
  const snapshot = snapshotWeqClientSettings(source.value);
  expect(Object.keys(snapshot)).toHaveLength(3);
  expect(snapshot).not.toHaveProperty('weq.group-badge-display.v1');
  expect(JSON.stringify(snapshot)).not.toContain('private-key');
  expect(JSON.stringify(snapshot)).not.toContain('合成草稿');
  expect(source.values.size).toBe(7);
});

it('恢复替换所选偏好而保留无关令牌和业务现场，空设置可恢复默认', () => {
  const source = storage({
    'weq.theme-preference': 'dark',
    'weq.theme-background': 'paper',
    'weq-bot-key': 'synthetic-key',
  });
  applyWeqClientSettings(source.value, { 'weq.theme-preference': 'light' });
  expect(Object.fromEntries(source.values)).toEqual({
    'weq.theme-preference': 'light',
    'weq-bot-key': 'synthetic-key',
  });
  applyWeqClientSettings(source.value, {});
  expect(Object.fromEntries(source.values)).toEqual({ 'weq-bot-key': 'synthetic-key' });
});

it('当前偏好损坏也能恢复，不让导出校验阻止修复现有配置', () => {
  const source = storage({
    'weq:group-assistant-pins:10001': 'not-json',
    'weq.theme-preference': 'invalid',
  });
  applyWeqClientSettings(source.value, { 'weq.theme-preference': 'system' });
  expect(Object.fromEntries(source.values)).toEqual({ 'weq.theme-preference': 'system' });
});

it('写入途中失败回滚全部已改偏好，回滚失败不能伪报成功', () => {
  const initial = { 'weq.theme-preference': 'dark', 'weq.theme-accent': '#123456' };
  const source = storage(initial);
  let failed = false;
  const set = source.value.setItem;
  source.value.setItem = (key, value) => {
    if (key === 'weq.theme-accent' && !failed) {
      failed = true;
      throw Error('合成存储错误');
    }
    set(key, value);
  };
  expect(() =>
    applyWeqClientSettings(source.value, {
      'weq.theme-preference': 'light',
      'weq.theme-accent': '#abcdef',
    }),
  ).toThrow('合成存储错误');
  expect(Object.fromEntries(source.values)).toEqual(initial);
  source.value.setItem = () => {
    throw Error('合成持续错误');
  };
  expect(() => applyWeqClientSettings(source.value, { 'weq.theme-preference': 'light' })).toThrow(
    '未能回滚',
  );
});

it.each([
  { unknown: 'not-allowed' },
  { 'weq.theme-preference': 'unknown' },
  { 'weq.theme-accent': 'url(synthetic)' },
  { 'weq.theme-background': 'unknown' },
  { 'weq.theme-component-style': 'unknown' },
  { 'weq.privacy-mode': 'true' },
  { 'weq.desktop.sidebarWidth.v2': 'NaN' },
  { 'weq:tools-position': '{"x":"bad","y":0}' },
  { 'weq.group-badge-display.v1': '{"not-a-scope":{"showTitle":true,"showLevel":false}}' },
  {
    'chat-template:conversation-preferences':
      '{"__proto__":{"pinned":true,"muted":false,"blocked":false}}',
  },
  { 'weq:group-assistant-pins:10001': '{"12345":"true"}' },
])('拒绝无效界面偏好且不产生部分写入：%j', (input) => {
  const source = storage({ 'weq.theme-preference': 'dark' });
  expect(() => validateWeqClientSettings(input)).toThrow();
  expect(() => applyWeqClientSettings(source.value, input)).toThrow();
  expect(source.value.getItem('weq.theme-preference')).toBe('dark');
});
