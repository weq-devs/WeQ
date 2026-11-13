import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationBatchExportPane } from '../src/renderer/src/views/export/ConversationBatchExportPane';
import {
  conversationBatchSelection,
  type ConversationBatchTarget,
} from '../src/shared/content_selection';
import type { LightboxResult } from '../src/renderer/src/views/export/ExportLightbox';
import { DEFAULT_OPTIONS } from '../src/renderer/src/views/export/types';
import type { ConversationExportPlan } from '../src/renderer/src/views/export/conversationBatchExport';

const fixture = vi.hoisted(() => ({
  confirm: vi.fn(),
  error: vi.fn(),
  prepare: vi.fn(),
  start: vi.fn(),
  invalidate: vi.fn(),
  nextResult: null as LightboxResult | null,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { listExportTasks: { invalidate: fixture.invalidate } } }),
    bootstrap: { getExportPresets: { useQuery: () => ({ data: {}, isLoading: false }) } },
  },
  client: { bootstrap: { setExportPreset: { mutate: vi.fn() } } },
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'synthetic' },
    prepareSave: fixture.prepare,
    isCurrent: () => true,
    serverLocation: null,
    chooseServerLocation: vi.fn(),
    picking: false,
  }),
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: fixture.confirm, error: fixture.error }),
}));
vi.mock('../src/renderer/src/views/export/chatExport', () => ({
  preflightChatExport: async () => true,
}));
vi.mock('../src/renderer/src/views/export/ExportLightbox', () => ({
  ExportLightbox: ({
    summary,
    onConfirm,
    disabled,
  }: {
    summary: string;
    onConfirm: (result: LightboxResult) => void;
    disabled: boolean;
  }) =>
    h(
      'button',
      { type: 'button', disabled, onClick: () => onConfirm(fixture.nextResult!) },
      summary,
    ),
}));
vi.mock('../src/renderer/src/views/export/TimeRangePicker', () => ({
  TimeRangePicker: () => null,
}));
vi.mock('../src/renderer/src/views/export/StructuredExportControls', () => ({
  StructuredExportControls: () => null,
}));
vi.mock('../src/renderer/src/views/export/ExportReportControl', () => ({
  ExportReportControl: () => null,
}));
vi.mock('../src/renderer/src/views/export/conversationBatchExport', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/renderer/src/views/export/conversationBatchExport')
    >();
  return { ...actual, startConversationBatchExport: fixture.start };
});

const targets: ConversationBatchTarget[] = [
  { id: 'qq', name: '合成QQ好友', kind: 'c2c', ownerId: 'u_qq' },
  { id: 'guild', name: '合成频道私聊', kind: 'guild', ownerId: 'node' },
  { id: 'clone', name: '合成克隆', kind: 'persona', ownerId: 'persona', sessionId: null },
  { id: 'assistant', name: '合成助手对话', kind: 'assistant', sessionId: 'session' },
];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.confirm.mockReset().mockResolvedValue(true);
  fixture.error.mockReset();
  fixture.prepare.mockReset().mockResolvedValue({ mode: 'before', directory: '/synthetic/export' });
  fixture.invalidate.mockReset().mockResolvedValue(undefined);
  fixture.nextResult = { formats: ['json'], options: structuredClone(DEFAULT_OPTIONS) };
  fixture.start
    .mockReset()
    .mockImplementation(async ({ plan }: { plan: ConversationExportPlan }) => ({
      created: plan.targets.map(({ target }) => ({ target, taskId: `task-${target.id}` })),
      failed: [],
    }));
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const host = document.createElement('div');
  const root = createRoot(host);
  const close = vi.fn();
  act(() =>
    root.render(
      h(ConversationBatchExportPane, {
        initialSelection: conversationBatchSelection(targets),
        onClose: close,
      }),
    ),
  );
  return { host, close, dispose: () => act(() => root.unmount()) };
}

describe('混合批量导出界面', () => {
  it('一次确认保留全部来源的目标，并共用一次保存位置选择', async () => {
    const f = mount();
    try {
      for (const target of targets) expect(f.host.textContent).toContain(target.name);
      await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
      expect(fixture.prepare).toHaveBeenCalledOnce();
      expect(fixture.prepare).toHaveBeenCalledWith(undefined, {
        kind: 'bundle',
        name: '会话批量导出',
      });
      expect(fixture.start).toHaveBeenCalledOnce();
      expect(
        fixture.start.mock.calls[0]?.[0].plan.targets.map(
          (item: { target: ConversationBatchTarget }) => item.target,
        ),
      ).toEqual(targets);
      expect(fixture.invalidate).toHaveBeenCalledOnce();
      expect(f.close).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });

  it('不兼容格式的确认逐个列出对象，取消不选择位置也不创建任何任务', async () => {
    fixture.nextResult!.formats = ['html'];
    fixture.confirm.mockResolvedValue(false);
    const f = mount();
    try {
      await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
      expect(fixture.confirm).toHaveBeenCalledWith(
        '部分会话不支持所选格式',
        expect.stringContaining(targets[2]!.name),
        expect.any(Object),
      );
      expect(fixture.confirm.mock.calls[0]?.[1]).toContain(targets[3]!.name);
      expect(fixture.prepare).not.toHaveBeenCalled();
      expect(fixture.start).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it('确认跳过不适用对象后保留待办，改用可用格式重试不会重复创建已成功任务', async () => {
    fixture.nextResult!.formats = ['html'];
    const f = mount();
    try {
      await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
      expect(
        fixture.start.mock.calls[0]?.[0].plan.targets.map(
          (item: { target: ConversationBatchTarget }) => item.target.id,
        ),
      ).toEqual(['qq', 'guild']);
      expect(f.close).not.toHaveBeenCalled();
      fixture.nextResult!.formats = ['json'];
      await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
      expect(
        fixture.start.mock.calls[1]?.[0].plan.targets.map(
          (item: { target: ConversationBatchTarget }) => item.target.id,
        ),
      ).toEqual(['clone', 'assistant']);
      expect(f.close).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });

  it('某个对象失败显示原错误并保留精确重试，其他成功对象不再重复启动', async () => {
    fixture.start.mockImplementationOnce(async ({ plan }: { plan: ConversationExportPlan }) => ({
      created: plan.targets.slice(1).map(({ target }) => ({ target, taskId: target.id })),
      failed: [{ target: plan.targets[0]!.target, reason: '合成启动失败' }],
    }));
    const f = mount();
    try {
      await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
      expect(f.host.querySelector('[role="alert"]')?.textContent).toBe('合成启动失败');
      expect(f.close).not.toHaveBeenCalled();
      await act(async () => f.host.querySelector<HTMLButtonElement>('button')!.click());
      expect(
        fixture.start.mock.calls[1]?.[0].plan.targets.map(
          (item: { target: ConversationBatchTarget }) => item.target.id,
        ),
      ).toEqual(['qq']);
      expect(f.close).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });
});
