/**
 * 编排层：连接 adapter，路由消息，驱动 AgentRuntime，把回复逐条发回。
 *
 * M1：私聊闭环（收文本 → AgentRuntime.chat → 逐条 renderedTurn 发回）。
 * M3 扩展：群聊（意愿闸决定是否回）在 handleGroup 里补。
 */
import { AgentRuntime, type AgentLabChatTurn } from '@weq/agentlab';
import type { OneBot11Adapter } from './adapter/types';
import { normalizeInbound, type NormalizedMessage } from './normalize/inbound';
import { encodeTurn, type AssetResolver } from './normalize/outbound';

const HISTORY_CAP = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OrchestratorOptions {
  /** 是否参与群聊（M3）。默认关：只处理私聊。 */
  groupChat?: boolean;
}

export class BotOrchestrator {
  /** 按对端 id 维护的近期对话历史（喂给 AgentRuntime.chat 作上下文）。 */
  private readonly histories = new Map<string, AgentLabChatTurn[]>();

  constructor(
    private readonly adapter: OneBot11Adapter,
    private readonly runtime: AgentRuntime,
    private readonly personaId: string,
    private readonly selfId: string,
    private readonly assets: AssetResolver,
    private readonly opts: OrchestratorOptions = {},
  ) {}

  /** 注册事件回调（在 adapter.connect() 之前调）。 */
  start(): void {
    this.adapter.onEvent((event) => {
      void this.onEvent(event);
    });
  }

  private async onEvent(event: Parameters<Parameters<OneBot11Adapter['onEvent']>[0]>[0]): Promise<void> {
    const msg = normalizeInbound(event, this.selfId);
    if (!msg || !msg.text) return;
    if (msg.senderId === this.selfId) return; // 不理会自己发的
    if (msg.chatType === 'private') {
      await this.handlePrivate(msg);
    } else if (this.opts.groupChat) {
      await this.handleGroup(msg);
    }
  }

  private async handlePrivate(msg: NormalizedMessage): Promise<void> {
    const history = this.histories.get(msg.peerId) ?? [];
    let result: Awaited<ReturnType<AgentRuntime['chat']>>;
    try {
      result = await this.runtime.chat({ personaId: this.personaId, history, text: msg.text });
    } catch (err) {
      console.error('[bot] 生成回复失败:', err instanceof Error ? err.message : err);
      return;
    }
    if (result.silent) return;

    await this.deliver({ chatType: 'private', peerId: msg.peerId }, result.renderedTurns, result.replyDelayMs);

    const next: AgentLabChatTurn[] = [
      ...history,
      { role: 'user', text: msg.text },
      ...result.renderedTurns.map((text): AgentLabChatTurn => ({ role: 'assistant', text })),
    ];
    this.histories.set(msg.peerId, next.slice(-HISTORY_CAP));
  }

  /** M3：群聊（单 persona + 意愿闸）。占位，先不回。 */
  private async handleGroup(_msg: NormalizedMessage): Promise<void> {
    // TODO(M3): reply_gate.scoreReplyGate 决定是否回 + relation/memory 维护对群友的关系。
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
      } catch (err) {
        console.error('[bot] 发送失败:', err instanceof Error ? err.message : err);
      }
      if (replyDelayMs > 0) await sleep(replyDelayMs);
    }
  }
}
