import { expect, it } from 'vitest';
import {
  applyWeqClientSettings,
  snapshotWeqClientSettings,
  validateWeqClientSettings,
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
  expect(Object.keys(snapshot)).toHaveLength(4);
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
    'weq.group-badge-display.v1': 'not-json',
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
