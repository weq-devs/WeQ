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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, extname, join, resolve, sep } from 'node:path';
import {
  reportUsage,
  pickMessageText,
  type AgentLabEndpoint,
  type AgentLabModelRef,
  type AgentLabUsage,
} from '@weq/agentlab';
import type { TokenUsageStore } from './agentlab_usage';
import type { ConversationStore, ConversationTurn } from './agentlab_conversation';
import { JsonStore } from '../common/json_store';

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
  /**
   * 写报告时随机抽 n 条「一言」候选（句子 + 出处），供模型挑一句做「主题大字」——
   * 让每份报告有个醒目、有格调的封面主题，弱化僵化标题、拉开风格差异。数据在应用层
   * （resources/hitokoto.json），故由应用层注入；缺省则报告小节不出现主题句候选。
   */
  sampleHitokoto?: (n: number) => Array<{ text: string; from: string }>;
}

/** 思考等级（reasoning effort）。映射为 OpenAI 兼容请求的 `reasoning_effort` 参数（`off` = 不带）。 */
export type AssistantReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface AssistantConfig {
  model?: AgentLabModelRef;
  customPrompt?: string;
  /** 思考等级（见 {@link AssistantReasoningEffort}）：非 `off` 时以 `reasoning_effort` 传给模型。 */
  reasoningEffort?: AssistantReasoningEffort;
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
  if (
    card &&
    typeof card.id === 'string' &&
    typeof card.name === 'string' &&
    typeof card.kind === 'string'
  ) {
    return card;
  }
  return null;
}

/**
 * 调查计划（借鉴 WeFlow agentInvestigationPlan）：让模型在开查前先想清楚要查什么、
 * 分几步，执行中随进度更新。前端渲染成顶部计划面板，也随每轮注入模型上下文。
 */
export interface AssistantPlanStep {
  id: string;
  title: string;
  /** 执行中可随进度更新；模型判断某步已达成时标 completed。 */
  status: 'pending' | 'in_progress' | 'completed';
}

export interface AssistantInvestigationPlan {
  title: string;
  /** 模型对问题的理解（一句话）。 */
  question: string;
  steps: AssistantPlanStep[];
}

/** 一轮任务内的调查工作区：计划 + 工作笔记（跨多轮工具调用的短期记忆）。 */
export interface AssistantWorkspace {
  plan?: AssistantInvestigationPlan;
  /** 调查过程中记下的关键事实/待查项/推断，随每轮注入，防止长任务中遗忘早期材料。 */
  notes: string[];
}

/**
 * 一轮任务推进里可观测的一步。前端按 kind 渲染（thinking/工具调用/工具结果可折叠，
 * final 用 Markdown，artifact 渲染成气泡里的附件卡片）。`error`/`aborted` 为终止态。
 *
 * 流式（M2）：正文与推理不再等整段返回，而是逐片以 `text_delta` / `reasoning_delta`
 * 推出（前端累积进气泡 / 思考面板）。`thinking` 仍保留——工具调用前那段思路会作为
 * 一条 thinking 写进 steps[] 持久化（但运行时不重复 emit，正文已由 text_delta 送达）。
 *
 * `plan` / `notes` / `compaction` 是「调查过程」类步骤：
 * - plan：调查计划快照（模型调 update_investigation_plan 后 emit，前端更新顶部计划面板）；
 * - notes：工作笔记快照（模型调 update_work_notes 后 emit）；
 * - compaction：上下文压缩发生标记（含折叠摘要），长会话中早期历史被折叠时 emit。
 */
export type AssistantStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'reasoning_delta'; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: unknown }
  | { kind: 'tool_result'; id: string; name: string; ok: boolean; preview: string }
  | { kind: 'artifact'; artifact: AssistantArtifact }
  | { kind: 'plan'; plan: AssistantInvestigationPlan }
  | { kind: 'notes'; notes: string[] }
  | { kind: 'compaction'; summary: string; foldedTurns: number }
  | { kind: 'final'; text: string }
  | { kind: 'aborted' }
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
      '**务必让风格多元**：给 <body> 挑一款皮肤换背景+配色、开篇换不同 masthead、挑一句「一言」做主题大字（详见系统提示）。' +
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
 * update_investigation_plan / update_work_notes：调查过程的结构化记忆工具。
 *
 * 模型通过它们把「计划」和「读到/确认的关键事实」写进本轮工作区（不落最终答复、
 * 不落会话历史），服务端每轮把最新状态注入模型上下文——解决长任务里模型做完一步
 * 就忘掉早期材料的痛点（借鉴 WeFlow agentInvestigationPlan + research checkpoints）。
 * 只 push 一个简短结果消息回灌模型，不 emit tool_call/tool_result 过程步骤
 * （前端由专用 plan / notes step 渲染成面板，不占聊天过程的视觉重量）。
 */
const WORKSPACE_SPECS: AssistantToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'update_investigation_plan',
      description:
        '（内部记忆，不写入对话）规划或更新你正在进行的调查任务：在动手查之前先想清楚' +
        '要查什么、分几步，执行中随进度更新步骤状态。步骤控制在 3-6 步，每步一句话；' +
        '只在计划创建/整体重排/某步完成时调用，不要为了记录琐碎进展反复调用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '计划标题（简短，如「查小枳壳最近在忙什么」）' },
          question: { type: 'string', description: '对用户问题的理解，一句话' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '稳定 id（沿用已有步骤的 id；新增才造新 id）' },
                title: { type: 'string', description: '这一步要做什么，一句话' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: '进行中 / 待办 / 已完成',
                },
              },
              required: ['id', 'title', 'status'],
            },
          },
        },
        required: ['title', 'question', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_work_notes',
      description:
        '（内部记忆，不写入对话）把你调查过程中读到的关键事实、确认的结论、还需核实的待查项' +
        '记进工作笔记，防止后面忘记。每条一句话、具体（如「小枳壳的 uid=xxx」「3 月 5 日聊过考研」），' +
        '不要记客套话；已记过的不要重复。只在有新信息值得记或需要修正时调用，每次传完整列表。',
      parameters: {
        type: 'object',
        properties: {
          notes: {
            type: 'array',
            items: { type: 'string' },
            description: '完整的工作笔记列表（会整体替换当前笔记），最多 12 条，每条 ≤120 字',
          },
        },
        required: ['notes'],
      },
    },
  },
];

/** 一轮任务的运行时状态（内存态；断点快照是它的持久化投影）。 */
type AssistantRunState = {
  question: string;
  basePrompt: string;
  messages: ApiMessage[];
  workspace: AssistantWorkspace;
  summary: string;
  toolCallCount: number;
};

/**
 * 一轮任务的断点快照（断点续答用）。任务进行中定期落盘，用户停止/异常/进程退出后
 * 可从快照续跑——已完成的工具调用及其结果原样保留，不用重查。
 * `messages` 恒处于「一致」状态：每条 assistant(tool_calls) 都已配齐 tool 结果。
 */
interface AssistantRunSnapshot extends AssistantRunState {
  schemaVersion: 1;
  sessionId: string;
  status: 'running' | 'aborted' | 'completed';
  startedAt: number;
  updatedAt: number;
}

/**
 * 助手持久化分桶前缀。每个会话独占一个桶，桶 key 为 `assistant:<sessionId>`；
 * 裸 `assistant`（无后缀）是旧版「单一对话」遗留桶，仅用于一次性迁移。
 */
export const ASSISTANT_AGENT_ID = 'assistant';

/** 新建会话的占位标题；首轮对话后会被模型总结的标题替换。 */
const DEFAULT_SESSION_TITLE = '新对话';

/** 单轮任务最多调用工具的轮数。任务型 agent 要敢多试，故给得宽一些。 */
const TOOL_LOOP_LIMIT = 24;

/** 单个工具执行的超时上限：到点算失败回灌模型继续，避免某个工具挂住拖死整轮。 */
const TOOL_TIMEOUT_MS = 60_000;
/** 整轮任务（多轮工具调用 + LLM）总时限：超时自动中止并给出可读错误，防前端永久转圈。 */
const RUN_TIMEOUT_MS = 600_000;

