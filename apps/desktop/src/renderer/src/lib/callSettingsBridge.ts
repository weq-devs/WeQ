/**
 * 跨窗口的轻量指令通道。
 *
 * 通话窗口是 `window.open` 出来的独立窗口 —— **同源、同进程**，但没有共享的
 * React 状态。需要让主界面做点什么（比如「打开设置页的通话与录音」）时，走
 * `localStorage` 的 `storage` 事件：它在同源的所有窗口里触发，且不需要建立
 * 长连接，也不会因为窗口被关掉而泄漏监听。
 *
 * 为什么不用 `postMessage`：那要求持有对端窗口的引用（`opener` 在弹窗被重开
 * 或从别处打开时不一定可靠），而 `storage` 是广播语义，谁在听谁就响应。
 */

/** 通话窗口 → 主界面：打开设置页并定位到某一节。 */
export const OPEN_SETTINGS_COMMAND = 'weq:open-settings';

export type SettingsSection = 'callRecording';

interface OpenSettingsPayload {
  section: SettingsSection;
  /** 每次递增，保证重复点击也能触发（`storage` 只在值变化时发事件）。 */
  nonce: number;
}

/** 请求主界面打开设置页的指定一节。 */
export function requestOpenSettings(section: SettingsSection): void {
  const payload: OpenSettingsPayload = { section, nonce: Date.now() };
  try {
    window.localStorage.setItem(OPEN_SETTINGS_COMMAND, JSON.stringify(payload));
  } catch {
    // 隐私模式 / 配额满：跳转失败不影响通话，静默即可。
  }
}

/** 在主界面里监听这个请求。返回取消订阅。 */
export function onOpenSettingsRequest(handler: (section: SettingsSection) => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== OPEN_SETTINGS_COMMAND || !event.newValue) return;
    try {
      const payload = JSON.parse(event.newValue) as OpenSettingsPayload;
      if (payload.section) handler(payload.section);
    } catch {
      // 值被别的东西写坏了，忽略。
    }
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}
