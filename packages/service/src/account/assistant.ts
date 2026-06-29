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
 * 助手用 write_report 写到本地的一份报告/文档（落在账号缓存目录的 reports/ 下）。
 * `id` 同时是磁盘文件名与 open/save 的句柄；前端据此渲染附件卡片（查看/另存为）。
 */
export interface AssistantArtifact {
  /** 磁盘文件名（含 uuid，纯 basename）。同时是 openArtifact/saveArtifact 的 id。 */
  id: string;
  /** 展示名（带扩展名）：卡片标题 + 另存为默认文件名。 */
  name: string;
  kind: 'html' | 'markdown' | 'text';
  mime: string;
  /** 字节数（UTF-8），卡片显示大小用。 */
  bytes: number;
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
      '强烈优先 kind="html"：应用内置本地 Tailwind 运行时 + 一套报告组件库 class（rp-*）离线渲染，' +
      '优先用 rp-* 组件（rp-page/rp-hero/rp-stat/rp-section/rp-card/rp-rank/rp-table/rp-callout 等）搭骨架，套上即美，' +
      '无需写 <style>、也无需引任何 CDN（详见系统提示的【写报告】小节）。' +
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
    private readonly rootDir: string,
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

      const content = typeof msg.content === 'string' ? msg.content.trim() : '';

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
      '- 当产出是成体系的长内容（报告、总结、数据清单、可视化网页）时，用 write_report 工具把它写成本地文件（**优先 kind="html"**），' +
        '用户能在你的回复里「查看」或「另存为」；不要把这种长文整段塞进聊天回复里。',
      '- 报告渲染环境已内置两样东西，你直接用即可，**无需写 <style>、无需引任何 CDN**：' +
        '① 本地 Tailwind 运行时（可用 Tailwind 原子类做微调）；' +
        '② 一套"开箱即美"的报告组件库 class（`rp-*`）——**优先用 rp-* 组件搭骨架**，套上就专业，别自己从零拼样式。',
      '- 组件清单（按需取用）：',
      '  • `rp-page`：整页容器，所有内容都包在它里面；',
      '  • `rp-hero`：头图，内放 `rp-eyebrow`(小标签) + `<h1>`(大标题) + `<p>`(副标题/概览)；',
      '  • `rp-grid rp-grid-3`(或 -2/-4)：指标卡栅格，内含若干 `rp-stat`（各带 `rp-stat-label`/`rp-stat-value`/`rp-stat-sub`）；',
      '  • `rp-section` + `rp-section-title`：分章节；普通内容块用 `rp-card`；',
      '  • `rp-rank`：排行榜，每行 `rp-rank-item`(名称 `rp-rank-name` + 进度条 `rp-rank-bar`>`<span style="--rp-pct:73%">` + 数值 `rp-rank-val`)；',
      '  • `rp-table`：表格（表头深色、隔行底色，数字单元格加 `rp-num` 右对齐）；',
      '  • `rp-badge` + `rp-badge-up`/`-down`/`-info`/`-warn`：趋势/状态徽章（配 emoji，如 📈🔥）；',
      '  • `rp-quote`(内含 `<cite>` 写是谁、大概何时说的)：引用聊天原话；',
      '  • `rp-callout`：高亮块，放你的解读 / 总结 / 金句（见下条）；`rp-footer`：页脚署名。',
      '- ⭐ **报告的灵魂是你的洞察，不是数据搬运**：如果只把数字排进模板，那写死一个生成器就够了，要你做什么？所以每份报告都必须：',
      '  • 在恰当位置（如 hero 副标题、章节里）穿插**你自己的简短总结与解读**——这群最近在聊什么、谁最活跃、氛围/趋势有什么变化、有没有值得一提的瞬间；',
      '  • 结尾用 `rp-callout` 写**一两句走心的点评或鸡汤**：温暖、有人情味、贴合这份数据本身（不要套话），让报告有温度、有记忆点。',
      '  • 语气可以活泼、有梗，像一个懂这个群的朋友在做总结，而不是冷冰冰的数据面板。',
      '- 骨架示例（照这个风格组织，内容按实际自由发挥）：',
      '```html',
      '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>群活跃度报告</title></head>',
      '<body><div class="rp-page">',
      '  <div class="rp-hero"><div class="rp-eyebrow">WEQ 群报告</div><h1>「摸鱼大队」本周活跃度</h1><p>6/23–6/29 · 共 1,240 条消息，比上周 📈 +18%，周末那场露营约局把群点着了。</p></div>',
      '  <div class="rp-grid rp-grid-3">',
      '    <div class="rp-stat"><div class="rp-stat-label">总消息</div><div class="rp-stat-value">1,240</div><div class="rp-stat-sub">日均 177 条</div></div>',
      '    <div class="rp-stat"><div class="rp-stat-label">活跃成员</div><div class="rp-stat-value">23</div><div class="rp-stat-sub">占全群 64%</div></div>',
      '    <div class="rp-stat"><div class="rp-stat-label">龙王</div><div class="rp-stat-value">小枳壳</div><div class="rp-stat-sub">312 条 <span class="rp-badge rp-badge-up">🔥 TOP1</span></div></div>',
      '  </div>',
      '  <div class="rp-section"><div class="rp-section-title">成员排行</div><div class="rp-card"><div class="rp-rank">',
      '    <div class="rp-rank-item"><span class="rp-rank-name">小枳壳</span><div class="rp-rank-bar"><span style="--rp-pct:100%"></span></div><span class="rp-rank-val">312</span></div>',
      '    <div class="rp-rank-item"><span class="rp-rank-name">阿白</span><div class="rp-rank-bar"><span style="--rp-pct:61%"></span></div><span class="rp-rank-val">190</span></div>',
      '  </div></div></div>',
      '  <div class="rp-section"><div class="rp-section-title">我的观察</div>',
      '    <div class="rp-callout">这周的热度几乎全是周末露营约局烧起来的，小枳壳一个人就占了四分之一的消息量 😎。<strong>一句话：白天集体潜水，晚上准时炸群的快乐老群。</strong>愿这份热闹，往后每周都不缺席 🌿</div>',
      '  </div>',
      '  <div class="rp-footer">由 WeQ 助手生成 · 2026-06-29</div>',
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

/** JSON.stringify，循环引用/异常兜底成字符串。 */
function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
