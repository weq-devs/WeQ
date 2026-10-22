import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';
import { QzoneCardNavigationContext } from '../src/renderer/src/lib/qzoneNavigation';
import { QqDynamic } from '../src/renderer/src/components/QqDynamic';
import { QqGroupReceipt } from '../src/renderer/src/components/QqGroupReceipt';
import {
  RedBagDetailHost,
  openRedBagDetail,
} from '../src/renderer/src/components/RedBagDetailDialog';
import { ForwardWindowHost, openForwardWindow } from '../src/renderer/src/components/ForwardWindow';
import { GroupKeywordEditor } from '../src/renderer/src/components/GroupKeywordEditor';
import { BuddyAnalyticsDialog } from '../src/renderer/src/components/BuddyAnalyticsDialog';
import { MemberAnalyticsDialog } from '../src/renderer/src/components/MemberAnalyticsDialog';

const rpc = vi.hoisted(() => ({
  profile: vi.fn(),
  members: vi.fn(),
  detail: vi.fn(),
  grab: vi.fn(),
  rules: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      getProfileByUin: { query: rpc.profile },
      getGroupMembersByUins: { query: rpc.members },
      redbagDetail: { query: rpc.detail },
      redbagGrab: { mutate: rpc.grab },
    },
    bootstrap: {
      getGroupKeywordRules: { query: rpc.rules },
      setGroupKeywordRules: { mutate: rpc.save },
    },
  },
  trpc: { account: { dressup: { peerStats: { useQuery: () => ({ data: undefined }) } } } },
}));
vi.mock('../src/renderer/src/hooks/useAvatarUrl', () => ({ useAvatarUrl: () => null }));
vi.mock('../src/renderer/src/hooks/useMsgDecoration', () => ({ useMsgDecoration: () => ({}) }));
vi.mock('../src/renderer/src/hooks/useActiveWidget', () => ({
  useActiveWidget: () => ({ widget: null }),
}));
vi.mock('../src/renderer/src/components/useAnalyticsExport', () => ({
  useAnalyticsExport: () => ({ available: false, exporting: false, start: vi.fn() }),
}));

const group = { code: '12345', name: '' };
const member = { uid: 'u_peer', uin: '10002', name: '合成成员' };
const claim = { uin: '10001', nickname: '合成领取者', amount: 1, claimTime: 1 };
const detail = {
  selfUin: '10001',
  selfClaim: claim,
  totalNum: 2,
  totalAmount: 2,
  claimedCount: 1,
  wishing: '合成祝福',
  senderUin: '10002',
  senderNickname: '合成发送者',
  lucky: true,
  claims: [claim],
  expireTime: 0,
};
const stats = {
  totalMessages: 2,
  selfMessages: 1,
  peerMessages: 1,
  textMessages: 2,
  imageMessages: 0,
  voiceMessages: 0,
  videoMessages: 0,
  emojiMessages: 0,
  otherMessages: 0,
  firstMessageTime: 1,
  lastMessageTime: 2,
  activeDays: 1,
};
const buddyData = {
  peer: { uid: member.uid, uin: member.uin },
  self: { uin: '10001' },
  statistics: stats,
  messageTypes: {},
  range: {},
  daily: [],
  hourlySelf: {},
  hourlyPeer: {},
  phrasesSelf: [],
  phrasesPeer: [],
  emojisSelf: [],
  emojisPeer: [],
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  rpc.profile.mockResolvedValue({ nick: '合成发布者' });
  rpc.members.mockResolvedValue([{ ...member, card: member.name }]);
  rpc.detail.mockResolvedValue(detail);
  rpc.grab.mockResolvedValue({
    ...claim,
    senderUin: '10002',
    senderNickname: '结果发送者',
    claimedCount: 1,
  });
  rpc.rules.mockResolvedValue({
    '12345': { keywords: [{ keyword: '合成关键词', memberUids: ['u_peer'] }] },
  });
  rpc.save.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function fixture(element: ReactNode) {
  const open = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(h(ProfileNavigationContext.Provider, { value: open }, element)),
  );
  cleanups.push(() => {
    act(() => {
      document.querySelector<HTMLButtonElement>('.weq-redbag-detail-close')?.click();
      for (const button of document.querySelectorAll<HTMLButtonElement>('.weq-forward-close'))
        button.click();
      root.unmount();
    });
    host.remove();
  });
  return { host, open };
}
function buttons(scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLButtonElement>('.weq-profile-avatar-button')];
}
function click(button: HTMLButtonElement) {
  act(() =>
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1, clientX: 40, clientY: 60 }),
    ),
  );
}
function expectTarget(
  open: ReturnType<typeof vi.fn>,
  identity: string,
  expectedGroup?: typeof group,
) {
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({ identityValue: identity }),
    { x: 40, y: 60 },
    expectedGroup,
  );
}

