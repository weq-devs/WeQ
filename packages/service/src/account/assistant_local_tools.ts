import type { AssistantToolSpec } from './assistant';

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

export const ANALYZE_ATTACHED_IMAGE_SPEC: AssistantToolSpec = {
  type: 'function',
  function: {
    name: 'analyze_attached_image',
    description:
      '查看用户附件原图中现有图片解读没有覆盖的细节。复用已有描述，只有确实缺少细节或用户要求重新分析时才调用。',
    parameters: {
      type: 'object',
      properties: {
        imageId: { type: 'string', description: '上下文中 [图片 …] 标明的附件 ID' },
        question: { type: 'string', maxLength: 4000, description: '需要查看的具体细节' },
        refresh: { type: 'boolean', description: '仅在用户明确要求重新分析同一附件时为 true' },
      },
      required: ['imageId'],
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

export const ASSISTANT_BASE_SPECS: readonly AssistantToolSpec[] = [
  WRITE_REPORT_SPEC,
  ...WORKSPACE_SPECS,
];
