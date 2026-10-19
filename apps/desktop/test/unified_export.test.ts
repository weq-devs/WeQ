import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { X } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportTool } from '../src/renderer/src/views/ExportView';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_OPTIONS } from '../src/renderer/src/views/export/types';
import type { LightboxResult } from '../src/renderer/src/views/export/ExportLightbox';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import type { ExportTask, ExportSavePolicy } from '@weq/service';
import type { UiTask } from '../src/renderer/src/views/export/TaskList';

const fixture = vi.hoisted(() => ({
  realPicker: false,
  current: true,
  configId: 'fixture-config',
  tasks: [] as ExportTask[],
  saveOutput: vi.fn(async (_input: unknown): Promise<string | null> => '/saved/result.json'),
  dialogError: vi.fn(),
  dialogInfo: vi.fn(),
  prepare: vi.fn(
    async (intent?: ExportSavePolicy): Promise<ExportSavePolicy | null> =>
      intent ?? { mode: 'after' },
  ),
  startContacts: vi.fn(
    async (_input: {
      scope: string;
      groupCode?: string;
      uids?: string[];
      categoryIds?: number[];
    }) => 'contact-task',
  ),
  contactPreview: vi.fn(),
  nativeReads: vi.fn(),
  startGuild: vi.fn(async (_input: { nodeId: string; messageIds?: string[] }) => 'guild-task'),
  startQzone: vi.fn(async (_input: { targetUin: string; tids?: string[] }) => 'qzone-task'),
  friends: ['a', 'b', 'c'].map((id, index) => ({
    uid: `friend-${id}`,
    uin: String(10001 + index),
    name: `合成好友${id}`,
    categoryId: 0,
  })),
  members: ['a', 'b', 'c'].map((id, index) => ({
    uid: `member-${id}`,
    uin: String(20001 + index),
    name: `合成成员${id}`,
    categoryId: 0,
  })),
  groups: [
    { groupCode: '10001', groupName: '合成群甲', memberCount: 3 },
    { groupCode: '10002', groupName: '合成群乙', memberCount: 3 },
  ],
  conversations: [
    {
      chatType: 1,
      targetUid: 'u_fixture',
      targetUin: '10001',
      targetDisplayName: '合成好友',
      messageCount: 8,
    },
  ],
  schedules: [
    {
      id: 'schedule-1',
      name: '合成计划',
      enabled: true,
      format: 'json',
      conversations: [],
      schedule: { mode: 'daily', time: '12:00' },
      options: { range: { preset: 'all' } },
      nextRunAt: null,
      history: [],
    },
  ],
}));
const emptyQuery = { data: [], isLoading: false, isError: false, refetch: vi.fn() };
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { listExportTasks: { invalidate: vi.fn() } } }),
    account: {
      getAccountConfig: {
        useQuery: () => ({ data: { uin: '10002', configId: fixture.configId }, isFetching: false }),
      },
      listConversationsWithCount: {
        useQuery: (_input: undefined, options: { enabled: boolean }) => {
          if (options.enabled) fixture.nativeReads('conversations');
          return { data: fixture.conversations };
        },
      },
      getSelfProfile: {
        useQuery: (_input: undefined, options: { enabled: boolean }) => {
          if (options.enabled) fixture.nativeReads('self');
          return { data: { uid: 'u_self', uin: '10002', nick: '自己', avatarUrl: '' } };
        },
      },
      listAllGroups: { useQuery: () => emptyQuery },
      exportGroupDirectory: { useQuery: () => ({ ...emptyQuery, data: fixture.groups }) },
      contactsExportPreview: {
        useQuery: (input: { scope: string }, options: { enabled: boolean }) => {
          if (options.enabled) fixture.contactPreview(input);
          return {
            ...emptyQuery,
            data: input.scope === 'friends' ? fixture.friends : fixture.members,
          };
        },
      },
      listExportTasks: { useQuery: () => ({ ...emptyQuery, data: fixture.tasks }) },
      listSchedules: { useQuery: () => ({ data: fixture.schedules }) },
      guildDirectListSessions: {
        useQuery: () => ({
          ...emptyQuery,
          data: [
            {
              nodeId: '100',
              peerNick: '合成频道好友',
              peerTinyId: '200',
              messageCount: 3,
            },
          ],
        }),
      },
      listCategories: { useQuery: () => emptyQuery },
      listBuddies: { useQuery: () => emptyQuery },
      listFriendsByIntimacy: { useQuery: () => emptyQuery },
    },
  },
  client: {
    bootstrap: { getExportPresets: { query: async () => ({}) } },
    account: {
      onExportProgress: { subscribe: () => ({ unsubscribe: vi.fn() }) },
      startContactsExport: { mutate: fixture.startContacts },
      saveExportTaskOutput: { mutate: fixture.saveOutput },
      guildDirectStartExport: { mutate: fixture.startGuild },
      startQzoneExport: { mutate: fixture.startQzone },
    },
  },
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: (selector: (value: { openedUin: string }) => unknown) =>
    selector({ openedUin: '10002' }),
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => {
    const configId = fixture.configId;
    return {
      settings: {},
      policy: { mode: 'after' },
      binding: { expectedAccountUin: '10002', expectedAccountConfigId: configId },
      setOverride: vi.fn(),
      prepareSave: fixture.prepare,
      pickDirectory: vi.fn(),
      setDefault: vi.fn(),
      isCurrent: () => fixture.current && fixture.configId === configId,
    };
  },
}));
vi.mock('../src/renderer/src/hooks/useExportCollections', () => ({
  useExportCollections: () => ({ items: [], loading: false }),
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ error: fixture.dialogError, info: fixture.dialogInfo, success: vi.fn() }),
}));
vi.mock('../src/renderer/src/views/export/TaskList', () => ({
  TaskList: ({
    tasks,
    onDownload,
    onSaveAll,
  }: {
    tasks: UiTask[];
    onDownload: (task: UiTask) => void;
    onSaveAll: () => void;
  }) =>
    createElement(
      'div',
      null,
      '合成执行任务',
      ...tasks.map((task) =>
        createElement('button', { key: task.id, onClick: () => onDownload(task) }, '保存合成任务'),
      ),
      createElement('button', { onClick: onSaveAll }, '保存全部合成任务'),
    ),
}));
vi.mock('../src/renderer/src/views/export/ExportLightbox', () => ({
  ExportLightbox: ({
    onConfirm,
    onClose,
    scopeSummary,
    summary,
    onEditList,
    hidden,
  }: {
    onConfirm: (result: LightboxResult) => void;
    onClose: () => void;
    scopeSummary?: string;
    summary?: string;
    onEditList?: () => void;
    hidden?: boolean;
  }) =>
    createElement(
      'div',
      { hidden, 'data-config': '' },
      createElement('span', { 'data-export-summary': '' }, scopeSummary || summary),
      onEditList && createElement('button', { onClick: onEditList }, '编辑列表'),
      createElement(
        'button',
        { onClick: () => onConfirm({ formats: ['json'], options: DEFAULT_OPTIONS }) },
        '夹具确认导出',
      ),
      createElement('button', { onClick: onClose }, '夹具关闭配置'),
    ),
}));
vi.mock('../src/renderer/src/views/export/ConversationPicker', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/renderer/src/views/export/ConversationPicker')>();
  return {
    ConversationPicker: ({ ...props }: Parameters<typeof actual.ConversationPicker>[0]) => {
      if (fixture.realPicker) return createElement(actual.ConversationPicker, props);
      const { selected, onChange, onEditScope } = props;
      return createElement(
        'div',
        { 'data-selection': [...selected].join(',') },
        createElement(
          'button',
          { onClick: () => onChange(new Set(fixture.conversations.map((item) => item.targetUid))) },
          '夹具全选',
        ),
        createElement('button', { onClick: () => onEditScope?.(props.items[0]!) }, '夹具调整范围'),
      );
    },
  };
});
vi.mock('../src/renderer/src/views/export/MessageScopePicker', () => ({
  MessageScopePicker: ({ onChange, kind }: { onChange: (ids: string[]) => void; kind: string }) => {
    const [seed] = useState(kind);
    return createElement(
      'div',
      { 'data-scope-picker': '', 'data-scope-seed': seed },
      createElement('button', { onClick: () => onChange(['2']) }, '夹具改消息选择'),
    );
  },
}));
vi.mock('../src/renderer/src/views/export/QzoneScopePicker', () => ({
  QzoneScopePicker: ({ onChange }: { onChange: (ids: string[]) => void }) =>
    createElement('button', { onClick: () => onChange(['other']) }, '夹具改说说选择'),
}));
vi.mock('../src/renderer/src/views/export/preflight', () => ({
  preflightQqOnline: vi.fn(async () => true),
  ocrReadiness: vi.fn(async () => ({ filterReady: true })),
}));
vi.mock('../src/renderer/src/views/export/chatExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/views/export/chatExport')>()),
  preflightChatExport: vi.fn(async () => true),
}));