// ── 上下文压缩（长会话/多工具循环的 token 预算管理）──────────────────────────
// 借鉴 WeFlow agentContextManager：估算 token → 超阈值触发 → 早期历史折叠成摘要 →
// 摘要随每轮注入 + 落一条 compaction step 供前端展示。只折叠「本轮提问之前的历史」，
// 本轮内的工具过程永远保留（避免破坏 tool_calls/tool 配对）。

/** 默认上下文窗口估算（模型窗口通常 32k~128k，取保守值避免压坏普通模型）。 */
const CONTEXT_WINDOW_DEFAULT = 32_768;
/** 消息 token 估算（中文约 1.5~2 字符/token，英文约 4；取 1.8 折中 + 每条消息开销）。 */
const CHARS_PER_TOKEN = 1.8;
const MESSAGE_OVERHEAD_TOKENS = 6;
/** 达到窗口比例触发压缩。 */
const COMPRESS_TRIGGER_RATIO = 0.7;
/** 压缩目标：折叠后历史+本轮降到窗口比例。 */
const COMPRESS_TARGET_RATIO = 0.5;
/** 压缩后至少保留的「最近完整回合」数（历史侧）。 */
const MIN_RETAINED_ROUNDS = 1;
/** 摘要生成的最大 token（输入侧同样受限）。 */
const MAX_SUMMARY_TOKENS = 1_500;
/** 摘要输入单条消息的最大字符数。 */
const SUMMARY_INPUT_MSG_CHARS = 1_200;
/** 摘要失败时的本地兜底长度。 */
const SUMMARY_FALLBACK_CHARS = 5_000;

/**
 * 证据追问检测：用户是不是在质疑/追问上一条结论的依据（「真的假的 / 有证据吗 / 原话呢 / 为什么这么说」）。
 * 命中且**上一轮助手确实用过工具**时，systemPrompt 会注入一条硬规则：本轮必须重新调工具查证再答，
 * 禁止复述或为旧结论辩护（见 {@link AssistantService.systemPrompt} 的【本轮特别要求】）。
 * 正则借鉴 WeFlow `EVIDENCE_FOLLOW_UP_PATTERN`。
 */
const EVIDENCE_FOLLOW_UP_PATTERN =
  /真的假的|真(?:的)?吗|你确定|确定(?:吗|么)|有(?:什么)?证据|证据(?:呢|在哪|是什么)?|原话|原文|哪句话?|怎么证明|如何证明|依据(?:呢|是什么)?|出处(?:呢|是什么)?|为什么这么说|凭什么|瞎说|乱说|胡说|不对吧|真有|假的吧/i;

/**
 * 判定用户这轮是否「想要一份报告/可视化文档」。命中才把体量约 55 行的 rp-* 报告排版
 * 指南注入 system prompt（见 {@link AssistantService.systemPrompt}）。
 * 宁可少注入也别误伤日常提问：只匹配明确的成品诉求（报告/网页/看板/海报…）与"生成/做/写一份…"结构，
 * 不匹配"总结一下""分析下他"这类既可能只是聊天回答、也可能要报告的模糊表达——那种就让模型自己按
 * 【写报告 / 文档】缺省判断（缺省下模型仍知道有 write_report，只是不带排版细节）。
 */
const REPORT_INTENT_PATTERN =
  /报告|周报|月报|日报|网页|可视化|看板|仪表盘|dashboard|海报|长图|画一?[张份个]|做一?[张份个]|生成一?[张份个]|写一?[份张个](?:.*?)(?:报告|文档|网页|页面|总结|分析)|导出(?:成|为)?(?:报告|文档|网页|html|pdf)|html|排版|封面/i;

/** 单个工具结果回灌给模型 / 落库的字符上限。 */
const TOOL_RESULT_CAP = 8000;
const STEP_PREVIEW_CAP = 4000;

interface ApiMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** OpenAI 兼容流式响应的一片（`data: {...}`）；只声明我们会读的字段。 */
interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: unknown;
}

export class AssistantService {
  private readonly configPath: string;
  private readonly sessionsPath: string;
  /** 配置 / 会话列表的整文件存储（save() 原子落盘，失败静默）。 */
  private readonly configStore: JsonStore<AssistantConfig>;
  private readonly sessionsStore: JsonStore<AssistantSession[]>;

  private get config(): AssistantConfig {
    return this.configStore.data;
  }

  private set config(next: AssistantConfig) {
    this.configStore.data = next;
  }

  private get sessions(): AssistantSession[] {
    return this.sessionsStore.data;
  }

  private set sessions(next: AssistantSession[]) {
    this.sessionsStore.data = next;
  }
  /** provider 若不认 `reasoning_effort`（首次 400）就置真，本进程后续调用不再带该参数。 */
  private reasoningUnsupported = false;

