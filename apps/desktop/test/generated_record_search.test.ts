import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRecordsModal } from '../src/renderer/src/components/search/ChatRecordsModal';
import {
  cloneChatUser,
  cloneChatConversation,
  cloneChatMessages,
} from '../src/renderer/src/views/agentlab/cloneChatAdapter';
import { changeInput } from './support/form-controls';
import { usePreviews } from '../src/renderer/src/components/mediaPreviewStore.shared';
import { useGroupMemberRosterOrder } from '../src/renderer/src/lib/groupMemberRosterOrder';

const nativeReads = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/trpc/client', async () => {
  const stub = await import('./browser/clone-conversation.stub');
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) =>
        key === 'query' || key === 'mutate'
          ? (input: unknown, options?: { signal: AbortSignal }) => {
              return Promise.resolve(
                nativeReads(path.join('.'), input, options) ?? { items: [], total: 0 },
              );
            }
          : proxy([...path, String(key)]),
    });
  return { trpc: stub.trpc, client: proxy() };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  nativeReads.mockReset();
  vi.useRealTimers();
});

it('会话搜索没有条件时不查历史，清空关键词会清除结果并中止查询', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  const pending = Promise.withResolvers<{ items: []; cursor: null; hasMore: false }>();
  const browse = vi.fn().mockReturnValue(pending.promise);
  nativeReads.mockImplementation((path: string, input: unknown, options: unknown) =>
    path === 'account.browseConversation' ? browse(input, options) : undefined,
  );
  try {
    await act(async () => root.render(nativeRecords('')));
    const input = document.querySelector<HTMLInputElement>('[aria-label="搜索本会话"]')!;
    const results = () => document.querySelector<HTMLElement>('.weq-chatrecords-body');
    await act(async () => changeInput(input, '  '));
    expect(results()).toBeNull();
    expect(browse).not.toHaveBeenCalled();

    await act(async () => changeInput(input, '合成'));
    expect(browse.mock.lastCall?.[0]).toMatchObject({ filter: { keyword: '合成' } });
    expect(results()?.querySelector('[role="status"]')).not.toBeNull();

    await act(async () => changeInput(input, ''));
    expect(browse.mock.lastCall?.[1].signal.aborted).toBe(true);
    await act(async () => pending.resolve({ items: [], cursor: null, hasMore: false }));
    expect(results()).toBeNull();
    expect(browse).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it('服务号搜索显示候选截断提示，消息定位保留服务号和消息身份', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const jump = vi.fn();
  const hit = {
    category: 'chatRecord' as const,
    source: 'buddy' as const,
    partition: '90001',
    targetUid: 'service:90001',
    targetUin: '',
    name: '合成服务号',
    count: 1,
  };
  nativeReads.mockImplementation((path: string) =>
    path === 'account.searchConversationRecords'
      ? {
          items: [
            {
              msgId: 'm1',
              msgSeq: '1',
              senderUid: 'service-sender',
              senderUin: '',
              senderName: '',
              sendTime: '1',
              content: '合成正文',
            },
          ],
          total: 1,
          limited: true,
        }
      : path === 'account.searchMore'
        ? { category: 'chatRecord', items: [hit], total: 1, hasMore: false }
        : undefined,
  );
  try {
    await act(async () =>
      root.render(
        h(ChatRecordsModal, {
          initialKeyword: '合成',
          initialHit: hit,
          onClose: vi.fn(),
          onJumpMessage: jump,
        }),
      ),
    );
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(document.body.textContent).toContain('本轮候选已显示完');
    expect(document.body.textContent).not.toContain('没有更多了');
    const message = document.querySelector<HTMLButtonElement>('.weq-chatrecords-msg')!;
    act(() => message.click());
    expect(jump).toHaveBeenCalledWith({
      source: 'buddy',
      targetUid: 'service:90001',
      msgSeq: '1',
      msgId: 'm1',
    });
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('克隆输入关键词后分页显示本地匹配消息，不查询原生 QQ 记录', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const user = cloneChatUser('self', '我', '10000');
  const peer = cloneChatUser('peer', '合成好友', '20001', true);
  const conversation = cloneChatConversation({
    target: { kind: 'persona', ownerId: 'peer', sessionId: 's' },
    viewId: 'virtual:clone:search',
    name: peer.displayName,
    peer,
  });
  const messages = cloneChatMessages(
    Array.from({ length: 61 }, (_, index) => ({
      id: `row-${index}`,
      text: `合成记录 ${index}`,
      ts: index * 1000,
    })),
    conversation.id,
    () => peer,
  );
  try {
    await act(async () =>
      root.render(
        h(ChatRecordsModal, {
          fixed: true,
          initialKeyword: '',
          initialHit: {
            category: 'chatRecord',
            source: 'buddy',
            partition: conversation.id,
            targetUid: conversation.id,
            targetUin: '',
            name: peer.displayName,
            count: messages.length,
          },
          localSource: { conversation, messages, user, onJump: vi.fn() },
          onClose: vi.fn(),
          onJumpMessage: vi.fn(),
        }),
      ),
    );
    const input = document.querySelector<HTMLInputElement>('[aria-label="搜索本会话"]')!;
    const results = () => document.querySelector<HTMLElement>('.weq-chatrecords-msgs');
    expect(results()).toBeNull();
    await act(async () => changeInput(input, '合成'));
    expect(document.querySelectorAll('.weq-chatrecords-msg')).toHaveLength(30);
    const list = results()!;
    Object.defineProperties(list, {
      clientHeight: { value: 300 },
      scrollHeight: {
        get: () => (list.querySelectorAll('.weq-chatrecords-msg').length / 30) * 1000,
      },
    });
    list.scrollTop = 700;
    act(() => list.dispatchEvent(new Event('scroll')));
    expect(document.querySelectorAll('.weq-chatrecords-msg')).toHaveLength(60);
    await act(async () => changeInput(input, ''));
    expect(results()).toBeNull();
    expect(nativeReads).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('会话首次搜索自动越过空批次，查完才显示无结果', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  const cursor = { time: Date.parse('2026-11-18T16:30:00Z') / 1000, rowId: '500' };
  const second = Promise.withResolvers<{ items: []; cursor: null; hasMore: false }>();
  const browse = vi
    .fn()
    .mockResolvedValueOnce({ items: [], cursor, hasMore: true })
    .mockReturnValueOnce(second.promise);
  nativeReads.mockImplementation((path: string, input: unknown) =>
    path === 'account.browseConversation' ? browse(input) : undefined,
  );
  try {
    await act(async () => root.render(nativeRecords()));
    expect(browse.mock.calls.map(([input]) => input.cursor)).toEqual([undefined, cursor]);
    expect(document.querySelector('.weq-record-notice[role="status"]')?.textContent).toContain(
      '正在搜索聊天记录',
    );
    expect(document.querySelector('.weq-record-progress')).toBeNull();
    expect(document.body.textContent).not.toContain('没有找到相关消息');

    await act(async () => second.resolve({ items: [], cursor: null, hasMore: false }));
    expect(document.body.textContent).toContain('没有找到相关消息');
    expect(browse).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});

it('换关键词时中止旧搜索，迟到的空批次不会继续分页', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  const oldPage = Promise.withResolvers<{
    items: [];
    cursor: { time: number; rowId: string };
    hasMore: true;
  }>();
  const browse = vi
    .fn()
    .mockReturnValueOnce(oldPage.promise)
    .mockResolvedValueOnce({
      items: [
        {
          msgId: '1',
          msgSeq: '1',
          senderUid: 'fixture',
          senderUin: '',
          senderName: '',
          sendTime: '1794528000',
          content: '新词命中的正文',
        },
      ],
      cursor: null,
      hasMore: false,
    });
  nativeReads.mockImplementation((path: string, input: unknown, options: unknown) =>
    path === 'account.browseConversation' ? browse(input, options) : undefined,
  );
  try {
    await act(async () => root.render(nativeRecords()));
    const input = document.querySelector<HTMLInputElement>('[aria-label="搜索本会话"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '新词',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(browse.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(browse.mock.calls[1]?.[0]).toMatchObject({ filter: { keyword: '新词' } });

    await act(async () =>
      oldPage.resolve({ items: [], cursor: { time: 1794528000, rowId: '500' }, hasMore: true }),
    );
    expect(browse).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('新词命中的正文');
  } finally {
    act(() => root.unmount());
  }
});

function nativeRecords(initialKeyword = '合成') {
  return h(ChatRecordsModal, {
    fixed: true,
    initialKeyword,
    initialHit: {
      category: 'chatRecord',
      source: 'group',
      partition: '12345',
      targetUid: '12345',
      targetUin: '12345',
      name: '合成群',
      count: 0,
    },
    onClose: vi.fn(),
    onJumpMessage: vi.fn(),
  });
}

async function jumpFromRecord(record: HTMLElement) {
  await act(async () =>
    record.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes('定位原消息'))!
      .click(),
  );
}

it('跳到原消息后重新打开搜索，恢复筛选、已加载页及滚动位置', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const cursor = { time: 1794528000, rowId: '2' };
  const scannedTime = Date.parse('2026-11-18T16:30:00Z') / 1000;
  const nextCursor = { time: scannedTime, rowId: '1' };
  const item = (id: string) => ({
    msgId: id,
    msgSeq: id,
    senderUid: 'fixture',
    senderUin: '',
    senderName: '',
    sendTime: '1794528000',
    content: `记录 ${id}`,
  });
  const nextPage = Promise.withResolvers<{
    items: ReturnType<typeof item>[];
    cursor: null;
    hasMore: false;
  }>();
  const browse = vi.fn(async (input: { cursor?: typeof cursor }) => {
    if (!input.cursor) return { items: [item('2')], cursor, hasMore: true };
    if (input.cursor.rowId === cursor.rowId)
      return { items: [], cursor: nextCursor, hasMore: true, scannedTime };
    return nextPage.promise;
  });
  const jump = vi.fn();
  nativeReads.mockImplementation((path: string, input: { cursor?: typeof cursor }) =>
    path === 'account.browseConversation' ? browse(input) : undefined,
  );
  const { props } = nativeRecords();
  function Fixture() {
    const [suspended, setSuspended] = useState(false);
    return h(
      'div',
      null,
      h('button', { id: 'reopen', onClick: () => setSuspended(false) }, '重新打开'),
      h(ChatRecordsModal, {
        ...props,
        suspended,
        onJumpMessage: jump,
        onSuspend: () => setSuspended(true),
      }),
    );
  }
  // 浮层内容走 Portal，重开按钮保留在原宿主。
  const host = document.createElement('div');
  document.body.append(host);
  const page = createRoot(host);
  const input = () => document.querySelector<HTMLInputElement>('[aria-label="搜索本会话"]')!;
  const category = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[aria-label="消息类型"] button')].find(
      (button) => button.textContent === label,
    )!;
  const results = () => document.querySelector<HTMLDivElement>('.weq-chatrecords-msgs')!;
  try {
    await act(async () => page.render(h(Fixture)));
    await act(async () => changeInput(input(), '站点'));
    await act(async () => category('链接/卡片').click());
    Object.defineProperties(results(), {
      clientHeight: { value: 300 },
      scrollHeight: { value: 1000 },
    });
    results().scrollTop = 700;
    await act(async () => results().dispatchEvent(new Event('scroll')));
    expect(document.querySelector('.weq-record-progress')?.textContent).toContain(
      '已查到 2026-11-19',
    );
    expect(browse.mock.lastCall?.[0]).toMatchObject({
      filter: { recordType: 'linkCard', keyword: '站点' },
      cursor: nextCursor,
    });
    await act(async () => nextPage.resolve({ items: [item('1')], cursor: null, hasMore: false }));
    expect(results().textContent).toContain('记录 1');
    results().scrollTop = 700;
    const queries = browse.mock.calls.length;
    await jumpFromRecord(results().querySelector<HTMLElement>('.weq-chatrecords-msg')!);
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ msgId: '2', targetUid: '12345' }));
    expect(results()).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('#reopen')!.click());
    expect(input().value).toBe('站点');
    expect(category('链接/卡片').getAttribute('aria-current')).toBe('page');
    expect(results().textContent).toContain('记录 1');
    expect(results().scrollTop).toBe(700);
    expect(browse).toHaveBeenCalledTimes(queries);
  } finally {
    act(() => page.unmount());
    host.remove();
  }
});

