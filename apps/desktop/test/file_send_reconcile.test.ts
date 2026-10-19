import { describe, expect, it } from 'vitest';
import { reconcileFileMessages } from '../src/renderer/src/lib/fileSendReconcile';

const at = Date.parse('2026-10-20T03:00:00.500Z');
const pending = (id = 'pending', overrides = {}) => ({
  id,
  convId: 'group',
  state: 'sent',
  at,
  fileSync: { fileId: 'file-id', existingMsgIds: ['old'] },
  ...overrides,
});
const wire = (msgId = 'new', overrides = {}) => ({
  msgId,
  sendTime: String(Math.floor(at / 1000)),
  elements: [{ type: 'file', data: { fileToken: 'file-id', fileName: 'same.txt' } }],
  ...overrides,
});

describe('文件发送回显对账', () => {
  it('群文件没有 random 或序号回执时，按文件 ID 收起临时气泡', () => {
    expect(reconcileFileMessages([pending()], [wire()], 'group', new Set())).toEqual(
      new Set(['pending']),
    );
  });

  it('真消息先到、发送回执后到时，回执补齐后仍可完成对账', () => {
    const consumed = new Set<string>();
    expect(
      reconcileFileMessages(
        [pending('pending', { state: 'sending', fileSync: { fileId: '', existingMsgIds: [] } })],
        [wire()],
        'group',
        consumed,
      ).size,
    ).toBe(0);
    expect(reconcileFileMessages([pending()], [wire()], 'group', consumed)).toEqual(
      new Set(['pending']),
    );
  });

  it('同名不同 ID、旧消息、其他会话、发送中和失败条目均不匹配', () => {
    const messages = [
      wire('old'),
      wire('earlier', { sendTime: String(Math.floor(at / 1000) - 1) }),
      wire('different', {
        elements: [{ type: 'file', data: { fileToken: 'other-id', fileName: 'same.txt' } }],
      }),
    ];
    expect(reconcileFileMessages([pending()], messages, 'group', new Set()).size).toBe(0);
    for (const overrides of [
      { convId: 'other' },
      { state: 'failed' },
      { state: 'sending' },
      { fileSync: undefined },
    ]) {
      expect(
        reconcileFileMessages([pending('pending', overrides)], [wire()], 'group', new Set()).size,
      ).toBe(0);
    }
  });

  it('一条真消息只匹配一次，后续同步到第二条才收掉第二个临时气泡', () => {
    const consumed = new Set<string>();
    expect(
      reconcileFileMessages([pending('first'), pending('second')], [wire()], 'group', consumed),
    ).toEqual(new Set(['first']));
    expect(reconcileFileMessages([pending('second')], [wire()], 'group', consumed).size).toBe(0);
    reconcileFileMessages([pending('second')], [], 'other', consumed);
    expect(reconcileFileMessages([pending('second')], [wire()], 'group', consumed).size).toBe(0);
    expect(
      reconcileFileMessages([pending('second')], [wire(), wire('second')], 'group', consumed),
    ).toEqual(new Set(['second']));
  });

  it('重复加载同一条消息不会多消耗，未知时间和空文件 ID 不匹配', () => {
    expect(
      reconcileFileMessages(
        [pending('first'), pending('second')],
        [wire(), wire()],
        'group',
        new Set(),
      ),
    ).toEqual(new Set(['first']));
    expect(
      reconcileFileMessages([pending()], [wire('new', { sendTime: '' })], 'group', new Set()).size,
    ).toBe(0);
    expect(
      reconcileFileMessages(
        [pending('pending', { fileSync: { fileId: '', existingMsgIds: [] } })],
        [wire()],
        'group',
        new Set(),
      ).size,
    ).toBe(0);
  });
});