  constructor(
    private readonly rootDir: string,
    private readonly resolveEndpoint: EndpointResolver,
    private readonly usage: TokenUsageStore,
    private readonly conversations: ConversationStore,
    private readonly tools?: AssistantTools,
  ) {
    this.configPath = join(rootDir, 'assistant.json');
    this.sessionsPath = join(rootDir, 'assistant_sessions.json');
    this.configStore = new JsonStore(this.configPath, () => ({}), {
      pretty: true,
      normalize: (raw) => (raw && typeof raw === 'object' ? (raw as AssistantConfig) : {}),
    });
    this.sessionsStore = new JsonStore(this.sessionsPath, () => [], {
      normalize: (raw) =>
        Array.isArray(raw)
          ? (raw as AssistantSession[]).filter((s) => s && typeof s.id === 'string')
          : [],
    });
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
      customPrompt:
        patch.customPrompt !== undefined ? patch.customPrompt : this.config.customPrompt,
      reasoningEffort:
        patch.reasoningEffort !== undefined ? patch.reasoningEffort : this.config.reasoningEffort,
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
    const session: AssistantSession = {
      id: randomUUID(),
      title: DEFAULT_SESSION_TITLE,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.push(session);
    this.persistSessions();
    return session;
  }

  /** 删除会话：移除元数据 + 清掉其对话桶 + 清理断点快照。 */
  deleteSession(sessionId: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.conversations.clear(this.bucketId(sessionId));
    this.clearRun(sessionId);
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

  /** 清空某会话的对话内容（保留会话本身，标题复位待重新总结），并作废未完成的断点任务。 */
  clearConversation(sessionId: string): void {
    this.conversations.clear(this.bucketId(sessionId));
    this.clearRun(sessionId);
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
   * 若该会话存在未完成的断点快照（上次中断的任务），新消息会**取代**它（快照作废）。
   */
  async chat(
    sessionId: string,
    text: string,
    onStep?: (step: AssistantStep) => void,
    signal?: AbortSignal,
  ): Promise<{ text: string; steps: AssistantStep[] }> {
    if (!this.config.model) throw new Error('请先在助手设置里选择聊天模型。');
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error('对话不存在，请新建一个对话。');

    const steps: AssistantStep[] = [];
    // 累积「当前可见正文」：用户点停止时用它作为已完成的部分答复持久化。
    // 一批工具调用开始（tool_call）意味着此前那段正文已转为「思考」，故清零重来。
    let streamed = '';
    const emit = (step: AssistantStep): void => {
      if (step.kind === 'text_delta') streamed += step.text;
      else if (step.kind === 'tool_call') streamed = '';
      steps.push(step);
      try {
        onStep?.(step);
      } catch {
        /* 前端推送失败不应中断任务 */
      }
    };
    // 仅持久化、不再实时推送：正文/推理已通过 *_delta 到达前端，这里只补一条汇总 step 供重载回看。
    const record = (step: AssistantStep): void => {
      steps.push(step);
    };
    // text_delta / reasoning_delta 是逐字碎片，不入库（会重复且臃肿）；落库只保留过程性 step。
    const persistable = (): AssistantStep[] =>
      steps.filter((s) => s.kind !== 'text_delta' && s.kind !== 'reasoning_delta');
    const collectToolsUsed = (): string[] => [
      ...new Set(
        steps
          .filter((s): s is Extract<AssistantStep, { kind: 'tool_call' }> => s.kind === 'tool_call')
          .map((s) => s.name),
      ),
    ];

    // 新问题取代旧任务：丢弃该会话任何未完成的 run 快照（resume 只针对「同一任务」）。
    this.clearRun(sessionId);
    // 只取最近若干条历史（过长的历史由上下文压缩在 runLoop 内折叠，而不是硬切）。
    const prior = this.conversations.get(this.bucketId(sessionId)).slice(-12);
    // 证据追问：本轮像在质疑上一结论，且上一条助手回复确实用过工具时，才强制重新查证。
    // （像开场就问「真的假的」这种没有可查证对象，强制反而诱导模型编造，故要求 prior 用过工具。）
    const lastAssistant = [...prior].reverse().find((t) => t.role === 'assistant');
    const evidenceFollowUp =
      EVIDENCE_FOLLOW_UP_PATTERN.test(text) && !!lastAssistant?.toolsUsed?.length;
    const basePrompt = this.systemPrompt(text, evidenceFollowUp);
    const state: AssistantRunState = {
      question: text,
      basePrompt,
      messages: [
        { role: 'system', content: basePrompt },
        ...prior.map((t) => ({ role: t.role, content: t.text })),
        { role: 'user', content: text },
      ],
      workspace: { notes: [] },
      summary: '',
      toolCallCount: 0,
    };

    try {
      const reply = await this.runLoop(sessionId, state, emit, record, signal);
      // 正常完成 → 断点快照已无意义，清掉。
      this.clearRun(sessionId);
      const now = Date.now();
      const toolsUsed = collectToolsUsed();
      this.conversations.append(this.bucketId(sessionId), [
        { role: 'user', text, ts: now },
        {
          role: 'assistant',
          text: reply,
          ts: now,
          steps: persistable(),
          ...(toolsUsed.length ? { toolsUsed } : {}),
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
      // 用户取消：把已流出的半截正文当作本轮答复持久化（保持 user/assistant 成对、不留悬空 user），
      // 正常返回而非抛错——这不是失败。同时保存断点快照供「继续回答」。
      const aborted = signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      if (aborted) {
        const now = Date.now();
        const reply = streamed.trim() || '（已停止）';
        const toolsUsed = collectToolsUsed();
        this.conversations.append(this.bucketId(sessionId), [
          { role: 'user', text, ts: now },
          {
            role: 'assistant',
            text: reply,
            ts: now,
            steps: persistable(),
            ...(toolsUsed.length ? { toolsUsed } : {}),
          },
        ]);
        session.updatedAt = now;
        this.persistSessions();
        this.persistRun(sessionId, state, 'aborted');
        emit({ kind: 'aborted' });
        return { text: reply, steps };
      }
      // 其它异常：同样保留现场快照（用户可「继续回答」重试），再报错。
      this.persistRun(sessionId, state, 'aborted');
      const message = error instanceof Error ? error.message : String(error);
      emit({ kind: 'error', message });
      throw error;
    }
  }

  /**
   * 断点续答：从该会话上次中断（用户停止 / 异常 / 进程退出）留下的快照继续跑，
   * 已完成的工具调用与其结果原样保留，不重查。完成后把会话里那条半截 assistant
   * 回合替换成完整答复。无可用快照时抛可读错误。
   */
  async resumeAssistantRun(
    sessionId: string,
    onStep?: (step: AssistantStep) => void,
    signal?: AbortSignal,
  ): Promise<{ text: string; steps: AssistantStep[] }> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error('对话不存在，请新建一个对话。');
    const snapshot = this.loadRun(sessionId);
    if (!snapshot || snapshot.status === 'completed' || snapshot.messages.length < 2) {
      throw new Error('没有可继续的任务。');
    }

    const steps: AssistantStep[] = [];
    let streamed = '';
    const emit = (step: AssistantStep): void => {
      if (step.kind === 'text_delta') streamed += step.text;
      else if (step.kind === 'tool_call') streamed = '';
      steps.push(step);
      try {
        onStep?.(step);
      } catch {
        /* 前端推送失败不应中断任务 */
      }
    };
    const record = (step: AssistantStep): void => {
      steps.push(step);
    };
    const persistable = (): AssistantStep[] =>
      steps.filter((s) => s.kind !== 'text_delta' && s.kind !== 'reasoning_delta');
    const state: AssistantRunState = {
      question: snapshot.question,
      basePrompt: snapshot.basePrompt,
      messages: snapshot.messages,
      workspace: snapshot.workspace,
      summary: snapshot.summary,
      toolCallCount: snapshot.toolCallCount,
    };

    try {
      record({
        kind: 'thinking',
        text: `（已从中断处继续，保留 ${snapshot.toolCallCount} 次已完成工具调用，正在收尾调查…）`,
      });
      const reply = await this.runLoop(sessionId, state, emit, record, signal);
      this.clearRun(sessionId);
      const now = Date.now();
      const toolsUsed = [
        ...new Set(
          steps
            .filter(
              (s): s is Extract<AssistantStep, { kind: 'tool_call' }> => s.kind === 'tool_call',
            )
            .map((s) => s.name),
        ),
      ];
      // 替换最后一条（半截）assistant 回合为完整答复，而不是追加一条重复的。
      this.conversations.patchLastAssistant(this.bucketId(sessionId), {
        text: reply,
        steps: persistable(),
        ...(toolsUsed.length ? { toolsUsed } : {}),
      });
      session.updatedAt = now;
      this.persistSessions();
      emit({ kind: 'final', text: reply });
      return { text: reply, steps };
    } catch (error) {
      const aborted = signal?.aborted || (error instanceof Error && error.name === 'AbortError');
      if (aborted) {
        const reply = streamed.trim() || '（已停止）';
        this.conversations.patchLastAssistant(this.bucketId(sessionId), {
          text: reply,
          steps: persistable(),
        });
        session.updatedAt = Date.now();
        this.persistSessions();
        this.persistRun(sessionId, state, 'aborted');
        emit({ kind: 'aborted' });
        return { text: reply, steps };
      }
      this.persistRun(sessionId, state, 'aborted');
      const message = error instanceof Error ? error.message : String(error);
      emit({ kind: 'error', message });
      throw error;
    }
  }

  /** 该会话是否存在可继续的任务（前端据此显示「继续回答」）。 */
  getResumeState(sessionId: string): {
    resumable: boolean;
    question?: string;
    toolCallCount?: number;
  } {
    const snapshot = this.loadRun(sessionId);
    if (!snapshot || snapshot.status === 'completed' || snapshot.messages.length < 2) {
      return { resumable: false };
    }
    return {
      resumable: true,
      question: snapshot.question,
      toolCallCount: snapshot.toolCallCount,
    };
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

  /**
   * 核心多轮循环：返回最终文本。中途正文/推理走 `emit`（*_delta 流式），工具调用前的思路
   * 走 `record`（只落库、不重复推）。`signal` 在每轮与每次工具调用前检查以尽早取消。
   *
   * `state.messages` 是运行时上下文兼断点快照的数据源（每完成一批工具调用就落盘一次）；
   * 动态注入段（调查计划/工作笔记/会话摘要）不写进 state.messages，只在每轮发送前拼进
   * system 消息——resume 后这些状态从快照恢复，照样注入。
   */
  private async runLoop(
    sessionId: string,
    state: AssistantRunState,
    emit: (step: AssistantStep) => void,
    record: (step: AssistantStep) => void,
    signal?: AbortSignal,
  ): Promise<string> {
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

    // write_report 是 service 内置工具（需要 rootDir、要顺手 emit artifact）；
    // update_investigation_plan / update_work_notes 是调查过程的内置记忆工具；
    // 其余来自应用层注入的内置 AI_TOOLS + 外部 MCP。
    const specs = [WRITE_REPORT_SPEC, ...WORKSPACE_SPECS, ...((await this.tools?.specs()) ?? [])];

    // 组合取消源：把「外部 signal（用户点停止）」与「整轮总超时」合流到一个内部 controller。
    // 全程只把 ac.signal 传给下游（LLM 请求 / throwIfAborted）——任一触发都能尽早收尾。
    // timedOut 标记用于把总超时与用户主动取消区分开：超时转成普通 Error 走 chat() 的 error 分支
    // （给可读提示），用户取消则保持 AbortError 走 aborted 分支（留半截答复）。
    const ac = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => ac.abort();
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', onExternalAbort);
    }
    const runTimer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, RUN_TIMEOUT_MS);

    try {
      for (let loop = 0; loop < TOOL_LOOP_LIMIT; loop += 1) {
        throwIfAborted(ac.signal);
        // 每轮发送前先做上下文压缩（长会话/多工具循环的 token 预算管理）。
        await this.compressIfNeeded(state, endpoint, emit, ac.signal);
        const roundMessages = this.buildRoundMessages(state);
        // 最后一轮强制关闭工具，逼模型给出文字结论，避免"用尽轮数"硬中断。
        const allowTools = specs.length > 0 && loop < TOOL_LOOP_LIMIT - 1;
        const { content, toolCalls } = await this.callApiStream(
          endpoint,
          roundMessages,
          allowTools ? specs : [],
          emit,
          ac.signal,
        );

        if (allowTools && toolCalls?.length) {
          // 模型在调用工具前给出的思路 → 已随 text_delta 流式到达前端；这里只补一条 thinking 落库。
          if (content) record({ kind: 'thinking', text: content });
          state.messages.push({ role: 'assistant', content, tool_calls: toolCalls });
          for (const call of toolCalls) {
            throwIfAborted(ac.signal);
            const args = this.parseArgs(call.function.arguments);

            // 调查过程记忆工具：更新 workspace + emit plan/notes step（前端渲染专用面板），
            // 只回灌简短成功消息。不占聊天过程的视觉重量，也不写进最终答复。
            if (
              call.function.name === 'update_investigation_plan' ||
              call.function.name === 'update_work_notes'
            ) {
              const handled = this.handleWorkspaceTool(
                call.function.name,
                args,
                state.workspace,
                emit,
              );
              state.messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: safeStringify(handled),
              });
              continue;
            }

            emit({ kind: 'tool_call', id: call.id, name: call.function.name, args });

            // write_report：service 内部处理 —— 写盘 + emit artifact（卡片）。不 emit
            // tool_result（否则折叠过程里会出现一条与卡片重复的 JSON 预览）；仍 push 一条
            // 简短成功结果给模型，让它知道写成功、拿到文件名。
            if (call.function.name === 'write_report') {
              let toolMsg: string;
              try {
                const artifact = this.writeReport(args);
                emit({ kind: 'artifact', artifact });
                toolMsg = safeStringify({
                  ok: true,
                  id: artifact.id,
                  name: artifact.name,
                  kind: artifact.kind,
                });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                emit({
                  kind: 'tool_result',
                  id: call.id,
                  name: call.function.name,
                  ok: false,
                  preview: message,
                });
                toolMsg = safeStringify({ ok: false, error: message });
              }
              state.messages.push({ role: 'tool', tool_call_id: call.id, content: toolMsg });
              continue;
            }

            let result: unknown;
            let ok = true;
            try {
              if (!this.tools) throw new Error(`未知工具：${call.function.name}`);
              // 单工具超时：到点抛可读错误落进下面 catch → ok:false 回灌模型继续，不拖死整轮。
              result = await withTimeout(
                this.tools.run(call.function.name, args),
                TOOL_TIMEOUT_MS,
                `工具 ${call.function.name} 执行`,
              );
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
            // 回灌模型：智能截断（数组截条数并提示翻页，退化才字符硬切）——保证喂给模型的始终是合法 JSON。
            state.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: capToolResult(result),
            });
            state.toolCallCount += 1;
          }
          // 一批工具调用全部完成、消息数组处于一致状态 → 落盘断点快照。
          this.persistRun(sessionId, state, 'running');
          continue;
        }

        // 没有工具调用 → 这就是最终答复（正文已随 text_delta 流式送达前端）。
        return content || '（没能得出结论，请换个问法或补充信息。）';
      }
      // 理论上到不了这里（最后一轮已关工具强制出文本）。
      return '（任务推进超过最大轮数，已中止。）';
    } catch (error) {
      // 总超时：外部 signal 未被用户 abort，但内部 ac 因 runTimer 触发。转成普通 Error（name≠AbortError）
      // 让 chat() 走 error 分支给出清晰提示；用户主动停止则原样抛（AbortError）走 aborted 分支。
      if (timedOut && !signal?.aborted) {
        throw new Error('任务运行超过 10 分钟总时限，已自动中止。可缩小时间范围、拆分问题后重试。');
      }
      throw error;
    } finally {
      clearTimeout(runTimer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** 每轮发送前的消息组装：把动态注入段（摘要 + 调查计划/工作笔记）拼进 system。 */
  private buildRoundMessages(state: AssistantRunState): ApiMessage[] {
    const blocks: string[] = [];
    if (state.summary) blocks.push(summaryBlock(state.summary));
    const ws = workspaceBlock(state.workspace);
    if (ws) blocks.push(ws);
    return [
      {
        role: 'system',
        content: blocks.length ? `${state.basePrompt}\n\n${blocks.join('\n\n')}` : state.basePrompt,
      },
      ...state.messages.slice(1),
    ];
  }

  /**
   * 上下文压缩（借鉴 WeFlow agentContextManager）：估算 token 超阈值时，把本轮提问之前
   * 的早期历史折叠成摘要（LLM 生成，失败本地兜底），随每轮注入 + 落一条 compaction step。
   * 只折叠完整回合（不切断 tool_calls/tool 配对），且保留最近至少 1 轮历史与全部本轮内容。
   */
  private async compressIfNeeded(
    state: AssistantRunState,
    endpoint: AgentLabEndpoint,
    emit: (step: AssistantStep) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const messages = state.messages;
    const totalTokens = estimateMessagesTokens(messages);
    const triggerTokens = Math.floor(CONTEXT_WINDOW_DEFAULT * COMPRESS_TRIGGER_RATIO);
    if (totalTokens <= triggerTokens) return;

    const rounds = foldableRounds(messages);
    if (rounds.length <= MIN_RETAINED_ROUNDS) return; // 没有可折叠的历史（只剩最近一轮/本轮）。
    const foldableCount = rounds.length - MIN_RETAINED_ROUNDS;
    const targetTokens = Math.floor(CONTEXT_WINDOW_DEFAULT * COMPRESS_TARGET_RATIO);
    const foldedRanges: Array<[number, number]> = [];
    let foldedTokens = 0;
    for (let i = 0; i < foldableCount; i += 1) {
      const [s, e] = rounds[i]!;
      foldedRanges.push([s, e]);
      foldedTokens += estimateMessagesTokens(messages.slice(s, e));
      if (totalTokens - foldedTokens <= targetTokens) break;
    }
    if (foldedRanges.length === 0) return;

    const foldedText = renderFoldableMessages(
      messages,
      foldedRanges,
      Math.min(120_000, Math.floor(CONTEXT_WINDOW_DEFAULT * 1.5)),
    );
    // 旧摘要一并喂给模型，让它综合（旧摘要 + 新折叠内容 → 一份新摘要）。
    const userContent = [
      state.summary ? `较早的摘要（保留要点，可合并）：\n${state.summary.slice(0, 4_000)}` : '',
      `需要折叠的对话记录：\n${foldedText}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    let summary = '';
    try {
      const data = await this.callApi(
        endpoint,
        [
          { role: 'system', content: summarySystemPrompt() },
          { role: 'user', content: userContent },
        ],
        [],
        { maxTokens: MAX_SUMMARY_TOKENS },
      );
      summary = pickMessageText(data.choices?.[0]?.message).trim().slice(0, 5_000);
    } catch {
      /* 摘要失败走本地兜底 */
    }
    if (!summary) summary = fallbackSummary(state.summary, foldedText);

    // 折叠区间是连续前缀 [1, lastFoldedEnd)：替换为新摘要，保留最近的历史轮 + 本轮。
    const lastFoldedEnd = foldedRanges[foldedRanges.length - 1]![1];
    state.messages = [messages[0]!, ...messages.slice(lastFoldedEnd)];
    state.summary = summary;
    emit({ kind: 'compaction', summary, foldedTurns: foldedRanges.length });
    throwIfAborted(signal); // 摘要生成期间用户可能已停止。
  }

  /** 处理调查过程记忆工具：更新 workspace + emit 专用 step。返回回灌给模型的简短结果。 */
  private handleWorkspaceTool(
    name: string,
    args: Record<string, unknown>,
    workspace: AssistantWorkspace,
    emit: (step: AssistantStep) => void,
  ): { ok: true } {
    if (name === 'update_investigation_plan') {
      const plan = normalizePlan(args);
      if (plan) {
        workspace.plan = plan;
        emit({ kind: 'plan', plan });
      }
      return { ok: true };
    }
    const notes = normalizeNotes(args);
    if (notes) {
      workspace.notes = notes;
      emit({ kind: 'notes', notes });
    }
    return { ok: true };
  }

  // ── 断点快照（断点续答）──────────────────────────────────────────────────

  /** 快照路径：sessionId 是 uuid，再兜一层安全化（防目录逃逸）。 */
  private runSnapshotPath(sessionId: string): string {
    const safe = String(sessionId || '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 120);
    return join(this.rootDir, 'assistant_runs', `${safe}.json`);
  }

  /** 把当前任务状态落盘为断点快照（原子写：tmp + rename）。失败静默——不能拖慢主流程。 */
  private persistRun(
    sessionId: string,
    state: AssistantRunState,
    status: 'running' | 'aborted',
  ): void {
    try {
      const dir = join(this.rootDir, 'assistant_runs');
      mkdirSync(dir, { recursive: true });
      const target = this.runSnapshotPath(sessionId);
      const previous = this.loadRun(sessionId);
      const snapshot: AssistantRunSnapshot = {
        schemaVersion: 1,
        sessionId,
        status,
        question: state.question,
        basePrompt: state.basePrompt,
        messages: state.messages,
        workspace: state.workspace,
        summary: state.summary,
        toolCallCount: state.toolCallCount,
        startedAt: previous?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
      try {
        renameSync(tmp, target);
      } catch {
        // 个别平台 rename 偶发失败时直接覆盖。
        if (existsSync(tmp)) unlinkSync(tmp);
        writeFileSync(target, JSON.stringify(snapshot), 'utf-8');
      }
    } catch {
      /* 断点快照写失败不影响本轮运行 */
    }
  }

  private loadRun(sessionId: string): AssistantRunSnapshot | null {
    try {
      const target = this.runSnapshotPath(sessionId);
      if (!existsSync(target)) return null;
      const raw = JSON.parse(readFileSync(target, 'utf-8')) as AssistantRunSnapshot;
      if (
        !raw ||
        raw.sessionId !== sessionId ||
        !Array.isArray(raw.messages) ||
        raw.messages.length < 2
      ) {
        return null;
      }
      return {
        ...raw,
        workspace:
          raw.workspace && typeof raw.workspace === 'object'
            ? {
                plan: raw.workspace.plan,
                notes: Array.isArray(raw.workspace.notes) ? raw.workspace.notes : [],
              }
            : { notes: [] },
      };
    } catch {
      return null;
    }
  }

  private clearRun(sessionId: string): void {
    try {
      unlinkSync(this.runSnapshotPath(sessionId));
    } catch {
      /* 不存在即空 */
    }
  }

  private systemPrompt(userText = '', evidenceFollowUp = false): string {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    // 报告排版指南（rp-* 那一大段）只在用户这轮确有「写报告/网页/看板」意图时才注入，
    // 否则整段剔除：省 token，也避免几十行排版细节稀释调查方法论指令。
    const wantsReport = REPORT_INTENT_PATTERN.test(userText);
    // 随机抽一批「一言」候选（每轮重抽 → 候选池天然变化 → 报告主题句天然多元）。
    const verses = wantsReport ? (this.tools?.sampleHitokoto?.(8) ?? []) : [];
    const verseBlock = verses.length
      ? verses.map((v, i) => `  ${i + 1}. ${v.text}${v.from ? `　—— ${v.from}` : ''}`).join('\n')
      : '';
    return [
      '你是 WeQ 助手，运行在用户的 QQ 客户端里，是一个**任务执行者**：你的职责是亲自把用户的问题查清楚、把任务做完，而不是告诉用户"你可以自己去搜索/查看"。',
      `今天是 ${dateStr}。涉及"哪天/什么时候"等时间问题时，结合聊天记录里的日期与今天推算。`,
      // 证据追问命中：置顶一条硬规则，强制本轮重新取证，压住"复述旧结论/嘴硬辩护"的倾向。
      evidenceFollowUp
        ? '\n⚠️【本轮特别要求：这是对上一条结论的证据追问】\n' +
          '用户在质疑你上一条回答的依据。**本轮必须先重新调用工具查证，再作答**，禁止直接复述或为上一段结论辩护。' +
          '从上一条结论里挑出人名/事件/日期/关键词去检索（用 inspect_timeline / get_messages / get_messages_by_date / search_messages 等），' +
          '别拿"真的假的/有没有证据"这类追问原话当搜索词。' +
          '查证后：能坐实就补上真实原话（谁、何时说的）；查不到支持内容就**老实说这轮没查到能支持该说法的原话，并撤回或降级上一结论**——绝不坚称它存在。'
        : '',
      '',
      '【工作方式】',
      '- 把用户的每个问题都当成一个需要主动完成的任务，需要数据就调用工具，能查就查，别把活儿甩回给用户。',
      '- 提到某个人名/群名（如"小枳壳"）时，先用 find_contact 把名字解析成会话（私聊对方 uid 或群号），再用 get_messages / search_messages 在该会话里查；不要把人名本身当关键词去全文搜索。',
      '- search_messages 一次没命中，要换同义词/更短的关键词/不同 scope 多试几次；也可以直接 get_messages 把相关会话最近的消息读出来自己判断。',
      '- 群里找某个人的发言：先 find_contact 或 list_group_members 把昵称解析成 uid，再定位。',
      '- 多轮推进：每一步先想清楚下一步查什么，再调用工具；拿到结果后据此决定继续查还是作答。',
      '- 只有在合理地尝试过多种方式仍查不到时，才如实说明"没找到"，并简要说明你已经查过的范围，给出可能的下一步建议。绝不编造不存在的信息。',
      '',
      '【调查方法论】（关系/人物/结论类问题必须遵守，避免"看几句话就下判断"）',
      '- **引用 vs 推断分离**：工具返回的原话只能证明它字面直接支持的事实；任何关系亲疏、态度、动机、情绪的判断都属于你的推断，要另起一句标成"我的推断是……"，并说明依据与不确定性，别把推断当既定事实陈述。',
      '- **原话必须真实**：引用的每一句都必须严格来自某次工具返回的内容，标清是谁、大概何时说的；字段缺失就写"未知"，绝不凭印象补造原话，也不得声称看过工具没返回的消息。',
      '- **工具结果只是线索，不是结论**：rank_friends_by_activity / rank_my_groups_by_activity / get_period_overview / list_* 这类排行与聚合只提供"从哪查"的候选和方向，不能代替原文；要坐实一个具体结论，必须再用 inspect_timeline + get_messages / search_messages 读到真实原话核验。',
      '- **累计消息量 ≠ 关系最好**：消息条数多只代表历史互动体量大。判断"最亲密/最重要/最疏远/谁在升温降温"要综合最近是否仍活跃、90 天变化、最后联系时间、谁更常主动、沉默前后的真实内容，别拿单一排行下断言。多人里选情感候选时，至少对 2-3 个不同候选分别跑 inspect_timeline 并读到原文再比较，别用同一人反复调用冒充多方核对。',
      '- **信息不足就继续查**：每次拿到工具结果先看它的 range / coverage / hasMore / hint——覆盖不全或还有下一页就换关键词、翻页、换时间段或换工具补查，直到足以可靠回答；确实到头仍不完整，就在结论里明确降低强度、说清局限，而不是硬下定论。',
      '- **面对追问（真的假的 / 有证据吗 / 原话呢 / 为什么这么说）**：这一轮必须重新调工具查证再答，禁止复述或为上一段结论辩护；从上一结论里挑姓名/事件/日期/关键词去检索，别拿"真的假的"这类追问原句当搜索词。已经展示过的原话不算本轮新证据；查不到支持内容就直说"这轮没查到能支持该说法的原话"，并撤回或降级上一结论，绝不坚称它存在。',
      '- **认错要分清责任**：被质疑判断错时，区分是"工具确实返回错了"、"工具覆盖范围有限没查全"、还是"我自己取证不足/权重判断错了"。除非工具输出与事实矛盾，别把锅甩给工具；指出当时漏看的时间尺度或候选，本轮重新核验后再修正结论。',
      '',
      '【回答格式】',
      '- 最终答复用 **Markdown**：可用标题、要点列表、引用（> 原话）、必要时表格或代码块，让结论一眼可读。',
      '- 引用聊天记录原文时用引用块，并尽量带上是谁、大概什么时候说的。',
      '- 简洁、直接给结论，不要复述工具调用过程（过程前端会单独展示）。',
      '',
      // 报告排版指南（rp-* 皮肤/组件/图表/艺术字约 55 行）体量很大，只在这轮确有写报告
      // 意图时才注入；平时整段以空数组 spread 出去，既省 token 又不稀释上面的调查方法论。
      ...(wantsReport
        ? [
            '【写报告 / 文档】',
            '- 当产出是成体系的长内容（报告、总结、数据清单、人物分析、时间线、可视化网页…）时，用 write_report 工具把它写成本地文件（**优先 kind="html"**），' +
              '用户能在你的回复里「查看」或「另存为」；不要把这种长文整段塞进聊天回复里。',
            '- 渲染环境已内置、开箱即用，**无需写 <style>、无需引任何 CDN**：' +
              '① 本地 Tailwind 运行时（任意 Tailwind 原子类都可用）；' +
              '② 一套报告组件库 class（`rp-*`）；' +
              '③ 一组「皮肤」——给 `<body>` 挂一个 class 就换掉整份报告的背景与主色。',
            '- ⭐ **这套组件是「调色板」，不是「模板」**：用哪些、用不用、怎么排列组合、整份报告长什么样，' +
              '**完全由你按内容自由决定**。一份人物分析、一条时间线、一次对比、一个核心结论、一块数据看板，本该长得各不相同——' +
              '别把所有报告都套进同一个「头图＋指标卡＋排行榜」的壳子里。让结构去贴合内容，而不是让内容去填模板。',
            '- 🎨 **换肤（背景 + 主色）**：给 `<body>` 挂一个皮肤 class，整份报告的背景与配色随之改变。' +
              '**每份报告按主题/心情选一款，别老用默认靛紫**：' +
              '`rp-aurora`(靛紫·默认) `rp-rose`(玫瑰暖) `rp-emerald`(青翠) `rp-ocean`(海蓝) `rp-sunset`(落日橙粉) ' +
              '`rp-grape`(葡萄紫) `rp-mono`(灰度杂志) `rp-paper`(米色纸感·文艺) `rp-midnight`(深蓝暗色) `rp-ink`(近黑暗色)。' +
              '可再叠一层纹理：`rp-pat-dots`(点阵) / `rp-pat-grid`(网格) / `rp-pat-rays`(光晕)。' +
              '想微调，直接覆盖 `--rp-accent` 等变量。如 `<body class="rp-paper rp-pat-dots">`。',
            '- 🏷️ **开篇（masthead）也别千篇一律**：四选一或自由发挥——' +
              '`rp-hero`(渐变色块·热闹) / `rp-masthead`(杂志式·细线+衬线大标题·克制) / ' +
              '`rp-cover`(整屏居中封面·最适合放主题句大字) / `rp-band`(极简·左侧粗边框)。报告标题的重要性不高，别让它占据全部视觉重量。',
            verseBlock
              ? '- ✨ **主题句（一言）—— 报告的「大字」主题**：与其堆一个僵硬标题，不如挑一句有格调的话做封面级大字，' +
                '让报告一眼有记忆点、有情绪。下面是随机候选，**挑一句最贴合本报告主题/心情的**（也可不用、或自拟金句）：\n' +
                verseBlock +
                '\n  用 `rp-verse` 渲染，叠不同修饰换风格（务必每份报告都换一种组合，别定式）：' +
                '`rp-verse-serif`(衬线文艺) `rp-verse-grad`(渐变大字) `rp-verse-outline`(描边空心) ' +
                '`rp-verse-center`(居中) `rp-verse-mark`(前置大引号) `rp-verse-vert`(左竖条) `rp-verse-card`(卡片承托)；' +
                '句子放 `<p class="rp-verse-text">`、出处放 `<span class="rp-verse-from">—— 出处</span>`。' +
                '例：`<div class="rp-verse rp-verse-serif rp-verse-mark"><p class="rp-verse-text">句子…</p><span class="rp-verse-from">—— 出处</span></div>`，' +
                '很适合放进 `rp-cover` 当封面主角。'
              : '',
            '- 可用积木（任选、可只用一两个、也可全不用，自己拿 Tailwind 拼也行）：',
            '  • `rp-page` 整页容器；开篇用上面四种 masthead 之一（`rp-hero` 头图内放 `rp-eyebrow` + `<h1>` + `<p>`）；主题句用 `rp-verse` 系列；',
            '  • `rp-grid rp-grid-2/-3/-4` 栅格 + `rp-stat`（`rp-stat-label`/`-value`/`-sub`）指标卡；',
            '  • `rp-section` + `rp-section-title` 分章节；`rp-card` 内容块；',
            '  • `rp-rank` 排行榜：每行 `rp-rank-item`(名称 `rp-rank-name` + 进度条 `rp-rank-bar`>`<span style="--rp-pct:73%">` + 数值 `rp-rank-val`)；',
            '  • `rp-table` 表格（数字单元格加 `rp-num` 右对齐）；`rp-badge` + `-up`/`-down`/`-info`/`-warn` 徽章（配 emoji）；',
            '  • `rp-quote`（内含 `<cite>` 写是谁、大概何时说的）引用原话；`rp-callout` 高亮/解读块；`rp-divider` 分隔线；`rp-footer` 页脚。',
            '  • 时间线 `rp-timeline`>`rp-tl-item`(内放 `rp-tl-time` + 内容)，很适合「活跃日记/今日时间线」；标签 `rp-chips`>`rp-chip`（话题/标签）；首字母头像 `rp-ava`（可 `style="--c:#色"`，放成员名前）。',
            '  • 词云 `rp-cloud`：每个热词一个 `<span class="rp-cloud-word" style="--rp-w:0.8">词</span>`，`--rp-w` 用「该词频/最高词频」算 0~1，自动缩放字号与浓淡（可加 `--c:#色` 单独换色）。get_group_activity 返回的 wordCloud 直接拿来用。',
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
            '<body class="rp-ocean rp-pat-dots"><div class="rp-page">',
            '  <div class="rp-masthead"><span class="rp-kicker">小标签</span><h1>大标题</h1><p>副标题：一句你自己的概览/解读。</p></div>',
            '  <div class="rp-verse rp-verse-serif rp-verse-mark"><p class="rp-verse-text">一句贴合主题的话。</p><span class="rp-verse-from">—— 出处</span></div>',
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
          ]
        : []),
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
    options: { maxTokens?: number } = {},
  ): Promise<{ choices?: Array<{ message?: ApiMessage }>; usage?: unknown }> {
    const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        temperature: 0.3,
        messages,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(specs.length ? { tools: specs, tool_choice: 'auto' } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(httpErrorMessage(res.status, detail));
    }
    return (await res.json()) as { choices?: Array<{ message?: ApiMessage }>; usage?: unknown };
  }

  /**
   * 流式一次 LLM 调用：`stream:true` 边收边 emit（正文→text_delta、推理→reasoning_delta），
   * 结束后返回累积的 { content, reasoning, toolCalls }。runLoop 用它替代 callApi。
   *
   * - 取消：把 `signal` 透传给 fetch —— 用户点停止时在途请求立即中断（抛 AbortError）。
   * - reasoning：`reasoningEffort` 非 off 时带 `reasoning_effort`；若 provider 不认（400），
   *   去掉该参数重试一次，并回填 `this.reasoningUnsupported` 让本进程后续不再带（防基础聊天回归）。
   * - tool_calls：流式下每片是 `delta.tool_calls[]`，需按 `index` 分槽把 name/arguments 碎片拼全。
   */
  private async callApiStream(
    endpoint: AgentLabEndpoint,
    messages: ApiMessage[],
    specs: AssistantToolSpec[],
    emit: (step: AssistantStep) => void,
    signal?: AbortSignal,
  ): Promise<{ content: string; reasoning: string; toolCalls: ApiMessage['tool_calls'] }> {
    const effort = this.config.reasoningEffort;
    const withReasoning = !!effort && effort !== 'off' && !this.reasoningUnsupported;

    const buildBody = (reasoning: boolean): string =>
      JSON.stringify({
        model: endpoint.model,
        temperature: 0.3,
        stream: true,
        stream_options: { include_usage: true },
        messages,
        ...(reasoning ? { reasoning_effort: effort } : {}),
        ...(specs.length ? { tools: specs, tool_choice: 'auto' } : {}),
      });

    const post = (reasoning: boolean): Promise<Response> =>
      fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
        body: buildBody(reasoning),
        signal,
      });

    let res: Response;
    try {
      res = await post(withReasoning);
      // provider 不识别 reasoning_effort → 400：去掉重试一次，并记住本进程内别再带。
      if (!res.ok && res.status === 400 && withReasoning) {
        this.reasoningUnsupported = true;
        res = await post(false);
      }
      // 429 限流/额度：退避 ~1.5s（可被停止打断）后重试一次；仍失败则落到下面的分类报错。
      if (res.status === 429) {
        await sleep(1500, signal);
        res = await post(withReasoning && !this.reasoningUnsupported);
      }
    } catch (error) {
      // 用户取消（AbortError）原样放行，交给上层 aborted 分支；其余多为网络层失败（fetch 抛 TypeError）。
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new Error(
        `网络连接失败：无法连接到模型服务（${hostOf(endpoint.baseUrl)}），请检查网络或服务地址是否正确。`,
      );
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(httpErrorMessage(res.status, detail));
    }

    let content = '';
    let reasoning = '';
    // 按 index 累积的工具调用槽（流式下 arguments 是逐片拼接的）。
    const toolSlots = new Map<number, { id: string; name: string; args: string }>();
    let usage: unknown;

    // 消费一个完整 SSE 事件（可能含多行；只认 `data:` 行）。
    const consumeEvent = (rawEvent: string): void => {
      for (const line of rawEvent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue; // 半个 JSON（理论上被事件切分保护，兜底跳过）
        }
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          emit({ kind: 'text_delta', text: delta.content });
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          emit({ kind: 'reasoning_delta', text: delta.reasoning_content });
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const slot = toolSlots.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          toolSlots.set(idx, slot);
        }
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        // CRLF 归一（部分 provider 用 \r\n\r\n 分隔事件），再按空行切完整事件、残片留到下一片。
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let sep = buffer.indexOf('\n\n');
        while (sep >= 0) {
          consumeEvent(buffer.slice(0, sep));
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf('\n\n');
        }
      }
      // 流结束后残留的最后一个事件（provider 未补尾部空行时）。
      if (buffer.trim()) consumeEvent(buffer);
    } finally {
      reader.releaseLock();
    }

