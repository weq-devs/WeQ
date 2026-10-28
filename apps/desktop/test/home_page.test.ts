import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HOME_SETTINGS } from '@weq/service/home-settings';
import { ChatHome } from '../src/renderer/src/views/ChatHome';
import { HomeSettingsSection } from '../src/renderer/src/components/settings/HomeSettingsSection';
import { SETTINGS_GROUPS } from '../src/renderer/src/components/settings/navigation';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';

const fixture = vi.hoisted(() => ({
  home: { showTags: true, showGreeting: true, showHitokoto: true, blockedWords: [] as string[] },
  save: vi.fn(),
  invalidate: vi.fn(),
  sampleEnabled: false,
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
  it('主页紧跟常规第一个标签页，搜索可定位屏蔽词', () => {
    expect(SETTINGS_GROUPS[0]!.sections.slice(0, 2)).toEqual(['startup', 'home']);
    expect(searchAppEntries('一言屏蔽词')[0]?.target).toMatchObject({
      section: 'home',
      settingId: 'home-blocked-words',
    });
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
  it('开关只提交单字段，屏蔽词编辑不自动保存，提交后刷新一言', async () => {
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
      await act(async () =>
        view.host
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
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
      await act(async () =>
        view.host
          .querySelector('form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      );
      expect(input.value).toBe('尚未保存');
      expect(fixture.home.blockedWords).toEqual(['后台更新']);
      expect(fixture.invalidate).not.toHaveBeenCalled();
    } finally {
      view.close();
    }
  });
});
