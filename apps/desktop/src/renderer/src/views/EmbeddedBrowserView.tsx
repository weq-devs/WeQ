/**
 * 内嵌浏览器视图（QQ 空间 / QQ 频道共用）。
 *
 * 用一个 Electron `<webview>` 把远程页面（user.qzone.qq.com / pd.qq.com）嵌进主
 * 窗口，取代原来另开的独立 BrowserWindow。进入视图时先调用主进程的 `prepare`：
 * 它按当前账号解析出持久化 session 分区（`persist:qqzone-…` / `persist:qqchannel-…`
 * ——与独立窗口共用同一套），并在首次导航前把自动登录 cookie 种进去，然后返回
 * `{ partition, url }`。拿到后才渲染 `<webview>`，用同一 partition 加载，登录状态
 * 与持久化 cookie 完全沿用旧逻辑。
 *
 * 安全：`<webview>` 不挂主窗口 preload，也不开 nodeIntegration —— 远程内容拿不到
 * 应用的 tRPC 特权桥，隔离级别与旧的沙箱独立窗口一致。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useThemeStore } from '../state/theme';

/** `<webview>` 是 Electron 注入的自定义元素，给 TSX 补一个最小类型声明。 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: boolean;
        },
        HTMLElement
      >;
    }
  }
}

type PreparedTarget = { partition: string; url: string };

type EmbeddedBrowserBridge = {
  prepare(theme?: 'system' | 'light' | 'dark'): Promise<PreparedTarget>;
  setTheme(theme: 'system' | 'light' | 'dark'): Promise<boolean>;
};

export function EmbeddedBrowserView({
  bridge,
  label,
}: {
  /** `window.weq.qzone` 或 `window.weq.channel`。 */
  bridge: EmbeddedBrowserBridge | undefined;
  /** 加载失败时展示用的名称，如「QQ 空间」。 */
  label: string;
}): ReactElement {
  const [target, setTarget] = useState<PreparedTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preference = useThemeStore((s) => s.preference);

  // 进入视图时准备一次：种 cookie + 拿 partition/url。主题用当前值，避免闪一下
  // 默认色。partition 一旦定下就不再变（换账号是整页重挂，见 MainView 的 key）。
  useEffect(() => {
    let alive = true;
    if (!bridge) {
      setError('内嵌浏览器桥不可用');
      return;
    }
    bridge
      .prepare(useThemeStore.getState().preference)
      .then((result) => {
        if (alive) setTarget(result);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [bridge]);

  // 主题实时跟随：WeQ 深/浅切换时推给主进程（nativeTheme 是进程级的，webview 的
  // prefers-color-scheme 随之更新）。
  useEffect(() => {
    void bridge?.setTheme(preference);
  }, [bridge, preference]);

  if (error) {
    return (
      <div className="weq-embedded-browser weq-embedded-browser-error">
        <p>{label}加载失败：{error}</p>
      </div>
    );
  }

  if (!target) {
    return (
      <div className="weq-embedded-browser weq-embedded-browser-loading">
        <p>正在加载{label}…</p>
      </div>
    );
  }

  return (
    <div className="weq-embedded-browser">
      <EmbeddedWebview partition={target.partition} src={target.url} />
    </div>
  );
}

/**
 * 裸 `<webview>` 封装。`allowpopups` 打开，让 QQ 扫码 / 快捷登录的子弹窗能弹出，
 * 且共享同一 partition —— cookie 落进同一个按账号隔离的 jar，与独立窗口的
 * `setWindowOpenHandler('allow')` 行为对齐。
 */
function EmbeddedWebview({
  partition,
  src,
}: {
  partition: string;
  src: string;
}): ReactElement {
  const ref = useRef<HTMLElement>(null);

  // React 不认识 boolean 的 allowpopups，用 DOM 属性显式设一次。
  useEffect(() => {
    const el = ref.current;
    if (el) el.setAttribute('allowpopups', 'true');
  }, []);

  return (
    <webview
      ref={ref}
      src={src}
      partition={partition}
      style={{ width: '100%', height: '100%', border: 'none' }}
    />
  );
}
