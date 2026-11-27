/**
 * 在线语音转写驱动（主进程），供聊天和即时导出共用。
 *
 * 原理（已验证）：`pttTrans.Trans{C2C,Group}PttReq` 是裸 SSO 命令，同步响应只回
 * 一个 ack；真正的转写文本随后由 `trpc.msg.olpush.OlPushService.MsgPush`
 * （msgType 528 / subType 61）异步推送 —— 而这条 push **不会回到我们自己建立的
 * 连接**（实测：同进程 `sendPacket` 收不到，只有网卡旁路抓包能看到）。
 *
 * 所以要拿文本必须「旁路抓包 + 发包」两手一起：
 *   1. arm —— 用账号的 SSO 物料（a2/d2/d2key/guid）起一个网卡抓包会话；
 *   2. transcribe —— 借同机 QQ 的凭据 `sendPacket` 发请求（并发可配），同时从
 *      抓包会话里捞 MsgPush 帧，按 `item.msgId == 请求 msgId` 归集文本。
 *
 * 即时导出可提前准备会话。聊天按需临时使用同账号会话，单独准备的会在操作结束后释放。
 */

import {
  encodePttTransReq,
  parsePttTransAck,
  parsePttTransPush,
  pttTransCmd,
  sendPacket,
} from '@weqbot/protocol';
import {
  getLogger,
  type OnlineTranscribeFn,
  type OnlineTranscribeOutcome,
  type OnlineTranscribeRequest,
  type StageLog,
} from '@weq/service';
import { requirePlatform } from './context/app_context';
import {
  startAccountCapture,
  isAccountCaptureCurrent,
  stopAccountCapture,
  takeAccountFrames,
  type AccountCaptureHandle,
} from './capture_session';

const logger = getLogger().child({ scope: 'online-transcribe' });

/** 单次转写批次的总等待上限（毫秒）—— 超过即把没拿到的丢给本地模型。 */
const BATCH_TIMEOUT_MS = 30_000;
/** 每次拉帧的等待窗口（毫秒）。 */
const POLL_WINDOW_MS = 800;
/** MsgPush 命令字（抓包帧按它过滤；识别 push 类型仍以 msgType/subType 为准）。 */
const MSG_PUSH_CMD = 'trpc.msg.olpush.OlPushService.MsgPush';

/** 一次在线转写会话（arm 出来的抓包句柄）。 */
interface ArmedSession {
  uin: string;
  handle: AccountCaptureHandle;
  /** 已消费到的帧游标（arm 时先排空存量，避免历史帧干扰）。 */
  cursor: number;
}

