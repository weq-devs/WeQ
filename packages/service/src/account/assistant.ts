/**
 * WeQ 助手：一个会调用 WeQ 内置工具（搜索消息 / 列会话 / 导出 等）帮用户完成
 * 操作的对话 agent。OpenAI 兼容 function-calling 循环 + 配置/对话持久化 + token 记账。
 *
 * 工具注册表在应用层（apps/.../mcp/tools.ts），这里通过注入的 {@link AssistantTools}
 * 拿到「规格 + 执行」，service 不直接依赖 app。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { reportUsage, type AgentLabEndpoint, type AgentLabModelRef, type AgentLabUsage } from '@weq/agentlab';
import type { TokenUsageStore } from './agentlab_usage';
import type { ConversationStore, ConversationTurn } from './agentlab_conversation';

export type EndpointResolver = (ref: AgentLabModelRef) => AgentLabEndpoint;

/** OpenAI function 规格（由应用层从 AI_TOOLS 转换后注入）。 */
export interface AssistantToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface AssistantTools {
  specs: () => AssistantToolSpec[];
  run: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface AssistantConfig {
  model?: AgentLabModelRef;
  customPrompt?: string;
  /** 外部 MCP 服务器（地址，每行一个）。当前仅存储展示，执行接入待后续。 */
  mcpServers?: string;
}

/** 助手会话固定的 agentId（持久化分桶用）。 */
export const ASSISTANT_AGENT_ID = 'assistant';

const TOOL_LOOP_LIMIT = 6;

interface ApiMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export class AssistantService {
  private readonly configPath: string;
  private config: AssistantConfig;

  constructor(
    rootDir: string,
    private readonly resolveEndpoint: EndpointResolver,
    private readonly usage: TokenUsageStore,
    private readonly conversations: ConversationStore,
    private readonly tools?: AssistantTools,
  ) {
    this.configPath = join(rootDir, 'assistant.json');
    this.config = this.loadConfig();
  }

  getConfig(): AssistantConfig {
    return this.config;
  }

  setConfig(patch: AssistantConfig): AssistantConfig {
    this.config = {
      model: patch.model ?? this.config.model,
      customPrompt: patch.customPrompt !== undefined ? patch.customPrompt : this.config.customPrompt,
      mcpServers: patch.mcpServers !== undefined ? patch.mcpServers : this.config.mcpServers,
    };
    this.persistConfig();
    return this.config;
  }

  getConversation(): ConversationTurn[] {
    return this.conversations.get(ASSISTANT_AGENT_ID);
  }

  clearConversation(): void {
    this.conversations.clear(ASSISTANT_AGENT_ID);
  }

  async chat(text: string): Promise<{ text: string; toolsUsed: string[] }> {
    if (!this.config.model) throw new Error('请先在助手设置里选择聊天模型。');
    const endpoint: AgentLabEndpoint = {
      ...this.resolveEndpoint(this.config.model),
      kind: 'chat',
      onUsage: (u: AgentLabUsage) =>
        this.usage.record({
          ts: Date.now(),
          model: u.model,
          kind: u.kind,
          scope: 'assistant',
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          totalTokens: u.totalTokens,
        }),
    };

    const prior = this.conversations.get(ASSISTANT_AGENT_ID).slice(-12);
    const messages: ApiMessage[] = [
      {
        role: 'system',
        content:
          '你是 WeQ 助手，运行在用户的 QQ 客户端里。可以调用提供的工具读取本地聊天数据帮用户完成查询/操作。' +
          '需要数据时主动调用工具；拿到结果后用简洁中文回答。无法用工具完成时如实说明。' +
          (this.config.customPrompt ? `\n额外要求：${this.config.customPrompt}` : ''),
      },
      ...prior.map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: text },
    ];

    const specs = this.tools?.specs() ?? [];
    const toolsUsed: string[] = [];

    for (let loop = 0; loop < TOOL_LOOP_LIMIT; loop += 1) {
      const data = await this.callApi(endpoint, messages, specs);
      reportUsage(endpoint, data);
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('助手返回为空');

      if (msg.tool_calls?.length && this.tools) {
        messages.push(msg as ApiMessage);
        for (const call of msg.tool_calls) {
          toolsUsed.push(call.function.name);
          let result: unknown;
          try {
            const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            result = await this.tools.run(call.function.name, args as Record<string, unknown>);
          } catch (error) {
            result = { error: error instanceof Error ? error.message : String(error) };
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result).slice(0, 8000),
          });
        }
        continue;
      }

      const finalText = typeof msg.content === 'string' ? msg.content.trim() : '';
      const reply = finalText || '（助手没有给出回复）';
      const now = Date.now();
      this.conversations.append(ASSISTANT_AGENT_ID, [
        { role: 'user', text, ts: now },
        { role: 'assistant', text: reply, ts: now, ...(toolsUsed.length ? { toolsUsed } : {}) },
      ]);
      return { text: reply, toolsUsed };
    }
    throw new Error('助手调用工具次数过多，已中止。');
  }

  private async callApi(
    endpoint: AgentLabEndpoint,
    messages: ApiMessage[],
    specs: AssistantToolSpec[],
  ): Promise<{ choices?: Array<{ message?: ApiMessage }>; usage?: unknown }> {
    const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0.4,
        messages,
        ...(specs.length ? { tools: specs, tool_choice: 'auto' } : {}),
      }),
    });
    if (!res.ok) throw new Error(`WeQ 助手接口调用失败: HTTP ${res.status}`);
    return (await res.json()) as { choices?: Array<{ message?: ApiMessage }>; usage?: unknown };
  }

  private loadConfig(): AssistantConfig {
    try {
      if (!existsSync(this.configPath)) return {};
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      return parsed && typeof parsed === 'object' ? (parsed as AssistantConfig) : {};
    } catch {
      return {};
    }
  }

  private persistConfig(): void {
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch {
      /* ignore */
    }
  }
}
