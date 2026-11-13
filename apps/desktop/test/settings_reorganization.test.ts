import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog, type SectionId } from '../src/renderer/src/components/SettingsDialog';
import { HelpSection } from '../src/renderer/src/components/settings/HelpSection';
import type { SettingsSearchTarget } from '../src/renderer/src/components/settings/searchTarget';
import { useUpdateStore } from '../src/renderer/src/state/update';
import { useViewState } from '../src/renderer/src/state/view';
import { SETTINGS_ITEM_TARGETS } from '../src/renderer/src/components/settings/navigation';
import { SETTINGS_RESET_CARDS } from '../src/shared/settings_reset';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';

vi.mock('../src/renderer/src/trpc/client', () => {
  const queryData = (name: string) => {
    if (name === 'getAccountConfig')
      return {
        uin: '10001',
        configId: 'fixture',
        dbKey: 'synthetic-db-secret',
        static: false,
        rkeys: [{ type: 10, rkey: 'synthetic-rkey-secret', createTime: 1, ttlSeconds: 1 }],
        clientKey: {
          keyIndex: 1,
          clientKey: 'synthetic-client-secret',
          fetchedAt: 1,
          ttlSeconds: 1,
        },
      };
    if (name === 'getSelfProfile') return { uin: '10001', nick: '合成账号' };
    return undefined;
  };
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({
              data:
                path.join('.') === 'settings.intent.getStatus'
                  ? { engine: 'api' }
                  : queryData(path.at(-1) ?? ''),
              isLoading: false,
              refetch: vi.fn(),
            })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/components/settings/LogViewerPanel', () => ({
  LogViewerPanel: () => '合成日志查看器',
}));
vi.mock('../src/renderer/src/components/settings/FaqPanel', () => ({
  FaqPanel: () => '合成常见问题正文',
}));
vi.mock('../src/renderer/src/components/settings/BugReportPanel', () => ({
  BugReportPanel: () => '合成反馈表单',
}));

afterEach(() => vi.unstubAllGlobals());

function mount(initialSection?: SectionId) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const previousUin = useViewState.getState().openedUin;
  useViewState.setState({ openedUin: '10001' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenMaintenance = vi.fn();
  const render = (section: SectionId | undefined, searchTarget?: SettingsSearchTarget) =>
    act(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(SettingsDialog, {
            open: true,
            initialSection: section,
            searchTarget,
            onClose: vi.fn(),
            onOpenMaintenance,
            onOpenRecalls: vi.fn(),
          }),
        ),
      ),
    );
  render(initialSection);
  return {
    host,
    render,
    onOpenMaintenance,
    body: () => host.querySelector('.weq-settings-body')!,
    close: () => {
      act(() => root.unmount());
      useViewState.setState({ openedUin: previousUin });
      queryClient.clear();
      host.remove();
    },
  };
}

const FOCUSABLE_IN_ROW =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="switch"]:not([disabled]), button:not([disabled]), a[href], summary, [tabindex="0"]';

/** 命中提示后焦点应在行内控件上；行内没有可操作控件时才允许落在容器上。 */
function expectInnermostControlFocused(highlighted: HTMLElement | null) {
  expect(highlighted).not.toBeNull();
  const control = highlighted!.matches(FOCUSABLE_IN_ROW)
    ? highlighted!
    : highlighted!.querySelector(FOCUSABLE_IN_ROW);
  expect(document.activeElement).toBe(control ?? highlighted);
}

