import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog, type SectionId } from '../src/renderer/src/components/SettingsDialog';
import { HelpSection } from '../src/renderer/src/components/settings/HelpSection';
import type { SettingsSearchTarget } from '../src/renderer/src/components/settings/searchTarget';
import { useUpdateStore } from '../src/renderer/src/state/update';

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
          ? () => ({ data: queryData(path.at(-1) ?? ''), isLoading: false, refetch: vi.fn() })
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

function mount(initialSection?: SectionId, onCreateClone?: () => void) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onOpenMaintenance = vi.fn();
  const render = (section: SectionId | undefined, searchTarget?: SettingsSearchTarget) =>
    act(() =>
      root.render(
        createElement(SettingsDialog, {
          open: true,
          initialSection: section,
          searchTarget,
          onClose: vi.fn(),
          onOpenMaintenance,
          onOpenRecalls: vi.fn(),
          onCreateClone,
        }),
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
      host.remove();
    },
  };
}

describe('设置归位后的实际页面', () => {
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
  it('聊天行为与自定义显示按最终顺序展示，显示项具有稳定身份', () => {
    const f = mount('chat-messages');
    try {
      expect(
        [...f.body().querySelectorAll('.weq-settings-appearance-card strong')].map(
          (node) => node.textContent,
        ),
      ).toEqual([
        '在消息图标上显示红点',
        '群助手显示总消息数',
        '从第一条新消息开始阅读',
        '发送消息后定位到最新消息',
      ]);
      const display = f.body().querySelector('[data-setting-id="custom-message-display"]')!;
      expect(display).not.toBeNull();
      expect(display.querySelectorAll('.weq-set-card, .weq-settings-appearance-card')).toHaveLength(
        0,
      );
      expect(
        [...display.querySelectorAll('.weq-set-row-label')].map((node) => node.textContent),
      ).toEqual([
        '显示消息序号（seq）',
        '显示发送时间（精确到秒）',
        '聊天头像挂件',
        '消息装扮（气泡/字体/挂件）',
        '纯文本消息渲染 Markdown',
        '链接预览卡片',
        '无封面时网页截图',
      ]);
      expect(
        [...display.querySelectorAll('[data-setting-id]')].map((node) =>
          node.getAttribute('data-setting-id'),
        ),
      ).toEqual([
        'message-seq',
        'message-time',
        'avatar-pendant',
        'message-decoration',
        'text-markdown',
        'link-preview',
        'link-screenshot',
      ]);
    } finally {
      f.close();
    }
  });
  it.each([
    ['global', '默认发送正在输入状态', 'typing-status', '聊天消息'],
    ['account', '手动标记时上报已读位置', 'read-sync', '聊天消息'],
    ['storage', '优先使用 CDN', 'prefer-cdn', '资源加载'],
    ['media', '关联本机媒体目录', 'linked-resources', 'WeQ 账号管理'],
    ['media', '允许使用外部安卓图片缓存', 'external-chatpic', 'WeQ 账号管理'],
    ['rkey', '外部 RKEY', 'external-rkey', '凭据管理'],
    ['applock', '隐私模式', 'privacy-mode', '隐私模式'],
    ['anti-recall', '防撤回', 'anti-recall', '聊天消息'],
    ['maintenance', '本地缓存', 'resource-viewer', '资源目录管理'],
    ['maintenance', '存储占用', 'qq-storage-analysis', '资源目录管理'],
    ['maintenance', '清理缓存', 'qq-storage-cleanup', '资源目录管理'],
    ['maintenance', '数据库修复', 'database-repair', '损坏与修复'],
    ['maintenance', '导出明文数据库', 'database-export', '数据库管理'],
    ['maintenance', '密钥扫描', 'key-scan', '凭据管理'],
    ['maintenance', '其它设备密钥', 'other-device-key', '凭据管理'],
    ['message-display', '显示消息汇总红点', 'message-unread-badge', '聊天消息'],
    ['reply-suggestions', '常驻显示', 'intent-persistent-display', '意图感知'],
    ['reply-suggestions', '悬停显示', 'intent-hover-display', '意图感知'],
    ['intent-models', '意图模型资源', 'intent-model-resources', '意图感知'],
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

  it('未指定入口时默认主题与背景，普通页面导航不自动执行工具', () => {
    const f = mount();
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe('常规');
      expect(f.host.querySelector('.weq-settings-subnav-item.is-active')?.textContent).toBe(
        '主题与背景',
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
        ['storage', '缓存目录'],
        ['global', '成功通知停留时长'],
        ['version', '内置组件'],
      ] as const) {
        f.render(section, { section, item, revision: Date.now() });
        const highlighted = f.body().querySelector<HTMLElement>('[data-search-highlight="true"]');
        expect(highlighted, `${section}: ${item}`).not.toBeNull();
        expect(document.activeElement).toBe(highlighted);
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
  it('帮助与关于按四页展示，版本更新及日志能力各自合并，旧入口仍可达', () => {
    const f = mount('version');
    try {
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map((item) => item.textContent),
      ).toEqual(['版本与更新', '常见问题', '日志', '反馈']);
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
  it('好友克隆为空时仍可从设置打开已有创建流程', () => {
    const onCreateClone = vi.fn();
    const f = mount('clone-settings', onCreateClone);
    try {
      expect(f.body().textContent).toContain('暂无好友克隆');
      const add = f.body().querySelector<HTMLButtonElement>('[aria-label="添加好友克隆"]');
      expect(add).not.toBeNull();
      expect(add!.disabled).toBe(false);
      act(() => add!.click());
      expect(onCreateClone).toHaveBeenCalledTimes(1);
      expect(onCreateClone).toHaveBeenCalledWith();
    } finally {
      f.close();
    }
  });

  it('聊天、通话录音、空间与邮箱归入基础功能，通话录音位于第二项', () => {
    const f = mount('qzone');
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '基础功能',
      );
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map((item) => item.textContent),
      ).toEqual(['聊天消息', '通话录音', 'QQ 空间', 'QQ 邮箱']);
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
      expect(f.host.querySelectorAll('.weq-settings-nav-item')).toHaveLength(9);
      for (const title of ['现有配置', '缓存目录', '日志保留时长', '导出保存目录'])
        expect(f.body().textContent).not.toContain(title);
      expect(f.host.querySelector('.weq-settings-scope')).toBeNull();
      f.render('storage');
      expect(f.body().textContent).toContain('缓存目录');
      expect(f.body().textContent).toContain('WeQ 存储管理');
      expect(f.body().textContent).not.toContain('现有配置');
      f.render('saving');
      expect(f.body().textContent).toContain('默认保存目录');
      expect(f.body().querySelector('[aria-label="默认导出保存方式"]')).not.toBeNull();
      expect(f.body().textContent).toContain('缓存目录');
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
      expect(f.body().textContent).toContain('开机自动启动');
      expect(f.body().textContent).not.toContain('启用 WeQ 助手');
      f.render('daemon');
      expect(f.body().textContent).toContain('内置组件');
      expect(f.host.querySelector('[data-search-highlight]')?.textContent).toContain('内置组件');
      f.render('assistant');
      expect(f.body().textContent).toContain('启用 QQ 公众号推送');
      expect(f.host.textContent).not.toContain('后台服务');
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

  it('API 用量保留模型与识别一级入口，识别、克隆与画像入口完整', () => {
    const f = mount('model-usage');
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe('AI 功能');
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map(
          (button) => button.textContent,
        ),
      ).toEqual([
        'API 配置',
        'API 用量',
        '意图感知',
        '互动画像',
        '推荐回复',
        '好友克隆',
        '语音识别',
        '图片识别',
      ]);
      expect(f.host.querySelector('.weq-settings-scope')?.textContent).toBe('当前账号');
      expect(f.body().querySelector('.weq-set-head-title .weq-settings-scope')).not.toBeNull();
      expect(f.host.querySelector('.weq-settings-content > .weq-settings-scope')).toBeNull();
    } finally {
      f.close();
    }
  });

  it('意图感知落在模型与识别，按账号作用域展示', () => {
    const f = mount('intent-sense');
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe('AI 功能');
      expect(f.body().querySelector('.weq-set-head-title .weq-settings-scope')?.textContent).toBe(
        '当前账号',
      );
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
    } finally {
      f.close();
    }
  });

  it('损坏提醒拆出后，容错记录通过入口弹窗查看，旧深链只定位不自动打开', () => {
    const f = mount('database');
    try {
      expect(f.body().textContent).toContain('宽容级别');
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
      expect(f.body().textContent).not.toContain('宽容级别');
    } finally {
      f.close();
    }
  });
});
