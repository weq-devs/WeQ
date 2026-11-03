/**
 * 闪照补拉结果的**会话级持久缓存**。
 *
 * 补拉到的真元素不能只放 React state：切换会话会把组件里的 Map 清空，再切回来
 * 就得重新发包（而且重试名额也一起没了，表现就是「第一次还能看到，切一下就没了」）。
 * 这里按会话号分桶写进 `sessionStorage` —— 不落盘、不碰数据库，关掉应用即失效。
 *
 * 存两份东西：
 *   - `patches`：本地 `msgId` → 服务端返回的真元素；
 *   - `dead`：确认补不回来的本地 `msgId`（服务端这一窗确实没有闪照元素），
 *     免得每次切会话都对同一条白打一次请求。
 */

/** 一条补丁：补到的元素 + 来源格式（渲染层只当作不透明值透传）。 */
export interface FlashPhotoPatch {
  elements: unknown[];
  sourceFormat?: 'native' | 'protocol';
}

export interface FlashPhotoConvState {
  patches: Record<string, FlashPhotoPatch>;
  dead: string[];
}

const STORAGE_PREFIX = 'weq.flash-photo.v1.';

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // 某些沙箱 / 隐私模式下访问 sessionStorage 会抛，补拉结果丢了也不该影响渲染。
    return null;
  }
}

const keyFor = (conv: string): string => `${STORAGE_PREFIX}${conv}`;

/** 读回某个会话已补好的状态；坏数据一律当空，不让它污染时间线。 */
export function loadFlashPhotoState(conv: string): FlashPhotoConvState {
  const empty: FlashPhotoConvState = { patches: {}, dead: [] };
  if (!conv) return empty;
  try {
    const raw = storage()?.getItem(keyFor(conv));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<FlashPhotoConvState> | null;
    if (!parsed || typeof parsed !== 'object') return empty;
    const patches: Record<string, FlashPhotoPatch> = {};
    for (const [msgId, value] of Object.entries(parsed.patches ?? {})) {
      if (!value || typeof value !== 'object') continue;
      const elements = (value as FlashPhotoPatch).elements;
      if (!Array.isArray(elements)) continue;
      patches[msgId] = {
        elements,
        ...((value as FlashPhotoPatch).sourceFormat
          ? { sourceFormat: (value as FlashPhotoPatch).sourceFormat }
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
export function saveFlashPhotoState(conv: string, state: FlashPhotoConvState): void {
  if (!conv) return;
  try {
    storage()?.setItem(keyFor(conv), JSON.stringify(state));
  } catch {
    // 配额满 / 被禁用：缓存是加速手段，丢了下一轮重拉即可，不能影响消息渲染。
  }
}
