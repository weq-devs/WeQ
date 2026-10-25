import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationList } from '../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { useOutgoingConversationPreviews } from '../src/renderer/src/hooks/useOutgoingConversationPreviews';
import {
  applyOutgoingConversationPreview,
  updateOutgoingConversationPreviews,
  type OutgoingPreviewRecord,
} from '../src/renderer/src/lib/outgoingConversationPreview';
import { sortConversationRows } from '../src/renderer/src/lib/conversationListOrder';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});

afterEach(() => vi.unstubAllGlobals());
const demo = createTemplateDemoData();
const at = Date.parse('2026-10-25T09:10:30.900+08:00');
const oldTime = new Date(at - 60000).toISOString();
const direct = {
  ...demo.conversations.find((row) => row.type === 'direct')!,
  id: 'u_fixture',
  updatedAt: oldTime,
  unreadCount: 0,
  preference: { pinned: false, muted: false, blocked: false },
  lastMessage: { id: 'old', senderId: 'u_fixture', body: '旧消息', createdAt: oldTime },
};
const record: OutgoingPreviewRecord = {
  id: 'optimistic-fixture',
  convId: direct.id,
  state: 'sending',
  at,
  afterSeq: '9007199254740992',
  body: '新消息',
  elements: [{ type: 'text', data: { textContent: '新消息' } }],
};
const recent = {
  targetUid: direct.id,
  sendTime: String(Math.floor(at / 1000) - 60),
  msgSeq: record.afterSeq,
};
const recents = [recent];

describe('本地发送会话摘要', () => {
  it('发送开始即更新摘要、时间与排序，不改未读和置顶，也不修改输入对象', () => {
    const previews = updateOutgoingConversationPreviews(new Map(), [record], [recent]);
    const next = applyOutgoingConversationPreview(direct, previews, demo.user);
    expect(next.updatedAt).toBe(new Date(at).toISOString());
    expect(next.lastMessage).toMatchObject({
      id: record.id,
      senderId: demo.user.id,
      body: '[发送中] 新消息',
      createdAt: next.updatedAt,
    });
    expect(next.unreadCount).toBe(0);
    expect(next.preference).toBe(direct.preference);
    const other = { ...direct, id: 'other', updatedAt: new Date(at - 1000).toISOString() };
    expect(sortConversationRows([other, next])[0]).toBe(next);
    expect(direct.lastMessage.body).toBe('旧消息');
    expect(applyOutgoingConversationPreview(other, previews, demo.user)).toBe(other);
  });

  it.each([
    ['queued', false, '[排队中] 新消息'],
    ['sending', false, '[发送中] 新消息'],
    ['failed', false, '[发送失败] 新消息'],
    ['sent', false, '新消息'],
    ['sent', true, '[可能未送达] 新消息'],
  ] as const)('随回执更新 %s/%s 状态', (state, seqRejected, body) => {
    const previews = updateOutgoingConversationPreviews(
      new Map(),
      [{ ...record, state, seqRejected }],
      [recent],
    );
    expect(applyOutgoingConversationPreview(direct, previews, demo.user).lastMessage?.body).toBe(
      body,
    );
  });

  it('多种消息共用摘要，同秒连续发送按提交先后选最新，旧回执不倒退', () => {
    const records: OutgoingPreviewRecord[] = [
      record,
      { ...record, id: 'optimistic-image', body: '[图片]', elements: [{ type: 'pic', data: {} }] },
      { ...record, id: 'optimistic-ark', body: undefined, elements: undefined, arkData: '{}' },
      { ...record, id: 'optimistic-forward', body: undefined, elements: undefined, title: '记录' },
    ];
    let previews = updateOutgoingConversationPreviews(new Map(), records, [recent]);
    expect(applyOutgoingConversationPreview(direct, previews, demo.user).lastMessage?.body).toBe(
      '[发送中] [合并转发] 记录',
    );
    previews = updateOutgoingConversationPreviews(
      previews,
      records.map((item, index) => (index === 0 ? { ...item, state: 'sent' } : item)),
      [recent],
    );
    expect(previews.get(direct.id)?.id).toBe('optimistic-forward');
    expect(previews.size).toBe(1);
  });

  it('富文本沿用现有预览节点，保留文字、提及和表情零号的原始顺序', () => {
    const previews = updateOutgoingConversationPreviews(
      new Map(),
      [
        {
          ...record,
          elements: [
            { type: 'text', data: { textContent: '你好 ' } },
            { type: 'face', data: { faceId: 0, faceText: '/惊讶' } },
            { type: 'at', data: { textContent: '@好友' } },
            { type: 'pic', data: { subType: 1 } },
          ],
        },
      ],
      [recent],
    );
    expect(
      applyOutgoingConversationPreview(direct, previews, demo.user).lastMessage?.previewNodes,
    ).toEqual([
      { t: 'text', text: '[发送中] ' },
      { t: 'text', text: '你好 ' },
      { t: 'face', faceId: 0, label: '/惊讶' },
      { t: 'text', text: '@好友' },
      { t: 'text', text: '[表情]' },
    ]);
  });

  it('气泡先完成对账时保留已发摘要，直到会话列表追上，不保留失败或移除的未送达占位', () => {
    const accepted = { ...record, state: 'sent' as const, seq: '9007199254740993' };
    let previews = updateOutgoingConversationPreviews(new Map(), [accepted], [recent]);
    previews = updateOutgoingConversationPreviews(previews, [], [recent]);
    expect(previews.get(direct.id)?.id).toBe(record.id);
    for (const patch of [{ state: 'failed' as const }, { seqRejected: true }]) {
      const failed = updateOutgoingConversationPreviews(
        new Map(),
        [{ ...accepted, ...patch }],
        [recent],
      );
      expect(updateOutgoingConversationPreviews(failed, [], [recent]).size).toBe(0);
    }
    const caughtUp = { ...recent, sendTime: String(Math.floor(at / 1000)), msgSeq: accepted.seq };
    expect(updateOutgoingConversationPreviews(previews, [], [caughtUp]).size).toBe(0);
    expect(updateOutgoingConversationPreviews(previews, [accepted], [caughtUp]).size).toBe(0);
  });

  it('同秒更高真实序号与后续来信接管预览，草稿或临时会话时间不参与消息对账', () => {
    const accepted = { ...record, state: 'sent' as const, seq: '9007199254740993' };
    for (const state of [accepted, { ...record, state: 'failed' as const }]) {
      expect(
        updateOutgoingConversationPreviews(
          new Map(),
          [state],
          [
            {
              ...recent,
              sendTime: String(Math.floor(at / 1000)),
              msgSeq: '9007199254740994',
            },
          ],
        ).size,
      ).toBe(0);
    }
    expect(
      updateOutgoingConversationPreviews(
        new Map(),
        [record],
        [
          {
            ...recent,
            sendTime: String(Math.floor(at / 1000) + 1),
          },
        ],
      ).size,
    ).toBe(0);
    const previews = updateOutgoingConversationPreviews(new Map(), [record], [recent]);
    expect(
      applyOutgoingConversationPreview({ ...direct, activityTime: at + 10000 }, previews, demo.user)
        .lastMessage?.body,
    ).toContain('新消息');
  });

  it('移除最新失败消息后恢复尚未被摘要追上的上一条成功发送，不保留媒体与草稿', () => {
    const accepted = { ...record, state: 'sent' as const, seq: '9007199254740993' };
    let previews = updateOutgoingConversationPreviews(new Map(), [accepted], [recent]);
    const failed = {
      ...record,
      id: 'optimistic-failed-next',
      state: 'failed' as const,
      at: at + 1,
    };
    previews = updateOutgoingConversationPreviews(previews, [failed], [recent]);
    expect(previews.get(direct.id)?.id).toBe(failed.id);
    previews = updateOutgoingConversationPreviews(previews, [], [recent]);
    expect(previews.get(direct.id)?.id).toBe(accepted.id);
    expect(previews.get(direct.id)).not.toHaveProperty('elements');
    expect(previews.get(direct.id)).not.toHaveProperty('composerDraft');
  });
});

