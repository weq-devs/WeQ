type ResultKind = 'tasks' | 'assistant';

const storageKey = (scope: string, kind: ResultKind) =>
  `weq:workspace-read:v1:${encodeURIComponent(scope)}:${kind}`;

export function readWorkspaceResults(scope: string, kind: ResultKind): Record<string, string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(scope, kind)) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

export function rememberWorkspaceResults(
  scope: string,
  kind: ResultKind,
  results: Record<string, string>,
): void {
  try {
    const key = storageKey(scope, kind);
    if (Object.keys(results).length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    const serialized = JSON.stringify(results);
    if (window.localStorage.getItem(key) !== serialized)
      window.localStorage.setItem(key, serialized);
  } catch {
    /* 存储禁用或写满时仍保留本窗口的已读状态。 */
  }
}

/** 结果指纹不保存对话原文；流式结果与重新读取的历史使用相同口径。 */
export function assistantResultVersion(turns: readonly { role: string; text: string }[]): string {
  const content = JSON.stringify([
    turns.length,
    turns.slice(-2).map((turn) => [turn.role, turn.text]),
  ]);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < content.length; index++) {
    hash ^= BigInt(content.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16);
}
