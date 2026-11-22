export interface AvatarSuccess {
  src: string;
  webKey?: string;
}

const recent = new Map<string, AvatarSuccess>();
const listeners = new Map<string, Set<() => void>>();
const MAX_RECENT = 512;

function trim() {
  if (recent.size <= MAX_RECENT) return;
  for (const key of recent.keys()) {
    if (!listeners.has(key)) recent.delete(key);
    if (recent.size <= MAX_RECENT) break;
  }
}

// 只记录成功来源，图片仍由浏览器或 Web 头像缓存持有。
export const avatarRecovery = {
  peek(key: string) {
    return recent.get(key);
  },
  remember(key: string, success: AvatarSuccess) {
    const previous = recent.get(key);
    if (success.webKey && previous?.webKey === success.webKey && previous.src === success.src)
      return;
    recent.delete(key);
    recent.set(key, success);
    trim();
    for (const listener of listeners.get(key) ?? []) listener();
  },
  subscribe(key: string, listener: () => void) {
    const group = listeners.get(key) ?? new Set();
    listeners.set(key, group);
    group.add(listener);
    return () => {
      group.delete(listener);
      if (!group.size) {
        listeners.delete(key);
        trim();
      }
    };
  },
};
