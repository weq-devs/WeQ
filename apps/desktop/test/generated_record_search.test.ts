import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DialogHost } from '../src/renderer/src/components/Dialog';
import { useDialog } from '../src/renderer/src/components/Dialog.shared';
import { ChatRecordsModal } from '../src/renderer/src/components/search/ChatRecordsModal';
import {
  cloneChatUser,
  cloneChatConversation,
  cloneChatMessages,
} from '../src/renderer/src/views/agentlab/cloneChatAdapter';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { useContentExportRequest } from '../src/renderer/src/state/contentSelection.shared';
import { changeInput, chooseFormOption } from './support/form-controls';
import { usePreviews } from '../src/renderer/src/components/mediaPreviewStore.shared';

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
  useDialog.getState().close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  nativeReads.mockReset();
  vi.useRealTimers();
});

it('筛选结果导出仅确认预检，并透传原位选择的完整性报告', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  nativeReads.mockImplementation((path: string) => {
    if (path === 'account.browseConversation') return { items: [], cursor: null, hasMore: false };
    if (path === 'account.exportPreflight')
      return {
        matchingMessages: 7,
        destination: '/fixture/export',
        estimatedMessageBytes: 1024,
        availableBytes: 100_000,
        spaceWarning: false,
      };
    return undefined;
  });
  try {
    await act(async () => root.render(h('div', null, nativeRecords(), h(DialogHost))));
    const report = document.querySelector<HTMLInputElement>('[aria-label="附带完整性报告"]')!;
    const exportButton = document.querySelector<HTMLButtonElement>('[aria-label="导出筛选结果"]')!;
    expect(report.checked).toBe(false);
    act(() => report.click());

    await act(async () => exportButton.click());
    expect(useDialog.getState().current?.title).toBe('导出预检');
    await act(async () => useDialog.getState().close());
    expect(nativeReads).not.toHaveBeenCalledWith(
      'account.startExport',
      expect.anything(),
      undefined,
    );

    await act(async () => exportButton.click());
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '开始导出',
    );
    await act(async () => confirm!.click());
    expect(nativeReads).toHaveBeenCalledWith(
      'account.startExport',
      expect.objectContaining({ includeIntegrityReport: true, conv: '12345' }),
      undefined,
    );
  } finally {
    act(() => root.unmount());
    host.remove();
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

it('克隆复用普通搜索窗，分页显示但按完整匹配身份导出，不查询原生 QQ 记录', async () => {
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
  const close = vi.fn();
  function Probe() {
    return h('output', null, JSON.stringify(useContentExportRequest()?.selection));
  }
  try {
    await act(async () =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(ChatRecordsModal, {
            fixed: true,
            initialKeyword: '合成',
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
            onClose: close,
            onJumpMessage: vi.fn(),
          }),
          h(Probe),
        ),
      ),
    );
    expect(document.querySelectorAll('.weq-chatrecords-msg')).toHaveLength(30);
    expect(document.querySelector<HTMLSelectElement>('[aria-label="消息类型"]')?.disabled).toBe(
      true,
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="导出筛选结果"]')!.click(),
    );
    const exported = JSON.parse(host.querySelector('output')!.textContent!);
    expect(exported.owner).toEqual({
      kind: 'clone-messages',
      container: JSON.stringify(['persona', 'peer', 's']),
    });
    expect(exported.scope.ids).toEqual(messages.map((message) => message.id));
    expect(close).toHaveBeenCalledOnce();
    const results = document.querySelector<HTMLElement>('.weq-chatrecords-msgs')!;
    Object.defineProperties(results, {
      clientHeight: { value: 300 },
      scrollHeight: {
        get: () => (results.querySelectorAll('.weq-chatrecords-msg').length / 30) * 1000,
      },
    });
    results.scrollTop = 700;
    act(() => results.dispatchEvent(new Event('scroll')));
    expect(document.querySelectorAll('.weq-chatrecords-msg')).toHaveLength(60);
    expect(nativeReads).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('会话搜索自动越过空批次，按北京时间显示扫描日期，查完才显示无结果', async () => {
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
    expect(document.body.textContent).toContain('已查到 2026-11-19');
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
    const input = document.querySelector<HTMLInputElement>('.weq-search-more-input')!;
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

function nativeRecords() {
  return h(ChatRecordsModal, {
    fixed: true,
    initialKeyword: '合成',
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

it('跳到原消息后重新打开搜索，恢复筛选、已加载页及滚动位置', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const cursor = { time: 1794528000, rowId: '2' };
  const item = (id: string) => ({
    msgId: id,
    msgSeq: id,
    senderUid: 'fixture',
    senderUin: '',
    senderName: '',
    sendTime: '1794528000',
    content: `记录 ${id}`,
  });
  const browse = vi.fn(async (input: { cursor?: typeof cursor }) => ({
    items: input.cursor ? [item('1')] : [item('2')],
    cursor: input.cursor ? null : cursor,
    hasMore: !input.cursor,
  }));
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
  const input = () => document.querySelector<HTMLInputElement>('.weq-search-more-input')!;
  const category = () => document.querySelector<HTMLButtonElement>('[aria-label="消息类型"]')!;
  const results = () => document.querySelector<HTMLDivElement>('.weq-chatrecords-msgs')!;
  try {
    await act(async () => page.render(h(Fixture)));
    await act(async () => changeInput(input(), '站点'));
    await act(async () => chooseFormOption(category(), 'link'));
    Object.defineProperties(results(), {
      clientHeight: { value: 300 },
      scrollHeight: { value: 1000 },
    });
    results().scrollTop = 700;
    await act(async () => results().dispatchEvent(new Event('scroll')));
    expect(results().textContent).toContain('记录 1');
    expect(browse.mock.lastCall?.[0]).toMatchObject({
      filter: { category: 'link', keyword: '站点' },
      cursor,
    });
    const queries = browse.mock.calls.length;
    act(() => results().querySelector<HTMLButtonElement>('.weq-chatrecords-msg')!.click());
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ msgId: '2', targetUid: '12345' }));
    expect(results()).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('#reopen')!.click());
    expect(input().value).toBe('站点');
    expect(category().dataset.value).toBe('link');
    expect(results().textContent).toContain('记录 1');
    expect(results().scrollTop).toBe(700);
    expect(browse).toHaveBeenCalledTimes(queries);
  } finally {
    act(() => page.unmount());
    host.remove();
  }
});

it('共享媒体使用原筛选分页，缩略图预览与定位原消息分别操作', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  const { props } = nativeRecords();
  const jump = vi.fn();
  const item = (category: string) => ({
    msgId: '4',
    msgSeq: '4',
    senderUid: 'u_peer',
    senderUin: '20001',
    senderName: '成员',
    sendTime: '1794528000',
    content: `${category} 正文`,
    elements: [
      {
        type: category === 'image' ? 'pic' : category,
        data: {
          fileName: category === 'video' ? 'preview.webm' : `fixture-${category}`,
          fileToken: 'media-token',
        },
      },
      ...(category === 'video' ? [{ type: 'pic', data: { fileName: '同消息配图.jpg' } }] : []),
    ],
  });
  nativeReads.mockImplementation((path: string, input: { filter: { category: string } }) =>
    path === 'account.browseConversation'
      ? { items: [item(input.filter.category)], cursor: null, hasMore: false }
      : undefined,
  );
  const labeled = (label: string) =>
    document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  try {
    await act(async () =>
      root.render(
        h(ChatRecordsModal, {
          ...props,
          initialKeyword: '',
          sharedMedia: true,
          onJumpMessage: jump,
        }),
      ),
    );
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>('.weq-record-media-categories button'),
    ];
    expect(buttons.map((button) => button.textContent)).toEqual(['图片', '视频', '文件']);
    await act(async () => labeled('查看图片：fixture-image').click());
    expect(usePreviews.getState().sessions.get(document)?.items[0]?.kind).toBe('image');
    expect(jump).not.toHaveBeenCalled();

    await act(async () => buttons[1]!.click());
    await act(async () => labeled('查看视频：preview.webm').click());
    expect(
      usePreviews
        .getState()
        .sessions.get(document)
        ?.items.map(({ kind }) => kind),
    ).toEqual(['video']);
    expect(jump).not.toHaveBeenCalled();
    await act(async () => labeled('定位原消息：preview.webm').click());
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ msgId: '4', msgSeq: '4' }));

    await act(async () => buttons[2]!.click());
    expect(document.querySelector('.weq-record-media-grid')).toBeNull();
    expect(document.querySelector('.weq-chatrecords-msg')).not.toBeNull();
    expect(
      nativeReads.mock.calls
        .filter(([path]) => path === 'account.browseConversation')
        .map(([, input]) => input.filter.category),
    ).toEqual(['image', 'video', 'file']);
  } finally {
    act(() => root.unmount());
  }
});