it('真实列表从发送中即时切换到成功或失败，切换账号和数据源不泄漏旧摘要', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture({ scope, records }: { scope: string; records: OutgoingPreviewRecord[] }) {
    const previews = useOutgoingConversationPreviews(scope, [records], recents);
    return createElement(
      ContentSelectionProvider,
      null,
      createElement(ConversationList, {
        conversations: [applyOutgoingConversationPreview(direct, previews, demo.user)],
        activeConversationId: direct.id,
        preferences: {},
        drafts: {},
        user: demo.user,
        onSelect: () => {},
      }),
    );
  }
  const render = (records: OutgoingPreviewRecord[], scope = 'account:source-a') =>
    act(() => root.render(createElement(Fixture, { scope, records })));
  const preview = () => host.querySelector('.row-message-preview')?.textContent;
  try {
    render([]);
    expect(preview()).toBe('旧消息');
    render([record]);
    expect(preview()).toBe('[发送中] 新消息');
    const accepted = [{ ...record, state: 'sent' as const, seq: '9007199254740993' }];
    render(accepted);
    expect(preview()).toBe('新消息');
    render([]);
    expect(preview()).toBe('新消息');
    render(accepted, 'other-account:source-a');
    expect(preview()).toBe('旧消息');
    render([], 'other-account:source-a');
    expect(preview()).toBe('旧消息');
    render([], 'account:source-b');
    expect(preview()).toBe('旧消息');
    render([{ ...record, state: 'failed' }], 'account:source-b');
    expect(preview()).toBe('[发送失败] 新消息');
    render([], 'account:source-b');
    expect(preview()).toBe('旧消息');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
