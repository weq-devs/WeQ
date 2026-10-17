/**
 * 群资料面板（`im-template/template/groupInfoPanel`）的渲染回归测试。
 *
 * 背景：群资料卡片从 `groupInfoPanel.tsx` 搬到应用层时，`formatShortDate` 这个被
 * **面板与卡片共用**的小工具被跟着删掉了（它还留着一条 `// @ts-nocheck`，typecheck
 * 看不见），于是打开群资料面板当场 `ReferenceError: formatShortDate is not defined`。
 *
 * 这里真挂一次面板并断言「创建时间」那一行渲染出来了：只要那个工具再丢一次，
 * 渲染就会抛错 / 该行消失，测试立刻红。
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GroupInfoPanel } from '@renderer/im-template/template/groupInfoPanel';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const roots: Root[] = [];
const hosts: HTMLDivElement[] = [];

/** 最小可渲染的群会话：面板只读 group.* 与 members。 */
const CONVERSATION = {
  id: 'g1',
  type: 'group',
  title: '测试群',
  group: {
    name: '测试群',
    identityLabel: '群号',
    identityValue: '123456',
    description: '群简介',
    remark: null,
    createTime: '2024-03-05T08:00:00.000Z',
    memberCount: 12,
    maxMemberCount: 200,
    labels: '游戏',
    customLabels: null,
    addressName: null,
    entranceQ: null,
  },
  members: [
    {
      id: 'uid-1',
      uin: '10001',
      identityLabel: 'QQ',
      identityValue: '10001',
      displayName: '测试成员',
      avatarUrl: null,
      role: 'owner',
    },
  ],
};

function mountPanel(): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(GroupInfoPanel, { conversation: CONVERSATION }));
  });
  roots.push(root);
  hosts.push(host);
}

/** 面板第一段里的「标签 → 值」行。 */
function metaRow(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.group-info-meta-row')].find(
    (row) => row.querySelector('span')?.textContent === label,
  );
}

describe('群资料面板', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const host of hosts) host.remove();
    roots.length = 0;
    hosts.length = 0;
  });

  it('渲染群资料行，创建时间格式化成 年/月/日', () => {
    mountPanel();

    expect(metaRow('群简介')?.querySelector('strong')?.textContent).toBe('群简介');
    expect(metaRow('群容量')?.querySelector('strong')?.textContent).toBe('12/200');

    const created = metaRow('创建时间')?.querySelector('strong')?.textContent ?? '';
    // 不写死具体日期：格式化用的是本地时区，断言形状即可。
    expect(created).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
  });

  it('渲染群成员列表', () => {
    mountPanel();
    expect(document.querySelector('.group-info-member-row')?.textContent).toContain('测试成员');
  });
});