describe('设置归位后的实际页面', () => {
  it('媒体来源独立显示，账号页不再混入媒体设置，协议工具不重复放性能入口', () => {
    const f = mount('accounts');
    try {
      expect(f.body().querySelector('[data-setting-id="linked-resources"]')).toBeNull();
      expect(f.body().querySelector('[data-setting-id="external-chatpic"]')).toBeNull();
      f.render('media');
      expect(f.body().getAttribute('data-settings-page')).toBe('media');
      expect(f.body().querySelector('h3')?.textContent).toBe('媒体来源');
      expect(f.body().querySelector('[data-setting-id="linked-resources"]')).not.toBeNull();
      expect(f.body().querySelector('[data-setting-id="external-chatpic"]')).not.toBeNull();
      f.render('diagnostics');
      expect(f.body().querySelector('h3')?.textContent).toBe('QQ 协议工具');
      expect(f.body().querySelector('[data-setting-id="performance-monitor"]')).toBeNull();
      expect(f.body().querySelector('[data-setting-id="qqnt-capture"]')).not.toBeNull();
      f.render('resource-loading');
      expect(f.body().querySelector('[aria-label="优先直连 QQ 加载图片"]')).not.toBeNull();
      expect(f.body().textContent).toContain('缺失时代取并缓存');
      f.render('agentlab');
      expect(f.body().textContent).toContain('已保存的服务商');
      expect(f.body().textContent).not.toContain('已保存的 provider');
    } finally {
      f.close();
    }
  });
  it('含可恢复偏好的二级页和可见卡片均有统一入口，信息与工具页不显示', () => {
    const f = mount('appearance');
    try {
      for (const page of new Set(SETTINGS_RESET_CARDS.map(([id]) => id))) {
        f.render(page);
        expect(f.body().getAttribute('data-settings-page'), page).toBe(page);
        expect(f.body().querySelectorAll('[aria-label="恢复本页默认设置"]'), page).toHaveLength(1);
        // 恢复入口只保留页面级：卡片级按钮不再渲染，避免两个措辞不同的入口。
        for (const card of f.body().querySelectorAll('.weq-set-card')) {
          const title = card.querySelector('.weq-set-card-title')?.textContent;
          const descriptor = SETTINGS_RESET_CARDS.find(
            ([id, , label]) => id === page && label === title,
          );
          if (!descriptor) continue;
          expect(
            card.querySelector(`[aria-label="恢复${descriptor[2]}默认设置"]`),
            `${page}:${title}`,
          ).toBeNull();
        }
      }
      for (const page of [
        'backup',
        'faq',
        'feedback',
        'diagnostics',
        'database-management',
        'weq-storage',
      ] as const) {
        f.render(page);
        expect(f.body().querySelector('[aria-label="恢复本页默认设置"]'), page).toBeNull();
      }
    } finally {
      f.close();
    }
  });
  it('WeQ 服务直接展示独立管理页，不再显示后台服务总览', () => {
    const f = mount('mcp');
    try {
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map((node) => node.textContent),
      ).toEqual([
        'Web 与 Remote',
        'MCP 服务器',
        'OneBot / cc-connect',
        'SSE 推送',
        'QQ 公众号推送',
      ]);
      expect(f.host.textContent).not.toContain('后台服务');
      expect(f.body().querySelector('[aria-label="MCP 端口"]')).not.toBeNull();
      f.render('global', {
        section: 'global',
        settingId: 'window-close-behavior',
        revision: 1,
      });
      const setting = f.body().querySelector('[data-setting-id="window-close-behavior"]');
      expect(setting?.querySelector('[aria-label="关闭按钮行为"]')).not.toBeNull();
      expect(setting?.getAttribute('data-search-highlight')).toBe('true');
    } finally {
      f.close();
    }
  });
  it('Markdown 开关明确为自动渲染，关闭后仍可手动渲染', () => {
    const f = mount('message-display');
    try {
      const row = f.body().querySelector('[data-setting-id="text-markdown"]')!;
      expect(row.querySelector('.weq-set-row-label')?.textContent).toBe(
        '纯文本消息自动渲染为 Markdown',
      );
      expect(row.querySelector('[aria-label="纯文本消息自动渲染为 Markdown"]')).not.toBeNull();
      expect(row.textContent).toContain('仍可右键手动选择「显示 Markdown」');
    } finally {
      f.close();
    }
  });
  it('旧 TTS 页面直接定位 API 页内语音分区，不打开编辑弹窗', () => {
    const f = mount('tts');
    try {
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        'API 配置',
      );
      expect(
        f.body().querySelector<HTMLElement>('[data-search-highlight]')?.dataset.settingId,
      ).toBe('tts-providers');
      expect(f.onOpenMaintenance).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('旧应用锁入口与隐私同页，备份紧跟关于中的版本页且不打开工具', () => {
    const f = mount('applock');
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe('常规');
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe('隐私');
      for (const id of ['app-lock', 'unlock-method', 'auto-lock', 'privacy-mode']) {
        expect(f.body().querySelector(`[data-setting-id="${id}"]`)).not.toBeNull();
      }
      const appLock = f.body().querySelector('[data-setting-id="app-lock"]')!;
      expect(appLock.classList.contains('weq-set-card')).toBe(true);
      expect(appLock.querySelector('.weq-set-card')).toBeNull();
      for (const id of ['unlock-method', 'auto-lock']) {
        expect(appLock.querySelector(`[data-setting-id="${id}"]`)).not.toBeNull();
      }
      expect(appLock.textContent).toContain('WeQ 验证器');
      expect(appLock.querySelector('[aria-label="启用应用锁"]')).not.toBeNull();
      expect(appLock.querySelector('button')?.closest('.weq-set-card')).toBe(appLock);
      expect(f.body().querySelectorAll('.weq-set-card')).toHaveLength(2);
      f.render('backup');
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '关于 WeQ',
      );
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map((node) => node.textContent),
      ).toEqual(['版本与更新', '配置备份与恢复', '常见问题', '日志', '性能监视', '反馈']);
      expect(f.onOpenMaintenance).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('资源加载独立归数据分类，公众号独立页，Remote 开关位于连接方式前', () => {
    const f = mount('remote');
    try {
      expect(f.body().querySelector('[data-setting-id="prefer-cdn"]')).toBeNull();
      expect(f.body().textContent).not.toContain('QQ 公众号推送');
      const remote = f.body().querySelector('.weq-remote')!;
      const toggle = remote.querySelector('[aria-label="允许远程连接"]')!;
      const addresses = remote.querySelector('.weq-remote-addresses')!;
      expect(toggle.compareDocumentPosition(addresses) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
        0,
      );
      expect(remote.querySelector('[aria-label="连接方式"]')).toBeNull();
      f.render('resource-loading');
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '数据库与资源',
      );
      expect(f.body().querySelector('[data-setting-id="prefer-cdn"]')).not.toBeNull();
      expect(f.body().textContent).toContain('桌面端与 Web 共用');
      f.render('assistant');
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        'QQ 公众号推送',
      );
      expect(f.body().textContent).toContain('启用 QQ 公众号推送');
      expect(f.body().textContent).not.toContain('WeQ 助手');
    } finally {
      f.close();
    }
  });
  it('QQ 登录账号与逆向直接呈现在设置正文，不再是工具入口', () => {
    const f = mount('qq-accounts');
    try {
      expect(f.body().querySelector('.weq-login-acc')).not.toBeNull();
      expect(f.body().querySelector('.weq-maintenance-entry')).toBeNull();
      f.render('diagnostics');
      expect(f.body().querySelector('[data-setting-id="reverse-tool"] textarea')).not.toBeNull();
      expect(
        f.body().querySelector('[data-setting-id="reverse-tool"] .weq-maintenance-entry'),
      ).toBeNull();
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      expect(f.onOpenMaintenance).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('聊天设置拆成二级页面，不增加三级导航，同类开关合并为连续设置行', () => {
    const f = mount('chat-messages');
    try {
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map((node) => node.textContent),
      ).toEqual([
        '阅读与未读',
        '消息显示',
        '互动与防撤回',
        '联系人名片',
        '通话录音',
        'QQ 空间',
        'QQ 邮箱',
      ]);
      expect(f.body().querySelector('[role="tablist"]')).toBeNull();
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '阅读与未读',
      );
      expect(
        [...f.body().querySelectorAll('.weq-set-row-label')]
          .filter((node) => !node.closest('[data-setting-id^="all-conversations-"]'))
          .map((node) => node.textContent),
      ).toEqual([
        '在消息图标上显示红点',
        '在联系人界面显示未读消息数',
        '群助手显示总消息数',
        '向 QQ 服务器上报已读位置',
        '鼠标停留时保持会话位置',
        '从第一条新消息开始阅读',
        '自动跟随最新消息',
        '发送消息后定位到最新消息',
        '向下滚动时显示定位到底部按钮',
        '查看时自动拉取缺失的消息',
        '定位到缺失消息时自动拉取上下文',
      ]);
      const readReportRow = f.body().querySelector('[data-setting-id="read-sync"]');
      expect(
        readReportRow?.closest('.weq-set-card')?.querySelector('.weq-set-card-title')?.textContent,
      ).toBe('未读显示');
      expect(f.body().querySelector('[data-setting-id="message-system-notifications"]')).toBeNull();
      expect(f.body().querySelector('[data-setting-id="application-unread-badge"]')).toBeNull();
      expect(f.body().querySelectorAll('[data-setting-id="read-sync"]')).toHaveLength(1);
      expect(f.body().querySelector('.weq-set-card .weq-set-card')).toBeNull();
      expect(f.body().querySelector('.weq-settings-appearance-card')).toBeNull();
      expect(f.body().querySelector('[data-setting-id="anti-recall"]')).toBeNull();
      expect(f.body().querySelector('[data-setting-id="text-markdown"]')).toBeNull();
      const tabs = [...f.host.querySelectorAll<HTMLButtonElement>('.weq-settings-subnav-item')];
      act(() => tabs.find((tab) => tab.textContent === '消息显示')!.click());
      const display = f.body();
      expect(display.querySelector('.weq-set-card .weq-set-card')).toBeNull();
      expect(
        [...display.querySelectorAll('.weq-set-row-label')].map((node) => node.textContent),
      ).toEqual([
        '显示消息序号（seq）',
        '显示发送日期',
        '显示发送时间',
        '聊天头像挂件',
        '消息气泡',
        '消息字体',
        '聊天 QQ 秀替换头像',
        'QQ 秀缓存有效期',
        '纯文本消息自动渲染为 Markdown',
        '链接预览卡片',
        '无封面时网页截图',
        '语音消息自动转文字',
        '图片预览内存预算',
      ]);
      expect(
        [...display.querySelectorAll('.weq-set-card-title')].map((node) => node.textContent),
      ).toEqual(['时间与序号', '头像与装扮', '文本与链接', '语音消息', '图片与表情']);
      act(() => tabs.find((tab) => tab.textContent === '互动与防撤回')!.click());
      expect(f.body().querySelector('[data-setting-id="send-with-qq-font"]')).not.toBeNull();
      expect(f.body().querySelector('[data-setting-id="typing-status"]')).not.toBeNull();
      expect(f.body().querySelector('[data-setting-id="read-sync"]')).toBeNull();
      expect(f.body().querySelector('[data-setting-id="anti-recall"]')).not.toBeNull();
      expect(f.body().querySelector('[role="tablist"]')).toBeNull();
    } finally {
      f.close();
    }
  });
  it('旧聊天条目的搜索切换二级页，手动切页不重放旧搜索，同一条目可再次定位', () => {
    const f = mount('chat-messages');
    try {
      const target = {
        section: 'chat-messages',
        settingId: 'link-screenshot',
        revision: 1,
      } as const;
      f.render('chat-messages', target);
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '消息显示',
      );
      expect(
        f.body().querySelector('[data-search-highlight]')?.getAttribute('data-setting-id'),
      ).toBe('link-screenshot');
      const tabs = [...f.host.querySelectorAll<HTMLButtonElement>('.weq-settings-subnav-item')];
      act(() => tabs.find((tab) => tab.textContent === '阅读与未读')!.click());
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '阅读与未读',
      );
      expect(f.body().querySelector('[data-setting-id="link-screenshot"]')).toBeNull();
      f.render('chat-messages', { ...target, revision: 2 });
      expect(
        f.body().querySelector('[data-search-highlight]')?.getAttribute('data-setting-id'),
      ).toBe('link-screenshot');
      // 命中后焦点必须落到行内第一个可操作控件，而不是只有容器拿到焦点。
      expectInnermostControlFocused(f.body().querySelector('[data-search-highlight]'));
    } finally {
      f.close();
    }
  });
  it('聊天设置目录中每个条目都能切换到实际分类并定位', () => {
    const f = mount('chat-messages');
    try {
      act(() =>
        acceptPreferences(
          {
            revision: 1,
            records: {},
            values: { autoFetchMissingMessages: false, autoFetchMissingContext: true },
          },
          false,
        ),
      );
      let revision = 0;
      for (const item of SETTINGS_ITEM_TARGETS.filter((item) =>
        ['chat-messages', 'message-display', 'chat-interaction', 'anti-recall'].includes(
          item.section,
        ),
      )) {
        const target = { section: item.section, settingId: item.id, revision: ++revision };
        f.render('chat-messages', target);
        expect(f.body().getAttribute('data-settings-page'), item.id).toBe(item.section);
        expect(f.body().querySelector('[role="tablist"]'), item.id).toBeNull();
        expect(
          f.body().querySelector('[data-search-highlight]')?.getAttribute('data-setting-id'),
          item.id,
        ).toBe(item.id);
      }
    } finally {
      f.close();
      acceptPreferences({ revision: 2, records: {}, values: {} }, false);
    }
  });
  it.each([
    ['global', '默认发送正在输入状态', 'typing-status', '互动与防撤回'],
    ['account', '手动标记时上报已读位置', 'read-sync', '阅读与未读'],
    ['chat-messages', '向 QQ 服务器上报已读位置', 'read-sync', '阅读与未读'],
    ['storage', '优先使用 CDN', 'prefer-cdn', '资源加载'],
    ['media', '关联本机媒体目录', 'linked-resources', '媒体来源'],
    ['media', '允许使用外部安卓图片缓存', 'external-chatpic', '媒体来源'],
    ['rkey', '外部 RKEY', 'external-rkey', '凭据管理'],
    ['applock', '隐私模式', 'privacy-mode', '隐私'],
    ['applock', '启用应用锁', 'app-lock', '隐私'],
    ['applock', '解锁方式', 'unlock-method', '隐私'],
    ['applock', '无操作自动上锁', 'auto-lock', '隐私'],
    ['anti-recall', '防撤回', 'anti-recall', '互动与防撤回'],
    ['maintenance', '本地缓存', 'resource-viewer', 'QQ 资源管理'],
    ['maintenance', '存储占用', 'qq-storage-analysis', 'QQ 资源管理'],
    ['maintenance', '清理缓存', 'qq-storage-cleanup', 'QQ 资源管理'],
    ['maintenance', '数据库修复', 'database-repair', '损坏与修复'],
    ['maintenance', '导出明文数据库', 'database-export', '数据库管理'],
    ['maintenance', '密钥扫描', 'key-scan', '凭据管理'],
    ['maintenance', '其它设备密钥', 'other-device-key', '凭据管理'],
    ['message-display', '显示消息汇总红点', 'message-unread-badge', '阅读与未读'],
    ['chat-messages', '纯文本消息自动渲染为 Markdown', 'text-markdown', '消息显示'],
    ['chat-messages', '语音消息自动转文字', 'auto-transcribe-voice', '消息显示'],
    ['chat-messages', '图片预览内存预算', 'chat-image-cache', '消息显示'],
    ['chat-messages', '使用 QQ 账号设置的个性字体发送消息', 'send-with-qq-font', '互动与防撤回'],
    ['reply-suggestions', '常驻显示', 'intent-persistent-display', '意图感知'],
    ['reply-suggestions', '悬停显示', 'intent-hover-display', '意图感知'],
    ['intent-models', '意图模型资源', 'intent-engine', '意图感知'],
    ['database', '数据库异常时弹窗提醒', 'damage-reminder', '损坏与修复'],
  ] as const)('旧 %s / %s 定位实际控件而不执行工具', (section, item, settingId, page) => {
    const f = mount('appearance');
    try {
      f.render(section, { section, item, revision: 1 });
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(page);
      expect(
        f.body().querySelector<HTMLElement>('[data-search-highlight]')?.dataset.settingId,
      ).toBe(settingId);
      expect(f.onOpenMaintenance).not.toHaveBeenCalled();
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('未指定入口时默认启动，普通页面导航不自动执行工具', () => {
    const f = mount();
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe('常规');
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '启动与主页',
      );
      expect(f.onOpenMaintenance).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('更新提醒定位到帮助分类和版本项，打开页面不会清除待更新状态', () => {
    const f = mount('version');
    try {
      act(() => useUpdateStore.setState({ available: true }));
      expect(
        f.host.querySelector('.weq-settings-nav-item .weq-settings-update-mark')?.closest('button')
          ?.textContent,
      ).toBe('关于 WeQ');
      expect(
        f.host
          .querySelector('.weq-settings-subnav-item .weq-settings-update-mark')
          ?.closest('button')?.textContent,
      ).toBe('版本与更新');
      f.render('version');
      expect(useUpdateStore.getState().available).toBe(true);
      act(() => useUpdateStore.setState({ available: false }));
      expect(f.host.querySelector('.weq-settings-update-mark')).toBeNull();
    } finally {
      f.close();
      useUpdateStore.setState({ available: false });
    }
  });
  it('从搜索打开设置时切换分区并定位真实项目，离开分区撤销高亮', () => {
    const f = mount('qzone');
    try {
      for (const [section, item] of [
        ['appearance', '基础模式'],
        ['message-display', '显示消息序号（seq）'],
        ['storage', '空间清理'],
        ['global', '成功通知停留时长'],
        ['version', '内置组件'],
      ] as const) {
        f.render(section, { section, item, revision: Date.now() });
        const highlighted = f.body().querySelector<HTMLElement>('[data-search-highlight="true"]');
        expect(highlighted, `${section}: ${item}`).not.toBeNull();
        expectInnermostControlFocused(highlighted);
      }
      f.render('qzone');
      expect(f.host.querySelector('[data-search-highlight]')).toBeNull();
    } finally {
      f.close();
    }
  });
  it('手动离开后再次搜索同一页面也会重新定位，不被原 section 相同挡住', () => {
    const f = mount('qzone');
    try {
      const target = { section: 'appearance', item: '基础模式', revision: 1 } as const;
      f.render('appearance', target);
      act(() =>
        [...f.host.querySelectorAll<HTMLButtonElement>('.weq-settings-subnav-item')]
          .find((button) => button.textContent === '提醒与窗口')!
          .click(),
      );
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '提醒与窗口',
      );
      f.render('appearance', { ...target, revision: 2 });
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '主题与背景',
      );
      expect(f.body().querySelector('[data-search-highlight]')?.textContent).toContain('基础模式');
    } finally {
      f.close();
    }
  });
  it('旧独立帮助内容仍能切换日志、常见问题和反馈', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(createElement(HelpSection)));
      expect(host.textContent).toContain('合成日志查看器');
      const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      act(() => tabs.find((tab) => tab.textContent === '常见问题')!.click());
      expect(host.textContent).toContain('合成常见问题正文');
      act(() => tabs.find((tab) => tab.textContent === '反馈')!.click());
      expect(host.textContent).toContain('合成反馈表单');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('关于包含性能监视，版本更新及日志能力各自合并，旧入口仍可达', () => {
    const f = mount('version');
    try {
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map((item) => item.textContent),
      ).toEqual(['版本与更新', '配置备份与恢复', '常见问题', '日志', '性能监视', '反馈']);
      expect(f.body().querySelector('h3')?.textContent).toBe('版本与更新');
      expect(f.body().textContent).toContain('内置组件');
      expect(f.body().textContent).not.toContain('监控新版本发布');
      f.render('help');
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '常见问题',
      );
      expect(f.body().textContent).toContain('合成常见问题正文');
      expect(f.body().querySelector('[role="tablist"]')).toBeNull();
      f.render('logs');
      expect(f.body().querySelector('h3')?.textContent).toBe('日志');
      expect(f.body().textContent).toContain('日志保留时长');
      expect(f.body().textContent).toContain('合成日志查看器');
      const feedback = [
        ...f.host.querySelectorAll<HTMLButtonElement>('.weq-settings-subnav-item'),
      ].find((item) => item.textContent === '反馈')!;
      act(() => feedback.click());
      expect(f.body().textContent).toContain('合成反馈表单');
      expect(f.body().textContent).not.toContain('合成日志查看器');
      f.render('updates');
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '版本与更新',
      );
      expect(f.body().textContent).not.toContain('监控新版本发布');
    } finally {
      f.close();
    }
  });
  it('AI 分类不再提供独立克隆页及克隆创建入口', () => {
    const f = mount('agentlab');
    try {
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map((item) => item.textContent),
      ).not.toContain('好友克隆');
      expect(f.host.querySelector('[aria-label="添加好友克隆"]')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('拆分后的聊天设置与通话录音、空间、邮箱同属基础功能', () => {
    const f = mount('qzone');
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '基础功能',
      );
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map((item) => item.textContent),
      ).toEqual([
        '阅读与未读',
        '消息显示',
        '互动与防撤回',
        '联系人名片',
        '通话录音',
        'QQ 空间',
        'QQ 邮箱',
      ]);
      expect(f.body().querySelector('h3')?.textContent).toBe('QQ 空间');
      expect(f.host.textContent).not.toContain('QQ 空间设置');
      f.render('call-recording');
      expect(f.body().querySelector('h3')?.textContent).toBe('通话录音');
      expect(f.body().textContent).toContain('录音来源');
      expect(f.body().textContent).toContain('同时录电脑声音');
      expect(f.body().querySelector('.weq-settings-scope')).toBeNull();
      f.render('mail');
      expect(f.body().querySelector('[aria-label="在邮箱图标上显示红点"]')).not.toBeNull();
      expect(f.body().querySelector('[aria-label="收到新邮件时横幅提醒"]')).not.toBeNull();
    } finally {
      f.close();
    }
  });
  it('常规不再混入账号、缓存、日志；二级页仅呈现对应配置', () => {
    const f = mount('global');
    try {
      expect(f.host.querySelectorAll('.weq-settings-nav-item')).toHaveLength(7);
      for (const title of ['现有配置', '缓存目录', '日志保留时长', '导出保存目录'])
        expect(f.body().textContent).not.toContain(title);
      expect(f.host.querySelector('.weq-settings-scope')).toBeNull();
      f.render('storage');
      expect(f.body().textContent).not.toContain('缓存目录');
      expect(f.body().textContent).toContain('WeQ 存储管理');
      expect(f.body().textContent).not.toContain('现有配置');
      expect(f.body().textContent).not.toContain('默认保存目录');
      expect(f.body().querySelector('[aria-label="默认导出保存方式"]')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('普通账号页无凭据，凭据页默认掩码，离开后不保留展开状态', () => {
    const f = mount('account');
    try {
      expect(f.body().textContent).toContain('启用数据库监听');
      expect(f.body().textContent).not.toContain('会话密钥');
      f.render('credentials');
      expect(f.body().textContent).toContain('会话密钥');
      for (const secret of [
        'synthetic-db-secret',
        'synthetic-rkey-secret',
        'synthetic-client-secret',
      ]) {
        expect(f.body().textContent).not.toContain(secret);
        expect(f.body().innerHTML).not.toContain(secret);
      }
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="显示密钥"]')!.click());
      expect(f.body().textContent).toContain('synthetic-db-secret');
      f.render('account');
      f.render('credentials');
      expect(f.body().textContent).not.toContain('synthetic-db-secret');
    } finally {
      f.close();
    }
  });

  it('自启独立于助手服务，旧后台入口转到内置组件，助手保留在服务区域', () => {
    const f = mount('startup');
    try {
      expect(f.body().querySelector('[aria-label="启动时进入"]')?.textContent).toBe(
        '主页消息上次退出时所在页面',
      );
      expect(
        f.host.querySelector('.weq-settings-subnav-item.is-active .lucide-power'),
      ).not.toBeNull();
      expect(f.body().querySelector('.weq-set-head .lucide-power')).not.toBeNull();
      expect(f.body().textContent).toContain('开机自动启动');
      expect(f.body().textContent).not.toContain('启用 WeQ 助手');
      f.render('daemon');
      expect(f.body().textContent).toContain('内置组件');
      expect(f.host.querySelector('[data-search-highlight]')?.textContent).toContain('内置组件');
      expect(f.host.querySelector<HTMLElement>('[data-search-highlight]')?.dataset.settingId).toBe(
        'builtin-components',
      );
      f.render('assistant');
      expect(f.body().textContent).toContain('启用 QQ 公众号推送');
      expect(f.body().textContent).not.toContain('后台服务状态');
      expect(f.body().textContent).not.toContain('开机自动启动');
      f.render('updates');
      expect(f.body().textContent).not.toContain('监控新版本发布');
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '关于 WeQ',
      );
    } finally {
      f.close();
    }
  });
  it('启动与主页按开机启动、启动页面、主页设置排列，旧主页入口定位到底部分区', () => {
    const f = mount('startup');
    try {
      expect(f.body().querySelector('h3')?.textContent).toBe('启动与主页');
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map((node) => node.textContent),
      ).toEqual(['启动与主页', '主题与背景', '提醒与窗口', 'WeQ 存储管理', '隐私']);
      const ids = [...f.body().querySelectorAll('[data-setting-id]')].map((node) =>
        node.getAttribute('data-setting-id'),
      );
      expect(ids).toEqual([
        'weq-config-management',
        'startup-enabled',
        'startup-page',
        'home-settings',
        'home-prefer-qqshow',
        'home-tags',
        'home-greeting',
        'home-hitokoto',
        'home-blocked-words',
      ]);
      expect(f.body().querySelector('.weq-set-row-label')?.textContent).toBe('开机自动启动');
      f.render('home');
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '启动与主页',
      );
      expect(
        f.body().querySelector('[data-search-highlight]')?.getAttribute('data-setting-id'),
      ).toBe('home-settings');
      for (const [item, id] of [
        ['优先展示 QQ 秀', 'home-prefer-qqshow'],
        ['个性标签', 'home-tags'],
        ['问候语', 'home-greeting'],
        ['一言', 'home-hitokoto'],
        ['一言屏蔽词', 'home-blocked-words'],
      ] as const) {
        f.render('home', { section: 'home', item, revision: 1 });
        expect(
          f.body().querySelector('[data-search-highlight]')?.getAttribute('data-setting-id'),
        ).toBe(id);
      }
    } finally {
      f.close();
    }
  });

  it('API 用量保留模型与识别一级入口，识别、克隆与画像入口完整', () => {
    const f = mount('model-usage');
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '增强功能',
      );
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map(
          (button) => button.textContent,
        ),
      ).toEqual([
        '增强包',
        '识别与转写',
        'API 配置',
        'API 用量',
        '推荐回复',
        '意图感知',
        '互动画像',
      ]);
      expect(f.host.querySelector('.weq-settings-scope')?.textContent).toBe('当前账号');
      expect(f.body().querySelector('.weq-set-head-title .weq-settings-scope')).not.toBeNull();
      expect(f.host.querySelector('.weq-settings-content > .weq-settings-scope')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('意图感知落在模型与识别，不再标记为当前账号设置', () => {
    const f = mount('intent-sense');
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '增强功能',
      );
      expect(f.body().querySelector('.weq-set-head-title .weq-settings-scope')).toBeNull();
      expect(f.body().textContent).toContain('启用意图感知');
    } finally {
      f.close();
    }
  });

  it('深链切换同时将一级分类和二级选中页滚入可视区', () => {
    const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    });
    const f = mount('model-usage');
    try {
      expect(
        scroll.mock.contexts.some(
          (element) =>
            element instanceof HTMLElement && element.classList.contains('weq-settings-nav-item'),
        ),
      ).toBe(true);
      expect(
        scroll.mock.contexts.some(
          (element) =>
            element instanceof HTMLElement &&
            element.classList.contains('weq-settings-subnav-item'),
        ),
      ).toBe(true);
    } finally {
      f.close();
      if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('服务二级导航显示 Web 与 Remote，保留 remote 深链', () => {
    const f = mount('remote');
    try {
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toContain(
        'Web 与 Remote',
      );
      expect(f.body().querySelector('.weq-remote-settings')).not.toBeNull();
      expect(f.body().querySelector('.weq-set-title')?.textContent).toBe('Web 与 Remote');
      f.render('sse');
      expect(f.body().querySelector('.weq-set-title')?.textContent).toBe('SSE 推送');
    } finally {
      f.close();
    }
  });

  it('损坏提醒拆出后，容错记录通过入口弹窗查看，旧深链只定位不自动打开', () => {
    const f = mount('database');
    try {
      expect(f.body().textContent).toContain('容错级别');
      expect(f.body().querySelector('.weq-set-head-title .weq-settings-scope')?.textContent).toBe(
        '当前账号',
      );
      expect(f.body().textContent).not.toContain('数据库异常时弹窗提醒');
      expect(f.body().textContent).not.toContain('降级账本');
      f.render('database-status');
      const entry = f.body().querySelector<HTMLElement>('[data-setting-id="tolerance-records"]')!;
      expect(entry.dataset.searchHighlight).toBe('true');
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      const body = f.body();
      act(() => entry.querySelector<HTMLButtonElement>('button')!.click());
      expect(document.querySelector('.weq-tool-modal')?.textContent).toContain('降级账本');
      expect(f.body()).toBe(body);
      act(() =>
        document.querySelector<HTMLButtonElement>('.weq-tool-modal [aria-label="关闭"]')!.click(),
      );
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      f.render('database-repair', {
        section: 'database',
        item: '数据库异常时弹窗提醒',
        revision: 1,
      });
      expect(
        f
          .body()
          .querySelector('[data-setting-id="damage-reminder"]')
          ?.getAttribute('data-search-highlight'),
      ).toBe('true');
      expect(f.body().textContent).not.toContain('容错级别');
    } finally {
      f.close();
    }
  });
});
