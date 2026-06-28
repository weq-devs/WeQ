/**
 * 把传输无关的 {@link AI_TOOLS} 注册表转成 OpenAI 兼容的 function-calling 规格，
 * 供 WeQ 助手（AssistantService）调用。复用同一份 `run`，逻辑只此一处。
 *
 * 这里手写一个**极小**的 zod(v3)→JSON Schema 转换，只覆盖工具里实际用到的类型
 * （string / number / boolean / enum，及 optional / default 包装），不追求通用。
 */

import { z } from 'zod';
import { AI_TOOLS } from './tools';

export interface OpenAiToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 剥掉 optional/default 包装，返回内核 schema + 是否必填 + 描述。 */
function unwrap(schema: z.ZodTypeAny): { core: z.ZodTypeAny; required: boolean; description?: string } {
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

/** 按名字执行一个工具（复用注册表里的 run）。 */
export async function runAiTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const t = AI_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`未知工具：${name}`);
  return t.run(args);
}