export class OnlineVoiceTranscriber {
  private armed: ArmedSession | null = null;
  private exportArmed = false;
  private tail: Promise<unknown> = Promise.resolve();

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation);
    this.tail = task.catch(() => undefined);
    return task;
  }

  async transcribeOne(
    uin: string,
    request: OnlineTranscribeRequest,
    checkAccount: () => void,
  ): Promise<string | undefined> {
    return this.run(async () => {
      checkAccount();
      const borrowed = this.armed?.uin === uin && isAccountCaptureCurrent(this.armed.handle);
      if (this.isArmed() && !borrowed) throw new Error('另一个语音转写会话仍在运行，请稍后重试。');
      try {
        if (!borrowed) await this.armSession(uin, checkAccount);
        checkAccount();
        const result = await this.transcribeBatch([request], 1);
        checkAccount();
        return result.texts[request.fileName];
      } finally {
        if (!borrowed) await this.disarmSession();
      }
    });
  }

  /** 当前是否已 arm（供 UI 状态查询）。 */
  isArmed(): boolean {
    return Boolean(this.exportArmed && this.armed && isAccountCaptureCurrent(this.armed.handle));
  }

  armedUin(): string | null {
    return this.armed?.uin ?? null;
  }

  /**
   * arm 抓包会话：探测后端（Windows 缺 Npcap 会抛引导文案）→ 登记 SSO 物料拿
   * d2key → 起抓包并排空存量帧。同一个账号重复 arm 会先 disarm 旧的。
   */
  arm(uin: string, checkAccount?: () => void) {
    return this.run(async () => {
      const session = await this.armSession(uin, checkAccount);
      this.exportArmed = true;
      return session;
    });
  }

  private async armSession(
    uin: string,
    checkAccount?: () => void,
  ): Promise<{ pid: number; elevated: boolean; hasD2Key: boolean }> {
    checkAccount?.();
    if (this.armed && this.armed.uin === uin && isAccountCaptureCurrent(this.armed.handle)) {
      return {
        pid: this.armed.handle.pid,
        elevated: this.armed.handle.elevated,
        hasD2Key: this.armed.handle.hasD2Key,
      };
    }
    await this.disarmSession();
    const handle = await startAccountCapture(uin);
    if (!handle.hasD2Key) {
      // 没有 d2key 就解不开 push 的密文 —— 直接停掉并报错，别让导出空等。
      await stopAccountCapture(handle.pid, handle.sessionId);
      throw new Error('未能获取该账号的会话密钥（d2key），无法解密在线转写结果');
    }
    // 排空 arm 之前网卡上已有的帧，把游标推到当前末尾。
    let cursor = 0;
    try {
      const batch = await takeAccountFrames(handle.pid, { waitMs: 0, sessionId: handle.sessionId });
      cursor = batch.nextCursor;
    } catch {
      cursor = 0;
    }
    try {
      checkAccount?.();
    } catch (error) {
      await stopAccountCapture(handle.pid, handle.sessionId);
      throw error;
    }
    this.armed = { uin, handle, cursor };
    logger.info('online transcribe armed', {
      event: 'online-transcribe-armed',
      uin,
      pid: handle.pid,
      elevated: handle.elevated,
    });
    return { pid: handle.pid, elevated: handle.elevated, hasD2Key: handle.hasD2Key };
  }

  /** 停抓包会话并清空状态（幂等）。 */
  disarm(uin?: string): Promise<void> {
    return this.run(async () => {
      if (!uin || this.armed?.uin === uin) await this.disarmSession();
    });
  }

  private async disarmSession(): Promise<void> {
    const armed = this.armed;
    this.armed = null;
    this.exportArmed = false;
    if (!armed) return;
    try {
      await stopAccountCapture(armed.handle.pid, armed.handle.sessionId);
    } catch {
      /* best-effort */
    }
    logger.info('online transcribe disarmed', {
      event: 'online-transcribe-disarmed',
      uin: armed.uin,
      pid: armed.handle.pid,
    });
  }

  /**
   * 一批语音的在线转写：并发发请求 → 从抓包帧里按 msgId 捞 push。
   * 拿到文本的进 `texts`，ack 非 0 / 超时没等到 push 的进 `missing`（交本地模型）。
   * 未 arm 时抛错 —— 导出阶段会整体回退本地。
   */
  transcribeFor(uin: string): OnlineTranscribeFn {
    return (requests, concurrency, onLog) =>
      this.run(() => {
        if (!this.isArmed() || this.armedUin() !== uin)
          throw new Error('当前账号的 QQ 在线转写未就绪。');
        return this.transcribeBatch(requests, concurrency, onLog);
      });
  }

  private async transcribeBatch(
    reqs: OnlineTranscribeRequest[],
    concurrency: number,
    onLog?: StageLog,
  ): Promise<OnlineTranscribeOutcome> {
    const armed = this.armed;
    if (!armed || !isAccountCaptureCurrent(armed.handle)) {
      throw new Error('在线转写未开启（抓包会话未 arm）');
    }
    const sender = requirePlatform().native.ntHelper;
    const texts: Record<string, string> = {};
    const missing = new Set<string>();
    const pending = new Map<string, OnlineTranscribeRequest>();

    const limit = Math.max(1, Math.min(concurrency | 0 || 5, 32));
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, reqs.length) }, async () => {
      for (;;) {
        const req = reqs[next++];
        if (!req) break;
        try {
          const cmd = pttTransCmd(req.isGroup);
          const body = encodePttTransReq({
            isGroup: req.isGroup,
            msgId: req.msgId,
            senderUin: req.senderUin,
            peerUin: req.peerUin,
            uuid: req.uuid,
            md5: req.md5,
            duration: req.duration,
            size: req.size,
            format: req.format,
            eventType: req.eventType,
            fileId: req.fileId,
          });
          const reply = await sendPacket(sender, armed.handle.pid, cmd, body);
          // ack errCode 非 0 = 语音过期 / 服务端拒绝，不会再有 push —— 直接本地补。
          const ack = parsePttTransAck(new Uint8Array(reply), req.isGroup);
          if (ack && ack.errCode !== 0) {
            onLog?.(`在线转写被拒（errCode=${ack.errCode}）：${req.fileName}`, 'warn');
            missing.add(req.fileName);
            continue;
          }
          pending.set(req.msgId, req);
        } catch (e) {
          onLog?.(
            `在线转写发包失败：${req.fileName}（${e instanceof Error ? e.message : String(e)}）`,
            'warn',
          );
          missing.add(req.fileName);
        }
      }
    });
    await Promise.all(workers);

    if (pending.size === 0) {
      return { texts, missing: [...missing] };
    }

    // ---- 捞 push：按 msgId 归集 ----
    const deadline = Date.now() + BATCH_TIMEOUT_MS;
    let cursor = armed.cursor;
    while (pending.size > 0 && Date.now() < deadline) {
      let batch: Awaited<ReturnType<typeof takeAccountFrames>>;
      try {
        batch = await takeAccountFrames(armed.handle.pid, {
          sessionId: armed.handle.sessionId,
          cursor,
          waitMs: Math.min(POLL_WINDOW_MS, Math.max(0, deadline - Date.now())),
        });
      } catch (e) {
        onLog?.(`拉取抓包帧失败：${e instanceof Error ? e.message : String(e)}`, 'warn');
        break;
      }
      cursor = batch.nextCursor;
      for (const frame of batch.frames) {
        if (frame.cmd !== MSG_PUSH_CMD || !frame.bodyHex) continue;
        const push = parsePttTransPush(new Uint8Array(Buffer.from(frame.bodyHex, 'hex')));
        if (!push) continue;
        const req = pending.get(push.msgId.toString());
        if (!req) continue;
        texts[req.fileName] = push.text;
        pending.delete(req.msgId);
      }
    }
    armed.cursor = cursor;

    for (const req of pending.values()) {
      missing.add(req.fileName);
      onLog?.(`在线转写超时未收到结果：${req.fileName}`, 'warn');
    }
    return { texts, missing: [...missing] };
  }
}

/** 全局单例（一次只服务一个打开账号；arm/disarm 由 IPC 控制）。 */
export const onlineTranscriber = new OnlineVoiceTranscriber();