it('发送者可选群昵称、备注或号码，使用身份筛选并保留账号绑定', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const root = createRoot(document.createElement('div'));
  const { props } = nativeRecords();
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source' };
  nativeReads.mockImplementation((path: string) =>
    path === 'account.searchGroupMembers'
      ? { members: [{ uid: 'u_peer', uin: '20001', nick: '昵称样本', card: '群名片' }], total: 1 }
      : { items: [], cursor: null, hasMore: false },
  );
  try {
    await act(async () => root.render(h(ChatRecordsModal, { ...props, accountBinding: binding })));
    const input = document.querySelector<HTMLInputElement>('[aria-label="发送者"]')!;
    await act(async () => changeInput(input, '昵称样本'));
    await act(async () => vi.advanceTimersByTime(180));
    expect(nativeReads).toHaveBeenCalledWith(
      'account.searchGroupMembers',
      expect.objectContaining({
        ...binding,
        groupCode: '12345',
        keyword: '昵称样本',
      }),
      expect.anything(),
    );
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
      element.textContent?.includes('昵称样本'),
    )!;
    await act(async () => option.click());
    expect(nativeReads).toHaveBeenCalledWith(
      'account.browseConversation',
      expect.objectContaining({
        ...binding,
        filter: expect.objectContaining({ sender: '20001' }),
      }),
      expect.anything(),
    );
  } finally {
    act(() => root.unmount());
  }
});
