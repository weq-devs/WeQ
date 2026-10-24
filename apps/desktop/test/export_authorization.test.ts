import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  exportAuthorizationPlan,
  skipExportAuthorization,
  useExportAuthorization,
} from '../src/renderer/src/views/export/authorization';
import { DEFAULT_OPTIONS, type ExportOptions } from '../src/renderer/src/views/export/types';
import { useRestrictedMode } from '../src/renderer/src/state/restrictedMode';
import { ExportLightbox } from '../src/renderer/src/views/export/ExportLightbox';
import { BaselinePicker } from '../src/renderer/src/views/export/BaselinePicker';

const f = vi.hoisted(() => ({
  armed: false,
  access: {
    qqOnline: true,
    attachEnabled: true,
    hasA2: true,
    hasD2: true,
    hasD2Key: true,
    hasGuid: true,
  },
  arm: vi.fn(async (_input: unknown) => ({})),
  disarm: vi.fn(async () => ({})),
  refresh: vi.fn(async () => true),
  pickBaseline: vi.fn(async () => '/synthetic/baseline'),
  baselines: [
    {
      directory: '/synthetic/baseline/.weq-export',
      journalPath: '/synthetic/baseline/.weq-export/messages.jsonl',
      name: '合成归档',
      kind: 'group',
      conv: '777',
      messageCount: 9,
      formats: ['json'],
      range: null,
      updatedAt: 1792771200000,
      bytes: 1024,
    },
  ],
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      exportCalendar: { useQuery: () => ({ data: undefined, isLoading: false, isError: false }) },
    },
  },
  client: {
    account: {
      getGroupAlbumAccessState: { query: async () => ({ ...f.access }) },
      onlineTranscribeStatus: { query: async () => ({ armed: f.armed }) },
      onlineTranscribeArm: { mutate: f.arm },
      onlineTranscribeDisarm: { mutate: f.disarm },
      refreshRkeys: { mutate: f.refresh },
      pickExportBaselineDirectory: { mutate: f.pickBaseline },
      listExportBaselines: {
        query: async () => ({ items: f.baselines.map((item) => ({ ...item })), truncated: false }),
      },
    },
    wonderfulTools: {
      captureSupport: { query: async () => ({ available: true, elevated: false }) },
    },
    bootstrap: {
      getSettings: {
        query: async () => ({
          voiceTranscribe: { modelId: 'fixture' },
          ocr: { modelId: '', filterModelId: '' },
        }),
      },
      voiceModels: { query: async () => [{ id: 'fixture', downloaded: true }] },
      ocrModels: { query: async () => ({ models: [], engineBlocker: null }) },
      onOcrModelProgress: { subscribe: () => ({ unsubscribe() {} }) },
    },
  },
}));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.armed = false;
  f.access = {
    qqOnline: true,
    attachEnabled: true,
    hasA2: true,
    hasD2: true,
    hasD2Key: true,
    hasGuid: true,
  };
  f.arm.mockClear();
  f.baselines = [
    {
      directory: '/synthetic/baseline/.weq-export',
      journalPath: '/synthetic/baseline/.weq-export/messages.jsonl',
      name: '合成归档',
      kind: 'group',
      conv: '777',
      messageCount: 9,
      formats: ['json'],
      range: null,
      updatedAt: 1792771200000,
      bytes: 1024,
    },
  ];
  f.disarm.mockClear();
  f.refresh.mockClear();
  useRestrictedMode.setState({ requests: [], reasons: [], open: false });
});
afterEach(() => vi.unstubAllGlobals());
const options = (): ExportOptions => ({
  ...structuredClone(DEFAULT_OPTIONS),
  transcribeVoice: true,
  onlineTranscribe: true,
});
const flush = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
function mount(value: ExportOptions = options()) {
  const result = vi.fn();
  function Harness() {
    const authorization = useExportAuthorization(value, true);
    return h(
      'div',
      null,
      authorization.needsElevation ? h('span', null, '需要提权') : null,
      h(
        'button',
        {
          onClick: () => {
            void authorization.prepare(value).then((prepared) => {
              if (prepared) result(prepared);
            });
          },
        },
        '导出',
      ),
      authorization.dialog,
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(Harness)));
  return {
    host,
    result,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent === label,
  )!;
  expect(button).toBeDefined();
  act(() => button.click());
}

