import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog, type SectionId } from '../src/renderer/src/components/SettingsDialog';
import { HelpSection } from '../src/renderer/src/components/settings/HelpSection';

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

function mount(initialSection: SectionId, onCreateClone?: () => void) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (section: SectionId) =>
    act(() =>
      root.render(
        createElement(SettingsDialog, {
          open: true,
          initialSection: section,
          onClose: vi.fn(),
          onOpenMaintenance: vi.fn(),
          onOpenRecalls: vi.fn(),
          onCreateClone,
        }),
      ),
    );
  render(initialSection);
  return {
    host,
    render,
    body: () => host.querySelector('.weq-settings-body')!,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('设置归位后的实际页面', () => {
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
      expect(f.body().textContent).toContain('监控新版本发布');
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
      expect(f.body().textContent).toContain('监控新版本发布');
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

  it('空间与邮箱有独立一级入口，空间标题不再带设置后缀', () => {
    const f = mount('qzone');
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '空间与邮箱',
      );
      expect(
        [...f.host.querySelectorAll('.weq-settings-subnav-item')].map((item) => item.textContent),
      ).toEqual(['QQ 空间', 'QQ 邮箱']);
      expect(f.body().querySelector('h3')?.textContent).toBe('QQ 空间');
      expect(f.host.textContent).not.toContain('QQ 空间设置');
      f.render('mail');
      expect(f.body().querySelector('[aria-label="显示未读邮件数"]')).not.toBeNull();
      expect(f.body().querySelector('[aria-label="新邮件提醒"]')).not.toBeNull();
    } finally {
      f.close();
    }
  });
  it('常规不再混入账号、缓存、日志；二级页仅呈现对应配置', () => {
    const f = mount('global');
    try {
      expect(f.host.querySelectorAll('.weq-settings-nav-item')).toHaveLength(10);
      for (const title of ['现有配置', '缓存目录', '日志保留时长', '导出保存目录'])
        expect(f.body().textContent).not.toContain(title);
      expect(f.host.querySelector('.weq-settings-scope')).toBeNull();
      f.render('storage');
      expect(f.body().textContent).toContain('缓存目录');
      expect(f.body().textContent).toContain('WeQ 存储管理');
      expect(f.body().textContent).not.toContain('现有配置');
      f.render('saving');
      expect(f.body().textContent).toContain('保存位置');
      expect(f.body().querySelector('[aria-label="默认导出保存方式"]')).not.toBeNull();
      expect(f.body().textContent).not.toContain('缓存目录');
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

  it('开机启动、后台服务和更新提醒各自独立，不混入助手推送', () => {
    const f = mount('startup');
    try {
      expect(f.body().textContent).toContain('开机自动启动 WeQ');
      expect(f.body().textContent).not.toContain('启用 WeQ 助手');
      f.render('daemon');
      expect(f.body().textContent).toContain('静态文件服务');
      expect(f.body().textContent).not.toContain('开机自动启动 WeQ');
      f.render('updates');
      expect(f.body().textContent).toContain('监控新版本发布');
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '帮助与关于',
      );
    } finally {
      f.close();
    }
  });

  it('API 用量保留模型与识别一级入口，识别、克隆与画像入口完整', () => {
    const f = mount('model-usage');
    try {
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '模型与识别',
      );
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
      expect(f.host.querySelector('.weq-settings-nav-item.is-active')?.textContent).toBe(
        '模型与识别',
      );
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

  it('损坏处理设置与容错记录分开，故障深链仍可到达', () => {
    const f = mount('database');
    try {
      expect(f.body().textContent).toContain('宽容级别');
      expect(f.body().querySelector('.weq-set-head-title .weq-settings-scope')?.textContent).toBe(
        '账号与全局',
      );
      expect(f.body().textContent).toContain('损坏提醒为全局设置');
      expect(f.body().textContent).not.toContain('降级账本');
      f.render('database-status');
      expect(f.body().textContent).toContain('降级账本');
      expect(f.body().querySelector('[aria-label="数据库宽容级别"]')).toBeNull();
    } finally {
      f.close();
    }
  });
});
