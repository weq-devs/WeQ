/**
 * WeQ 助手：一个会调用 WeQ 内置工具（搜索消息 / 列会话 / 找联系人 等）+ 用户接入的
 * 外部 MCP 工具，多轮推进直到把用户的任务做完的对话 agent。
 *
 * 设计要点：
 * - **任务执行者**，不是"教用户怎么做"。一次工具失败/没结果要换关键词、换工具继续尝试，
 *   穷尽合理尝试后才如实说找不到。
 * - **可观测**：每一轮的思考、工具调用、工具结果通过 `onStep` 回调实时吐出，供前端流式展示。
 * - 工具注册表在应用层（apps/.../mcp/tools.ts + external.ts），这里通过注入的
 *   {@link AssistantTools} 拿到「规格 + 执行」，service 不直接依赖 app。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { reportUsage, type AgentLabEndpoint, type AgentLabModelRef, type AgentLabUsage } from '@weq/agentlab';
import type { TokenUsageStore } from './agentlab_usage';
import type { ConversationStore, ConversationTurn } from './agentlab_conversation';

export type EndpointResolver = (ref: AgentLabModelRef) => AgentLabEndpoint;

/** OpenAI function 规格（由应用层从 AI_TOOLS / 外部 MCP 转换后注入）。 */
export interface AssistantToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface AssistantTools {
  /** 内置 + 外部 MCP 工具的合并规格（外部列举是异步的，故允许 Promise）。 */
  specs: () => AssistantToolSpec[] | Promise<AssistantToolSpec[]>;
  run: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** 配置变更时把外部 MCP 服务器原始配置同步给应用层的 Hub（可选）。 */
  syncExternalMcp?: (raw: string | undefined) => void;
}

export interface AssistantConfig {
  model?: AgentLabModelRef;
  customPrompt?: string;
  /** 外部 MCP 服务器配置（Claude Desktop JSON 或每行 `名字=url`）。 */
  mcpServers?: string;
}

/**
 * 一轮任务推进里可观测的一步。前端按 kind 渲染（thinking/工具调用/工具结果可折叠，
 * final 用 Markdown）。`error` 为终止态。
 */
export type AssistantStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown }
  | { kind: 'tool_result'; id: string; name: string; ok: boolean; preview: string }
  | { kind: 'final'; text: string }
  | { kind: 'error'; message: string };

/** 助手会话固定的 agentId（持久化分桶用）。 */
export const ASSISTANT_AGENT_ID = 'assistant';