function capture(element: Element, name: string) {
  const output = process.env.WEQ_PROFILE_ADDITIONAL_LAYOUT_DIR;
  if (!output) return;
  const css = [
    'styles/index.css',
    'styles/profile-avatar.css',
    'styles/conversation-analytics.css',
    'im-template/styles/base.css',
    'im-template/styles/chat.css',
    'im-template/styles/modals.css',
  ]
    .map((file) => readFileSync(resolve('src/renderer/src', file), 'utf8'))
    .join('\n');
  mkdirSync(output, { recursive: true });
  writeFileSync(
    resolve(output, `${name}.html`),
    `<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><style>${css}</style><style>*,*::before,*::after{box-sizing:border-box}body{margin:0;padding:24px;font-family:system-ui;background:var(--weq-bg-surface);color:var(--weq-fg-primary)}body>.group-album-dialog{max-width:100%}</style><body>${element.outerHTML}</body></html>`,
  );
}

it('动态发布者头像点击与 Enter/空格不触发动态卡片跳转', async () => {
  const navigate = vi.fn();
  const f = await fixture(
    h(
      QzoneCardNavigationContext.Provider,
      { value: navigate },
      h(QqDynamic, {
        publisherUin: [10002],
        dynamicType: 2,
        meta: JSON.stringify({
          jump_schema: `mqqapi://qzoneschema/?schema=${encodeURIComponent(btoa('mqzone://arouse/detail?appid=311&uin=10002&cellid=synthetic'))}`,
        }),
      }),
    ),
  );
  const button = buttons(f.host)[0]!;
  capture(f.host, 'dynamic');
  expect(button).toBeDefined();
  for (const key of ['Enter', ' '])
    act(() => button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key })));
  click(button);
  expectTarget(f.open, '10002');
  expect(navigate).not.toHaveBeenCalled();
  act(() => f.host.querySelector<HTMLElement>('.weq-dynamic-container')!.click());
  expect(navigate).toHaveBeenCalledOnce();
});

it('群收款名单按成员 UID 打开并保留来源群', async () => {
  const f = await fixture(
    h(QqGroupReceipt, {
      detail: { receiptList: { payers: [{ uin: member.uin }] } },
      groupCode: group.code,
    }),
  );
  await act(async () => f.host.querySelector<HTMLElement>('.weq-group-receipt-card')!.click());
  capture(document.querySelector('.weq-group-receipt-dialog')!, 'receipt');
  click(buttons(document.querySelector('.weq-group-receipt-dialog')!)[0]!);
  expectTarget(f.open, member.uin, group);
  expect(f.open.mock.calls[0]![0].id).toBe(member.uid);
});

it.each(['group', 'c2c'] as const)(
  '红包发送者和领取者可查看，%s 只在群聊附带群信息且不触发领取',
  async (kind) => {
    const f = await fixture(h(RedBagDetailHost));
    await act(async () => openRedBagDetail({ msgId: 'synthetic', kind, conv: group.code }));
    const avatars = buttons(document.querySelector('.weq-redbag-detail')!);
    capture(document.querySelector('.weq-redbag-detail')!, `redbag-${kind}`);
    expect(avatars).toHaveLength(2);
    click(avatars[0]!);
    expectTarget(f.open, '10002', kind === 'group' ? group : undefined);
    click(avatars[1]!);
    expectTarget(f.open, '10001', kind === 'group' ? group : undefined);
    expect(rpc.grab).not.toHaveBeenCalled();
  },
);

