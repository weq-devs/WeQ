import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PersonaSettingsModal } from '../src/renderer/src/views/agentlab/PersonaSettingsModal';
import { CloneGenerationPanel } from '../src/renderer/src/components/settings/CloneGenerationPanel';
import { CLONE_GENERATION_KEYS, CLONE_GENERATION } from '@weq/agentlab/generation';

const f = vi.hoisted(() => ({
  update: vi.fn(async (_input: unknown): Promise<unknown> => ({ id: 'p' })),
  confirm: vi.fn(async () => false),
  error: vi.fn(),
  success: vi.fn(),
  providers: [{ id: 'tts', name: '合成语音', vendor: 'fixture' }],
  empty: [],
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const endpoints = new Proxy(
    {},
    {
      get: (_, name) => ({
        useQuery: () => ({
          data: name === 'listTtsProviders' ? f.providers : f.empty,
          isLoading: false,
        }),
        useMutation: () => {
          const [isLoading, setLoading] = useState(false);
          return {
            isLoading,
            mutateAsync: async (input: unknown) => {
              setLoading(true);
              try {
                return await f.update(input);
              } finally {
                setLoading(false);
              }
            },
          };
        },
      }),
    },
  );
  return { trpc: { account: endpoints, bootstrap: endpoints, useUtils: () => ({}) } };
});
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: f.confirm, error: f.error, success: f.success }),
}));
vi.mock('../src/renderer/src/components/Dialog', async (original) => ({
  ...(await original<typeof import('../src/renderer/src/components/Dialog')>()),
  useDialog: Object.assign(() => f.error, { getState: () => ({ confirm: f.confirm }) }),
}));
vi.mock('../src/renderer/src/components/settings/ApiModelSelect', () => ({
  ApiModelSelect: () => h('span', null, '合成模型'),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  f.update.mockResolvedValue({ id: 'p' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const persona = {
  id: 'p',
  name: '合成克隆',
  customPrompt: '原提示',
  models: { chat: { providerId: 'fixture', model: 'chat' } },
  voiceProfile: { ratio: 0.1 },
};
function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  const saved = vi.fn();
  const remove = vi.fn();
  act(() =>
    root.render(
      h(PersonaSettingsModal, {
        persona,
        fromGroup: true,
        onClose: close,
        onSaved: saved,
        onDelete: remove,
        profileContent: h('div', null, '合成画像与样本'),
        replyContent: h(CloneGenerationPanel, { persona, onSaved: saved }),
      }),
    ),
  );
  const pane = () => document.querySelector<HTMLElement>('.weq-conversation-settings-pane')!;
  const button = (text: string) =>
    [...pane().querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === text,
    )!;
  const change = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(() => {
      const prototype =
        input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  return {
    pane,
    button,
    change,
    close,
    saved,
    remove,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('分类保留草稿，跨页补交配置，语音切换自动保存而不显示手动保存按钮', async () => {
  const t = fixture();
  try {
    expect(t.button('保存更改')).toBeUndefined();
    expect(t.pane().textContent).toContain('所有私聊和群聊');
    expect(t.pane().querySelector('.weq-cvs-nav')?.textContent).not.toContain('训练参数');
    expect(t.button('删除克隆体')).toBeUndefined();
    t.change(t.pane().querySelector('textarea')!, '新提示');
    act(() => t.button('回复设置').click());
    expect(t.pane().querySelector('.weq-clone-generation details')).toBeNull();
    expect(t.pane().querySelector('.weq-clone-generation')?.textContent).toContain('上下文与参考');
    expect(t.pane().querySelector('.weq-clone-generation')?.textContent).toContain('生成参数');
    const key = CLONE_GENERATION_KEYS[0]!;
    const input = t
      .pane()
      .querySelector<HTMLInputElement>(`[aria-label="${CLONE_GENERATION[key].label}"]`)!;
    t.change(input, String(CLONE_GENERATION[key].default + 1));
    const willing = t.pane().querySelector<HTMLInputElement>('input[type="range"]')!;
    t.change(willing, '75');
    act(() => t.button('语音').click());
    const voiceToggle = t
      .pane()
      .querySelector<HTMLButtonElement>('[role="switch"][aria-label="开启语音克隆"]')!;
    act(() => voiceToggle.click());
    await act(async () => vi.advanceTimersByTimeAsync(500));
    act(() => t.button('人格与画像').click());
    expect(t.pane().querySelector('textarea')!.value).toBe('新提示');
    expect(Object.assign({}, ...f.update.mock.calls.map(([patch]) => patch))).toEqual(
      expect.objectContaining({
        personaId: 'p',
        customPrompt: '新提示',
        voiceCloneEnabled: true,
        voice: { providerId: 'tts', mode: 'preset', voice: undefined },
        generation: expect.objectContaining({ [key]: CLONE_GENERATION[key].default + 1 }),
        willing: expect.objectContaining({ level: 75 }),
      }),
    );
    expect(t.saved).toHaveBeenCalled();
    expect(t.button('保存更改')).toBeUndefined();
    await act(async () => t.pane().querySelector<HTMLButtonElement>('.weq-cvs-close')!.click());
    expect(t.close).toHaveBeenCalledOnce();
    expect(f.confirm).not.toHaveBeenCalled();
  } finally {
    t.dispose();
  }
});

it('无效参数阻止关闭；失败保留跨页草稿，重试成功后只发送修改过的配置', async () => {
  const t = fixture();
  try {
    act(() => t.button('回复设置').click());
    const key = CLONE_GENERATION_KEYS[0]!;
    const input = t
      .pane()
      .querySelector<HTMLInputElement>(`[aria-label="${CLONE_GENERATION[key].label}"]`)!;
    t.change(input, '');
    await act(async () => t.pane().querySelector<HTMLButtonElement>('.weq-cvs-close')!.click());
    expect(t.close).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    t.change(input, String(CLONE_GENERATION[key].default));
    act(() => t.button('人格与画像').click());
    t.change(t.pane().querySelector('textarea')!, '重试提示');
    f.update.mockRejectedValueOnce(new Error('合成失败'));
    await act(async () => t.pane().querySelector<HTMLButtonElement>('.weq-cvs-close')!.click());
    expect(t.pane().textContent).toContain('合成失败');
    expect(f.confirm).not.toHaveBeenCalled();
    expect(t.close).not.toHaveBeenCalled();
    expect(t.pane().querySelector('textarea')!.value).toBe('重试提示');
    await act(async () => t.button('重试保存').click());
    expect(f.update).toHaveBeenLastCalledWith({ personaId: 'p', customPrompt: '重试提示' });
    expect(t.pane().textContent).toContain('已保存');
    act(() => t.button('克隆体管理').click());
    await act(async () => t.button('删除克隆体').click());
    expect(t.remove).toHaveBeenCalledOnce();
  } finally {
    t.dispose();
  }
});

it('保存期间允许继续编辑，关闭等候回执；对象不存在时不误报成功或清掉草稿', async () => {
  const t = fixture();
  try {
    t.change(t.pane().querySelector('textarea')!, '在途修改');
    let finish: (value: unknown) => void = () => {};
    f.update.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => t.pane().querySelector<HTMLButtonElement>('.weq-cvs-close')!.click());
    expect(t.pane().textContent).toContain('保存中');
    expect(t.pane().querySelector('fieldset')!.disabled).toBe(false);
    t.change(t.pane().querySelector('textarea')!, '在途的新修改');
    expect(t.close).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    await act(async () => finish(null));
    expect(t.saved).not.toHaveBeenCalled();
    expect(f.success).not.toHaveBeenCalled();
    expect(t.pane().textContent).toContain('克隆体已不存在');
    expect(t.pane().querySelector('textarea')!.value).toBe('在途的新修改');
    expect(t.button('重试保存').disabled).toBe(false);
  } finally {
    t.dispose();
  }
});