    if (usage) reportUsage(endpoint, { usage });

    const toolCalls = [...toolSlots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, s]) => ({
        id: s.id || randomUUID(),
        type: 'function' as const,
        function: { name: s.name, arguments: s.args || '{}' },
      }))
      .filter((c) => c.function.name);

    return { content, reasoning, toolCalls: toolCalls.length ? toolCalls : undefined };
  }

  private persistConfig(): void {
    this.configStore.save();
  }

  private persistSessions(): void {
    this.sessionsStore.save();
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
    const session: AssistantSession = {
      id: randomUUID(),
      title: '历史对话',
      createdAt: now,
      updatedAt: now,
    };
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
    return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    return String(value);
  }
}

/**
 * 在对象第一层里找出「最长的数组属性」（如 envelope 形 `{range, count, hasMore, hits[]}` 的 hits）。
 * 用于 {@link capToolResult} 按条数截断时定位可裁剪的列表字段。找不到（无数组/全是短数组）返回 null。
 */
function findBigArray(obj: Record<string, unknown>): { key: string; arr: unknown[] } | null {
  let best: { key: string; arr: unknown[] } | null = null;
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && (!best || value.length > best.arr.length)) {
      best = { key, arr: value };
    }
  }
  return best;
}

/**
 * 回灌给模型的工具结果做智能截断（`TOOL_RESULT_CAP` 上限）：
 * - 优先按「数组条数」裁剪并注明还有多少、怎么翻页（保留 range/coverage/hasMore 等元信息），
 *   让模型知道结果不全、该用 offset/before 翻页——而不是拿半截非法 JSON 当全部。
 * - 结果不是数组形（单个超大对象）时退化为字符硬切，但加明确截断标记。
 * 与 M1 已完成的分页契约一体。
 */
