import { expect, it } from 'vitest';
import { matchGeneratedMessages } from '../src/renderer/src/lib/generatedOutgoing';

it('AI 声聊和闪传不以同文旧记录或已消费的回声收掉新预览', () => {
  const pending = {
    id: 'a',
    convId: 'group',
    state: 'sent',
    at: 100_000,
    signatures: ['aiVoice:你好'],
    generatedExistingMsgIds: ['old'],
  };
  const row = (msgId: string, sendTime = '100') => ({
    msgId,
    sendTime,
    elements: [{ type: 'ptt', data: { isAiVoice: true, pttTranscript: '你好' } }],
  });
  expect(matchGeneratedMessages([pending], [row('old')], 'group', new Map()).size).toBe(0);
  expect(matchGeneratedMessages([pending], [row('earlier', '98')], 'group', new Map()).size).toBe(
    0,
  );
  expect([
    ...matchGeneratedMessages([pending, { ...pending, id: 'b' }], [row('new')], 'group', new Map()),
  ]).toEqual([['a', 'group:new']]);
  expect(
    matchGeneratedMessages(
      [{ ...pending, id: 'b' }],
      [row('new')],
      'group',
      new Map([['group:new', 'a']]),
    ).size,
  ).toBe(0);
  expect(matchGeneratedMessages([pending], [row('new')], 'other', new Map()).size).toBe(0);
  expect(
    matchGeneratedMessages([{ ...pending, state: 'failed' }], [row('new')], 'group', new Map())
      .size,
  ).toBe(0);
  const flash = { ...pending, signatures: ['flash:fileset'] };
  expect(
    matchGeneratedMessages(
      [flash],
      [
        {
          ...row('new'),
          elements: [{ type: 'markdown', data: { flashTransferInfo: { fileSetId: 'fileset' } } }],
        },
      ],
      'group',
      new Map(),
    ).size,
  ).toBe(1);
});
