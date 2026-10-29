import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactProfileDialog } from '../src/renderer/src/im-template/template/profilePanes';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { Contact } from '../src/renderer/src/im-template/template/types';
import { ChatNavigationContext } from '../src/renderer/src/lib/chatNavigation';
import { contactProfileIdentity, sendTargetOf } from '../src/renderer/src/lib/conversationIdentity';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));
const device: Contact = {
  id: 'u_Wcc5rknRRqRO8y5gxMD6sA',
  identityLabel: '设备',
  identityValue: '10001',
  displayName: '本人昵称',
  username: 'device',
  avatarUrl: null,
  createdAt: new Date(0).toISOString(),
  age: 99,
  signature: '本人签名',
};
afterEach(() => vi.unstubAllGlobals());

it('设备身份不参与资料补全，普通联系人仍使用 UID 或 QQ 号', () => {
  expect(contactProfileIdentity(device)).toEqual({ uid: '', uin: '' });
  expect(contactProfileIdentity({ ...device, identityLabel: 'QQ', uid: 'u_self' })).toEqual({
    uid: '',
    uin: '',
  });
  expect(contactProfileIdentity({ ...device, id: 'unknown-device' })).toEqual({ uid: '', uin: '' });
  expect(contactProfileIdentity({ ...device, id: 'u_friend', identityLabel: 'QQ' })).toEqual({
    uid: 'u_friend',
    uin: '10001',
  });
  expect(contactProfileIdentity()).toEqual({ uid: '', uin: '' });
});

it('发送设备始终保留伪 UID，不采用会话中携带的本人 QQ 号或临时来源', () => {
  const demo = createTemplateDemoData();
  const direct = demo.conversations.find((row) => row.type === 'direct')!;
  const conversation = {
    ...direct,
    id: device.id,
    otherUser: device,
    tempSourceGroupCode: '12345',
  };
  expect(sendTargetOf(conversation)).toEqual({ peerType: 'c2c', targetId: device.id });
  expect(sendTargetOf({ ...direct, otherUser: { ...device, id: 'u_friend' } })).toEqual({
    peerType: 'c2c',
    targetId: '10001',
  });
  expect(
    sendTargetOf({
      ...direct,
      tempSourceGroupCode: '12345',
      otherUser: { ...device, id: 'u_friend' },
    }),
  ).toEqual({ peerType: 'c2c', targetId: 'u_friend', tempGroupCode: '12345' });
  const group = demo.conversations.find((row) => row.type === 'group')!;
  expect(sendTargetOf(group)).toEqual({ peerType: 'group', targetId: group.group.identityValue });
});

it('设备详情展示手机名称和消息入口，不展示本人资料或好友功能', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn(),
    preview = vi.fn();
  try {
    act(() =>
      root.render(
        h(
          ChatNavigationContext.Provider,
          { value: open },
          h(ContactProfileDialog, {
            contact: device,
            embedded: true,
            onClose: vi.fn(),
            onPreviewChat: preview,
          }),
        ),
      ),
    );
    expect(host.querySelector('[aria-label="设备信息"]')).not.toBeNull();
    expect(host.textContent).toContain('我的手机');
    for (const text of [
      '本人昵称',
      '本人签名',
      '10001',
      '99',
      '个人资料',
      '互动标识',
      '互动画像',
      '成为好友',
    ])
      expect(host.textContent).not.toContain(text);
    expect(host.querySelector('.weq-contact-workspace')).toBeNull();
    expect(host.querySelector<HTMLImageElement>('.weq-profile-avatar img')!.src).toMatch(
      /^data:image\/svg\+xml/,
    );
    const buttons = [...host.querySelectorAll('button')];
    act(() => buttons.find((button) => button.textContent === '查看消息')!.click());
    expect(open).toHaveBeenCalledWith({ kind: 'direct', user: device });
    act(() => buttons.find((button) => button.textContent === '预览消息')!.click());
    expect(preview).toHaveBeenCalledWith(device);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