it('图片、视频封面及表情自动加载，可预览和定位原消息', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  const root = createRoot(document.createElement('div'));
  const { props } = nativeRecords('');
  const jump = vi.fn();
  const item = (recordType: string) => ({
    msgId: '4',
    msgSeq: '4',
    senderUid: 'u_peer',
    senderUin: '20001',
    senderName: '成员',
    sendTime: '1794528000',
    content: '合成附件',
    elements:
      recordType === 'media'
        ? [
            { type: 'pic', data: { fileName: 'fixture-image.jpg', fileToken: 'image-token' } },
            { type: 'video', data: { fileName: 'preview.webm', fileToken: 'video-token' } },
          ]
        : recordType === 'emoji'
          ? [{ type: 'mface', data: { emojiPackId: 123, marketEmoticonIdHex: 'abc' } }]
          : [{ type: 'file', data: { fileName: 'fixture-file.txt', fileToken: 'file-token' } }],
  });
  const browse = vi.fn((input: { filter: { recordType: string } }) => ({
    items: [item(input.filter.recordType)],
    cursor: null,
    hasMore: false,
  }));
  nativeReads.mockImplementation((path: string, input: { filter: { recordType: string } }) =>
    path === 'account.browseConversation' ? browse(input) : undefined,
  );
  const tab = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[aria-label="消息类型"] button')].find(
      (button) => button.textContent === label,
    )!;
  try {
    await act(async () => root.render(h(ChatRecordsModal, { ...props, onJumpMessage: jump })));
    expect(browse).not.toHaveBeenCalled();
    await act(async () => tab('图片/视频').click());
    const previews = [
      ...document.querySelectorAll<HTMLButtonElement>('button.weq-record-media-thumbnail'),
    ];
    expect(previews.map((button) => button.getAttribute('aria-label'))).toEqual([
      'fixture-image.jpg',
      'preview.webm',
    ]);
    await act(async () => previews[0]!.click());
    const items = usePreviews.getState().sessions.get(document)?.items;
    expect(items?.map(({ kind }) => kind)).toEqual(['image', 'video']);
    const imageQuery = new URLSearchParams(items?.[0]?.src.split('?')[1]);
    expect(imageQuery.get('v')).toBe('thumb');
    expect(imageQuery.get('intent')).toBe('interactive');
    expect(imageQuery.has('preview')).toBe(false);
    const videoQuery = new URLSearchParams(items?.[1]?.poster?.split('?')[1]);
    expect(videoQuery.get('intent')).toBe('interactive');
    expect(jump).not.toHaveBeenCalled();
    await jumpFromRecord(previews[1]!);
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ msgId: '4', msgSeq: '4' }));

    await act(async () => tab('表情').click());
    const emoji = document.querySelector<HTMLImageElement>('.weq-record-media-grid img');
    const emojiQuery = new URLSearchParams(emoji?.src.split('?')[1]);
    expect(emojiQuery.get('intent')).toBe('interactive');

    await act(async () => tab('文件').click());
    expect(document.querySelector('.weq-record-media-grid')).toBeNull();
    expect(document.querySelector('.weq-chatrecords-msg')).not.toBeNull();
    expect(browse.mock.calls.map(([input]) => input.filter.recordType)).toEqual([
      'media',
      'emoji',
      'file',
    ]);
  } finally {
    act(() => root.unmount());
  }
});

