import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HOME_SETTINGS } from '@weq/service/home-settings';
import { ChatHome } from '../src/renderer/src/views/ChatHome';
import { HomeSettingsSection } from '../src/renderer/src/components/settings/HomeSettingsSection';
import { SETTINGS_GROUPS } from '../src/renderer/src/components/settings/navigation';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';

const fixture = vi.hoisted(() => ({
  home: {
    preferQqShow: true,
    showTags: true,
    showGreeting: true,
    showHitokoto: true,
    blockedWords: [] as string[],
  },
  qqShow: { hasShow: false, url: '', expiresAt: 1 },
  qqShowEnabled: false,
  save: vi.fn(),
  invalidate: vi.fn(),
  sampleEnabled: false,
}));
vi.mock('../src/renderer/src/hooks/useContactCard', () => ({
  useContactQqShow: (_: string, enabled: boolean) => {
    fixture.qqShowEnabled = enabled;
    return { data: fixture.qqShow };
  },
}));
vi.mock('../src/renderer/src/components/dressPieces', () => ({
  AvatarOrb: () => createElement('div', { 'data-avatar': true }),
  CardBackdrop: () => null,
  ScreenRain: () => null,
  TagRing: ({ tags }: { tags: unknown[] }) => createElement('div', { 'data-tags': tags.length }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      bootstrap: {
        getSettings: {
          setData: (_: unknown, updater: (data: unknown) => unknown) =>
            updater({ home: fixture.home }),
        },
      },
      account: { sampleHitokoto: { invalidate: fixture.invalidate } },
    }),
    bootstrap: {
      getSettings: { useQuery: () => ({ data: { home: fixture.home }, isError: false }) },
      setHomeSettings: { useMutation: () => ({ mutateAsync: fixture.save, isLoading: false }) },
    },
    account: {
      getHomeDress: { useQuery: () => ({ data: { tags: ['标签'] } }) },
      sampleHitokoto: {
        useQuery: (_: unknown, options: { enabled: boolean }) => {
          fixture.sampleEnabled = options.enabled;
          return { data: [{ text: '今天也要开心', from: '日常' }] };
        },
      },
    },
  },
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.home = { ...DEFAULT_HOME_SETTINGS, blockedWords: [] };
  fixture.qqShow = { hasShow: false, url: '', expiresAt: 1 };
  fixture.save.mockReset().mockImplementation(async (patch) => {
    fixture.home = { ...fixture.home, ...patch };
    return fixture.home;
  });
  fixture.invalidate.mockReset();
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(component: typeof HomeSettingsSection | typeof ChatHome) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(createElement(component, { nickname: '测试' })));
  render();
  return {
    host,
    render,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('主页显示与偏好', () => {
  it('主页开关与一言屏蔽词位于同一张卡片，保留定位标识', () => {
    const view = mount(HomeSettingsSection);
    try {
      const cards = view.host.querySelectorAll('.weq-set-card');
      expect(cards).toHaveLength(1);
      expect(cards[0]!.querySelector('.weq-set-card-title')?.textContent).toBe('主页');
      for (const id of [
        'home-prefer-qqshow',
        'home-tags',
        'home-greeting',
        'home-hitokoto',
        'home-blocked-words',
      ]) {
        expect(cards[0]!.querySelector(`[data-setting-id="${id}"]`)).not.toBeNull();
      }
      expect(cards[0]!.querySelector('.weq-set-card')).toBeNull();
      expect(cards[0]!.querySelector('label')?.htmlFor).toBe(
        cards[0]!.querySelector('textarea')?.id,
      );
    } finally {
      view.close();
    }
  });
  it('主页合并到启动页，搜索可定位屏蔽词', () => {
    expect(SETTINGS_GROUPS[0]!.sections[0]).toBe('startup');
    expect(SETTINGS_GROUPS[0]!.sections).not.toContain('home');
    expect(searchAppEntries('一言屏蔽词')[0]?.target).toMatchObject({
      section: 'startup',
      settingId: 'home-blocked-words',
    });
    expect(searchAppEntries('优先展示 QQ 秀')[0]?.target).toMatchObject({
      section: 'startup',
      settingId: 'home-prefer-qqshow',
    });
  });
  it('QQ 秀加载前保留头像，加载后在原标签环中央展示，关闭后恢复头像', () => {
    fixture.qqShow = {
      hasShow: true,
      url: 'https://images.qqshow.gtimg.com/fixture.png',
      expiresAt: 1,
    };
    const view = mount(ChatHome);
    try {
      const stage = view.host.querySelector('.weq-chathome-stage');
      const tags = stage!.querySelector('[data-tags]');
      const image = stage!.querySelector<HTMLImageElement>('.weq-chathome-qqshow')!;
      expect(image.hidden).toBe(true);
      expect(stage!.querySelector('[data-avatar]')).not.toBeNull();
      act(() => image.dispatchEvent(new Event('load')));
      expect(image.hidden).toBe(false);
      expect(stage!.querySelector('[data-avatar]')).toBeNull();
      expect(stage!.querySelector('[data-tags]')).toBe(tags);
      fixture.home = { ...fixture.home, preferQqShow: false };
      view.render();
      expect(fixture.qqShowEnabled).toBe(false);
      expect(stage!.querySelector('.weq-chathome-qqshow')).toBeNull();
      expect(stage!.querySelector('[data-avatar]')).not.toBeNull();
    } finally {
      view.close();
    }
  });
  it('没有 QQ 秀、图片失败及切换形象时均保留头像，不让失败状态污染新图片', () => {
    const view = mount(ChatHome);
    try {
      expect(view.host.querySelector('.weq-chathome-qqshow')).toBeNull();
      fixture.qqShow = {
        hasShow: true,
        url: 'https://images.qqshow.gtimg.com/one.png',
        expiresAt: 1,
      };
      view.render();
      const image = view.host.querySelector('.weq-chathome-qqshow')!;
      act(() => image.dispatchEvent(new Event('error')));
      expect(view.host.querySelector('.weq-chathome-qqshow')).toBeNull();
      expect(view.host.querySelector('[data-avatar]')).not.toBeNull();
      fixture.qqShow = { ...fixture.qqShow, url: 'https://images.qqshow.gtimg.com/two.png' };
      view.render();
      const next = view.host.querySelector<HTMLImageElement>('.weq-chathome-qqshow')!;
      act(() => next.dispatchEvent(new Event('load')));
      expect(next.hidden).toBe(false);
      fixture.qqShow = { ...fixture.qqShow, url: 'https://images.qqshow.gtimg.com/three.png' };
      view.render();
      expect(view.host.querySelector<HTMLImageElement>('.weq-chathome-qqshow')!.hidden).toBe(true);
      expect(view.host.querySelector('[data-avatar]')).not.toBeNull();
    } finally {
      view.close();
    }
  });
  it('QQ 秀开关仅保存主页偏好，不修改聊天头像开关', async () => {
    const view = mount(HomeSettingsSection);
    try {
      await act(async () =>
        view.host.querySelector<HTMLButtonElement>('[aria-label="优先展示 QQ 秀"]')!.click(),
      );
      expect(fixture.save).toHaveBeenLastCalledWith({ preferQqShow: false });
    } finally {
      view.close();
    }
  });
  it('有个性标签仍显示一言，三个开关独立生效', () => {
    const view = mount(ChatHome);
    try {
      expect(view.host.querySelector('[data-tags="1"]')).not.toBeNull();
      expect(view.host.querySelector('h1')).not.toBeNull();
      expect(view.host.textContent).toContain('今天也要开心');
      fixture.home = { ...fixture.home, showTags: false, showGreeting: false };
      view.render();
      expect(view.host.querySelector('[data-tags="0"]')).not.toBeNull();
      expect(view.host.querySelector('h1')).toBeNull();
      expect(view.host.textContent).toContain('今天也要开心');
      fixture.home = { ...fixture.home, showHitokoto: false };
      view.render();
      expect(fixture.sampleEnabled).toBe(false);
      expect(view.host.querySelector('.weq-chathome-hitokoto')).toBeNull();
    } finally {
      view.close();
    }
  });
  it('新的屏蔽词立即隐藏旧缓存句子', () => {
    fixture.home.blockedWords = ['日常'];
    const view = mount(ChatHome);
    try {
      expect(view.host.querySelector('.weq-chathome-hitokoto')).toBeNull();
    } finally {
      view.close();
    }
  });
  it('开关只提交单字段，屏蔽词停止输入后自动保存并刷新一言', async () => {
    const view = mount(HomeSettingsSection);
    try {
      await act(async () =>
        view.host.querySelector<HTMLButtonElement>('[aria-label="个性标签"]')!.click(),
      );
      expect(fixture.save).toHaveBeenLastCalledWith({ showTags: false });
      const input = view.host.querySelector('textarea')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          input,
          '剧透\n SPOILER \nspoiler\n',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(fixture.save).toHaveBeenCalledTimes(1);
      expect(view.host.querySelector('button[type="submit"]')).toBeNull();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 650));
      });
      expect(fixture.save).toHaveBeenLastCalledWith({ blockedWords: ['剧透', 'SPOILER'] });
      expect(fixture.invalidate).toHaveBeenCalledTimes(1);
    } finally {
      view.close();
    }
  });
  it('后台重读不覆盖屏蔽词草稿，保存失败时保留输入', async () => {
    const view = mount(HomeSettingsSection);
    try {
      const input = view.host.querySelector('textarea')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          input,
          '尚未保存',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      fixture.home = { ...fixture.home, blockedWords: ['后台更新'] };
      view.render();
      expect(input.value).toBe('尚未保存');
      fixture.save.mockRejectedValueOnce(new Error('保存失败'));
      await act(async () => input.dispatchEvent(new Event('focusout', { bubbles: true })));
      expect(input.value).toBe('尚未保存');
      expect(fixture.home.blockedWords).toEqual(['后台更新']);
      expect(fixture.invalidate).not.toHaveBeenCalled();
    } finally {
      view.close();
    }
  });
});