it('受限漫游、抓包和 OCR 按实际凭据判断，跳过不修改原配置或本地导出', () => {
  const value = { ...options(), completeMessages: true, ocrImages: true, onlineOcr: true };
  const state = {
    access: { ...f.access, hasA2: false },
    capture: { available: true, elevated: false },
    armed: false,
  };
  const plan = exportAuthorizationPlan(value, state);
  expect(plan).toMatchObject({ elevate: true, capture: true, roaming: true, ocr: true });
  expect(skipExportAuthorization(value, plan)).toMatchObject({
    completeMessages: false,
    onlineTranscribe: false,
    transcribeVoice: true,
    ocrImages: false,
    exportMedia: value.exportMedia,
  });
  expect(value.completeMessages).toBe(true);
  expect(
    exportAuthorizationPlan(value, { ...state, access: { ...f.access }, armed: true }).needed,
  ).toBe(false);
  expect(
    exportAuthorizationPlan(
      { ...value, onlineTranscribe: false },
      { ...state, access: { ...f.access, needsMemoryRead: true }, armed: true },
    ).elevate,
  ).toBe(true);
});

it('勾选在线项目不启动抓包，直接导出弹提权框，可跳过后提交其余选项', async () => {
  const view = mount();
  try {
    await flush();
    expect(view.host.textContent).toContain('需要提权');
    expect(f.arm).not.toHaveBeenCalled();
    click(view.host, '导出');
    await flush();
    expect(view.host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(f.arm).not.toHaveBeenCalled();
    click(view.host, '跳过需提权项目');
    await flush();
    expect(view.result).toHaveBeenCalledWith(
      expect.objectContaining({ onlineTranscribe: false, transcribeVoice: true }),
    );
    expect(f.arm).not.toHaveBeenCalled();
  } finally {
    view.close();
  }
});

it('提权请求在当前弹窗显示，跳过取消本次密码请求但保留已有请求', async () => {
  useRestrictedMode
    .getState()
    .request({ kind: 'ptrace', token: 99, title: '已有授权', message: '已有请求' });
  let rejectArm: ((error: Error) => void) | undefined;
  f.arm.mockImplementationOnce(async () => {
    useRestrictedMode
      .getState()
      .request({ kind: 'password', token: 11, title: '导出抓包', message: '合成授权请求' });
    return await new Promise((_resolve, reject) => {
      rejectArm = reject;
    });
  });
  const send = vi.fn((_channel: string, payload: { token: number; password?: string | null }) => {
    if (payload.token === 11 && payload.password === null) rejectArm?.(new Error('cancelled'));
  });
  vi.stubGlobal('electron', { ipcRenderer: { send } });
  const view = mount();
  try {
    await flush();
    click(view.host, '导出');
    await flush();
    click(view.host, '提权并继续');
    await flush();
    expect(view.host.querySelector('[role="dialog"] input[type="password"]')).not.toBeNull();
    click(view.host, '跳过需提权项目');
    await flush();
    expect(send).toHaveBeenCalledWith('elev:respond-password', { token: 11, password: null });
    expect(useRestrictedMode.getState().requests.map((request) => request.token)).toEqual([99]);
    expect(view.result).toHaveBeenCalledOnce();
  } finally {
    rejectArm?.(new Error('cleanup'));
    view.close();
  }
});

it('授权成功后才将完整选项交给导出，已就绪时不再次抓包', async () => {
  f.arm.mockImplementationOnce(async () => {
    f.armed = true;
    return {};
  });
  const view = mount();
  try {
    await flush();
    click(view.host, '导出');
    await flush();
    expect(view.result).not.toHaveBeenCalled();
    click(view.host, '提权并继续');
    await flush();
    expect(view.result).toHaveBeenCalledWith(expect.objectContaining({ onlineTranscribe: true }));
    click(view.host, '导出');
    await flush();
    expect(f.arm).toHaveBeenCalledOnce();
    expect(view.result).toHaveBeenCalledTimes(2);
  } finally {
    view.close();
  }
});

it('真实导出配置窗口选择基线后将文件夹带入本次确认', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    confirm = vi.fn();
  try {
    act(() =>
      root.render(
        h(ExportLightbox, {
          embedded: true,
          variant: 'full',
          headline: '导出',
          summary: '合成会话',
          onClose: vi.fn(),
          onConfirm: confirm,
          initialOptions: { ...DEFAULT_OPTIONS, exportMedia: false, exportAvatar: false },
        }),
      ),
    );
    await flush();
    act(() => host.querySelector<HTMLButtonElement>('[title="选择增量基线文件夹"]')!.click());
    await flush();
    act(() => host.querySelector<HTMLButtonElement>('[title="浏览基线所在文件夹"]')!.click());
    await flush();
    expect(host.textContent).toContain('合成归档');
    expect(host.textContent).toContain('约 9 条');
    click(host, '使用所选基线');
    await flush();
    expect(host.querySelector<HTMLInputElement>('[aria-label="增量基线文件夹"]')?.value).toBe(
      '/synthetic/baseline',
    );
    click(host, '开始导出');
    await flush();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ baselineDirectory: '/synthetic/baseline' }),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('查看器带入的增量基线保留到真实导出配置确认，不重新要求挑选', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    confirm = vi.fn();
  try {
    act(() =>
      root.render(
        h(ExportLightbox, {
          embedded: true,
          variant: 'full',
          headline: '导出',
          summary: '合成会话',
          initialBaselineDirectory: '/synthetic/baseline/.weq-export',
          calendarTargets: [{ kind: 'group', conv: '777' }],
          initialOptions: { ...DEFAULT_OPTIONS, exportMedia: false, exportAvatar: false },
          onClose: vi.fn(),
          onConfirm: confirm,
        }),
      ),
    );
    await flush();
    expect(host.querySelector<HTMLInputElement>('[aria-label="增量基线文件夹"]')?.value).toBe(
      '/synthetic/baseline/.weq-export',
    );
    click(host, '开始导出');
    await flush();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ baselineDirectory: '/synthetic/baseline/.weq-export' }),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('上级文件夹找到多个相同会话时列出信息并要求选择，不静默取最新', async () => {
  f.baselines.push({
    ...f.baselines[0]!,
    directory: '/synthetic/other/.weq-export',
    name: '另一份归档',
    messageCount: 12,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    select = vi.fn();
  try {
    act(() =>
      root.render(
        h(BaselinePicker, {
          initialDirectory: '/synthetic',
          targets: [{ kind: 'group', conv: '777' }],
          onSelect: select,
          onClose: vi.fn(),
        }),
      ),
    );
    await flush();
    expect(host.textContent).toContain('找到 2 个相同会话');
    expect(host.textContent).toContain('约 12 条');
    const confirm = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '使用所选基线',
    )!;
    expect(confirm.disabled).toBe(true);
    act(() => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    click(host, '使用所选基线');
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        byConversation: { 'group:777': '/synthetic/baseline/.weq-export' },
      }),
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('未找到同一会话时提示创建或重新选择，由用户确认新建', async () => {
  f.baselines = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    select = vi.fn();
  try {
    act(() =>
      root.render(
        h(BaselinePicker, {
          initialDirectory: '/synthetic',
          targets: [{ kind: 'group', conv: '777' }],
          onSelect: select,
          onClose: vi.fn(),
        }),
      ),
    );
    await flush();
    expect(host.textContent).toContain('未找到相同会话');
    expect(select).not.toHaveBeenCalled();
    click(host, '新建导出');
    expect(select).toHaveBeenCalledWith(null);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('关闭配置不停止原来已就绪的抓包会话', async () => {
  f.armed = true;
  const view = mount();
  await flush();
  view.close();
  expect(f.arm).not.toHaveBeenCalled();
  expect(f.disarm).not.toHaveBeenCalled();
});

it('授权提示上送外层标题栏，内部不重复放置按钮', async () => {
  f.access.hasA2 = false;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    indicator = vi.fn();
  try {
    act(() =>
      root.render(
        h(ExportLightbox, {
          embedded: true,
          variant: 'full',
          headline: '导出',
          summary: '合成会话',
          onClose: vi.fn(),
          onConfirm: vi.fn(),
          onAuthorizationChange: indicator,
          initialOptions: {
            ...DEFAULT_OPTIONS,
            completeMessages: true,
            exportMedia: false,
            exportAvatar: false,
          },
        }),
      ),
    );
    await flush();
    expect(indicator).toHaveBeenLastCalledWith(
      expect.objectContaining({ needed: true, request: expect.any(Function) }),
    );
    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent === '需要提权'),
    ).toBe(false);
    const state = indicator.mock.calls.at(-1)![0] as { request: () => void };
    act(() => state.request());
    await flush();
    expect(host.querySelector('[role="dialog"][aria-label="需要提权"]')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[title="返回导出配置"]')!.click());
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
