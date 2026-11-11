import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupLabelSources } from '../src/renderer/src/components/GroupLabelSources';
import type { GroupConversation } from '../src/renderer/src/im-template/template/types';

afterEach(() => vi.unstubAllGlobals());
it('同文案标签保留不同来源，优先本地备注，缺资料展示 UID', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'),
    root = createRoot(host);
  const group = {
    id: '12345',
    name: '合成群',
    customLabelRecords: [
      {
        content: '同名标签',
        setterUid: 'u_one',
        setTimestamp: String(Date.parse('2026-11-10T16:01:02Z') / 1000),
        labelId: '1',
      },
      { content: '同名标签', setterUid: 'u_missing', labelId: '2' },
    ],
  } as GroupConversation['group'];
  const members = [
    {
      id: 'u_one',
      uid: 'u_one',
      remark: '本地备注',
      card: '群名片',
      nick: '昵称',
      role: 'member',
      joinedAt: '',
    },
  ] as GroupConversation['members'];
  try {
    act(() => root.render(h(GroupLabelSources, { group, members })));
    expect(host.querySelectorAll('details')).toHaveLength(2);
    expect(host.textContent).toContain('本地备注');
    expect(host.textContent).toContain('u_missing');
    expect(host.textContent).toContain('2026-11-11 00:01:02');
    expect(host.textContent).toContain('设置时间：未记录');
  } finally {
    act(() => root.unmount());
  }
});
