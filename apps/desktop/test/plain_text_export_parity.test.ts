// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { exportConversationToTxt } from '../../../packages/service/src/account/export/txt_exporter';
import type { MsgService, RenderGroupMsg } from '../../../packages/service/src/account/msg';
import { selectedMessagesText } from '../src/renderer/src/lib/messageSelection';
import type { Conversation, Message, User } from '../src/renderer/src/im-template/template/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const self: User = {
  id: 'u_self',
  displayName: '小明',
  identityValue: '123456789',
  identityLabel: 'QQ',
  username: '',
  avatarUrl: null,
};
const peer: User = { ...self, id: 'u_peer', displayName: '小红', identityValue: '987654321' };

it.each(['group', 'c2c'] as const)(
  '%s 的 TXT 文件与多选复制逐字一致（含引用、卡片、图文、转发）',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-plain-parity-'));
    roots.push(root);
    const elements = [
      [{ type: 'text', data: { textContent: '第一行\n\n第三行' } }],
      [
        {
          type: 'reply',
          data: {
            origSenderUid: self.id,
            origSenderUin: Number(self.identityValue),
            origElements: [{ type: 'text', data: { textContent: '长引用'.repeat(30) } }],
          },
        },
        { type: 'text', data: { textContent: '收到' } },
        { type: 'pic', data: { fileName: 'a.png' } },
      ],
      [
        {
          type: 'ark',
          data: {
            arkData: {
              app: 'com.tencent.structmsg',
              meta: {
                news: {
                  title: '校园活动',
                  desc: '本周安排',
                  jumpUrl: 'https://example.com/events',
                },
              },
            },
          },
        },
      ],
      [
        {
          type: 'multiMsg',
          data: {
            forwardMessages: [
              {
                senderName: '小王',
                senderUin: '112233445',
                sendTime: 1793942400,
                elements: [{ type: 'text', data: { textContent: '转发第一行\n第二行' } }],
              },
            ],
          },
        },
      ],
      [{ type: 'reply', data: { origText: '仅引用的消息' } }],
    ];
    const rows = elements.map((body, index) => ({
      msgId: BigInt(index + 1),
      msgSeq: BigInt(index + 1),
      sendTime: 1793942400n + BigInt(index),
      senderUid: index === 1 ? peer.id : self.id,
      senderUin: BigInt(index === 1 ? peer.identityValue : self.identityValue),
      elements: body,
    })) as RenderGroupMsg[];
    const msgs = {
      getGroupAfter: async () => rows,
      getGroupSeqlessAfterRowId: async () => [],
      getC2cAfter: async () => rows,
      getC2cSeqlessAfterRowId: async () => [],
      listForward: async () => [],
    } as unknown as MsgService;
    const conv = kind === 'group' ? '77777' : peer.id;
    const outputPath = join(root, 'messages.txt');
    await exportConversationToTxt(
      msgs,
      { kind, conv, outputPath },
      {
        self: async () => ({ uid: self.id, uin: self.identityValue, nick: self.displayName }),
        resolveProfile: async () => ({
          uin: peer.identityValue,
          nick: '原昵称',
          remark: peer.displayName,
        }),
        resolveGroupMembers: async () =>
          [self, peer].map((user) => ({
            uid: user.id,
            uin: user.identityValue,
            nick: '原昵称',
            card: '',
            remark: user.displayName,
            adminFlag: 0,
          })),
      },
    );
    const conversation = (
      kind === 'group'
        ? { type: 'group', id: conv, members: [self, peer] }
        : { type: 'direct', id: conv, otherUser: peer }
    ) as Conversation;
    const messages = rows.map((row) => ({
      id: String(row.msgId),
      senderId: row.senderUid,
      createdAt: new Date(Number(row.sendTime) * 1000).toISOString(),
      body: '',
      qqElements: row.elements,
    })) as Message[];
    const copied = selectedMessagesText(messages, conversation, self);
    expect(readFileSync(outputPath, 'utf8')).toBe(copied);
    expect(copied).toContain('小明 (123456789) · 2026-11-06 13:20:00');
    expect(copied).toContain('> 小明 (123456789)\n> 长引用');
    expect(copied).toContain('标题：校园活动\n描述：本周安排\n链接：https://example.com/events');
    expect(copied).toContain('[聊天记录]\n  小王 (112233445)');
  },
);
