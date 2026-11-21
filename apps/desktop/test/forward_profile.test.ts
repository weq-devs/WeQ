import { readFileSync } from 'node:fs';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { forwardRecordToWire } from '../src/main/ipc/serde';
import { ForwardWindowHost } from '../src/renderer/src/components/ForwardWindow';
import {
  ShowMessageDateContext,
  ShowMessageSeqContext,
  ShowMessageTimeContext,
} from '../src/renderer/src/components/MessageProvenance.shared';
import { openForwardWindow } from '../src/renderer/src/state/forwardWindow';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';
import { forwardEntries } from '../src/renderer/src/lib/forwardRecordActions';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';
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

it('转发包允许原序号跳过和媒体插入，但不以同名替代发送者身份', () => {
  const first: ForwardRecordWire = {
    msgId: '1',
    msgSeq: '1',
    senderUid: 'u_a',
    senderUin: '10002',
    sendNick: '同名',
    sendTime: 1700000000,
    elements: [{ type: 'text', data: { textContent: '测试' } }],
  };
  const second = { ...first, msgId: '2', msgSeq: '50', sendTime: 1700000001 };
  const positions = (...records: ForwardRecordWire[]) =>
    forwardEntries({ id: 1, records }, true).map((entry) => entry.groupPosition);
  const picture = { ...second, senderUid: undefined, elements: [{ type: 'pic' }] };
  expect(positions(first, picture, { ...second, senderUin: undefined })).toEqual([
    'first',
    'middle',
    'last',
  ]);
  expect(positions(first, picture, { ...second, senderUid: 'u_b' })).toEqual([
    'first',
    'last',
    undefined,
  ]);
  expect(positions(first, { ...second, senderUin: undefined })).toEqual(['first', 'last']);
  expect(positions(first, { ...second, elements: [{ type: 'reply' }] })).toEqual(['first', 'last']);
  for (const boundary of [
    { ...second, senderUid: undefined, senderUin: '0' },
    { ...second, senderUid: 'u_b' },
    { ...second, senderUin: '10003' },
    { ...second, sendTime: 1700000300 },
    { ...second, elements: [{ type: 'grayTipPoke' }] },
  ])
    expect(positions(first, boundary)).toEqual([undefined, undefined]);
});

it('转发作者共用 QQ 号和 UID 时，仍按头像快照身份拆组', () => {
  const shared = { senderUid: 'u_shared', senderUin: '10002', elements: [{ type: 'text' }] };
  const snapshot = (encryptedUin: string) => ({ avatar: { encryptedUin } });
  const first = {
    ...shared,
    msgId: '1',
    sendTime: 1700000000,
    senderInfo: snapshot('avatar-account-a'),
  };
  const second = {
    ...shared,
    msgId: '2',
    sendTime: 1700000001,
    senderInfo: snapshot('avatar-account-b'),
  };
  const third = { ...second, msgId: '3', sendTime: 1700000002 };
  const positions = (...records: ForwardRecordWire[]) =>
    forwardEntries({ id: 1, records }, true).map((entry) => entry.groupPosition);
  expect(positions(first, second, third)).toEqual([undefined, 'first', 'last']);
  expect(positions(first, { ...second, senderInfo: undefined }, third)).toEqual([
    'first',
    'last',
    undefined,
  ]);
});

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

it('转发记录沿用时间分隔与元数据设置，仍仅头像打开名片', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2023-11-16T00:00:00+08:00'));
  useForwardStore.setState({ windows: [], seq: 0, zTop: 1000 });
  const record = forwardRecordToWire({
    msgId: 1n,
    msgSeq: 42,
    senderUin: 10002,
    sendNick: '本地昵称',
    sendTime: 1700000000,
    subMsgs: [{ msgId: 2n, senderUin: 10003 }],
  }) as ForwardRecordWire;
  expect(record.senderUin).toBe('10002');
  expect(record.subMsgs?.[0]?.senderUin).toBe('10003');
  const open = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (showMetadata: boolean) =>
    root.render(
      h(
        ProfileNavigationContext.Provider,
        { value: open },
        h(
          ShowMessageSeqContext.Provider,
          { value: showMetadata },
          h(
            ShowMessageDateContext.Provider,
            { value: showMetadata },
            h(ShowMessageTimeContext.Provider, { value: showMetadata }, h(ForwardWindowHost)),
          ),
        ),
      ),
    );
  try {
    await act(async () => render(false));
    await act(async () =>
      openForwardWindow({
        title: '合成转发',
        kind: 'c2c',
        conv: '',
        msgId: '1',
        records: [
          record,
          { ...record, msgId: '5', msgSeq: '71', sendTime: '1700000001' },
          { ...record, msgId: '2', msgSeq: '0', sendTime: '0' },
          { ...record, msgId: '3', msgSeq: undefined, sendTime: '1700000299' },
          { ...record, msgId: '4', msgSeq: undefined, sendTime: '1700000599' },
        ],
      }),
    );
    await act(async () => vi.dynamicImportSettled());
    const author = document.querySelector<HTMLElement>('.weq-forward-author')!;
    expect(author.tagName).toBe('HEADER');
    expect(author.querySelectorAll('button')).toHaveLength(1);
    const name = author.querySelector<HTMLElement>('.weq-forward-row-name')!;
    expect(name.classList.contains('message-name')).toBe(true);
    expect(name.closest('button')).toBeNull();
    const dialog = author.closest('[role="dialog"]')!;
    const times = Array.from(dialog.querySelectorAll('time'));
    expect(times.map((time) => time.textContent)).toEqual(['昨天 06:13:20', '昨天 06:23:19']);
    expect(times[0]?.title).toBe('2023-11-15 06:13:20（北京时间）');
    expect(author.parentElement?.previousElementSibling).toBe(times[0]);
    expect(dialog.textContent).not.toContain('seq 42');
    await act(async () => render(true));
    expect(dialog.querySelectorAll('.weq-forward-author')).toHaveLength(5);
    expect(dialog.textContent).toContain('seq 71');
    act(() =>
      acceptPreferences(
        { revision: 1, values: { groupConsecutiveMessages: true }, records: {} },
        false,
      ),
    );
    expect(author.textContent).toContain('seq 42');
    expect(author.querySelector('time')?.textContent).toBe('2023-11-15 06:13:20');
    expect(dialog.querySelectorAll('.weq-message-seq')).toHaveLength(1);
    expect(dialog.querySelectorAll('.weq-forward-author')).toHaveLength(4);
    expect(dialog.textContent).not.toContain('seq 71');
    expect(dialog.textContent).not.toContain('1970-01-01');
    act(() => {
      name.click();
      times[0]!.click();
    });
    expect(open).not.toHaveBeenCalled();
    act(() =>
      author
        .querySelector('.weq-forward-avatar')!
        .dispatchEvent(
          new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 60, detail: 1 }),
        ),
    );
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: '', identityValue: '10002', displayName: '本地昵称' }),
      { x: 40, y: 60 },
      undefined,
    );
    expect(useForwardStore.getState().windows).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    acceptPreferences({ revision: 2, values: {}, records: {} }, false);
    expect(useForwardStore.getState().windows).toHaveLength(0);
    host.remove();
    now.mockRestore();
    vi.unstubAllGlobals();
  }
});