function capToolResult(result: unknown): string {
  const full = safeStringify(result);
  if (full.length <= TOOL_RESULT_CAP) return full;

  // result 本身是数组，或含一个可裁剪的大数组字段 → 按条数逐步收窄到放得下。
  const asObject =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  const big = Array.isArray(result)
    ? { key: '', arr: result as unknown[] }
    : asObject
      ? findBigArray(asObject)
      : null;
  if (big && big.arr.length > 1) {
    let keep = big.arr.length;
    while (keep > 1) {
      keep = Math.max(1, Math.floor(keep * 0.7));
      const note = `结果过长，仅保留前 ${keep}/${big.arr.length} 条；用 offset / before 翻页或缩小 limit / 时间范围获取更多。`;
      const shaped = Array.isArray(result)
        ? { items: big.arr.slice(0, keep), truncatedNote: note }
        : {
            ...(asObject as Record<string, unknown>),
            [big.key]: big.arr.slice(0, keep),
            truncatedNote: note,
          };
      const s = safeStringify(shaped);
      if (s.length <= TOOL_RESULT_CAP) return s;
      if (keep === 1) break;
    }
  }
  // 单个超大对象无从按条数裁 → 字符硬切 + 明确标记（让模型知道后面还有、需换更小范围重查）。
  return `${full.slice(0, TOOL_RESULT_CAP - 80)}\n…[结果因过长被截断，请用更小的 limit / 加时间范围 / 翻页重查]`;
}