function mount(props: Parameters<typeof ExportTool>[0] = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (active: boolean) =>
    act(() =>
      root.render(createElement(TabActivity, { active }, createElement(ExportTool, props))),
    );
  render(true);
  return {
    host,
    setActive: render,
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  fixture.realPicker = false;
  fixture.current = true;
  fixture.configId = 'fixture-config';
  fixture.tasks = [];
  fixture.saveOutput.mockReset().mockResolvedValue('/saved/result.json');
  fixture.dialogError.mockClear();
  fixture.dialogInfo.mockClear();
  fixture.prepare.mockReset().mockImplementation(async (intent) => intent ?? { mode: 'after' });
  fixture.startContacts.mockReset().mockResolvedValue('contact-task');
  fixture.contactPreview.mockClear();
  fixture.nativeReads.mockClear();
  fixture.startGuild.mockClear();
  fixture.startQzone.mockClear();
});
function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text)!;
  act(() => button.click());
}

function captureLayout(host: HTMLElement, name: string) {
  const output = process.env.WEQ_EXPORT_LAYOUT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const styles = [
    'index.css',
    'export.css',
    'workspace-tools.css',
    'workspace-surfaces.css',
    'unified-export.css',
    'search-scope.css',
    'export-save-control.css',
  ]
    .map((file) => readFileSync(resolve('src/renderer/src/styles', file), 'utf8'))
    .join('\n');
  const snapshot = host.cloneNode(true) as HTMLElement;
  const selects = host.querySelectorAll('select');
  snapshot.querySelectorAll('select').forEach((select, index) => {
    for (const option of select.options)
      option.toggleAttribute('selected', option.value === selects[index]!.value);
  });
  const inputs = host.querySelectorAll('input');
  snapshot.querySelectorAll('input').forEach((input, index) => {
    input.toggleAttribute('checked', inputs[index]!.checked);
    input.setAttribute('value', inputs[index]!.value);
  });
  const closeIcon = renderToStaticMarkup(createElement(X, { size: 18 }));
  writeFileSync(
    resolve(output, `${name}.html`),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${styles}</style><style>html,body{margin:0;box-sizing:border-box;font-family:system-ui}*,*::before,*::after{box-sizing:border-box}.weq-dialog-layer{position:fixed;inset:0;display:grid;place-items:center}.weq-tools-modal{width:1000px}button,input,select{font:inherit}body{background:var(--weq-chat-bg,var(--background))}</style><body><div class="weq-dialog-layer"><div class="weq-modal weq-tools-modal"><header class="weq-tools-header"><h2>导出</h2><button type="button" aria-label="关闭工具">${closeIcon}</button></header>${snapshot.innerHTML}</div></div></body></html>`,
  );
}

describe('统一导出实际界面', () => {
  it('频道保存准备期间同号切换配置，不创建新数据源的任务', async () => {
    let finish!: (policy: ExportSavePolicy) => void;
    fixture.prepare.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const f = mount({
      initialSelection: {
        owner: { kind: 'guild-direct', container: '100' },
        scope: { type: 'all' },
      },
    });
    try {
      click(f.host, '导出');
      await act(async () => click(f.host, '夹具确认导出'));
      expect(fixture.prepare).toHaveBeenCalledOnce();
      fixture.configId = 'other-source';
      await act(async () => finish({ mode: 'after' }));
      expect(fixture.startGuild).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('正文不再单列保存配置，本次另存经确认后执行且下次主按钮恢复默认', async () => {
    const f = mount({
      initialSelection: {
        owner: { kind: 'contacts', container: 'friends' },
        scope: { type: 'items', ids: ['friend-b'] },
      },
    });
    try {
      expect(f.host.querySelector('.weq-export-save-control')).toBeNull();
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.click(),
      );
      const choose = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (node) => node.textContent === '另存到…',
      )!;
      expect(choose).toBeDefined();
      act(() => choose.click());
      expect(fixture.prepare).not.toHaveBeenCalled();
      await act(async () => click(f.host, '夹具确认导出'));
      expect(fixture.prepare).toHaveBeenLastCalledWith({ mode: 'before' });
      expect(fixture.startContacts).toHaveBeenLastCalledWith(
        expect.objectContaining({ savePolicy: { mode: 'before' } }),
      );
      await act(async () => click(f.host, '导出联系人'));
      await act(async () => click(f.host, '夹具确认导出'));
      expect(fixture.prepare).toHaveBeenLastCalledWith(undefined);
      expect(fixture.startContacts).toHaveBeenLastCalledWith(
        expect.objectContaining({ savePolicy: { mode: 'after' } }),
      );
    } finally {
      f.close();
    }
  });
  it('桌面另存交由服务端按真实产物选择系统对话框，取消不报失败或丢失任务', async () => {
    fixture.tasks = [
      {
        id: 'save-a',
        kind: 'c2c',
        conv: 'u_fixture',
        name: '合成结果',
        format: 'json',
        status: 'completed',
        progress: 100,
        current: 1,
        total: 1,
        createdAt: 0,
        updatedAt: 0,
        filePath: '/cache/result.json',
      },
    ];
    fixture.saveOutput.mockResolvedValue(null);
    const f = mount({ surface: 'tasks' });
    try {
      await act(async () => click(f.host, '保存合成任务'));
      expect(fixture.prepare).not.toHaveBeenCalled();
      expect(fixture.saveOutput).toHaveBeenCalledWith({
        taskId: 'save-a',
        expectedAccountUin: '10002',
        expectedAccountConfigId: 'fixture-config',
      });
      expect(fixture.dialogError).not.toHaveBeenCalled();
      expect(fixture.tasks[0]?.status).toBe('completed');
      await act(async () => click(f.host, '保存全部合成任务'));
      expect(fixture.dialogError).not.toHaveBeenCalled();
      expect(fixture.dialogInfo).toHaveBeenCalledWith(
        '已取消保存',
        expect.stringContaining('仍保留'),
      );
    } finally {
      f.close();
    }
  });
  it('全局入口预选当前会话但显示完整内容类型和会话列表', async () => {
    const props: Parameters<typeof ExportTool>[0] = {
      fixedScope: false,
      contentListRevision: 1,
      initialSelection: {
        owner: { kind: 'messages', container: 'direct:u_fixture' },
        scope: { type: 'all' },
      },
    };
    const f = mount(props);
    try {
      await act(async () => {});
      const modes = f.host.querySelector<HTMLSelectElement>('#weq-export-content-kind');
      expect(modes?.value).toBe('full');
      expect(modes!.options.length).toBeGreaterThan(1);
      expect(f.host.querySelector('[data-selection]')?.getAttribute('data-selection')).toBe(
        'u_fixture',
      );
      expect(f.host.querySelector('[data-config]')).toBeNull();
      act(() => f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.click());
      expect(f.host.querySelector('[data-config]')).not.toBeNull();
      props.contentListRevision = 2;
      f.setActive(true);
      expect(f.host.querySelector('[data-config]')).toBeNull();
      expect(f.host.querySelector('[data-selection]')?.getAttribute('data-selection')).toBe(
        'u_fixture',
      );
      const reopenedModes = f.host.querySelector<HTMLSelectElement>('#weq-export-content-kind')!;
      act(() => {
        reopenedModes.value = 'guild';
        reopenedModes.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(reopenedModes.value).toBe('guild');
    } finally {
      f.close();
    }
  });
  it('多会话直接进入配置，编辑列表沿用选区且保留已打开的配置', async () => {
    const f = mount({
      fixedScope: true,
      initialSelection: {
        owner: { kind: 'conversations', container: 'recent' },
        scope: { type: 'items', ids: ['u_fixture', 'u_other'] },
      },
    });
    try {
      await act(async () => {});
      expect(f.host.querySelector('#weq-export-content-kind')).toBeNull();
      expect(f.host.querySelector('[data-export-summary]')?.textContent).toBe('2 个会话');
      const config = f.host.querySelector('[data-config]');
      click(f.host, '编辑列表');
      expect(f.host.querySelector('[data-selection]')?.getAttribute('data-selection')).toBe(
        'u_fixture,u_other',
      );
      expect(config?.hasAttribute('hidden')).toBe(true);
      click(f.host, '夹具全选');
      const primary = f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!;
      act(() => primary.click());
      expect(f.host.querySelector('[data-config]')).toBe(config);
      expect(config?.hasAttribute('hidden')).toBe(false);
      expect(f.host.querySelector('#weq-export-content-kind')).toBeNull();
      expect(f.host.querySelector('[data-export-summary]')?.textContent).toBe('1 个会话');
    } finally {
      f.close();
    }
  });
  it('单会话与多选消息入口直接打开配置，不展示会话或消息范围选择器', async () => {
    const f = mount({
      fixedScope: true,
      initialSelection: {
        owner: { kind: 'messages', container: 'direct:u_peer' },
        scope: { type: 'items', ids: ['1', '3'] },
      },
    });
    try {
      await act(async () => {});
      expect(f.host.querySelector('#weq-export-content-kind')).toBeNull();
      expect(f.host.querySelector('[data-scope-seed]')).toBeNull();
      expect(f.host.querySelector('[data-export-summary]')?.textContent).toContain(
        '精确选中 2 条消息',
      );
    } finally {
      f.close();
    }
  });
  it('普通群与频道节点数值相同，往返模式也不复用另一来源的范围读取现场', async () => {
    const original = fixture.conversations;
    fixture.conversations = [{ ...original[0]!, chatType: 2, targetUid: '100' }];
    const f = mount({
      initialSelection: {
        owner: { kind: 'messages', container: 'group:100' },
        scope: { type: 'items', ids: ['1'] },
      },
    });
    const mode = (value: string) =>
      act(() => {
        const select = f.host.querySelector<HTMLSelectElement>('#weq-export-content-kind')!;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    try {
      await act(async () => {});
      expect(f.host.querySelector('[data-scope-seed]')?.getAttribute('data-scope-seed')).toBe(
        'group',
      );
      mode('guild');
      click(f.host, '夹具调整范围');
      expect(f.host.querySelector('[data-scope-seed]')?.getAttribute('data-scope-seed')).toBe(
        'guild',
      );
      mode('full');
      expect(f.host.querySelector('[data-scope-seed]')?.getAttribute('data-scope-seed')).toBe(
        'group',
      );
    } finally {
      f.close();
      fixture.conversations = original;
    }
  });
  it('空间列表按 UIN 去重，普通会话不能覆盖自己的空间身份', async () => {
    const original = fixture.conversations;
    fixture.conversations = [
      { ...original[0]!, targetUin: '10002', targetDisplayName: '不应覆盖自己' },
    ];
    fixture.realPicker = true;
    const f = mount({
      initialSelection: {
        owner: { kind: 'qzone-posts', container: '10002' },
        scope: { type: 'all' },
      },
    });
    try {
      await act(async () => {});
      expect(f.host.querySelectorAll('.weq-exp-row')).toHaveLength(1);
      expect(f.host.querySelector('.weq-exp-row')!.textContent).toContain('自己（我）');
      expect(f.host.textContent).not.toContain('不应覆盖自己');
    } finally {
      f.close();
      fixture.conversations = original;
    }
  });
  it('非好友空间精确集合按 UIN 带入，保存准备期间修改草稿不改写确认目标', async () => {
    let release!: (policy: { mode: 'after' }) => void;
    fixture.prepare.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const selection = {
      owner: { kind: 'qzone-posts' as const, container: '19999' },
      scope: { type: 'items' as const, ids: ['a', 'c'] },
    };
    const f = mount({ initialSelection: selection });
    try {
      await act(async () => {});
      expect(f.host.querySelector<HTMLSelectElement>('#weq-export-content-kind')!.value).toBe(
        'qzone',
      );
      expect(f.host.querySelector('[aria-label="当前空间说说范围"]')).not.toBeNull();
      click(f.host, '导出空间');
      expect(f.host.querySelector('[data-export-summary]')!.textContent).toContain(
        '精确选中 2 条说说',
      );
      await act(async () => click(f.host, '夹具确认导出'));
      click(f.host, '夹具关闭配置');
      click(f.host, '夹具改说说选择');
      expect(fixture.startQzone).not.toHaveBeenCalled();
      await act(async () => release({ mode: 'after' }));
      expect(fixture.startQzone).toHaveBeenCalledWith(
        expect.objectContaining({
          targetUin: '19999',
          tids: ['a', 'c'],
          range: undefined,
          expectedAccountUin: '10002',
          expectedAccountConfigId: 'fixture-config',
        }),
      );
      expect(selection.scope.ids).toEqual(['a', 'c']);
    } finally {
      f.close();
    }
  });
  it('空间精确空集合禁止提交，不自动变成整空间', async () => {
    const f = mount({
      initialSelection: {
        owner: { kind: 'qzone-posts', container: '19999' },
        scope: { type: 'items', ids: [] },
      },
    });
    try {
      await act(async () => {});
      expect(f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.disabled).toBe(true);
    } finally {
      f.close();
    }
  });
  it('频道离散选择进入独立导出草稿，确认后改动不影响待创建任务', async () => {
    let release!: (policy: { mode: 'after' }) => void;
    fixture.prepare.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const selection = {
      owner: { kind: 'guild-direct' as const, container: '100' },
      scope: { type: 'items' as const, ids: ['1', '3'] },
    };
    const f = mount({ initialSelection: selection });
    try {
      await act(async () => {});
      expect(f.host.querySelector<HTMLSelectElement>('#weq-export-content-kind')!.value).toBe(
        'guild',
      );
      captureLayout(f.host, 'guild-precise');
      act(() => f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.click());
      expect(f.host.querySelector('[data-export-summary]')!.textContent).toContain(
        '精确选中 2 条消息',
      );
      await act(async () => click(f.host, '夹具确认导出'));
      click(f.host, '夹具关闭配置');
      click(f.host, '夹具改消息选择');
      expect(fixture.startGuild).not.toHaveBeenCalled();
      await act(async () => release({ mode: 'after' }));
      expect(fixture.startGuild).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: '100',
          messageIds: ['1', '3'],
          range: undefined,
        }),
      );
      expect(selection.scope.ids).toEqual(['1', '3']);
    } finally {
      f.close();
    }
  });
  it('频道空精确集合禁止导出，切号后的旧草稿不创建任务', async () => {
    const props = {
      initialSelection: {
        owner: { kind: 'guild-direct' as const, container: '100' },
        scope: { type: 'items' as const, ids: [] as string[] },
      },
    };
    const empty = mount(props);
    try {
      await act(async () => {});
      expect(empty.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.disabled).toBe(true);
    } finally {
      empty.close();
    }
    const f = mount({
      initialSelection: { ...props.initialSelection, scope: { type: 'items', ids: ['1'] } },
    });
    try {
      await act(async () => {});
      act(() => f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.click());
      fixture.current = false;
      await act(async () => click(f.host, '夹具确认导出'));
      expect(fixture.startGuild).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('联系人模式不读取聊天计数，隐藏工具停止新目录查询但保留精确草稿', async () => {
    const f = mount({
      initialSelection: {
        owner: { kind: 'contacts', container: 'friends' },
        scope: { type: 'items', ids: ['friend-b'] },
      },
    });
    try {
      await act(async () => {});
      expect(fixture.nativeReads).not.toHaveBeenCalled();
      fixture.contactPreview.mockClear();
      f.setActive(false);
      expect(fixture.contactPreview).not.toHaveBeenCalled();
      f.setActive(true);
      expect(fixture.contactPreview).toHaveBeenCalledWith({ scope: 'friends' });
      expect(f.host.textContent).toContain('精确选中 1 位好友');
    } finally {
      f.close();
    }
  });
  it('真实好友与成员选择器复用有界列表，精确范围保留在工具内', async () => {
    fixture.realPicker = true;
    const friends = fixture.friends,
      members = fixture.members;
    fixture.friends = friends.map((friend) => ({ ...friend, uin: '0' }));
    fixture.members = members.map((member) => ({ ...member, uin: '0' }));
    const f = mount({
      initialSelection: {
        owner: { kind: 'contacts', container: 'friends' },
        scope: { type: 'items', ids: ['friend-b'] },
      },
    });
    try {
      await act(async () => {});
      expect(f.host.querySelectorAll('.weq-exp-row')).toHaveLength(3);
      expect(f.host.querySelector('.weq-exp-row[aria-pressed="true"]')?.textContent).toContain(
        '合成好友b',
      );
      captureLayout(f.host, 'friends-precise');
    } finally {
      f.close();
      fixture.friends = friends;
      fixture.members = members;
    }
    fixture.members = members.map((member) => ({ ...member, uin: '0' }));
    const group = mount({
      initialSelection: {
        owner: { kind: 'contacts', container: 'group:10001' },
        scope: { type: 'items', ids: ['member-a', 'member-c'] },
      },
    });
    try {
      await act(async () => {});
      expect(group.host.querySelectorAll('.weq-export-contact-panel .weq-exp-row')).toHaveLength(3);
      expect(
        group.host.querySelectorAll('.weq-export-contact-panel .weq-exp-row[aria-pressed="true"]'),
      ).toHaveLength(2);
      captureLayout(group.host, 'members-precise');
    } finally {
      group.close();
      fixture.friends = friends;
      fixture.members = members;
    }
  });
  it('好友多选带入联系人模式，精确 UID 贯穿导出确认而不是扩大成全部好友', async () => {
    const selection = {
      owner: { kind: 'contacts' as const, container: 'friends' },
      scope: { type: 'items' as const, ids: ['friend-b'] },
    };
    const f = mount({ initialSelection: selection });
    try {
      await act(async () => {});
      expect(f.host.querySelector<HTMLSelectElement>('#weq-export-content-kind')!.value).toBe(
        'contacts',
      );
      expect(f.host.textContent).toContain('精确选中 1 位好友');
      click(f.host, '导出联系人');
      expect(f.host.querySelector('[data-export-summary]')?.textContent).toContain(
        '精确选中 1 位好友',
      );
      await act(async () => {
        click(f.host, '夹具确认导出');
      });
      expect(fixture.startContacts).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'friends', uids: ['friend-b'] }),
      );
      expect(fixture.startContacts.mock.calls[0]?.[0]).not.toHaveProperty('categoryIds');
      expect(selection.scope.ids).toEqual(['friend-b']);
      expect(f.host.textContent).toContain('精确选中 1 位好友');
    } finally {
      f.close();
    }
  });
  it('等待保存位置时修改工具草稿，不会改写已经确认的联系人目标', async () => {
    let resolve!: (policy: { mode: 'after' }) => void;
    fixture.prepare.mockReturnValueOnce(
      new Promise<{ mode: 'after' }>((done) => {
        resolve = done;
      }),
    );
    const f = mount({
      initialSelection: {
        owner: { kind: 'contacts', container: 'friends' },
        scope: { type: 'items', ids: ['friend-b'] },
      },
    });
    try {
      await act(async () => {});
      click(f.host, '导出联系人');
      await act(async () => {
        click(f.host, '夹具确认导出');
      });
      click(f.host, '夹具关闭配置');
      act(() => f.host.querySelector<HTMLInputElement>('.weq-export-contact-mode input')!.click());
      expect(fixture.startContacts).not.toHaveBeenCalled();
      f.setActive(false);
      await act(async () => {
        resolve({ mode: 'after' });
      });
      expect(fixture.startContacts).toHaveBeenCalledWith(
        expect.objectContaining({ uids: ['friend-b'] }),
      );
    } finally {
      f.close();
    }
  });
  it('多个群可分别创建成员任务，单群精确成员不影响其它群', async () => {
    const f = mount({
      initialSelection: {
        owner: { kind: 'contacts', container: 'group:10001' },
        scope: { type: 'items', ids: ['member-a', 'member-c'] },
      },
    });
    try {
      await act(async () => {});
      expect(f.host.querySelector('[aria-label="当前群成员范围"]')).not.toBeNull();
      expect(fixture.contactPreview).toHaveBeenCalledWith({ scope: 'group', groupCode: '10001' });
      click(f.host, '导出联系人');
      await act(async () => {
        click(f.host, '夹具确认导出');
      });
      expect(fixture.startContacts).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'group',
          groupCode: '10001',
          uids: ['member-a', 'member-c'],
        }),
      );
    } finally {
      f.close();
    }
    fixture.startContacts.mockClear();
    fixture.contactPreview.mockClear();
    const all = mount({
      initialSelection: {
        owner: { kind: 'contacts', container: 'groups' },
        scope: { type: 'items', ids: ['10001', '10002'] },
      },
    });
    try {
      await act(async () => {});
      expect(all.host.querySelector('[aria-label="当前群成员范围"]')).toBeNull();
      expect(fixture.contactPreview).not.toHaveBeenCalled();
      click(all.host, '导出联系人');
      await act(async () => {
        click(all.host, '夹具确认导出');
      });
      expect(fixture.startContacts.mock.calls.map((call) => call[0].groupCode)).toEqual([
        '10001',
        '10002',
      ]);
      for (const call of fixture.startContacts.mock.calls)
        expect(call[0]).not.toHaveProperty('uids');
    } finally {
      all.close();
    }
  });
  it('好友精确空集合禁止提交；切号后停止尚未创建的群成员任务', async () => {
    const empty = mount({
      initialSelection: {
        owner: { kind: 'contacts', container: 'friends' },
        scope: { type: 'items', ids: [] },
      },
    });
    try {
      await act(async () => {});
      expect(empty.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.disabled).toBe(true);
    } finally {
      empty.close();
    }
    fixture.startContacts.mockImplementationOnce(async () => {
      fixture.current = false;
      return 'first';
    });
    const f = mount({
      initialSelection: {
        owner: { kind: 'contacts', container: 'groups' },
        scope: { type: 'items', ids: ['10001', '10002'] },
      },
    });
    try {
      await act(async () => {});
      click(f.host, '导出联系人');
      await act(async () => {
        click(f.host, '夹具确认导出');
      });
      expect(fixture.startContacts).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });
  it('真实虚拟列表全选 1500 个会话后 DOM 有界，消息范围按需打开', async () => {
    const original = fixture.conversations;
    fixture.realPicker = true;
    fixture.conversations = Array.from({ length: 1500 }, (_, index) => ({
      ...original[0]!,
      targetUid: `u_${index}`,
      targetDisplayName: `离线夹具会话 ${index}`,
    }));
    const f = mount();
    try {
      await act(async () => {});
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="全选"]')!.click());
      expect(f.host.textContent).toContain('已选 1500 个会话');
      expect(f.host.querySelectorAll('.weq-exp-row').length).toBeLessThan(40);
      expect(f.host.querySelectorAll('[data-scope-picker]')).toHaveLength(0);
      captureLayout(f.host, 'all-selected');
      act(() =>
        f.host
          .querySelector<HTMLButtonElement>('[aria-label="调整 离线夹具会话 0 的消息范围"]')!
          .click(),
      );
      expect(f.host.querySelectorAll('[data-scope-picker]')).toHaveLength(1);
    } finally {
      f.close();
      fixture.realPicker = false;
      fixture.conversations = original;
    }
  });
  it('全选 1500 个会话不会挂载 1500 个消息范围；只编辑一个明确打开的会话', async () => {
    const original = fixture.conversations;
    fixture.conversations = Array.from({ length: 1500 }, (_, index) => ({
      ...original[0]!,
      targetUid: `u_${index}`,
      targetDisplayName: `夹具会话 ${index}`,
    }));
    const f = mount();
    try {
      await act(async () => {});
      click(f.host, '夹具全选');
      expect(f.host.querySelectorAll('[data-scope-picker]')).toHaveLength(0);
      expect(f.host.querySelectorAll('.weq-message-scope-conversation')).toHaveLength(0);
      expect(f.host.textContent).toContain('已选 1500 个会话');
      click(f.host, '夹具调整范围');
      expect(f.host.querySelectorAll('[data-scope-picker]')).toHaveLength(1);
    } finally {
      f.close();
      fixture.conversations = original;
    }
  });
  it('定时不是内容类别；聊天与空间选择各自保留', async () => {
    const f = mount({
      initialSelection: {
        owner: { kind: 'conversations', container: 'all' },
        scope: { type: 'items', ids: ['u_fixture'] },
      },
    });
    try {
      await act(async () => {});
      const select = f.host.querySelector<HTMLSelectElement>('#weq-export-content-kind')!;
      expect([...select.options].map((option) => option.value)).not.toContain('scheduled');
      expect(f.host.querySelector('[data-selection]')?.getAttribute('data-selection')).toBe(
        'u_fixture',
      );
      act(() => {
        select.value = 'qzone';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(f.host.querySelector('[data-selection]')?.getAttribute('data-selection')).toBe('');
      act(() => {
        select.value = 'full';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(f.host.querySelector('[data-selection]')?.getAttribute('data-selection')).toBe(
        'u_fixture',
      );
      click(f.host, '定时执行');
      expect(f.host.querySelector('.weq-exp-primary')?.textContent).toBe('新建定时任务');
      expect(f.host.textContent).not.toContain('合成计划');
    } finally {
      f.close();
    }
  });
  it('精确消息集合不被定时执行扩大成整个会话', async () => {
    const f = mount({
      initialSelection: {
        owner: { kind: 'messages', container: 'c2c:u_fixture' },
        scope: { type: 'items', ids: ['1', '3'] },
      },
    });
    try {
      await act(async () => {});
      expect(f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.disabled).toBe(false);
      click(f.host, '定时执行');
      expect(f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.disabled).toBe(true);
      expect(f.host.textContent).toContain('精确消息集合不能转换为定时范围');
      click(f.host, '立即导出');
      expect(f.host.querySelector<HTMLButtonElement>('.weq-exp-primary')!.disabled).toBe(false);
    } finally {
      f.close();
    }
  });
  it('任务工具独立显示执行任务与定时计划，不包含新建导出选择器', async () => {
    const f = mount({ surface: 'tasks' });
    try {
      await act(async () => {});
      expect(f.host.textContent).toContain('合成执行任务');
      expect(f.host.querySelector('#weq-export-content-kind')).toBeNull();
      click(f.host, '定时计划');
      expect(f.host.textContent).toContain('合成计划');
      expect(f.host.textContent).not.toContain('合成执行任务');
    } finally {
      f.close();
    }
  });
});
