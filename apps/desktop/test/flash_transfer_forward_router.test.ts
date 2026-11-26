// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { FlashTransferService } from '@weq/service';
import { accountRouter } from '../src/main/ipc/routers/account';
import { repeatSendPlan } from '../src/renderer/src/lib/messageRepeat';

const state = vi.hoisted(() => ({
  uin: '10001',
  configId: 'flash-fixture',
  online: true,
  switchBeforeSend: false,
  sendOidbPacket: vi.fn(async (..._args: unknown[]) => Buffer.from('0a081a0608021a02087b', 'hex')),
}));
vi.mock('../src/main/context/full_mode', () => ({ fullModeAllowed: () => true }));
vi.mock('../src/main/context/app_context', () => {
  const record = () => ({
    uin: state.uin,
    configId: state.configId,
    qqOnline: state.online,
    qqPid: 4321,
  });
  const service = new FlashTransferService(
    { sendOidbPacket: state.sendOidbPacket },
    { uidMap: { uidByUin: () => 'u_friend' } } as unknown as AccountSession,
    () => {
      if (state.switchBeforeSend) state.configId = 'changed-source';
      return 4321;
    },
  );
  const services = { accountConfig: { getRecord: record }, flashTransfer: service };
  return {
    accountEventBus: new EventEmitter(),
    getAppContext: () => ({ account: { context: { uin: state.uin } }, services }),
    requireBootstrap: () => ({
      userConfig: { getSettings: () => ({ ocr: { prefilterEnabled: false } }) },
    }),
  };
});

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'flash-fixture' };
beforeEach(() => {
  state.uin = '10001';
  state.configId = 'flash-fixture';
  state.online = true;
  state.switchBeforeSend = false;
  state.sendOidbPacket.mockClear();
});

it('已停用的图文 Ark 和群报名拒绝旧客户端请求，不发 QQ 请求', async () => {
  const caller = accountRouter.createCaller({});
  await expect(
    caller.sendTuwenArk({
      peerType: 'group',
      targetId: '123',
      title: '合成卡片',
      jumpUrl: 'https://example.invalid/',
    }),
  ).rejects.toThrow('QQ 暂不支持从 WeQ 发送图文 Ark 卡片');
  await expect(
    caller.sendGroupSignup({ groupCode: '123', title: '合成报名', detail: '测试内容' }),
  ).rejects.toThrow('QQ 暂不支持从 WeQ 发送群报名卡片');
  expect(state.sendOidbPacket).not.toHaveBeenCalled();
});

describe('闪传转发计划到 IPC 与实际协议', () => {
  it.each(['c2c', 'group'] as const)('%s 走已有文件集分享接口', async (peerType) => {
    const plan = repeatSendPlan(
      [
        { type: 'text', data: { textContent: '' } },
        {
          type: 'markdown',
          data: {
            markdownContent: '仅供展示，不作为发送内容',
            flashTransferInfo: { fileSetId: 'fixture-fileset' },
          },
        },
      ],
      new Map(),
      peerType === 'group',
    );
    if (plan.kind !== 'flashTransfer') throw new Error('闪传误走普通消息');
    const result = await accountRouter.createCaller({}).forwardFlashTransfer({
      ...binding,
      peerType,
      targetId: peerType === 'group' ? '123' : '20002',
      fileSetId: plan.fileSetId,
    });
    expect(result).toEqual({ ok: true, fileSetId: plan.fileSetId });
    expect(state.sendOidbPacket).toHaveBeenCalledTimes(1);
    expect(state.sendOidbPacket.mock.calls[0]?.slice(0, 3)).toEqual([4321, 0x93d7, 1]);
  });

  it.each(['account', 'source', 'offline', 'in-flight'] as const)(
    '%s 变化时不发包',
    async (mode) => {
      if (mode === 'account') state.uin = '10002';
      if (mode === 'source') state.configId = 'other-source';
      if (mode === 'offline') state.online = false;
      if (mode === 'in-flight') state.switchBeforeSend = true;
      await expect(
        accountRouter.createCaller({}).forwardFlashTransfer({
          ...binding,
          peerType: 'group',
          targetId: '123',
          fileSetId: 'fixture-fileset',
        }),
      ).rejects.toThrow();
      expect(state.sendOidbPacket).not.toHaveBeenCalled();
    },
  );
});
