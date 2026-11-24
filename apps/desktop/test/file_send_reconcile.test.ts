// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { matchFileMessages } from '../src/renderer/src/lib/fileSendReconcile';

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
    expect(matchFileMessages([pending()], [wire()], 'group', new Map())).toEqual(
      new Map([['pending', 'group:new']]),
    );
  });

  it('真消息先到、发送回执后到时，回执补齐后仍可完成对账', () => {
    const consumed = new Map<string, string>();
    expect(
      matchFileMessages(
        [pending('pending', { state: 'sending', fileSync: { fileId: '', existingMsgIds: [] } })],
        [wire()],
        'group',
        consumed,
      ).size,
    ).toBe(0);
    expect(matchFileMessages([pending()], [wire()], 'group', consumed)).toEqual(
      new Map([['pending', 'group:new']]),
    );
  });

  it('按真实会话水位匹配新文件，不受本机时钟影响也不吃旧文件', () => {
    const old = wire('late-old', { msgSeq: '10' });
    const fresh = wire('new', { msgSeq: '11', sendTime: String(Math.floor(at / 1000) - 1) });
    const items = [pending('pending', { afterSeq: '10' })];
    expect(matchFileMessages(items, [old, fresh], 'group', new Map()).get('pending')).toBe(
      'group:new',
    );
    expect(matchFileMessages(items, [old], 'group', new Map()).size).toBe(0);
    expect(
      matchFileMessages(items, [{ ...fresh, sourceFormat: 'protocol' }], 'group', new Map(), true)
        .size,
    ).toBe(0);
  });

  it('同名不同 ID、旧消息、其他会话、发送中和失败条目均不匹配', () => {
    const messages = [
      wire('old'),
      wire('earlier', { sendTime: String(Math.floor(at / 1000) - 1) }),
      wire('different', {
        elements: [{ type: 'file', data: { fileToken: 'other-id', fileName: 'same.txt' } }],
      }),
    ];
    expect(matchFileMessages([pending()], messages, 'group', new Map()).size).toBe(0);
    for (const overrides of [
      { convId: 'other' },
      { state: 'failed' },
      { state: 'sending' },
      { fileSync: undefined },
    ]) {
      expect(
        matchFileMessages([pending('pending', overrides)], [wire()], 'group', new Map()).size,
      ).toBe(0);
    }
  });

  it('一条真消息只匹配一次，后续同步到第二条才收掉第二个临时气泡', () => {
    const consumed = new Map<string, string>();
    expect(
      matchFileMessages([pending('first'), pending('second')], [wire()], 'group', consumed),
    ).toEqual(new Map([['first', 'group:new']]));
    consumed.set('group:new', 'first');
    expect(matchFileMessages([pending('second')], [wire()], 'group', consumed).size).toBe(0);
    matchFileMessages([pending('second')], [], 'other', consumed);
    expect(matchFileMessages([pending('second')], [wire()], 'group', consumed).size).toBe(0);
    expect(
      matchFileMessages([pending('second')], [wire(), wire('second')], 'group', consumed),
    ).toEqual(new Map([['second', 'group:second']]));
  });

  it('重复加载同一条消息不会多消耗，未知时间和空文件 ID 不匹配', () => {
    expect(
      matchFileMessages(
        [pending('first'), pending('second')],
        [wire(), wire()],
        'group',
        new Map(),
      ),
    ).toEqual(new Map([['first', 'group:new']]));
    expect(
      matchFileMessages([pending()], [wire('new', { sendTime: '' })], 'group', new Map()).size,
    ).toBe(0);
    expect(
      matchFileMessages(
        [pending('pending', { fileSync: { fileId: '', existingMsgIds: [] } })],
        [wire()],
        'group',
        new Map(),
      ).size,
    ).toBe(0);
  });
});
