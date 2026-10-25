import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewCloneModal } from '../src/renderer/src/views/agentlab/NewCloneModal';
import { DEFAULT_MODEL_SELECTION_KEY } from '@weq/agentlab/model-selection';

vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
  useDialog: Object.assign(
    (select: (state: { confirm: () => Promise<boolean> }) => unknown) =>
      select({ confirm: async () => true }),
    { getState: () => ({ confirm: async () => true }) },
  ),
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ error: vi.fn() }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      listAgentLabProviders: {
        useQuery: () => ({
          data: [
            {
              id: 'synthetic',
              name: '合成服务',
              baseUrl: 'https://synthetic.invalid',
              models: [{ id: 'chat', capabilities: ['chat', 'vision', 'embedding'] }],
            },
          ],
          isLoading: false,
        }),
      },
      getAgentLabDefaultModel: {
        useQuery: () => ({
          data: { ref: { providerId: 'synthetic', model: 'chat' }, available: true, error: null },
        }),
      },
    },
  },
}));

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it('新建克隆不自动启用默认模型，聊天、向量与视觉可分别显式继承', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const start = vi.fn();
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((value) =>
      value.textContent?.includes(text),
    )!;
  const choose = (label: string) =>
    act(() => {
      const select = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
      select.value = DEFAULT_MODEL_SELECTION_KEY;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  try {
    act(() =>
      root.render(
        createElement(NewCloneModal, {
          buddies: [{ uid: 'u_synthetic', uin: '10001', label: '合成好友' }],
          initialSelectedUids: ['u_synthetic'],
          flatModels: { chat: [], embedding: [], vision: [] },
          onClose: vi.fn(),
          onStart: start,
        }),
      ),
    );
    act(() => button('下一步').click());
    expect(host.querySelector<HTMLSelectElement>('[aria-label="克隆聊天模型"]')!.value).toBe('');
    expect(button('开始克隆').disabled).toBe(true);
    choose('克隆聊天模型');
    act(() => button('开始克隆').click());
    expect(start.mock.calls[0]![0].params.models).toEqual({ chat: { useDefault: true } });
    choose('克隆向量模型');
    const checkbox = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (value) => value.closest('label')?.textContent?.includes('分析 TA'),
    )!;
    act(() => checkbox.click());
    choose('克隆视觉模型');
    act(() => button('开始克隆').click());
    expect(start.mock.calls[1]![0].params.models).toEqual({
      chat: { useDefault: true },
      embedding: { useDefault: true },
      vision: { useDefault: true },
    });
  } finally {
    act(() => root.unmount());
  }
});
