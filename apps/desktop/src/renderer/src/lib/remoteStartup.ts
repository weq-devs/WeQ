export type RemoteStartupState = {
  state: 'loading' | 'ready' | 'error' | 'action-required';
  message?: string;
};

declare global {
  interface Window {
    weqRemoteStartup?: RemoteStartupState;
  }
}

/** 保存最新状态，允许原生壳在 HTML 加载完成后补读，不依赖事件先后顺序。 */
export function publishRemoteStartup(state: RemoteStartupState): void {
  window.weqRemoteStartup = state;
  window.dispatchEvent(new Event('weq-remote-startup'));
}