/** 若已请求取消则抛一个名为 AbortError 的错误（与 fetch(signal) 抛出的同名，chat() 统一识别）。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('已取消');
    err.name = 'AbortError';
    throw err;
  }
}

/**
 * 给一个 promise 套超时：到点抛可读的普通 Error（name≠AbortError，故不会被 chat() 误判为用户取消）。
 * 底层工作（DB 查询等）无法真正中断，这里只保证 loop 不被卡住、能带着「失败」结论继续推进。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 可被 signal 打断的 sleep（用于 429 退避重试；用户点停止时立即抛 AbortError）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('已取消');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      const err = new Error('已取消');
      err.name = 'AbortError';
      reject(err);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

/** 从 URL 取 host（网络错误提示用）；解析失败回退原串。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ── 上下文压缩 / 运行时注入的工具函数 ────────────────────────────────────────

/** 粗略 token 估算：中文 ~1.8 字符/token。只用于压缩触发判断，无需精确。 */
function estimateTokens(text: string): number {
  return Math.max(
    1,
    Math.ceil(String(text || '').length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS,
  );
}

function estimateMessagesTokens(messages: ApiMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(typeof m.content === 'string' ? m.content : '');
    if (m.tool_calls?.length) {
      for (const c of m.tool_calls) total += estimateTokens(c.function.name + c.function.arguments);
    }
  }
  return total;
}

