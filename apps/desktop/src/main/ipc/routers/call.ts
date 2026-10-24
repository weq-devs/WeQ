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
import { callManagerFor, findCallManager } from '../../call_registry';
import {
  CallRecordingStore,
  recordingsRootFor,
  type CallRecordingEntry,
} from '../../call_recording_store';
import { systemAudioCapability } from '../../call_system_audio';
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
        kind: 'c2c',
        conv: peerUid,
        peerUin: input.peerUin,
        peerUid,
        peerName: input.peerName,
        peerAvatar: input.peerAvatar,
        backgroundUrl: background?.imageUrl,
        backgroundVideoUrl: background?.videoUrl,
        recordingConfig: ctx.bootstrap?.userConfig.getSettings().callRecording,
      });
      logger.info('发起通话', { peer: input.peerUin, room: call.roomId });
      return call;
    }),

  /** 挂断当前通话。没有通话时是空操作。 */
  hangup: procedure.mutation(async () => {
    const manager = findCallManager();
    if (!manager) return { ok: false };
    await manager.hangup();
    return { ok: true };
  }),

  /** 当前通话快照（界面首次挂载时取一次，之后靠订阅）。 */
  current: procedure.query(() => findCallManager()?.current() ?? null),

  /**
   * 推一帧麦克风音频。
   *
   * 渲染层按 20 ms 节拍调用；主进程不做缓冲，直接排进通话的发送队列，
   * 队列满 5 帧会丢老的（保持实时比完整更重要）。
   */
  pushAudio: procedure
    .input(z.object({ pcm: z.instanceof(Uint8Array), muted: z.boolean().optional() }))
    .mutation(({ input }) => {
      if (input.pcm.byteLength !== AUDIO_FRAME_BYTES) {
        throw new Error(`一帧必须是 ${AUDIO_FRAME_BYTES} 字节`);
      }
      const manager = findCallManager();
      if (!manager) return { ok: false };
      // 静音帧仍要喂录音（录音要的是麦克风原声），但**不发**给对方。
      manager.pushAudio(input.pcm, input.muted === true);
      return { ok: true };
    }),

  /** 通话状态变化（发起 / 振铃 / 接通 / 结束）。 */
  onCallState: procedure.subscription(() =>
    observable<ActiveCallInfo>((emit) => {
      const manager = findCallManager();
      if (!manager) return () => {};
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
      const manager = findCallManager();
      if (!manager) return () => {};
      const handler = (event: CallEvent) => {
        if (event.type === 'audio') emit.next(event.pcm);
      };
      manager.on('event', handler);
      return () => manager.off('event', handler);
    }),
  ),

  // ── 录音 ──

  /**
   * 电脑声音的采集能力（决定设置里的开关能不能开）+ 当前生效的录音目录。
   *
   * 目录也一起给：界面上的「打开目录」在用户没自选时必须能打开默认那一层，
   * 不能只回一句「用的是默认目录」。
   */
  recordingCapabilities: procedure.query(() => {
    const ctx = getAppContext();
    const settings = ctx.bootstrap?.userConfig.getSettings().callRecording;
    const uin = ctx.account?.context.uin;
    const dir =
      settings?.dir ??
      (ctx.platform && uin ? recordingsRootFor(ctx.platform.appDataRoot(), String(uin)) : null);
    return { systemAudio: systemAudioCapability(), dir };
  }),

  /**
   * 开始录音。`mode` / `systemAudio` 可临时覆盖设置页的值 —— 通话窗口的抽屉里
   * 改完立即生效，不必先跳到设置页。
   */
  startRecording: procedure
    .input(
      z
        .object({
          mode: z.enum(['self', 'peer', 'mixed']).optional(),
          systemAudio: z.boolean().optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) => {
      const manager = findCallManager();
      if (!manager) throw new Error('当前没有通话');
      return manager.startRecording(input);
    }),

  /** 停止录音，返回落盘后的记录（没在录时为 null）。 */
  stopRecording: procedure.mutation(async () => {
    const manager = findCallManager();
    if (!manager) return null;
    return manager.stopRecording();
  }),

  /**
   * 主进程侧的非致命错误（例如电脑声音采集失败，录音仍在继续）。
   *
   * 与 `lastError` 分开：那个是「通话本身挂了」，这个是「某个附加能力没成」，
   * 混在一起会让界面把状态行染成报错。
   */
  onCallError: procedure.subscription(() =>
    observable<string>((emit) => {
      const manager = findCallManager();
      if (!manager) return () => {};
      const handler = (event: CallEvent) => {
        if (event.type === 'error') emit.next(event.message);
      };
      manager.on('event', handler);
      return () => manager.off('event', handler);
    }),
  ),

  /**
   * 录音收尾事件。用户点「停止」时走 mutation 的返回值；但对端挂断 / 被踢 / 异常
   * 这类**内部收尾**没有调用方在等，必须靠这条订阅把结果送给界面。
   */
  onCallRecording: procedure.subscription(() =>
    observable<CallRecordingEntry>((emit) => {
      const manager = findCallManager();
      if (!manager) return () => {};
      const handler = (event: CallEvent) => {
        if (event.type === 'recording') emit.next(event.entry);
      };
      manager.on('event', handler);
      return () => manager.off('event', handler);
    }),
  ),

  /** Windows：渲染层采到的电脑声音帧（640 字节，16 kHz 单声道）。 */
  pushSystemAudio: procedure
    .input(z.object({ pcm: z.instanceof(Uint8Array) }))
    .mutation(({ input }) => {
      if (input.pcm.byteLength !== AUDIO_FRAME_BYTES) {
        throw new Error(`一帧必须是 ${AUDIO_FRAME_BYTES} 字节`);
      }
      findCallManager()?.pushSystemAudio(input.pcm);
      return { ok: true };
    }),

  /**
   * 某条 call 消息对应的录音（气泡上的播放按钮用）。
   *
   * 匹配是 best-effort：双方都用 WeQ 时可能没有这条消息，返回 null 即可，界面
   * 不渲染播放按钮。
   */
  recordingForMessage: procedure
    .input(
      z.object({
        kind: z.enum(['c2c', 'group']),
        conv: z.string(),
        sendTimeMs: z.number(),
        msgId: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      if (!input.conv) return null;
      const ctx = getAppContext();
      const bootstrap = ctx.bootstrap;
      const platform = ctx.platform;
      if (!bootstrap || !platform) return null;
      const settings = bootstrap.userConfig.getSettings().callRecording;
      const uin = ctx.account?.context.uin;
      if (!uin) return null;
      const root = settings.dir ?? recordingsRootFor(platform.appDataRoot(), String(uin));
      return new CallRecordingStore(root).match(input);
    }),
});
