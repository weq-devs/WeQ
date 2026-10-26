// @vitest-environment node
import { expect, it, vi } from 'vitest';

vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {
      profile: { getSelfProfile: async () => ({ uin: 1n }), nicksByUids: async () => ({}) },
      msgs: {
        getGroupMessageById: async () => ({
          msgId: 9007199254740993n,
          msgSeq: 2n,
          sendTime: 1792461600n,
          senderUid: 'fixture_sender',
          senderUin: 1n,
          elements: [],
        }),
        getGroupLatest: async () => [
          {
            msgId: 9007199254740993n,
            msgSeq: 2n,
            sendTime: 1792461600n,
            senderUid: 'fixture_sender',
            senderUin: 1n,
            elements: [],
          },
        ],
      },
    },
  }),
}));

import { AI_TOOLS } from '../src/main/mcp/tools';

it('returns exact source time and sender identity with message IDs without SQL', async () => {
  const tool = AI_TOOLS.find((item) => item.name === 'get_messages')!;
  const args = { kind: 'group', conv: '123', limit: 100, before: '' };
  const result = (await tool.run({ ...args, includeIds: true })) as { messages: object[] };
  expect(result.messages[0]).toMatchObject({
    msgId: '9007199254740993',
    sendTime: '1792461600',
    senderUid: 'fixture_sender',
  });
  const compact = (await tool.run({ ...args, includeIds: false })) as { messages: object[] };
  expect(compact.messages[0]).not.toHaveProperty('sendTime');
  expect(compact.messages[0]).not.toHaveProperty('senderUid');
});

it('returns the same raw time in read-only message details', async () => {
  const tool = AI_TOOLS.find((item) => item.name === 'get_message_details')!;
  expect(
    await tool.run({
      kind: 'group',
      conv: '123',
      msgId: '9007199254740993',
      includePayload: false,
      includeMedia: false,
    }),
  ).toMatchObject({
    found: true,
    kind: 'group',
    conv: '123',
    msgId: '9007199254740993',
    sendTime: '1792461600',
    senderUid: 'fixture_sender',
  });
});
