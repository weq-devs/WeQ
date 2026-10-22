import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  ContentSelectionProvider,
  useContentMultiSelect,
} from '../src/renderer/src/state/contentSelection';
import { useDialog } from '../src/renderer/src/components/Dialog';
import { useToast } from '../src/renderer/src/components/Toast';
import type { Message } from '../src/renderer/src/im-template/template/types';

const rpc = vi.hoisted(() => ({
  configId: 'source-a',
  recall: vi.fn(async (_input: unknown) => ({ ok: true })),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        if (key === 'useQuery')
          return () => ({
            data: path.endsWith('.getAccountConfig')
              ? { uin: '10001', configId: rpc.configId }
              : undefined,
          });
        if (key === 'useMutation')
          return () => ({
            mutate: vi.fn(),
            mutateAsync: path.endsWith('.recallMessage') ? rpc.recall : vi.fn(async () => ({})),
            isLoading: false,
          });
        return proxy(`${path}.${String(key)}`);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  rpc.configId = 'source-a';
  rpc.recall.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(true);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
});
function mount({
  kind = 'direct',
  role = 'member',
  online = true,
  overrides = [],
}: {
  kind?: 'direct' | 'group';
  role?: 'owner' | 'admin' | 'member';
  online?: boolean;
  overrides?: Array<Partial<Message>>;
} = {}) {
  const demo = createTemplateDemoData();
  const user = { ...demo.user, id: 'self:10001', uid: 'u_self', identityValue: '10001' };
  const base = demo.conversations.find((row) => row.type === kind)!;
  const conversation = base.type === 'group' ? { ...base, group: { ...base.group, role } } : base;
  const messages: Message[] = (overrides.length ? overrides : [{}, {}]).map((patch, index) => ({
    id: String(index + 1),
    conversationId: conversation.id,
    senderId: 'u_self',
    body: `合成消息${index + 1}`,
    createdAt: new Date().toISOString(),
    msgSeq: String(42 + index),
    clientSeq: String(17 + index),
    msgRandom: String(123456 + index),
    ...patch,
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Probe() {
    const selection = useContentMultiSelect({
      kind: 'messages',
      container: `${conversation.type}:${conversation.id}`,
    });
    return h(
      'aside',
      null,
      h(
        'button',
        {
          'data-select-all': true,
          onClick: () => {
            selection.setSelectionMode(true);
            selection.setSelectedIds(new Set(messages.map((message) => message.id)));
          },
        },
        '选择',
      ),
      h(
        'output',
        null,
        JSON.stringify({ mode: selection.selectionMode, ids: [...selection.selectedIds] }),
      ),
    );
  }
  const render = (visible = messages, sendAvailable = online) =>
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(Probe),
          h(ChatPane, {
            user,
            conversation,
            messages: visible,
            loading: false,
            sendAvailable,
            draft: '',
            onSend: vi.fn(),
            onDraftChange: vi.fn(),
            onDraftClear: vi.fn(),
            onBack: vi.fn(),
          }),
        ),
      ),
    );
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() => host.querySelector<HTMLButtonElement>('[data-select-all]')!.click());
  return {
    host,
    conversation,
    messages,
    render,
    button: () => host.querySelector<HTMLButtonElement>('[aria-label="撤回所选消息"]')!,
    state: () =>
      JSON.parse(host.querySelector('output')!.textContent!) as { mode: boolean; ids: string[] },
  };
}
async function clickText(text: string) {
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent === text)!
      .click(),
  );
}