it('红包领取结果的发送者头像也能查看', async () => {
  rpc.detail.mockResolvedValue({ ...detail, selfClaim: null });
  const f = await fixture(h(RedBagDetailHost));
  await act(async () =>
    openRedBagDetail({ msgId: 'synthetic-result', kind: 'group', conv: group.code }),
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="开红包"]')!.click(),
  );
  capture(document.querySelector('.weq-redbag-detail')!, 'redbag-result');
  click(buttons(document.querySelector('.weq-redbag-detail')!)[0]!);
  expectTarget(f.open, '10002', group);
  expect(rpc.grab).toHaveBeenCalledOnce();
});

it('红包上方存在名片浮层时 Escape 不关闭底层红包，关闭浮层后才关闭红包', async () => {
  await fixture(h(RedBagDetailHost));
  await act(async () =>
    openRedBagDetail({ msgId: 'synthetic-escape', kind: 'group', conv: group.code }),
  );
  const card = document.createElement('section');
  card.setAttribute('role', 'dialog');
  card.style.zIndex = '2147483647';
  card.style.position = 'fixed';
  document.body.append(card);
  try {
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(document.querySelector('.weq-redbag-detail')).not.toBeNull();
  } finally {
    card.remove();
  }
  act(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
  );
  expect(document.querySelector('.weq-redbag-detail')).toBeNull();
});

it('转发发送者按记录身份查看，不套用外层群；缺少身份无按钮', async () => {
  const f = await fixture(h(ForwardWindowHost));
  act(() =>
    openForwardWindow({
      title: '合成转发',
      kind: 'group',
      conv: group.code,
      msgId: 'synthetic-forward',
      records: [
        {
          msgId: 'one',
          senderUid: member.uid,
          senderUin: member.uin,
          sendNick: member.name,
          elements: [],
        },
        { msgId: 'two', sendNick: '无身份', elements: [] },
      ],
    }),
  );
  const avatars = buttons(document.querySelector('.weq-forward-window')!);
  capture(document.querySelector('.weq-forward-window')!, 'forward');
  expect(avatars).toHaveLength(1);
  click(avatars[0]!);
  expectTarget(f.open, member.uin);
});

it('关键词规则已选成员可查看，编辑态查看不移除成员且移除仍生效', async () => {
  const f = await fixture(
    h(GroupKeywordEditor, {
      groupId: group.code,
      members: [{ ...member, displayName: member.name, avatarUrl: null, role: 'member' }],
    }),
  );
  click(buttons(f.host)[0]!);
  expectTarget(f.open, member.uin, group);
  capture(f.host, 'keywords');
  act(() => f.host.querySelector<HTMLButtonElement>('.group-keyword-item-scope')!.click());
  capture(f.host, 'keywords-edit');
  click(buttons(f.host)[0]!);
  expect(f.host.textContent).toContain('1 人');
  expect(rpc.save).not.toHaveBeenCalled();
  act(() => f.host.querySelector<HTMLButtonElement>('[title="移除"]')!.click());
  expect(f.host.querySelector('.group-keyword-item-scope')?.textContent).toContain('全部成员');
});

it.each([false, true])(
  '好友分析头像及双方排行可查看，导出模式 %s 不含名片按钮',
  async (exportMode) => {
    const f = await fixture(
      h(BuddyAnalyticsDialog, {
        peerUid: member.uid,
        peerName: member.name,
        initialData: buddyData,
        embedded: true,
        exportMode,
        onClose: vi.fn(),
      }),
    );
    const avatars = buttons(f.host);
    if (!exportMode) capture(f.host, 'buddy-analysis');
    expect(avatars).toHaveLength(exportMode ? 0 : 3);
    if (!exportMode) {
      for (const [index, identity] of ['10002', '10001', '10002'].entries()) {
        click(avatars[index]!);
        expectTarget(f.open, identity);
      }
    }
  },
);

it.each([false, true])('成员分析头像带所属群，导出模式 %s 不含名片按钮', async (exportMode) => {
  const f = await fixture(
    h(MemberAnalyticsDialog, {
      groupCode: group.code,
      groupName: '合成群',
      member,
      initialData: { statistics: stats, timeDistribution: {}, commonPhrases: [], commonEmojis: [] },
      embedded: true,
      exportMode,
      onClose: vi.fn(),
    }),
  );
  expect(buttons(f.host)).toHaveLength(exportMode ? 0 : 1);
  if (!exportMode) capture(f.host, 'member-analysis');
  if (!exportMode) {
    click(buttons(f.host)[0]!);
    expectTarget(f.open, member.uin, { ...group, name: '合成群' });
  }
});