it('群发送者打开即使用当前排序读取完整名单，按昵称筛选并按身份查消息', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const query = new QueryClient();
  const { props } = nativeRecords('');
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source' };
  nativeReads.mockImplementation((path: string) =>
    path === 'account.groupMemberRoster'
      ? {
          members: [
            {
              member: { uid: 'u_other', uin: '20002', nick: '其他成员', card: '' },
              displayName: '其他成员',
            },
            {
              member: { uid: 'u_peer', uin: '20001', nick: '昵称样本', card: '群名片' },
              displayName: '群名片',
              remark: '联系人备注',
            },
          ],
          total: 2,
        }
      : path === 'account.groupSenderNames'
        ? { rows: [{ name: '旧群名片', senderUin: '20003', senderUid: 'u_legacy' }] }
        : { items: [], cursor: null, hasMore: false },
  );
  function Fixture() {
    const { changeOrder } = useGroupMemberRosterOrder('10001:source', '12345');
    return h(
      'div',
      null,
      h('button', {
        id: 'sort-fixture',
        onClick: () => changeOrder({ sort: 'uin', descending: true, prioritizeAdmins: false }),
      }),
      h(ChatRecordsModal, { ...props, accountBinding: binding }),
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const mountedRoot = createRoot(host);
  const options = () => [
    ...document.querySelectorAll<HTMLElement>('.weq-record-sender-options [role="checkbox"]'),
  ];
  try {
    await act(async () =>
      mountedRoot.render(h(QueryClientProvider, { client: query }, h(Fixture))),
    );
    act(() => host.querySelector<HTMLButtonElement>('#sort-fixture')!.click());
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="全部发送者"]')!;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    expect(nativeReads).toHaveBeenCalledWith(
      'account.groupMemberRoster',
      {
        ...binding,
        groupCode: '12345',
        limit: 'all',
        sort: 'uin',
        descending: true,
        prioritizeAdmins: false,
      },
      expect.anything(),
    );
    await act(async () => {
      await vi.waitFor(() => expect(query.isFetching()).toBe(0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(options().map((option) => option.textContent)).toEqual(['其他成员', '群名片']);
    const input = document.querySelector<HTMLInputElement>('[aria-label="查找发送者"]')!;
    expect(document.activeElement).toBe(input);
    await act(async () => changeInput(input, '联系人备注'));
    expect(options().map((option) => option.textContent)).toEqual(['群名片']);
    await act(async () => changeInput(input, '昵称样本'));
    expect(options().map((option) => option.textContent)).toEqual(['群名片']);
    const segments = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[aria-label="发送者查找范围"] [role="radio"]',
      ),
    ];
    expect(
      segments.map((button) => [button.textContent, button.getAttribute('aria-checked')]),
    ).toEqual([
      ['当前称呼', 'true'],
      ['包含历史称呼', 'false'],
    ]);
    await act(async () => changeInput(input, '旧群名片'));
    expect(nativeReads).not.toHaveBeenCalledWith(
      'account.groupSenderNames',
      expect.anything(),
      expect.anything(),
    );
    await act(async () => segments[1]!.click());
    expect(segments[1]!.getAttribute('aria-checked')).toBe('true');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(options().some((option) => option.textContent?.includes('旧群名片'))).toBe(true);
    expect(nativeReads).toHaveBeenCalledWith(
      'account.groupSenderNames',
      { ...binding, groupCode: '12345', keyword: '旧群名片' },
      expect.anything(),
    );
    await act(async () => segments[0]!.click());
    expect(options()).toHaveLength(0);
    await act(async () => changeInput(input, '昵称样本'));
    expect(nativeReads.mock.calls.some(([path]) => path === 'account.browseConversation')).toBe(
      false,
    );
    await act(async () => options()[0]!.click());
    expect(nativeReads).toHaveBeenCalledWith(
      'account.browseConversation',
      expect.objectContaining({
        ...binding,
        filter: expect.objectContaining({ senders: ['20001'] }),
      }),
      expect.anything(),
    );
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(trigger);
  } finally {
    act(() => mountedRoot.unmount());
    query.clear();
    host.remove();
  }
});