describe('消息多选撤回', () => {
  it('选中消息的右键撤回也作用于完整选区', async () => {
    const f = mount();
    act(() =>
      f.host
        .querySelector('[data-message-id="1"] .message-bubble')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 })),
    );
    await clickText('撤回所选 2 条消息');
    expect(rpc.recall).toHaveBeenCalledTimes(2);
  });
  it('逐条复用私聊撤回定位并携带账号绑定，不做本地乐观删除', async () => {
    const f = mount();
    expect(f.button().disabled).toBe(false);
    await act(async () => f.button().click());
    expect(useDialog.getState().confirm).toHaveBeenCalledOnce();
    expect(rpc.recall).toHaveBeenCalledTimes(2);
    expect(rpc.recall.mock.calls.map(([input]) => input)).toEqual(
      [42, 43].map((sequence, index) =>
        expect.objectContaining({
          kind: 'c2c',
          conv: f.conversation.type === 'direct' ? f.conversation.otherUser.id : '',
          sequence,
          clientSequence: 17 + index,
          random: 123456 + index,
          timestamp: expect.any(Number),
          expectedAccountUin: '10001',
          expectedAccountConfigId: 'source-a',
        }),
      ),
    );
    expect(f.state().mode).toBe(false);
    expect(f.host.querySelector('[data-message-id="1"]')).not.toBeNull();
  });
  it('混合选区先说明不可撤回项，仅提交支持项并保留其余选择', async () => {
    const f = mount({ overrides: [{}, { senderId: 'u_peer' }] });
    await act(async () => f.button().click());
    expect(rpc.recall).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('1 条消息不支持撤回，1 条可以继续');
    await clickText('仅撤回支持的 1 条');
    expect(rpc.recall).toHaveBeenCalledOnce();
    expect(f.state().ids).toEqual(['2']);
  });
  it('取消确认保留选区，不发请求', async () => {
    vi.mocked(useDialog.getState().confirm).mockResolvedValueOnce(false);
    const f = mount();
    await act(async () => f.button().click());
    expect(rpc.recall).not.toHaveBeenCalled();
    expect(f.state().ids).toEqual(['1', '2']);
  });
  it('遇到失败停止，不重试；已提交项移出选区，失败与未处理项保留', async () => {
    rpc.recall.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('合成拒绝'));
    const f = mount({ overrides: [{}, {}, {}] });
    await act(async () => f.button().click());
    expect(rpc.recall).toHaveBeenCalledTimes(2);
    expect(f.state().ids).toEqual(['2', '3']);
    expect(useToast.getState().toasts.at(-1)?.title).toContain('1 条未完成');
  });
  it('请求在途禁用重复点击，切换数据源后不继续后续提交', async () => {
    let complete: (() => void) | undefined;
    rpc.recall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ ok: true });
        }),
    );
    const f = mount();
    await act(async () => f.button().click());
    expect(f.button().disabled).toBe(true);
    expect(rpc.recall).toHaveBeenCalledOnce();
    rpc.configId = 'source-b';
    f.render();
    await act(async () => complete!());
    expect(rpc.recall).toHaveBeenCalledOnce();
  });
  it('确认等待中切换数据源，迟到的确认不发送撤回', async () => {
    let confirm: ((value: boolean) => void) | undefined;
    vi.mocked(useDialog.getState().confirm).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const f = mount();
    await act(async () => f.button().click());
    rpc.configId = 'source-b';
    f.render();
    await act(async () => confirm!(true));
    expect(rpc.recall).not.toHaveBeenCalled();
  });
  it('选中但已滚出当前窗口的消息仍按原始定位处理', async () => {
    const f = mount();
    f.render([f.messages[0]!]);
    await act(async () => f.button().click());
    expect(rpc.recall).toHaveBeenCalledTimes(2);
  });
  it('每条撤回前重核发送权限，途中切为受限模式时不继续发包', async () => {
    let complete: (() => void) | undefined;
    rpc.recall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ ok: true });
        }),
    );
    const f = mount();
    await act(async () => f.button().click());
    f.render(f.messages, false);
    await act(async () => complete!());
    expect(rpc.recall).toHaveBeenCalledOnce();
    expect(f.state().ids).toEqual(['2']);
  });
  it('受限模式时禁用按钮并显示原因', async () => {
    const f = mount({ online: false });
    expect(f.button().disabled).toBe(true);
    expect(f.button().title).toContain('受限模式');
    await act(async () => f.button().click());
    expect(rpc.recall).not.toHaveBeenCalled();
  });
  it.each([
    { createdAt: new Date(Date.now() - 180000).toISOString() },
    { clientSeq: undefined },
    { source: 'roaming' as const },
    { optimistic: 'sending' as const },
    { msgSeq: '9007199254740993' },
  ])('不可撤回记录只进入说明，不发送请求 %#', async (patch) => {
    const f = mount({ overrides: [patch] });
    await act(async () => f.button().click());
    expect(rpc.recall).not.toHaveBeenCalled();
    const proceed = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '仅撤回支持的 0 条',
    )!;
    expect(proceed.disabled).toBe(true);
    expect(f.state().ids).toEqual(['1']);
  });
  it.each(['owner', 'admin', 'member'] as const)(
    '群身份 %s 沿用单条撤回的权限判断',
    async (role) => {
      const f = mount({
        kind: 'group',
        role,
        overrides: [{ senderId: 'u_peer', createdAt: new Date(Date.now() - 180000).toISOString() }],
      });
      await act(async () => f.button().click());
      expect(rpc.recall).toHaveBeenCalledTimes(role === 'member' ? 0 : 1);
    },
  );
  it('群身份缺失时不能猜作管理员', async () => {
    const f = mount({ kind: 'group', overrides: [{ senderId: 'u_peer' }] });
    if (f.conversation.type === 'group') Object.assign(f.conversation.group, { role: undefined });
    f.render();
    await act(async () => f.button().click());
    expect(rpc.recall).not.toHaveBeenCalled();
  });
});
