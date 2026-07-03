/**
 * 编排层：连接 adapter，路由消息，驱动 AgentRuntime，把回复逐条发回。
 *
 * 内置详细 console 日志（收到消息 / 意愿闸决策 / 生成内容 / 发送内容），方便真机调试
 * ——尤其「为什么不回」一眼可查（看意愿闸 reason/score 或是否被判为空文本）。
 */
import { AgentRuntime, type AgentLabChatTurn } from '@weq/agentlab';
import type { OneBot11Adapter } from './adapter/types';
import { normalizeInbound, type NormalizedMessage } from './normalize/inbound';
import { encodeTurn, type AssetResolver } from './normalize/outbound';
import { BotCapabilities } from './capabilities';

const HISTORY_CAP = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 日志时间戳 HH:MM:SS。 */
function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

export interface OrchestratorOptions {
  /** 是否参与群聊（M3）。默认关：只处理私聊。 */
  groupChat?: boolean;
}

export class BotOrchestrator {
  /** 按对端 id 维护的近期对话历史（喂给 AgentRuntime 作上下文）。 */
  private readonly histories = new Map<string, AgentLabChatTurn[]>();
  /** 每个群里 bot 上次开口的时间（意愿闸冷却用）。 */
  private readonly lastGroupReplyAt = new Map<string, number>();
  /** 主动能力（撤回/戳一戳/查群…）——扩展轴③，供未来 AI-tool hook 调用。 */
  readonly capabilities: BotCapabilities;

  constructor(
    private readonly adapter: OneBot11Adapter,
    private readonly runtime: AgentRuntime,
    private readonly personaId: string,
    private readonly selfId: string,
    private readonly assets: AssetResolver,
    private readonly opts: OrchestratorOptions = {},
  ) {
    this.capabilities = new BotCapabilities(adapter);
  }

  /** 注册事件回调（在 adapter.connect() 之前调）。 */
  start(): void {
    this.adapter.onEvent((event) => {
      void this.onEvent(event);
    });
  }

  private async onEvent(event: Parameters<Parameters<OneBot11Adapter['onEvent']>[0]>[0]): Promise<void> {
    const msg = normalizeInbound(event, this.selfId);
    if (!msg) return;
    if (msg.senderId === this.selfId) return; // 不理会自己发的

    const where = msg.chatType === 'group' ? `群${msg.peerId}` : '私聊';
    console.log(
      `\n[${ts()}] 收到 <${where}> ${msg.senderName}(${msg.senderId})${msg.mentionsSelf ? ' 【@我】' : ''}: ${msg.text || '(无文本)'}`,
    );

    // @我 即使没带文字也要处理（群聊「被@必回」）；否则纯空文本消息忽略。
    if (!msg.text && !msg.mentionsSelf) {
      console.log(`[${ts()}] └ 跳过：空文本且未@我`);
      return;
    }
    if (msg.chatType === 'private') {
      await this.handlePrivate(msg);
    } else if (this.opts.groupChat) {
      await this.handleGroup(msg);
    } else {
      console.log(`[${ts()}] └ 跳过：群聊未开启（config.features.groupChat=false）`);
    }
  }

  private async handlePrivate(msg: NormalizedMessage): Promise<void> {
    const history = this.histories.get(msg.peerId) ?? [];
    let result: Awaited<ReturnType<AgentRuntime['chat']>>;
    try {
      result = await this.runtime.chat({ personaId: this.personaId, history, text: msg.text });
    } catch (err) {
      console.error(`[${ts()}] └ 生成失败:`, err instanceof Error ? err.message : err);
      return;
    }
    if (result.silent) {
      console.log(`[${ts()}] └ 静默（私聊意愿闸未过）`);
      return;
    }
    console.log(`[${ts()}] └ 生成 ${result.renderedTurns.length} 条: ${JSON.stringify(result.renderedTurns)}`);
    await this.deliver({ chatType: 'private', peerId: msg.peerId }, result.renderedTurns, result.replyDelayMs);

    const next: AgentLabChatTurn[] = [
      ...history,
      { role: 'user', text: msg.text },
      ...result.renderedTurns.map((text): AgentLabChatTurn => ({ role: 'assistant', text })),
    ];
    this.histories.set(msg.peerId, next.slice(-HISTORY_CAP));
  }

  /** 群聊（单 persona + 意愿闸）：过闸才回，关系/记忆按群友维护。 */
  private async handleGroup(msg: NormalizedMessage): Promise<void> {
    const history = this.histories.get(msg.peerId) ?? [];
    // 存在感（最近自己占比）+ 冷却（距上次开口）——喂给意愿闸压制刷屏/抢话。
    const recent = history.slice(-8);
    const selfShareRecent = recent.length > 0 ? recent.filter((t) => t.role === 'assistant').length / recent.length : 0;
    const lastReplyAt = this.lastGroupReplyAt.get(msg.peerId);
    const msSinceOwnLastReply = lastReplyAt !== undefined ? Date.now() - lastReplyAt : undefined;

    let result: Awaited<ReturnType<AgentRuntime['handleGroupMessage']>>;
    try {
      result = await this.runtime.handleGroupMessage({
        personaId: this.personaId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        text: msg.text,
        mentionsSelf: msg.mentionsSelf,
        history,
        selfShareRecent,
        msSinceOwnLastReply,
      });
    } catch (err) {
      console.error(`[${ts()}] └ 群聊生成失败:`, err instanceof Error ? err.message : err);
      return;
    }
    // 意愿闸决策日志：一眼看清「为什么回 / 为什么不回」。
    console.log(
      `[${ts()}] └ 意愿闸: ${result.reason} score=${result.score.toFixed(2)} → ${result.silent ? '不回' : '回复'}`,
    );

    history.push({ role: 'user', text: `「${msg.senderName}」：${msg.text}` });

    if (!result.silent && result.renderedTurns.length > 0) {
      console.log(`[${ts()}]   生成 ${result.renderedTurns.length} 条: ${JSON.stringify(result.renderedTurns)}`);
      await this.deliver({ chatType: 'group', peerId: msg.peerId }, result.renderedTurns, result.replyDelayMs);
      for (const t of result.renderedTurns) history.push({ role: 'assistant', text: t });
      this.lastGroupReplyAt.set(msg.peerId, Date.now());
    }
    this.histories.set(msg.peerId, history.slice(-HISTORY_CAP));
  }

  /** 逐条把 renderedTurns 编码成 OneBot 段发出（分条之间按 replyDelayMs 拟人停顿）。 */
  private async deliver(
    target: { chatType: 'private' | 'group'; peerId: string },
    turns: string[],
    replyDelayMs: number,
  ): Promise<void> {
    for (const turn of turns) {
      const segments = encodeTurn(turn, this.assets);
      if (!segments) continue;
      try {
        await this.adapter.sendMessage(target, segments);
        console.log(`[${ts()}]   发送 → ${target.chatType}:${target.peerId}: ${turn}`);
      } catch (err) {
        console.error(`[${ts()}]   发送失败:`, err instanceof Error ? err.message : err);
      }
      if (replyDelayMs > 0) await sleep(replyDelayMs);
    }
  }
}
