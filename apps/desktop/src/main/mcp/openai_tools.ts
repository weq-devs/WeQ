/**
 * 把传输无关的 {@link AI_TOOLS} 注册表转成 OpenAI 兼容的 function-calling 规格，
 * 供 WeQ 助手（AssistantService）调用。复用同一份 `run`，逻辑只此一处。
 *
 * 这里手写一个**极小**的 zod(v3)→JSON Schema 转换，只覆盖工具里实际用到的类型
 * （string / number / boolean / enum / 嵌套 object / array，及 optional / default
 * 包装），不追求通用。
 */

import type { z } from 'zod';
import { getExternalMcpHub } from './external';
import { AI_TOOLS } from './tools';

export interface OpenAiToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 剥掉 optional/default 包装，返回内核 schema + 是否必填 + 描述。 */
function unwrap(schema: z.ZodTypeAny): {
  core: z.ZodTypeAny;
  required: boolean;
  description?: string;
} {
  let cur = schema;
  let required = true;
  let description = cur.description;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const typeName = (cur as { _def?: { typeName?: string } })._def?.typeName;
    if (typeName === 'ZodOptional' || typeName === 'ZodDefault') {
      required = false;
      cur = (cur as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
      description = description ?? cur.description;
      continue;
    }
    break;
  }
  return { core: cur, required, description };
}

function fieldToJson(schema: z.ZodTypeAny): Record<string, unknown> {
  const { core, description } = unwrap(schema);
  const typeName = (core as { _def?: { typeName?: string } })._def?.typeName;
  const out: Record<string, unknown> = {};
  if (description) out.description = description;
  switch (typeName) {
    case 'ZodString':
      out.type = 'string';
      break;
    case 'ZodNumber':
      out.type = 'number';
      break;
    case 'ZodBoolean':
      out.type = 'boolean';
      break;
    case 'ZodEnum':
      out.type = 'string';
      out.enum = (core as unknown as { _def: { values: string[] } })._def.values;
      break;
    case 'ZodArray':
      out.type = 'array';
      out.items = fieldToJson((core as unknown as { _def: { type: z.ZodTypeAny } })._def.type);
      break;
    case 'ZodObject':
      Object.assign(out, objectToParameters(core as z.ZodObject<z.ZodRawShape>));
      break;
    default:
      out.type = 'string';
  }
  return out;
}

function objectToParameters(obj: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = obj.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = fieldToJson(field as z.ZodTypeAny);
    if (unwrap(field as z.ZodTypeAny).required) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/** 全部工具的 OpenAI function 规格。 */
export function aiToolSpecs(): OpenAiToolSpec[] {
  return AI_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: objectToParameters(t.input) },
  }));
}

/** 把 zod 校验失败压成一行可读信息（喂回模型，让它自己改参数重试）。 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '参数'} ${issue.message}`)
    .join('；');
}

/**
 * 按名字执行一个工具（复用注册表里的 run）。
 *
 * 助手侧拿到的是模型给的**裸** function-calling 参数，必须先按工具自己的 zod schema
 * 解析一遍再交给 `run`：
 *
 *   - `optional` / `default` 才会生效。`run` 里直接拿参数做算术/拼串的写法隐含依赖默认值
 *     （例如 `list_collections` 的 `const wantedEnd = offset + limit + 1`，offset 缺省不是 0
 *     而是 undefined → NaN → 扫描循环一次都不跑 → 静默返回「本地 collection.db 里没有收藏
 *     记录」，看着像「你确实没有收藏」）。
 *   - 类型不对（如 `limit: "10"`）时会当场报错，而不是把脏值带进 `run` 算出错误结果。
 *
 * 外部 MCP 那边由 SDK 用同一份 schema 校验（见 `server.ts` 的 `inputSchema: t.input.shape`），
 * 这里补齐助手路径，两边行为保持一致。
 */
export async function runAiTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const t = AI_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`未知工具：${name}`);
  const parsed = t.input.safeParse(args);
  if (!parsed.success) {
    throw new Error(`工具 ${name} 的参数不合法：${formatIssues(parsed.error)}`);
  }
  return t.run(parsed.data);
}

/**
 * 助手侧**统一**的工具执行入口：内置工具走注册表，外部 MCP 工具（`mcp__` 前缀）走 Hub。
 *
 * 独立成一个函数是因为它有两个调用方：助手自己的工具循环，以及 `run_js` 沙箱里的
 * `callTool`。沙箱能碰到的能力必须和助手自己能碰到的完全一致——这个函数就是那条
 * 边界的唯一定义处，别再在别处把路由逻辑写第二遍。
 */
export async function runAssistantTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name.startsWith('mcp__')) return getExternalMcpHub().run(name, args);
  return runAiTool(name, args);
}
