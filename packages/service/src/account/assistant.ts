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
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { reportUsage, pickMessageText, type AgentLabEndpoint, type AgentLabModelRef, type AgentLabUsage } from '@weq/agentlab';
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
 * 与 WeQ 助手的一次「会话」。一个会话 = 一段独立的对话历史（独立上下文、独立持久化桶）。
 * 标题在首轮对话后由模型自动总结生成（见 {@link AssistantService.generateTitle}）。
 */
export interface AssistantSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 助手用 write_report 写到本地的一份报告/文档（落在账号缓存目录的 reports/ 下）。
 * `id` 同时是磁盘文件名与 open/save 的句柄；前端据此渲染附件卡片（查看/另存为）。
 */
export interface AssistantArtifact {
  /**
   * 句柄：report 类是磁盘文件名（含 uuid，纯 basename，open/saveArtifact 用）；
   * export 类是导出任务 id（open/saveAssistantExport 用）。前端按 kind 路由。
   */
  id: string;
  /** 展示名（带扩展名）：卡片标题 + 另存为默认文件名。 */
  name: string;
  /** html/markdown/text 由 write_report 产出；export 由导出工具产出（结果文件/文件夹）。 */
  kind: 'html' | 'markdown' | 'text' | 'export';
  mime: string;
  /** 字节数，卡片显示大小用。 */
  bytes: number;
}

/**
 * 应用层工具想往聊天里吐一张「附件卡片」时，让 run() 返回一个带此键的对象即可
 * （如导出工具）。runLoop 检测到就 emit 一条 artifact step，保持 assistant 通用、
 * 不耦合具体工具名。
 */
export interface ToolArtifactResult {
  artifactCard: AssistantArtifact;
}

function extractArtifactCard(result: unknown): AssistantArtifact | null {
  if (!result || typeof result !== 'object' || !('artifactCard' in result)) return null;
  const card = (result as ToolArtifactResult).artifactCard;
  if (card && typeof card.id === 'string' && typeof card.name === 'string' && typeof card.kind === 'string') {
    return card;
  }
  return null;
}

/**
 * 一轮任务推进里可观测的一步。前端按 kind 渲染（thinking/工具调用/工具结果可折叠，
 * final 用 Markdown，artifact 渲染成气泡里的附件卡片）。`error` 为终止态。
 */
export type AssistantStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown }
  | { kind: 'tool_result'; id: string; name: string; ok: boolean; preview: string }
  | { kind: 'artifact'; artifact: AssistantArtifact }
  | { kind: 'final'; text: string }
  | { kind: 'error'; message: string };

/** report 文件类型 → 扩展名 / MIME。单一事实源，写盘与读取都走它。 */
const ARTIFACT_KIND = {
  html: { ext: '.html', mime: 'text/html' },
  markdown: { ext: '.md', mime: 'text/markdown' },
  text: { ext: '.txt', mime: 'text/plain' },
} as const;

type ArtifactKind = keyof typeof ARTIFACT_KIND;

/**
 * write_report 的 OpenAI function 规格（手写 JSON Schema —— 这是 service 的内置工具，
 * 不经应用层 {@link AssistantToolSpec} 的 zod 转换，故直接写死）。
 */
const WRITE_REPORT_SPEC: AssistantToolSpec = {
  type: 'function',
  function: {
    name: 'write_report',
    description:
      '把一份报告/文档写到本地文件（用户随后可在你的回复里「查看」或「另存为」）。' +
      '强烈优先 kind="html"：应用内置本地 Tailwind 运行时 + 一套可选的报告组件库 class（rp-*）离线渲染，' +
      '无需写 <style>、也无需引任何 CDN（详见系统提示的【写报告】小节）。' +
      'rp-* 组件是一块「调色板」而非「模板」：用哪些、怎么组合、整体什么结构，完全由你按内容自由决定，' +
      '别把所有报告都塞进同一个套路；也可叠加 Tailwind 原子类或自写样式。' +
      'HTML 请给一份完整自包含文档（<!doctype html><html>…），并加入你自己的解读与结尾点评，别只堆数据。' +
      '需要纯文本/便于二次编辑时才用 markdown / text。内容较长、成体系时用本工具，而不是把长文塞进聊天回复。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '报告标题（用作卡片显示名与文件名，简短）' },
        kind: {
          type: 'string',
          enum: ['html', 'markdown', 'text'],
          description: '文件类型，优先 html（Tailwind）',
        },
        content: { type: 'string', description: '文件的完整内容' },
        filename: { type: 'string', description: '可选：期望文件名（不含路径，扩展名可省略）' },
      },
      required: ['title', 'kind', 'content'],
    },
  },
};

