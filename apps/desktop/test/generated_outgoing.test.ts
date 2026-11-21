import { expect, it } from 'vitest';
import { matchGeneratedMessages } from '../src/renderer/src/lib/generatedOutgoing';

const hash = 'a'.repeat(32);

it('AI 声聊和闪传不以同文旧记录或已消费的回声收掉新预览', () => {
  const pending = {
    id: 'a',
    convId: 'group',
    state: 'sent',
    at: 100_000,
    signatures: [`aiVoice:${hash}`],
    generatedExistingMsgIds: ['old'],
  };
  const row = (msgId: string, sendTime = '100') => ({
    msgId,
    sendTime,
    elements: [
      { type: 'ptt', data: { isAiVoice: true, fileName: `${hash}.amr`, pttTranscript: 'Hey' } },
    ],
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

it('正式语音先到时同一帧隐藏 AI 占位，收到音频回执后才正式移除占位', () => {
  const pending = {
    id: 'preview',
    convId: 'group',
    state: 'sending',
    at: 100_000,
    awaitingAiVoice: true,
    generatedExistingMsgIds: ['old'],
  };
  const old = {
    msgId: 'old',
    sendTime: '100',
    elements: [{ type: 'ptt', data: { isAiVoice: true, md5: hash } }],
  };
  const actual = { ...old, msgId: 'actual' };
  expect(matchGeneratedMessages([pending], [old, actual], 'group', new Map()).size).toBe(0);
  expect(matchGeneratedMessages([pending], [old], 'group', new Map(), true).size).toBe(0);
  expect(
    matchGeneratedMessages([pending], [old, actual], 'group', new Map(), true).get('preview'),
  ).toBe('group:actual');
  const accepted = {
    ...pending,
    awaitingAiVoice: false,
    state: 'sent',
    signatures: [`aiVoice:${hash}`],
  };
  expect(matchGeneratedMessages([accepted], [old, actual], 'group', new Map()).get('preview')).toBe(
    'group:actual',
  );
});
