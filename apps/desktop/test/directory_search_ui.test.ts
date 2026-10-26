import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import { SearchResultCard } from '../src/renderer/src/components/search/SearchResultCard';
import {
  DEFAULT_SEARCH_CATEGORIES,
  searchHitKey,
} from '../src/renderer/src/components/search/types';
import { contactSearchHit } from './support/search-fixtures';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

function mount(element: ReturnType<typeof h>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    close() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('范围仅保留联系人和群聊，不再把通讯录、会话、群友分为三类', () => {
  const f = mount(
    h(SearchDropdown, {
      keyword: '',
      categories: DEFAULT_SEARCH_CATEGORIES,
      quick: null,
      slow: null,
      quickLoading: false,
      slowLoading: false,
      onCategoriesChange: vi.fn(),
      onSelect: vi.fn(),
      onMore: vi.fn(),
    }),
  );
  try {
    const labels = [...f.host.querySelectorAll('.weq-search-scope button')].map(
      (node) => node.textContent,
    );
    expect(labels).toContain('联系人');
    expect(labels).toContain('群聊');
    for (const label of ['会话', '好友', '群友']) expect(labels).not.toContain(label);
    expect(DEFAULT_SEARCH_CATEGORIES).toEqual(expect.arrayContaining(['contact', 'group']));
    for (const category of ['conversation', 'friend', 'groupMember'])
      expect(DEFAULT_SEARCH_CATEGORIES).not.toContain(category);
  } finally {
    f.close();
  }
});

it('联系人主项显示人名和关系，群名片保留来源群及稳定跳转身份', () => {
  const hit = contactSearchHit({
    uid: 'u_person',
    uin: '10001',
    nick: '本人昵称',
    groups: [
      { groupCode: '20001', groupName: '合成课程群', display: '报告名片' },
      { groupCode: '20002', groupName: '同名课程群', display: '另一份报告名片' },
    ],
  });
  const select = vi.fn();
  const f = mount(h(SearchResultCard, { hit, keyword: '报告', onSelect: select }));
  try {
    const main = f.host.querySelector<HTMLButtonElement>(
      `[data-search-hit-key="${searchHitKey(hit)}"]`,
    )!;
    expect(main.textContent).toContain('本人昵称');
    expect(main.textContent).toContain('好友');
    act(() => main.click());
    expect(select).toHaveBeenLastCalledWith(hit);
    const groups = f.host.querySelectorAll<HTMLButtonElement>('.weq-search-contact-groups button');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toContain('报告名片');
    act(() => groups[1]!.click());
    expect(select).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'group', groupCode: '20002', name: '同名课程群' }),
      `${searchHitKey(hit)}:group:20002`,
    );
    expect(f.host.querySelector('button button')).toBeNull();
  } finally {
    f.close();
  }
});

it('从联系人下方进入来源群时记住原名片按钮，而不是同群的另一个结果', () => {
  const hit = contactSearchHit({
    groups: [{ groupCode: '20001', groupName: '合成群', display: '合成名片' }],
  });
  const navigate = vi.fn();
  const f = mount(
    h(SearchDropdown, {
      keyword: '合成',
      categories: ['contact'],
      quick: { contacts: [hit], conversations: [], friends: [], groupMembers: [] },
      slow: null,
      quickLoading: false,
      slowLoading: false,
      onCategoriesChange: vi.fn(),
      onSelect: vi.fn(),
      onMore: vi.fn(),
      onNavigate: navigate,
    }),
  );
  try {
    act(() =>
      f.host.querySelector<HTMLButtonElement>('.weq-search-contact-groups button')!.click(),
    );
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ focusKey: `${searchHitKey(hit)}:group:20001` }),
    );
  } finally {
    f.close();
  }
});

it('历史联系人和群资料不误标已删除、退群或解散，非好友仍提供真实人名', () => {
  const f = mount(
    h(
      'div',
      null,
      h(SearchResultCard, {
        hit: contactSearchHit({ isFriend: false, hasConversation: true }),
        keyword: '合成',
      }),
      h(SearchResultCard, {
        hit: {
          category: 'group',
          groupCode: '20001',
          name: '历史群',
          remark: '',
          inDirectory: false,
          hasConversation: false,
          aliases: [],
        },
        keyword: '群',
      }),
    ),
  );
  try {
    expect(f.host.textContent).toContain('本地会话');
    expect(f.host.textContent).toContain('本地群资料');
    for (const label of ['已删除好友', '已退群', '已解散'])
      expect(f.host.textContent).not.toContain(label);
  } finally {
    f.close();
  }
});

it('当前昵称不同于命中别名时仍展示并高亮原匹配文字', () => {
  const f = mount(
    h(SearchResultCard, {
      hit: contactSearchHit({ nick: '新昵称', aliases: ['旧报告别名'] }),
      keyword: '报告',
    }),
  );
  try {
    expect(f.host.textContent).toContain('旧报告别名');
    expect(f.host.querySelector('mark')?.textContent).toBe('报告');
  } finally {
    f.close();
  }
});
