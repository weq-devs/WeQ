import { act, createElement as h, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SearchDropdown } from '../src/renderer/src/components/search/SearchDropdown';
import { contactSearchHit } from './support/search-fixtures';
import type { FileSearchHit } from '../src/renderer/src/components/search/types';

vi.mock('../src/renderer/src/components/search/appSearchCatalog', async (original) => ({
  ...(await original<typeof import('../src/renderer/src/components/search/appSearchCatalog')>()),
  searchAppEntries: (keyword: string) =>
    keyword === '报告'
      ? [
          {
            id: 'synthetic',
            title: '报告',
            keywords: [],
            path: '',
            target: { kind: 'view', view: 'messages' },
          },
        ]
      : [],
}));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());
const file = (fileName: string): FileSearchHit => ({
  category: 'file',
  fileName,
  source: 'group',
  partition: '1',
  targetUid: '1',
  targetUin: '0',
  msgId: '1',
  msgSeq: '1',
  sendTime: '1',
  convName: '合成群',
});

function mount(overrides: Partial<ComponentProps<typeof SearchDropdown>>) {
  const host = document.createElement('div');
  const root = createRoot(host);
  const props: ComponentProps<typeof SearchDropdown> = {
    keyword: '报告',
    quick: { contacts: [], groups: [], conversations: [], friends: [], groupMembers: [] },
    slow: {
      chatRecords: [],
      files: [],
      collections: [],
      cloneMessages: [],
      assistantMessages: [],
      indexStatus: 'disabled',
    },
    quickLoading: false,
    slowLoading: false,
    categories: ['contact', 'group', 'chatRecord', 'file'],
    appSearchEnabled: true,
    onSelectAppEntry: vi.fn(),
    onCategoriesChange: vi.fn(),
    onSelect: vi.fn(),
    onMore: vi.fn(),
    ...overrides,
  };
  act(() => root.render(h(SearchDropdown, props)));
  return {
    host,
    order: () =>
      [...host.querySelectorAll('.weq-search-section-name')].map((item) => item.textContent),
    close: () => act(() => root.unmount()),
  };
}

it('功能与设置也参与排序，同分按分类顺序，空分类始终落在有结果者之后', () => {
  const f = mount({
    quick: {
      contacts: [contactSearchHit({ nick: '报告' })],
      groups: [],
      conversations: [],
      friends: [],
      groupMembers: [],
    },
    slow: {
      chatRecords: [],
      files: [file('报告')],
      collections: [],
      cloneMessages: [],
      assistantMessages: [],
      indexStatus: 'disabled',
    },
  });
  try {
    expect(f.order()).toEqual(['功能与设置', '联系人', '文件', '群聊', '消息']);
  } finally {
    f.close();
  }
});

it('无结果的功能分类不固定置顶，已出结果不被其它分类的加载或失败覆盖', () => {
  const f = mount({
    keyword: '合成',
    quickLoading: true,
    slowLoading: true,
    quickError: true,
    categoryStates: {
      contact: { loading: true, error: false },
      group: { loading: false, error: true },
      file: { loading: false, error: false },
      chatRecord: { loading: true, error: false },
    },
    slow: {
      chatRecords: [],
      files: [file('合成文件')],
      collections: [],
      cloneMessages: [],
      assistantMessages: [],
      indexStatus: 'disabled',
    },
  });
  try {
    expect(f.order()).toEqual(['文件', '功能与设置', '联系人', '群聊', '消息']);
    expect(f.host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(f.host.querySelector('[data-search-hit-key="file:group:1:1"]')).not.toBeNull();
  } finally {
    f.close();
  }
});

it('使用每个分类的最佳结果而非第一条或结果数量决定分组得分', () => {
  const f = mount({
    appSearchEnabled: false,
    categories: ['contact', 'file'],
    quick: {
      contacts: [
        contactSearchHit({ uid: 'a', nick: '年度报告' }),
        contactSearchHit({ uid: 'b', nick: '报告' }),
      ],
      conversations: [],
      friends: [],
      groupMembers: [],
    },
    slow: {
      chatRecords: [],
      files: [file('报告')],
      collections: [],
      cloneMessages: [],
      assistantMessages: [],
      indexStatus: 'disabled',
    },
  });
  try {
    expect(f.order()).toEqual(['联系人', '文件']);
  } finally {
    f.close();
  }
});

it.each([
  ['报告年度汇总', '周报告', ['文件', '联系人']],
  ['这是很长但连续命中的报告内容', '报-告', ['联系人', '文件']],
  ['周报告', '周报告', ['联系人', '文件']],
])('跨分类使用相同匹配规则：%s / %s', (name, fileName, order) => {
  const f = mount({
    appSearchEnabled: false,
    categories: ['file', 'contact'],
    quick: {
      contacts: [contactSearchHit({ nick: name })],
      conversations: [],
      friends: [],
      groupMembers: [],
    },
    slow: {
      chatRecords: [],
      files: [file(fileName)],
      collections: [],
      cloneMessages: [],
      assistantMessages: [],
      indexStatus: 'disabled',
    },
  });
  try {
    expect(f.order()).toEqual(order);
  } finally {
    f.close();
  }
});