/**
 * 助手持久化分桶前缀。每个会话独占一个桶，桶 key 为 `assistant:<sessionId>`；
 * 裸 `assistant`（无后缀）是旧版「单一对话」遗留桶，仅用于一次性迁移。
 */
export const ASSISTANT_AGENT_ID = 'assistant';

/** 新建会话的占位标题；首轮对话后会被模型总结的标题替换。 */
const DEFAULT_SESSION_TITLE = '新对话';

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
  private readonly sessionsPath: string;
  private config: AssistantConfig;
  private sessions: AssistantSession[];

  constructor(
    private readonly rootDir: string,
    private readonly resolveEndpoint: EndpointResolver,
    private readonly usage: TokenUsageStore,
    private readonly conversations: ConversationStore,
    private readonly tools?: AssistantTools,
  ) {
    this.configPath = join(rootDir, 'assistant.json');
    this.sessionsPath = join(rootDir, 'assistant_sessions.json');
    this.config = this.loadConfig();
    this.sessions = this.loadSessions();
    this.migrateLegacyConversation();
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

  // ── 会话管理（多会话：每个会话独立上下文 + 独立持久化桶）──────────────────

  /** 某会话的持久化桶 key。 */
  private bucketId(sessionId: string): string {
    return `${ASSISTANT_AGENT_ID}:${sessionId}`;
  }

  /** 会话列表，按最近活跃倒序（最新在前）。 */
  listSessions(): AssistantSession[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 新建一个空会话并返回（标题待首轮对话后自动总结）。 */
  createSession(): AssistantSession {
    const now = Date.now();
    const session: AssistantSession = { id: randomUUID(), title: DEFAULT_SESSION_TITLE, createdAt: now, updatedAt: now };
    this.sessions.push(session);
    this.persistSessions();
    return session;
  }

  /** 删除会话：移除元数据 + 清掉其对话桶。 */
  deleteSession(sessionId: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.conversations.clear(this.bucketId(sessionId));
    this.persistSessions();
  }

  /** 重命名会话（空标题回退占位标题）。 */
  renameSession(sessionId: string, title: string): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    session.title = title.trim().slice(0, 40) || DEFAULT_SESSION_TITLE;
    session.updatedAt = Date.now();
    this.persistSessions();
  }

  /** 清空某会话的对话内容（保留会话本身，标题复位待重新总结）。 */
  clearConversation(sessionId: string): void {
    this.conversations.clear(this.bucketId(sessionId));
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.title = DEFAULT_SESSION_TITLE;
      session.updatedAt = Date.now();
      this.persistSessions();
    }
  }

  getConversation(sessionId: string): ConversationTurn[] {
    return this.conversations.get(this.bucketId(sessionId));
  }

  // ── 报告文件（write_report 内置工具 + 前端查看/另存为的取址）────────────────

  /** 报告文件落盘目录（账号缓存目录下，懒建）。 */
  private reportsDir(): string {
    const dir = join(this.rootDir, 'reports');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 写一份报告到 reports/，返回可供前端渲染卡片的 {@link AssistantArtifact}。
   * 文件名形如 `<slug>-<uuid>.<ext>`：纯 basename、仅安全字符，故天然过 artifactInfo
   * 的路径校验。kind 非法时兜底成 html。
   */
  private writeReport(args: Record<string, unknown>): AssistantArtifact {
    const kind: ArtifactKind = isArtifactKind(args.kind) ? args.kind : 'html';
    const { ext, mime } = ARTIFACT_KIND[kind];
    const content = typeof args.content === 'string' ? args.content : '';
    if (!content.trim()) throw new Error('report content is empty');

    const title = typeof args.title === 'string' ? args.title : '';
    const filename = typeof args.filename === 'string' ? args.filename : '';
    const base = slug(filename.replace(/\.[^.]+$/, '') || title) || 'report';
    const id = `${base}-${randomUUID()}${ext}`;
    const displayBase = (title.trim() || base).slice(0, 80);

    writeFileSync(join(this.reportsDir(), id), content, 'utf-8');
    return {
      id,
      name: `${displayBase}${ext}`,
      kind,
      mime,
      bytes: Buffer.byteLength(content, 'utf-8'),
    };
  }

  /**
   * 解析一个 artifact id 为本地路径 + 类型，供应用层「查看 / 另存为」使用。
   * 三重校验防目录逃逸：id 必须是纯 basename（无分隔符 / `..`）、解析后仍落在
   * reports/ 内、且文件存在。
   */
  artifactInfo(id: string): { path: string; kind: ArtifactKind; mime: string } {
    if (!id || id !== basename(id)) throw new Error(`非法的报告标识：${id}`);
    const dir = resolve(this.reportsDir());
    const full = resolve(dir, id);
    if (full !== join(dir, id) || !full.startsWith(dir + sep)) {
      throw new Error(`非法的报告标识：${id}`);
    }
    if (!existsSync(full)) throw new Error('报告文件不存在（可能已被清理）。');
    const kind = kindFromExt(id);
    return { path: full, kind, mime: ARTIFACT_KIND[kind].mime };
  }

  /**
   * 处理一条用户消息：多轮调用工具直到给出最终答复。每一步通过 `onStep` 实时吐出。
   * 失败（包括异常）也会作为 `error` step 推出后再抛出，便于前端统一处理。
   */
  async chat(
    sessionId: string,
    text: string,
    onStep?: (step: AssistantStep) => void,
  ): Promise<{ text: string; steps: AssistantStep[] }> {
    if (!this.config.model) throw new Error('请先在助手设置里选择聊天模型。');
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error('对话不存在，请新建一个对话。');

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
      const reply = await this.runLoop(sessionId, text, emit);
      const now = Date.now();
      const toolsUsed = steps.filter((s): s is Extract<AssistantStep, { kind: 'tool_call' }> => s.kind === 'tool_call').map((s) => s.name);
      this.conversations.append(this.bucketId(sessionId), [
        { role: 'user', text, ts: now },
        {
          role: 'assistant',
          text: reply,
          ts: now,
          steps,
          ...(toolsUsed.length ? { toolsUsed: [...new Set(toolsUsed)] } : {}),
        },
      ]);
      // 标题：仍是占位标题（即本会话首轮）时，让模型简单总结对话内容生成标题。
      // 放在 emit(final) 之前完成，前端收到 final 后刷新会话列表即可拿到新标题（无竞态）。
      if (session.title === DEFAULT_SESSION_TITLE) {
        try {
          const title = await this.generateTitle(text, reply);
          if (title) session.title = title;
        } catch {
          /* 标题总结失败不影响对话本身 */
        }
      }
      session.updatedAt = now;
      this.persistSessions();
      emit({ kind: 'final', text: reply });
      return { text: reply, steps };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ kind: 'error', message });
      throw error;
    }
  }

  /**
   * 让模型用一句短语概括对话主题，作为会话标题。轻量调用（无工具、不记账），
   * 失败/为空时返回 ''（上层保留占位标题）。
   */
  private async generateTitle(userText: string, reply: string): Promise<string> {
    if (!this.config.model) return '';
    const endpoint: AgentLabEndpoint = { ...this.resolveEndpoint(this.config.model), kind: 'chat' };
    const data = await this.callApi(
      endpoint,
      [
        {
          role: 'system',
          content:
            '你是会话标题生成器。根据用户与助手的一段对话，用一句不超过 14 个汉字的中文短语概括对话主题，' +
            '只输出标题本身，不要引号、书名号、句号或任何前后缀。',
        },
        { role: 'user', content: `用户：${userText.slice(0, 600)}\n助手：${reply.slice(0, 600)}` },
      ],
      [],
    );
    const raw = pickMessageText(data.choices?.[0]?.message);
    return cleanTitle(raw);
  }

  /** 核心多轮循环：返回最终文本。中途只 emit 过程 step，不 emit final。 */
  private async runLoop(sessionId: string, text: string, emit: (step: AssistantStep) => void): Promise<string> {
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

    const prior = this.conversations.get(this.bucketId(sessionId)).slice(-12);
    const messages: ApiMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      ...prior.map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: text },
    ];

    // write_report 是 service 内置工具（需要 rootDir、要顺手 emit artifact），前置合并；
    // 其余来自应用层注入的内置 AI_TOOLS + 外部 MCP。
    const specs = [WRITE_REPORT_SPEC, ...((await this.tools?.specs()) ?? [])];

    for (let loop = 0; loop < TOOL_LOOP_LIMIT; loop += 1) {
      // 最后一轮强制关闭工具，逼模型给出文字结论，避免"用尽轮数"硬中断。
      const allowTools = specs.length > 0 && loop < TOOL_LOOP_LIMIT - 1;
      const data = await this.callApi(endpoint, messages, allowTools ? specs : []);
      reportUsage(endpoint, data);
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('助手返回为空');

      const content = pickMessageText(msg);

      if (allowTools && msg.tool_calls?.length) {
        // 模型在调用工具前给出的思路 → 作为"思考"展示。
        if (content) emit({ kind: 'thinking', text: content });
        messages.push(msg as ApiMessage);
        for (const call of msg.tool_calls) {
          const args = this.parseArgs(call.function.arguments);
          emit({ kind: 'tool_call', id: call.id, name: call.function.name, args });

          // write_report：service 内部处理 —— 写盘 + emit artifact（卡片）。不 emit
          // tool_result（否则折叠过程里会出现一条与卡片重复的 JSON 预览）；仍 push 一条
          // 简短成功结果给模型，让它知道写成功、拿到文件名。
          if (call.function.name === 'write_report') {
            let toolMsg: string;
            try {
              const artifact = this.writeReport(args);
              emit({ kind: 'artifact', artifact });
              toolMsg = safeStringify({ ok: true, id: artifact.id, name: artifact.name, kind: artifact.kind });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              emit({ kind: 'tool_result', id: call.id, name: call.function.name, ok: false, preview: message });
              toolMsg = safeStringify({ ok: false, error: message });
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: toolMsg });
            continue;
          }

          let result: unknown;
          let ok = true;
          try {
            if (!this.tools) throw new Error(`未知工具：${call.function.name}`);
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
          // 工具若返回 artifactCard（如导出工具的结果文件/文件夹）→ 在聊天里出一张卡片。
          if (ok) {
            const card = extractArtifactCard(result);
            if (card) emit({ kind: 'artifact', artifact: card });
          }
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
      '',
      '【写报告 / 文档】',
      '- 当产出是成体系的长内容（报告、总结、数据清单、人物分析、时间线、可视化网页…）时，用 write_report 工具把它写成本地文件（**优先 kind="html"**），' +
        '用户能在你的回复里「查看」或「另存为」；不要把这种长文整段塞进聊天回复里。',
      '- 渲染环境已内置、开箱即用，**无需写 <style>、无需引任何 CDN**：' +
        '① 本地 Tailwind 运行时（任意 Tailwind 原子类都可用）；' +
        '② 一套报告组件库 class（`rp-*`）。',
      '- ⭐ **这套组件是「调色板」，不是「模板」**：用哪些、用不用、怎么排列组合、整份报告长什么样，' +
        '**完全由你按内容自由决定**。一份人物分析、一条时间线、一次对比、一个核心结论、一块数据看板，本该长得各不相同——' +
        '别把所有报告都套进同一个「头图＋指标卡＋排行榜」的壳子里。让结构去贴合内容，而不是让内容去填模板。',
      '- 可用积木（任选、可只用一两个、也可全不用，自己拿 Tailwind 拼也行）：',
      '  • `rp-page` 整页容器；`rp-hero` 头图（内放 `rp-eyebrow` + `<h1>` + `<p>`）；',
      '  • `rp-grid rp-grid-2/-3/-4` 栅格 + `rp-stat`（`rp-stat-label`/`-value`/`-sub`）指标卡；',
      '  • `rp-section` + `rp-section-title` 分章节；`rp-card` 内容块；',
      '  • `rp-rank` 排行榜：每行 `rp-rank-item`(名称 `rp-rank-name` + 进度条 `rp-rank-bar`>`<span style="--rp-pct:73%">` + 数值 `rp-rank-val`)；',
      '  • `rp-table` 表格（数字单元格加 `rp-num` 右对齐）；`rp-badge` + `-up`/`-down`/`-info`/`-warn` 徽章（配 emoji）；',
      '  • `rp-quote`（内含 `<cite>` 写是谁、大概何时说的）引用原话；`rp-callout` 高亮/解读块；`rp-divider` 分隔线；`rp-footer` 页脚。',
      '  • 时间线 `rp-timeline`>`rp-tl-item`(内放 `rp-tl-time` + 内容)，很适合「活跃日记/今日时间线」；标签云 `rp-chips`>`rp-chip`（话题/高频词）；首字母头像 `rp-ava`（可 `style="--c:#色"`，放成员名前）。',
      '- 📊 **图表**（纯 CSS/内联 SVG，数据由你绑定，照下面语法写就能出图，别引图表库）：',
      '  • 饼/环图 `rp-donut`：`<div class="rp-donut" style="--rp-donut:conic-gradient(#6366f1 0 62%,#f59e0b 0 85%,#e5e7eb 0)"><div class="rp-donut-center"><b>62%</b><small>占比</small></div></div>`，' +
        '配图例 `<div class="rp-legend"><span class="rp-legend-item"><span class="rp-dot" style="--c:#6366f1"></span>我 <b>62%</b></span>…</div>`；单值占比只给两段即可。',
      '  • 柱状图 `rp-bars`：每根 `<div class="rp-bar" style="--rp-h:73%"><span class="rp-bar-fill"></span><span class="rp-bar-val">42</span><span class="rp-bar-label">周一</span></div>`，--rp-h 用「该值/最大值」算百分比。',
      '  • 折线/面积图 `rp-spark`：内放你写的 SVG，`<svg viewBox="0 0 100 40" preserveAspectRatio="none"><polygon class="rp-spark-area" points="0,40 0,28 25,18 50,22 75,9 100,14 100,40"/><polyline class="rp-spark-line" points="0,28 25,18 50,22 75,9 100,14"/></svg>`，点位按数据换算到 viewBox 坐标（y 越小越高）。',
      '- ✨ **艺术字**：封面大字用 `rp-display`（超大渐变标题），行内给某几个字上色用 `rp-gradient-text`，强调短语用 `rp-mark`（荧光笔底）或 `rp-pull`（大号金句引言），文艺感叠 `rp-serif`，小标签用 `rp-kicker`。',
      '- 想更自由：可叠加任意 Tailwind 原子类微调，也可以自己写 <style>；想换主题色，直接覆盖 CSS 变量即可' +
        '（如 `<style>:root{--rp-accent:#e11d48;--rp-accent-2:#f59e0b}</style>` 一句换掉整套配色）。组件库只是省事的起点，不是围栏。',
      '- ⭐ **报告的灵魂是你的洞察，不是数据搬运**：把数字排进格子谁都会，那写死一个生成器就够了，要你做什么？所以每份报告都要：',
      '  • 穿插**你自己的简短总结与解读**——在聊什么、谁最活跃、氛围/趋势有什么变化、有没有值得一提的瞬间；',
      '  • 在合适处（用 `rp-callout` 或你自己排的版式）写**一两句走心、贴合这份数据的点评/金句**，让报告有温度、有记忆点（别套话）。',
      '  • 语气可以活泼、有梗，像一个懂行的朋友在做总结，而不是冷冰冰的数据面板。',
      '- 下面这段**只是演示几个组件怎么写、怎么嵌套**，不是要你照搬它的布局或主题——请按手上的内容重新决定结构：',
      '```html',
      '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>示例</title></head>',
      '<body><div class="rp-page">',
      '  <div class="rp-hero"><div class="rp-eyebrow">小标签</div><h1>大标题</h1><p>副标题：一句你自己的概览/解读。</p></div>',
      '  <div class="rp-grid rp-grid-3">',
      '    <div class="rp-stat"><div class="rp-stat-label">指标名</div><div class="rp-stat-value">1,240</div><div class="rp-stat-sub">附注 <span class="rp-badge rp-badge-up">📈 +18%</span></div></div>',
      '  </div>',
      '  <div class="rp-section"><div class="rp-section-title">某章节</div><div class="rp-card"><div class="rp-rank">',
      '    <div class="rp-rank-item"><span class="rp-rank-name">名称</span><div class="rp-rank-bar"><span style="--rp-pct:100%"></span></div><span class="rp-rank-val">312</span></div>',
      '  </div></div></div>',
      '  <div class="rp-callout">这里放一两句走心、贴合数据的点评。<strong>金句加粗。</strong></div>',
      '  <div class="rp-footer">由 WeQ 助手生成</div>',
      '</div></body></html>',
      '```',
      '- 需要纯文本、便于用户二次编辑时，才用 kind="markdown" 或 "text"。',
      '- 写完报告后，在聊天里用一两句话说明你写了什么（卡片会自动出现，不用你贴文件内容）。',
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

  private loadSessions(): AssistantSession[] {
    try {
      if (!existsSync(this.sessionsPath)) return [];
      const parsed = JSON.parse(readFileSync(this.sessionsPath, 'utf-8'));
      return Array.isArray(parsed) ? (parsed as AssistantSession[]).filter((s) => s && typeof s.id === 'string') : [];
    } catch {
      return [];
    }
  }

  private persistSessions(): void {
    try {
      mkdirSync(dirname(this.sessionsPath), { recursive: true });
      writeFileSync(this.sessionsPath, JSON.stringify(this.sessions), 'utf-8');
    } catch {
      /* 持久化失败不应影响对话本身 */
    }
  }

  /**
   * 旧版「单一对话」（裸 `assistant` 桶）迁移成一个会话——仅当尚无任何会话且旧桶有内容时
   * 触发一次：把旧 turn 搬进新会话桶、清掉旧桶、登记一条「历史对话」会话。
   */
  private migrateLegacyConversation(): void {
    if (this.sessions.length) return;
    const legacy = this.conversations.get(ASSISTANT_AGENT_ID);
    if (!legacy.length) return;
    const now = Date.now();
    const session: AssistantSession = { id: randomUUID(), title: '历史对话', createdAt: now, updatedAt: now };
    this.conversations.append(this.bucketId(session.id), legacy);
    this.conversations.clear(ASSISTANT_AGENT_ID);
    this.sessions.push(session);
    this.persistSessions();
  }
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return value === 'html' || value === 'markdown' || value === 'text';
}

/** 由文件扩展名反推报告类型（artifactInfo 用）；未知扩展兜底成 html。 */
function kindFromExt(name: string): ArtifactKind {
  const ext = extname(name).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.txt') return 'text';
  return 'html';
}

/**
 * 文件名 slug：保留中英文与数字，其余压成连字符。给 write_report 的文件名打底，
 * 既可读又只含安全字符（配合 uuid 保证唯一、纯 basename）。
 */
function slug(text: string): string {
  return text
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * 清洗模型生成的标题：去掉首尾空白、换行、包裹的引号/书名号与结尾标点，截断到 20 字。
 * 结果为空时返回 ''（上层保留占位标题）。
 */
function cleanTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ');
  // 取首行，去掉常见包裹符号与结尾标点。
  t = t.split('\n')[0]!.trim();
  t = t.replace(/^["'“”『』《》「」\s]+|["'“”『』《》「」\s]+$/g, '');
  t = t.replace(/[。.!！?？，,、；;：:]+$/g, '');
  return t.slice(0, 20).trim();
}

/** JSON.stringify，循环引用/异常兜底成字符串。 */
function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
