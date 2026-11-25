import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { findFeature, listFeatures, type FeatureDefinition } from '@weq/service/feature-catalog';
import { searchNameRank } from '@weq/service/search-policy';
import { z } from 'zod/v3';
import { botRuntime } from '../bot_runtime';
import { getAppContext } from '../context/app_context';
import { assertAccountToolScope, toolExecutionOptions } from './account_scope';
import { capabilityAccount, FRONTEND_CAPABILITIES } from './frontend_capabilities';
import {
  isCapabilityTool,
  isReadOnlyTool,
  isSandboxTool,
  MCP_WRITE_TOOLS,
} from './tool_permissions';
import { AI_TOOLS } from './tools';

const source = z
  .enum(['weq', 'onebot'])
  .default('weq')
  .describe('weq 为应用能力；onebot 为当前 OneBot 会话');
const name = z.string().regex(/^[a-z_][a-z0-9_]{0,95}$/);
export const listCapabilityInput = z.object({
  source,
  group: z.string().trim().min(1).max(64).optional(),
  query: z.string().trim().min(1).max(128).optional(),
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(50).default(15),
});
export const getCapabilityInput = z.object({ source, name });
export const callCapabilityInput = getCapabilityInput.extend({
  arguments: z.record(z.unknown()).default({}),
});

const featuresByTool = new Map<string, FeatureDefinition[]>();
for (const feature of listFeatures()) {
  for (const name of feature.tools ?? []) {
    const features = featuresByTool.get(name) ?? [];
    features.push(feature);
    featuresByTool.set(name, features);
  }
}

function allowWrites() {
  const options = toolExecutionOptions();
  const ctx = getAppContext();
  if (ctx.accountIsStatic || ctx.services?.accountConfig?.getRecord()?.static) return false;
  return (
    options.mcpCapabilityWrites === true ||
    (options.permissionMode === 'unrestricted' &&
      ctx.services?.assistant.getExecutionConfig().permissionMode === 'unrestricted')
  );
}

function summaryLine(text: string) {
  return (text.split('\n')[0] ?? '').slice(0, 100);
}

function weqCapabilities() {
  const options = toolExecutionOptions();
  const assistant = options.permissionMode !== undefined;
  const writes = allowWrites();
  return [
    ...AI_TOOLS.flatMap((tool) => {
      if (
        isCapabilityTool(tool.name) ||
        tool.name === 'switch_account' ||
        tool.name === 'list_accounts'
      )
        return [];
      const read =
        isReadOnlyTool(tool.name) && (assistant ? isSandboxTool(tool.name) : !tool.assistantOnly);
      if (!read && (!writes || !MCP_WRITE_TOOLS.has(tool.name))) return [];
      const features = featuresByTool.get(tool.name) ?? [];
      return [
        {
          ...tool,
          summary: summaryLine(tool.description),
          access: read ? ('read' as const) : ('write' as const),
          groups: [...new Set(features.map(({ domain }) => domain))],
          features,
          run: (args: unknown) => tool.run(tool.input.parse(args)),
        },
      ];
    }),
    ...FRONTEND_CAPABILITIES.map((tool) => {
      const feature = findFeature(tool.featureId)!;
      return {
        ...tool,
        description: tool.summary,
        access: 'read' as const,
        groups: [feature.domain],
        features: [feature],
      };
    }),
  ];
}

function botAccount() {
  const { ctx, selfUin, services } = capabilityAccount();
  if (ctx.accountIsStatic || services.accountConfig.getRecord()?.static)
    throw new Error('静态备份数据源不提供 OneBot 操作。');
  return selfUin;
}

export async function listCapabilities(input: z.infer<typeof listCapabilityInput>) {
  const { source, group, query, offset, limit } = input;
  if (source === 'onebot') {
    const result = await botRuntime.oneBotCapability(botAccount(), 'onebot.mcpList', {
      allowWrites: allowWrites(),
      group,
      query,
      offset,
      limit,
    });
    return { source, ...result };
  }
  const matches = weqCapabilities()
    .filter((tool) => !group || tool.groups.includes(group as FeatureDefinition['domain']))
    .map((tool) => ({
      tool,
      rank: query
        ? searchNameRank(
            query,
            tool.name,
            tool.summary,
            ...tool.features.flatMap(({ id, label, aliases }) => [id, label, ...aliases]),
          )
        : 1,
    }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank);
  const next = offset + limit;
  return {
    source,
    entries: matches.slice(offset, next).map(({ tool: { name, summary, groups, access } }) => ({
      name,
      summary,
      groups,
      access,
    })),
    nextOffset: next < matches.length ? next : null,
  };
}

export async function getCapability({ source, name }: z.infer<typeof getCapabilityInput>) {
  if (source === 'onebot') {
    const detail = await botRuntime.oneBotCapability(botAccount(), 'onebot.mcpDescribe', {
      allowWrites: allowWrites(),
      name,
    });
    return detail ? { source, found: true, ...detail } : { source, found: false, name };
  }
  const capability = weqCapabilities().find((tool) => tool.name === name);
  if (!capability) return { source, found: false, name };
  return {
    source,
    found: true,
    name,
    description: capability.description,
    groups: capability.groups,
    featureIds: capability.features.map(({ id }) => id),
    access: capability.access,
    inputSchema: toJsonSchemaCompat(capability.input),
  };
}

export async function callCapability({
  source,
  name,
  arguments: args,
}: z.infer<typeof callCapabilityInput>) {
  const { signal } = toolExecutionOptions();
  signal?.throwIfAborted();
  assertAccountToolScope();
  if (Buffer.byteLength(JSON.stringify(args)) > 64 * 1024) throw new Error('能力参数超过 64 KiB。');
  let value: unknown;
  if (source === 'onebot') {
    const result = (await botRuntime.oneBotCapability(botAccount(), 'onebot.mcpCall', {
      allowWrites: allowWrites(),
      name,
      arguments: args,
    })) as { status?: string; retcode?: number; data?: unknown; wording?: string };
    if (result?.status !== 'ok')
      throw new Error(result?.wording || `OneBot 操作失败（${result?.retcode ?? '无返回码'}）。`);
    value = result.data;
  } else {
    const capability = weqCapabilities().find((tool) => tool.name === name);
    if (!capability) throw new Error('当前会话未提供此能力。');
    assertAccountToolScope();
    signal?.throwIfAborted();
    value = await capability.run(args);
  }
  assertAccountToolScope();
  signal?.throwIfAborted();
  const result =
    value != null && typeof value === 'object' && !Array.isArray(value) ? value : { value };
  const encoded = JSON.stringify(result, (_key, value) =>
    typeof value === 'bigint' ? String(value) : value,
  );
  if (Buffer.byteLength(encoded) > 128 * 1024)
    throw new Error('能力结果超过 128 KiB。查询可缩小范围后重试，写入请先核对结果。');
  return JSON.parse(encoded) as Record<string, unknown>;
}
