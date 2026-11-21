import type { AgentLabEndpoint } from '@weq/agentlab';

export type LightweightPlan =
  | { kind: 'plain' }
  | { kind: 'setting' }
  | { kind: 'conversation'; query: string }
  | { kind: 'groupFiles'; query: string }
  | { kind: 'clarifyGroup' };

export function isLocalAssistantEndpoint(endpoint: AgentLabEndpoint): boolean {
  try {
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint.baseUrl).hostname) &&
      (endpoint.source === 'local' ||
        ['omlx', 'ollama', 'lmstudio'].includes(endpoint.providerVendor ?? ''))
    );
  } catch {
    return false;
  }
}

export function testedLocalToolCalling(endpoint: AgentLabEndpoint): boolean {
  return endpoint.providerVendor === 'omlx' && endpoint.model === 'Qwen3.6-35B-A3B-4bit';
}

export function lightweightPlan(question: string): LightweightPlan {
  const text = question
    .trim()
    .replace(/[。？?！!]+$/, '')
    .trim();
  if (
    /^(?:(?:请)?(?:查一下|找一下|查看|告诉我)\s*)?(?:WeQ\s*(?:的)?)?(?:默认聊天模型|默认模型)(?:在哪里设置|在哪设置|在哪里|在哪|怎么设置|设置入口)?$/i.test(
      text,
    )
  )
    return { kind: 'setting' };
  const lookup = text.match(
    /^(?:请\s*)?(?:帮我\s*)?(?:查一下|查找|查看|看看|找一下|列出|浏览|打开|找|查)\s*(.+)$/,
  )?.[1];
  if (!lookup) return { kind: 'plain' };
  if (/^群文件(?:列表|夹)?$/.test(lookup)) return { kind: 'clarifyGroup' };
  const group =
    lookup.match(
      /^([\p{L}\p{N} _·.-]{1,60}?)群(?:[里中]?的)?(?:群文件(?:列表)?|文件(?:列表)?|根目录(?:里|中)?(?:有(?:哪些|什么|哪个)?[^，、；。]{0,40}文件)?)$/u,
    ) ?? lookup.match(/^群(?:号)?\s*([1-9]\d{0,9})\s*(?:的)?(?:群文件|文件|根目录)$/);
  if (group?.[1]?.trim()) return { kind: 'groupFiles', query: group[1].trim() };
  const contact = lookup.match(/^([\p{L}\p{N} _·.-]{1,60}?)(?:的)?(?:会话|私聊)$/u);
  if (contact?.[1]?.trim()) return { kind: 'conversation', query: contact[1].trim() };
  return { kind: 'plain' };
}

export function parseAssistantToolArguments(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function lightweightRows(result: unknown, key: string): Record<string, unknown>[] {
  const rows =
    result && typeof result === 'object' ? (result as Record<string, unknown>)[key] : null;
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is Record<string, unknown> =>
          row != null && typeof row === 'object' && !Array.isArray(row),
      )
    : [];
}

export function exactLightweightGroups(result: unknown, query: string) {
  const clean = (name: unknown) =>
    typeof name === 'string' ? name.trim().replace(/群$/, '').toLocaleLowerCase() : '';
  return lightweightRows(result, 'groups').flatMap((row) => {
    const { groupCode, groupName, remark } = row;
    return typeof groupCode === 'string' &&
      /^[1-9]\d{0,9}$/.test(groupCode) &&
      (groupCode === query || [groupName, remark].some((name) => clean(name) === clean(query)))
      ? [{ code: groupCode, name: typeof groupName === 'string' ? groupName : groupCode }]
      : [];
  });
}

export function summarizeLightweightResult(name: string, result: unknown) {
  const pick = (key: string, fields: string[]) =>
    lightweightRows(result, key)
      .slice(0, 8)
      .map((row) =>
        Object.fromEntries(
          fields.flatMap((field) => {
            const value = row[field];
            return typeof value === 'string' ? [[field, value.slice(0, 160)]] : [];
          }),
        ),
      );
  switch (name) {
    case 'list_group_files': {
      const page = result as { hasMore?: boolean; nextOffset?: number | null } | null;
      const files = pick('files', ['fileId', 'fileName']);
      const folders = pick('folders', ['folderId', 'folderName']);
      return {
        files,
        folders,
        nextOffset: page?.nextOffset ?? null,
        limited:
          page?.hasMore === true ||
          lightweightRows(result, 'files').length > files.length ||
          lightweightRows(result, 'folders').length > folders.length,
      };
    }
    case 'find_contact':
      return {
        people: pick('people', ['name', 'remark', 'uid', 'uin']),
        groups: pick('groups', ['groupName', 'remark', 'groupCode']),
      };
    default:
      // Route setting navigation through get_feature to retain the host's actual link and conditions.
      return result;
  }
}
