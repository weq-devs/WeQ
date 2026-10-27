import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { AgentMessageContent } from '../src/renderer/src/views/agentlab/ChatBubble';
import {
  cloneChatUser,
  cloneChatConversation,
  cloneChatMessages,
  cloneChatInput,
} from '../src/renderer/src/views/agentlab/cloneChatAdapter';
import {
  conversationExportSelection,
  conversationAnalysisTarget,
  conversationRoamingTarget,
} from '../src/renderer/src/lib/conversationActions';
import { messageBatchBlockReason } from '../src/renderer/src/lib/messageBatchAction';
import { elementToToken } from '../src/renderer/src/im-template/template/draftElements';

vi.mock('../src/renderer/src/trpc/client', () => import('./browser/clone-conversation.stub'));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const user = cloneChatUser('self', '我', '10000');
const peer = cloneChatUser('persona', '合成好友', '20001', true);
const source = cloneChatConversation({
  target: { kind: 'persona', ownerId: 'persona', sessionId: 'session' },
  viewId: 'virtual:clone:persona',
  name: peer.displayName,
  peer,
});
function mount(readOnly = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn(async () => {});
  act(() =>
    root.render(
      h(ChatPane, {
        user,
        conversation: source,
        messages: cloneChatMessages([{ id: 'm', text: '合成正文', ts: 1 }], source.id, () => peer),
        loading: false,
        preference: undefined,
        draft: '',
        onDraftChange: vi.fn(),
        onDraftClear: vi.fn(),
        onSend: send,
        onBack: vi.fn(),
        sendAvailable: !readOnly,
        readOnly,
        messageRenderers: [
          {
            id: 'generated',
            match: () => true,
            render: ({ message }) => h(AgentMessageContent, { text: message.body }),
          },
        ],
      }),
    ),
  );
  return {
    host,
    send,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('克隆直接使用普通 ChatPane 的编辑器、时间线、菜单与多选，不挂独立克隆页面', () => {
  const f = mount();
  try {
    expect(
      f.host.querySelector('.chat-pane .composer-editor[contenteditable="true"]'),
    ).not.toBeNull();
    expect(f.host.querySelector('.composer-resize')).not.toBeNull();
    expect(f.host.querySelector('.weq-virtual-timeline')).not.toBeNull();
    expect(f.host.querySelector('.weq-clone-conversation')).toBeNull();
    expect(f.host.querySelector('.message-avatar-wrap .avatar img')?.getAttribute('src')).toContain(
      '20001',
    );
    expect(f.host.querySelector('.message-avatar-wrap [aria-label="克隆体"]')).not.toBeNull();
    act(() =>
      f.host
        .querySelector('.message-bubble')!
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
        ),
    );
    const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('.message-context-menu button')];
    for (const label of ['转发', '引用', '贴表情', '撤回', '删除']) {
      const button = buttons.find((node) => node.textContent === label)!;
      expect(button.disabled).toBe(true);
      expect(button.title).toContain('克隆会话');
    }
    act(() => buttons.find((node) => node.textContent === '多选')!.click());
    expect(f.host.querySelector('.composer.selection-mode .selection-bar')).not.toBeNull();
    expect(f.host.querySelector('.message-line.is-selected')).not.toBeNull();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
    expect(f.host.querySelector('.composer.selection-mode')).toBeNull();
  } finally {
    f.close();
  }
});

it('共用工具栏保留未实现能力并置灰，旧记录使用同一只读编辑器', () => {
  const f = mount(true);
  try {
    for (const label of ['发红包', '通话', '语音', '发送图片或文件', '发送 Ark 卡片', '位置共享']) {
      expect(f.host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled).toBe(
        true,
      );
    }
    expect(f.host.querySelector('.composer-editor')?.getAttribute('contenteditable')).toBe('false');
    expect(f.host.querySelector<HTMLButtonElement>('.composer-send')?.disabled).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('数据适配保留真实持久身份，不把草稿片段或合成序号交给 QQ', () => {
  const rows = cloneChatMessages(
    [
      { id: 'saved', text: '已保存', ts: 1 },
      { text: '流式片段', ts: 2 },
    ],
    source.id,
    () => peer,
  );
  expect(rows[0]?.id).toBe('saved');
  expect(rows[0]?.msgSeq).toBeUndefined();
  expect(rows[1]?.generatedPending).toBe(true);
  expect(messageBatchBlockReason(rows[1]!, 'export')).toContain('持久消息身份');
  expect(conversationExportSelection(source)).toEqual({
    owner: { kind: 'clone-messages', container: JSON.stringify(['persona', 'persona', 'session']) },
    scope: { type: 'all' },
  });
});

it('普通编辑器的系统表情和成员提及经适配传入原有克隆文本接口', () => {
  const at = elementToToken({ kind: 'at', textContent: '@合成好友', atTargetUid: peer.id });
  expect(cloneChatInput(`你好[[chat:face:14]] ${at}`, new Map([['微笑', 14]]))).toBe(
    '你好/微笑 @合成好友',
  );
  expect(() => cloneChatInput('[[chat:mface:1:abcd]]', new Map())).toThrow('暂不支持');
  expect(() =>
    cloneChatInput(elementToToken({ kind: 'pic', filePath: '/private/fixture' }), new Map()),
  ).toThrow('暂不支持');
});

it('来源元数据独立阻止原生分析和漫游，不仅依赖 virtual 前缀约定', () => {
  const nativeLooking =
    source.type === 'direct'
      ? { ...source, id: 'u_native_looking', otherUser: { ...peer, id: 'u_native_looking' } }
      : source;
  expect(conversationAnalysisTarget(nativeLooking)).toBeNull();
  expect(conversationRoamingTarget(nativeLooking)).toBeNull();
  expect(conversationExportSelection(nativeLooking)?.owner.kind).toBe('clone-messages');
});

it('损坏的时间字段不导致整个共用消息页面崩溃', () => {
  const rows = cloneChatMessages(
    [
      { id: 'a', text: '合成记录', ts: 1e100 },
      { id: 'b', text: '合成记录', ts: Number.NaN },
    ],
    source.id,
    () => peer,
  );
  expect(rows.map((row) => row.createdAt)).toEqual([
    new Date(0).toISOString(),
    new Date(0).toISOString(),
  ]);
});
