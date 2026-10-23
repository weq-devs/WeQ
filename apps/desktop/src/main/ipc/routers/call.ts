/**
 * 语音通话路由。
 *
 * 只做**主动发起**。来电由 QQ 本体的 AVSDK 处理，我们借凭据发包，收不到那条
 * 推送 —— 所以没有「接听」接口，界面也不该画接听按钮。
 *
 * 音频走两条独立的通道：
 *   - 上行：渲染层每 20 ms 推一帧 640 字节 PCM（`pushAudio`）；
 *   - 下行：主进程解码后经 `onAudio` 订阅下发给渲染层播。
 *
 * 用两条而不是塞进同一条流，是因为上行是高频单向写、下行需要订阅广播，混在
 * 一个请求里会让背压互相拖累。
 */

import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { ensureCallBackground, getLogger } from '@weq/service';
import { procedure, router } from '../trpc';
import { getAppContext, requireAttachEnabled } from '../../context/app_context';
import { callManagerFor } from '../../call_registry';
import type { ActiveCallInfo, CallEvent } from '../../call';

const logger = getLogger().child({ scope: 'call-router' });

/** 渲染层推来的一帧：16 kHz 单声道 16-bit 的原始字节。 */
const AUDIO_FRAME_BYTES = 640;

export const callRouter = router({
  /**
   * 发起通话。`peerUin` 是好友 QQ 号；uid 由主进程从会话里的 uid 表解析，
   * 渲染层拿不到也不需要拿。
   */
  start: procedure
    .input(
      z.object({
        peerUin: z.string().min(1),
        peerName: z.string().optional(),
        peerAvatar: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      requireAttachEnabled();
      const ctx = getAppContext();
      const session = ctx.account;
      if (!session) throw new Error('未打开账号');

      const selfUin = session.context.uin;
      const selfUid = session.selfUid;
      if (!selfUid) throw new Error('读不到本账号的 uid，无法发起通话');

      // 对端 uid 必须走这个会话的 uid 表：协议层只认 `u_...` 形态。
      const peerUid = session.uidMap.uidByUin(BigInt(input.peerUin)) ?? '';
      if (!peerUid) throw new Error(`找不到 ${input.peerUin} 的 uid（先和对方有过会话再试）`);

      const pid = ctx.platform?.resolveQqPid(selfUin);
      if (!pid) throw new Error('QQ 当前不在线，通话需要借用在线实例的凭据');

      // 通话背景是装饰：取不到就直接用默认底图，绝不因为它拖慢或挡住拨号。
      // `ensureCallBackground` 自己有缓存策略 —— 快照里查过这一项就不会再联网。
      const background = await ensureCallBackground(
        ctx.platform!.native.ntHelper,
        session,
        // 会话级服务里就是当前账号的配置服务。
        ctx.services!.accountConfig,
        pid,
      ).catch(() => null);

      const manager = callManagerFor(ctx.platform!, pid);
      const call = await manager.start({
        pid,
        selfUin,
        selfUid,
        peerUin: input.peerUin,
        peerUid,
        peerName: input.peerName,
        peerAvatar: input.peerAvatar,
        backgroundUrl: background?.imageUrl,
        backgroundVideoUrl: background?.videoUrl,
      });
      logger.info('发起通话', { peer: input.peerUin, room: call.roomId });
      return call;
    }),

  /** 挂断当前通话。没有通话时是空操作。 */
  hangup: procedure.mutation(async () => {
    const ctx = getAppContext();
    const platform = ctx.platform;
    const uin = ctx.account?.context.uin;
    if (!platform || !uin) return { ok: false };
    const manager = callManagerFor(platform, platform.resolveQqPid(uin) ?? 0);
    await manager.hangup();
    return { ok: true };
  }),

  /** 当前通话快照（界面首次挂载时取一次，之后靠订阅）。 */
  current: procedure.query(() => {
    const ctx = getAppContext();
    const platform = ctx.platform;
    const uin = ctx.account?.context.uin;
    if (!platform || !uin) return null;
    return callManagerFor(platform, platform.resolveQqPid(uin) ?? 0).current();
  }),

  /**
   * 推一帧麦克风音频。
   *
   * 渲染层按 20 ms 节拍调用；主进程不做缓冲，直接排进通话的发送队列，
   * 队列满 5 帧会丢老的（保持实时比完整更重要）。
   */
  pushAudio: procedure.input(z.object({ pcm: z.instanceof(Uint8Array) })).mutation(({ input }) => {
    if (input.pcm.byteLength !== AUDIO_FRAME_BYTES) {
      throw new Error(`一帧必须是 ${AUDIO_FRAME_BYTES} 字节`);
    }
    const ctx = getAppContext();
    const platform = ctx.platform;
    const uin = ctx.account?.context.uin;
    if (!platform || !uin) return { ok: false };
    callManagerFor(platform, platform.resolveQqPid(uin) ?? 0).pushAudio(input.pcm);
    return { ok: true };
  }),

  /** 通话状态变化（发起 / 振铃 / 接通 / 结束）。 */
  onCallState: procedure.subscription(() =>
    observable<ActiveCallInfo>((emit) => {
      const ctx = getAppContext();
      const platform = ctx.platform;
      const uin = ctx.account?.context.uin;
      if (!platform || !uin) return () => {};
      const manager = callManagerFor(platform, platform.resolveQqPid(uin) ?? 0);
      const handler = (event: CallEvent) => {
        if (event.type === 'state') emit.next(event.call);
      };
      manager.on('event', handler);
      return () => manager.off('event', handler);
    }),
  ),

  /** 对端音频（已解码成 16 kHz PCM）。 */
  onCallAudio: procedure.subscription(() =>
    observable<Uint8Array>((emit) => {
      const ctx = getAppContext();
      const platform = ctx.platform;
      const uin = ctx.account?.context.uin;
      if (!platform || !uin) return () => {};
      const manager = callManagerFor(platform, platform.resolveQqPid(uin) ?? 0);
      const handler = (event: CallEvent) => {
        if (event.type === 'audio') emit.next(event.pcm);
      };
      manager.on('event', handler);
      return () => manager.off('event', handler);
    }),
  ),
});
