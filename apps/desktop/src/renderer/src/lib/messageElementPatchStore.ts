/** 按账号、数据源和会话保留补回的消息元素，切回会话时可直接恢复。 */
/** 一条补丁：补到的元素 + 来源格式（渲染层只当作不透明值透传）。 */
export interface MessageElementPatch {
  elements: unknown[];
  sourceFormat?: 'native' | 'protocol';
}

export interface MessageElementPatchState {
  patches: Record<string, MessageElementPatch>;
  dead: string[];
}

const STORAGE_PREFIX = 'weq.message-elements.v1.';

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // 某些沙箱 / 隐私模式下访问 sessionStorage 会抛，补拉结果丢了也不该影响渲染。
    return null;
  }
}

const keyFor = (scope: string): string => `${STORAGE_PREFIX}${scope}`;

/** 读回某个会话已补好的状态；坏数据一律当空，不让它污染时间线。 */
export function loadMessageElementPatches(scope: string): MessageElementPatchState {
  const empty: MessageElementPatchState = { patches: {}, dead: [] };
  if (!scope) return empty;
  try {
    const raw = storage()?.getItem(keyFor(scope));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<MessageElementPatchState> | null;
    if (!parsed || typeof parsed !== 'object') return empty;
    const patches: Record<string, MessageElementPatch> = {};
    for (const [msgId, value] of Object.entries(parsed.patches ?? {})) {
      if (!value || typeof value !== 'object') continue;
      const elements = (value as MessageElementPatch).elements;
      if (!Array.isArray(elements)) continue;
      patches[msgId] = {
        elements,
        ...((value as MessageElementPatch).sourceFormat
          ? { sourceFormat: (value as MessageElementPatch).sourceFormat }
          : {}),
      };
    }
    const dead = Array.isArray(parsed.dead)
      ? parsed.dead.filter((id): id is string => typeof id === 'string')
      : [];
    return { patches, dead };
  } catch {
    return empty;
  }
}

/** 整体覆盖写回（数据量很小，直接序列化最省心）。 */
export function saveMessageElementPatches(scope: string, state: MessageElementPatchState): void {
  if (!scope) return;
  try {
    storage()?.setItem(keyFor(scope), JSON.stringify(state));
  } catch {
    // 配额满 / 被禁用：缓存是加速手段，丢了下一轮重拉即可，不能影响消息渲染。
  }
}