/** 单轮任务最多调用工具的轮数。任务型 agent 要敢多试，故给得宽一些。 */
const TOOL_LOOP_LIMIT = 14;
/** 单个工具结果回灌给模型 / 落库的字符上限。 */
const TOOL_RESULT_CAP = 8000;
const STEP_PREVIEW_CAP = 4000;

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
    // 启动即把已存的外部 MCP 配置交给 Hub，连接在首次用到时惰性建立。
    this.tools?.syncExternalMcp?.(this.config.mcpServers);
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
    if (patch.mcpServers !== undefined) this.tools?.syncExternalMcp?.(this.config.mcpServers);
    return this.config;
  }

  getConversation(): ConversationTurn[] {
    return this.conversations.get(ASSISTANT_AGENT_ID);
  }

  clearConversation(): void {
    this.conversations.clear(ASSISTANT_AGENT_ID);
  }

  /**
   * 处理一条用户消息：多轮调用工具直到给出最终答复。每一步通过 `onStep` 实时吐出。
   * 失败（包括异常）也会作为 `error` step 推出后再抛出，便于前端统一处理。
   */
  async chat(text: string, onStep?: (step: AssistantStep) => void): Promise<{ text: string; steps: AssistantStep[] }> {
    if (!this.config.model) throw new Error('请先在助手设置里选择聊天模型。');

    const steps: AssistantStep[] = [];
    const emit = (step: AssistantStep): void => {
      steps.push(step);
      try {
        onStep?.(step);
      } catch {
        /* 前端推送失败不应中断任务 */
      }
    };

    try {
      const reply = await this.runLoop(text, emit);
      emit({ kind: 'final', text: reply });
      const now = Date.now();
      const toolsUsed = steps.filter((s): s is Extract<AssistantStep, { kind: 'tool_call' }> => s.kind === 'tool_call').map((s) => s.name);
      this.conversations.append(ASSISTANT_AGENT_ID, [
        { role: 'user', text, ts: now },
        {
          role: 'assistant',
          text: reply,
          ts: now,
          steps,
          ...(toolsUsed.length ? { toolsUsed: [...new Set(toolsUsed)] } : {}),
        },
      ]);
      return { text: reply, steps };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ kind: 'error', message });
      throw error;
    }
  }

  /** 核心多轮循环：返回最终文本。中途只 emit 过程 step，不 emit final。 */
  private async runLoop(text: string, emit: (step: AssistantStep) => void): Promise<string> {
    const endpoint: AgentLabEndpoint = {
      ...this.resolveEndpoint(this.config.model!),
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
      { role: 'system', content: this.systemPrompt() },
      ...prior.map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: text },
    ];

    const specs = (await this.tools?.specs()) ?? [];

    for (let loop = 0; loop < TOOL_LOOP_LIMIT; loop += 1) {
      // 最后一轮强制关闭工具，逼模型给出文字结论，避免"用尽轮数"硬中断。
      const allowTools = specs.length > 0 && loop < TOOL_LOOP_LIMIT - 1;
      const data = await this.callApi(endpoint, messages, allowTools ? specs : []);
      reportUsage(endpoint, data);
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('助手返回为空');

      const content = typeof msg.content === 'string' ? msg.content.trim() : '';

      if (allowTools && msg.tool_calls?.length && this.tools) {
        // 模型在调用工具前给出的思路 → 作为"思考"展示。
        if (content) emit({ kind: 'thinking', text: content });
        messages.push(msg as ApiMessage);
        for (const call of msg.tool_calls) {
          const args = this.parseArgs(call.function.arguments);
          emit({ kind: 'tool_call', id: call.id, name: call.function.name, args });
          let result: unknown;
          let ok = true;
          try {
            result = await this.tools.run(call.function.name, args);
          } catch (error) {
            ok = false;
            result = { error: error instanceof Error ? error.message : String(error) };
          }
          const serialized = safeStringify(result);
          emit({
            kind: 'tool_result',
            id: call.id,
            name: call.function.name,
            ok,
            preview: serialized.slice(0, STEP_PREVIEW_CAP),
          });
          messages.push({ role: 'tool', tool_call_id: call.id, content: serialized.slice(0, TOOL_RESULT_CAP) });
        }
        continue;
      }

      // 没有工具调用 → 这就是最终答复。
      return content || '（没能得出结论，请换个问法或补充信息。）';
    }
    // 理论上到不了这里（最后一轮已关工具强制出文本）。
    return '（任务推进超过最大轮数，已中止。）';
  }

  private systemPrompt(): string {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return [
      '你是 WeQ 助手，运行在用户的 QQ 客户端里，是一个**任务执行者**：你的职责是亲自把用户的问题查清楚、把任务做完，而不是告诉用户"你可以自己去搜索/查看"。',
      `今天是 ${dateStr}。涉及"哪天/什么时候"等时间问题时，结合聊天记录里的日期与今天推算。`,
      '',
      '【工作方式】',
      '- 把用户的每个问题都当成一个需要主动完成的任务，需要数据就调用工具，能查就查，别把活儿甩回给用户。',
      '- 提到某个人名/群名（如"小枳壳"）时，先用 find_contact 把名字解析成会话（私聊对方 uid 或群号），再用 get_messages / search_messages 在该会话里查；不要把人名本身当关键词去全文搜索。',
      '- search_messages 一次没命中，要换同义词/更短的关键词/不同 scope 多试几次；也可以直接 get_messages 把相关会话最近的消息读出来自己判断。',
      '- 群里找某个人的发言：先 find_contact 或 list_group_members 把昵称解析成 uid，再定位。',
      '- 多轮推进：每一步先想清楚下一步查什么，再调用工具；拿到结果后据此决定继续查还是作答。',
      '- 只有在合理地尝试过多种方式仍查不到时，才如实说明"没找到"，并简要说明你已经查过的范围，给出可能的下一步建议。绝不编造不存在的信息。',
      '',
      '【回答格式】',
      '- 最终答复用 **Markdown**：可用标题、要点列表、引用（> 原话）、必要时表格或代码块，让结论一眼可读。',
      '- 引用聊天记录原文时用引用块，并尽量带上是谁、大概什么时候说的。',
      '- 简洁、直接给结论，不要复述工具调用过程（过程前端会单独展示）。',
      this.config.customPrompt ? `\n【用户额外要求】（优先遵守）\n${this.config.customPrompt}` : '',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  private parseArgs(raw: string): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
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
        temperature: 0.3,
        messages,
        ...(specs.length ? { tools: specs, tool_choice: 'auto' } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`WeQ 助手接口调用失败: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
    }
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

/** JSON.stringify，循环引用/异常兜底成字符串。 */
function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
