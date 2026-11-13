// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { classifyChatType } from '@weq/codec';
import { contactSenderName, contactTitle } from '../src/renderer/src/lib/contactTitle';
import { previewNodes, previewNodesToText } from '../src/renderer/src/lib/conversationPreview';
import { selfIdentityValues } from '../src/renderer/src/lib/selfIdentity';
import {
  groupDirectoryPreference,
  mutedFromNotifyLevel,
} from '../src/renderer/src/lib/groupNotifications';
import type { Conversation, User } from '../src/renderer/src/im-template/template/types';

const user: User = {
  id: 'self:10001',
  uid: 'u_self',
  username: 'uin-10001',
  displayName: '本人昵称',
  identityLabel: 'UIN',
  identityValue: '10001',
  avatarUrl: null,
};

// 执行 MainView 的真实转换函数，不为测试加载整套主界面及业务连接。
const file = new URL('../src/renderer/src/views/MainView.tsx', import.meta.url);
const source = ts.createSourceFile(
  file.pathname,
  readFileSync(file, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const names = new Set([
  'contactToConversation',
  'groupDetailToConversation',
  'chatTypeKind',
  'previewElementKind',
  'secondsToIsoTime',
  'toIsoTime',
]);
const declarations = source.statements.filter(
  (node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
);
const compiled = ts.transpileModule(
  `${declarations.map((node) => node.getText(source)).join('\n')}
  exports.contactToConversation = contactToConversation;
  exports.groupDetailToConversation = groupDetailToConversation;`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
);
const converters = {} as {
  contactToConversation: (
    row: Record<string, unknown>,
    user: User,
    groupNames: Map<string, string>,
    bots: Set<string>,
  ) => Conversation;
  groupDetailToConversation: (
    detail: Record<string, unknown>,
    fallback: Conversation | null,
    user: User,
  ) => Conversation;
};
runInNewContext(compiled.outputText, {
  exports: converters,
  classifyChatType,
  contactTitle,
  contactSenderName,
  previewNodes,
  previewNodesToText,
  selfIdentityValues,
  avatarSrc: () => null,
  groupAvatarSrc: () => null,
  mutedFromNotifyLevel,
  groupDirectoryPreference,
  fallbackPreference: { pinned: false, muted: false, archived: false },
});

function recentGroup() {
  return converters.contactToConversation(
    {
      chatType: 2,
      targetUid: '20001',
      targetDisplayName: '群名',
      sendTime: '1700000000',
      preview: {
        kind: 'grayTipPoke',
        grayTipXmlContent:
          '<gtip><qq uin="u_self" nm=""/><nor txt="戳了戳"/><qq uin="u_self" nm=""/></gtip>',
      },
    },
    user,
    new Map(),
    new Set(),
  );
}
const detail = {
  groupCode: '20001',
  groupName: '群名',
  ownerUid: 'u_self',
  customLabels: [],
};

it('最近群会话不预填本人，消息预览仍独立识别自己的身份', () => {
  const conversation = recentGroup();
  expect(conversation.type).toBe('group');
  expect(conversation.members).toEqual([]);
  expect(conversation.lastMessage?.body).toBe('你戳了戳你');
});

it.each([undefined, null])(
  '从群详情打开时不虚构成员，包括已退群记录（directory=%s）',
  (directory) => {
    const conversation = converters.groupDetailToConversation({ ...detail, directory }, null, user);
    expect(conversation.members).toEqual([]);
    expect(conversation.group?.role).toBe('owner');
  },
);

it('有最近会话但尚无成员时，群详情补全仍保持空列表', () => {
  const conversation = converters.groupDetailToConversation(detail, recentGroup(), user);
  expect(conversation.members).toEqual([]);
});

it('群详情补全保留已经读到的实际成员，包括真实名单中的自己', () => {
  const members = [
    { ...user, id: user.uid!, role: 'owner' as const, joinedAt: '2020-01-01T00:00:00Z' },
  ];
  const conversation = converters.groupDetailToConversation(
    detail,
    { ...recentGroup(), members },
    user,
  );
  expect(conversation.members).toBe(members);
});