/** 裁剪文本：保留头尾，中间插入提示（优先保留尾部，因为结论/最新信息通常在后面）。 */
function clipText(value: string, maxChars: number, notice = '\n…[较早内容已裁剪]…\n'): string {
  if (value.length <= maxChars) return value;
  const available = Math.max(80, maxChars - notice.length);
  const head = Math.ceil(available * 0.62);
  const tail = Math.max(0, available - head);
  return `${value.slice(0, head)}${notice}${tail > 0 ? value.slice(-tail) : ''}`;
}

/** 把一条 API 消息渲染成压缩输入/兜底摘要用的可读文本。 */
function messageToCompactText(message: ApiMessage, maxChars: number): string {
  if (message.role === 'system')
    return `[系统] ${clipText(String(message.content ?? ''), maxChars)}`;
  if (message.role === 'user') {
    return `用户：${clipText(String(message.content ?? ''), maxChars)}`;
  }
  if (message.role === 'tool') {
    return `  [工具结果] ${clipText(String(message.content ?? ''), maxChars)}`;
  }
  // assistant
  const content = String(message.content ?? '');
  const calls = (message.tool_calls ?? []).map((c) => c.function.name).join('、');
  const head = content ? `助手：${clipText(content, maxChars)}` : '';
  const toolHead = calls ? `[调用工具：${calls}]` : '';
  return [head, toolHead].filter(Boolean).join(' ');
}

