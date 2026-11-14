import { readFileSync } from 'node:fs';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { forwardRecordToWire } from '../src/main/ipc/serde';
import { ForwardWindowHost, openForwardWindow } from '../src/renderer/src/components/ForwardWindow';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';
import { useForwardStore, type ForwardRecordWire } from '../src/renderer/src/state/forwardWindow';

vi.mock('../src/renderer/src/trpc/client', () => ({ client: { account: {} }, trpc: {} }));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    binding: null,
    settings: { isLoading: false },
    isCurrent: () => true,
  }),
}));
vi.mock('../src/renderer/src/hooks/useMsgDecoration', () => ({
  useMsgDecoration: () => ({}),
}));
vi.mock('../src/renderer/src/hooks/useBubbleFontFx', () => ({
  useBubbleFontFx: () => undefined,
}));
vi.mock('../src/renderer/src/components/QqMessageContent', async () => {
  const contexts = await import('../src/renderer/src/state/messageContext');
  const appearance = await import('../src/renderer/src/state/messageAppearance');
  return { ...contexts, ...appearance, QqMessageContent: () => h('p', null, '合成正文') };
});
vi.mock('../src/renderer/src/im-template/template/messageRow', () => ({
  grayTipOf: () => null,
}));

it('实际应用只在名片导航上下文内挂载转发宿主', () => {
  const hosts: string[][] = [];
  for (const path of ['src/renderer/src/App.tsx', 'src/renderer/src/views/MainView.tsx']) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node, ancestors: string[]) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'ForwardWindowHost')
        hosts.push(ancestors);
      const next = ts.isJsxElement(node)
        ? [...ancestors, node.openingElement.tagName.getText(source)]
        : ancestors;
      ts.forEachChild(node, (child) => visit(child, next));
    };
    visit(source, []);
  }
  expect(hosts).toHaveLength(1);
  expect(hosts[0]).toContain('ProfileNavigationContext.Provider');
  expect(hosts[0]).toContain('ContactWorkspaceNavigationContext.Provider');
});

it('真实缓存序列化后 QQ 号为字符串，头像和昵称在 Portal 中打开同一人物的名片', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useForwardStore.setState({ windows: [], seq: 0, zTop: 1000 });
  const record = forwardRecordToWire({
    msgId: 1n,
    senderUin: 10002,
    sendNick: '本地昵称',
    subMsgs: [{ msgId: 2n, senderUin: 10003 }],
  }) as ForwardRecordWire;
  expect(record.senderUin).toBe('10002');
  expect(record.subMsgs?.[0]?.senderUin).toBe('10003');
  const open = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(h(ProfileNavigationContext.Provider, { value: open }, h(ForwardWindowHost))),
    );
    await act(async () =>
      openForwardWindow({
        title: '合成转发',
        kind: 'c2c',
        conv: '',
        msgId: '1',
        records: [record],
      }),
    );
    await act(async () => vi.dynamicImportSettled());
    const author = document.querySelector<HTMLButtonElement>('.weq-forward-author')!;
    expect(author.tagName).toBe('BUTTON');
    expect(author.textContent).toBe('本地昵称');
    for (const selector of ['.weq-forward-avatar', '.weq-forward-row-name']) {
      act(() =>
        author
          .querySelector(selector)!
          .dispatchEvent(
            new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 60, detail: 1 }),
          ),
      );
      expect(open).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: '', identityValue: '10002', displayName: '本地昵称' }),
        { x: 40, y: 60 },
        undefined,
      );
    }
    expect(open).toHaveBeenCalledTimes(2);
    expect(useForwardStore.getState().windows).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    expect(useForwardStore.getState().windows).toHaveLength(0);
    host.remove();
    vi.unstubAllGlobals();
  }
});
