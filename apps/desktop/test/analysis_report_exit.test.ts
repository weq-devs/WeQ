import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AnalysisReportPage } from '../src/renderer/src/views/analysis/AnalysisReportPage';
import type { AnalysisReportRequest } from '../src/renderer/src/views/analysis/model';
import { useViewState } from '../src/renderer/src/state/view';

vi.mock('../src/renderer/src/views/annual-report/AnnualReportView', () => ({
  AnnualReportView: () => h('div', null, '合成年度报告'),
}));
vi.mock('../src/renderer/src/views/analysis/SavedAnalysisBody', () => ({
  SavedAnalysisBody: () => h('div', { role: 'status' }, '合成报告加载中'),
}));

const base = {
  id: 'fixture',
  period: '合成期间',
  scope: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
};
const requests: AnalysisReportRequest[] = [
  { ...base, kind: 'annual', year: 2026 },
  { ...base, kind: 'buddy', peerUid: 'u_fixture', name: '合成好友' },
  { ...base, kind: 'group', groupCode: '20001', name: '合成群' },
  {
    ...base,
    kind: 'member',
    groupCode: '20001',
    groupName: '合成群',
    memberUid: 'u_fixture',
    name: '合成成员',
  },
];

it.each(requests)('$kind 报告的顶部始终提供退出按钮，不依赖正文完成加载', (request) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const account = useViewState.getState().openedUin;
  useViewState.setState({ openedUin: base.scope.expectedAccountUin });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  try {
    act(() => root.render(h(AnalysisReportPage, { request, onClose: close })));
    const button = host.querySelector<HTMLButtonElement>('[aria-label="关闭分析报告"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
    expect(close).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
    useViewState.setState({ openedUin: account });
    vi.unstubAllGlobals();
  }
});