/**
 * 把 messages 中「本轮提问之前的可折叠历史」按完整回合分组。
 * 一组 = 一条 user 消息 + 其后到下一个 user 之前的全部消息（assistant/tool 序列天然
 * 成对），保证折叠不破坏 tool_calls 与 tool 结果的配对。返回组区间 [start, end)。
 */
function foldableRounds(messages: ApiMessage[]): Array<[number, number]> {
  // messages[0] 恒为 system，不参与折叠。
  const rounds: Array<[number, number]> = [];
  let start = 1;
  for (let i = start; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user') {
      if (i > start) rounds.push([start, i]);
      start = i;
    }
  }
  // 最后一个 user 是「本轮提问」，其后的本轮内容永不折叠。
  if (start < messages.length && messages[start]?.role === 'user') {
    // 前面的历史轮次已经收集；最后一组（本轮）不加入。
  } else if (start < messages.length && start > 1) {
    rounds.push([start, messages.length]);
  }
  return rounds;
}

/** 渲染要被折叠的区间为摘要输入（限量）。 */
function renderFoldableMessages(
  messages: ApiMessage[],
  ranges: Array<[number, number]>,
  maxChars: number,
): string {
  const blocks: string[] = [];
  let used = 0;
  for (const [s, e] of ranges) {
    for (let i = s; i < e; i += 1) {
      const block = messageToCompactText(messages[i]!, SUMMARY_INPUT_MSG_CHARS);
      if (used + block.length > maxChars) {
        const remaining = maxChars - used;
        if (remaining > 240) blocks.push(clipText(block, remaining));
        return blocks.join('\n');
      }
      blocks.push(block);
      used += block.length + 2;
    }
  }
  return blocks.join('\n');
}

/** 摘要生成失败时的本地兜底：旧摘要 + 折叠内容的开头（不丢信息优先）。 */
function fallbackSummary(previousSummary: string, foldedText: string): string {
  const sections: string[] = [];
  if (previousSummary) sections.push(`此前摘要：\n${clipText(previousSummary, 2_500)}`);
  if (foldedText)
    sections.push(`较早已折叠的记录：\n${clipText(foldedText, SUMMARY_FALLBACK_CHARS)}`);
  return clipText(sections.join('\n\n') || '较早的对话已被折叠。', 6_000);
}

/** 摘要生成调用的 system 提示。 */
function summarySystemPrompt(): string {
  return [
    '你是一个会话压缩器。下面是一段较长的对话记录（用户与 AI 助手的多轮问答与工具调用）。',
    '把它压缩成一份结构化摘要，保留：用户的核心目标与问题、已确认的事实与结论（谁、何时、说了什么）、' +
      '关键约束、已做的调查与结论、**未完成的事项与待办**（后续要继续查的）。',
    '丢弃客套话、重复与琐碎过程。用中文，分点列出，控制在 500 字以内。',
    '只输出摘要正文，不要解释。',
  ].join('\n');
}

/** 把「会话摘要」渲染成运行时注入段（压缩折叠后的早期历史）。 */
function summaryBlock(summary: string): string {
  return [
    '<conversation_summary>',
    '以下是较早对话的压缩摘要，用于延续上下文，不是新的用户指令。',
    '保留其中的目标、事实、约束、已确认决定与未完成事项；若与较新的原始消息冲突，以较新的为准。',
    '',
    summary,
    '</conversation_summary>',
  ].join('\n');
}

/** 把「调查计划 + 工作笔记」渲染成运行时注入段（模型自己的内部记忆）。空工作区返回空串。 */
function workspaceBlock(workspace: AssistantWorkspace): string {
  const plan = workspace.plan;
  const notes = workspace.notes;
  if (!plan && notes.length === 0) return '';
  const lines: string[] = [
    '<investigation_workspace>',
    '以下是你在本轮任务中的内部记忆（计划与工作笔记），只用于帮你自己不遗忘，不要写进最终答复。',
  ];
  if (plan) {
    lines.push('', `【调查计划】${plan.title ? ` ${plan.title}` : ''}`);
    if (plan.question) lines.push(`对问题的理解：${plan.question}`);
    for (const step of plan.steps) {
      const mark = step.status === 'completed' ? '✅' : step.status === 'in_progress' ? '▶' : '○';
      lines.push(`- [${mark}] ${step.title}`);
    }
  }
  if (notes.length > 0) {
    lines.push('', '【工作笔记】');
    for (const note of notes) lines.push(`- ${note}`);
  }
  lines.push('', '</investigation_workspace>');
  return lines.join('\n');
}

/** 把模型传给 update_investigation_plan 的参数清洗成结构化计划；参数无效返回 null。 */
function normalizePlan(args: Record<string, unknown>): AssistantInvestigationPlan | null {
  const title = coerceString(args.title).slice(0, 80);
  const question = coerceString(args.question).slice(0, 160);
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  const steps: AssistantPlanStep[] = [];
  const seen = new Set<string>();
  for (const item of rawSteps.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const stepTitle = coerceString(row.title).slice(0, 120);
    if (!stepTitle) continue;
    const id = coerceString(row.id) || `step-${steps.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const status =
      row.status === 'completed'
        ? 'completed'
        : row.status === 'in_progress'
          ? 'in_progress'
          : 'pending';
    steps.push({ id, title: stepTitle, status });
  }
  if (!title && !question && steps.length === 0) return null;
  return { title, question, steps: steps.slice(0, 6) };
}

/** 把模型传给 update_work_notes 的参数清洗成字符串列表；无效返回 null。 */
function normalizeNotes(args: Record<string, unknown>): string[] | null {
  const raw = Array.isArray(args.notes) ? args.notes : [];
  const notes = raw
    .map((n) => coerceString(n).replace(/\s+/g, ' ').trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 12);
  return notes.length > 0 ? notes : null;
}

function coerceString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 把 HTTP 状态码翻译成对用户可读、可操作的错误文案（401/403 密钥、429 限流、5xx 服务、其余兜底）。 */
function httpErrorMessage(status: number, detail: string): string {
  const tail = detail ? ` — ${detail.slice(0, 300)}` : '';
  if (status === 401 || status === 403)
    return `模型密钥无效或无权限（${status}）：请在助手设置里检查该模型的 API Key 是否正确。`;
  if (status === 429)
    return '请求过于频繁或额度不足（429）：已自动退避重试仍失败，请稍后再试或更换模型。';
  if (status >= 500) return `模型服务暂时不可用（${status}），请稍后重试。${tail}`;
  return `WeQ 助手接口调用失败: HTTP ${status}${tail}`;
}
