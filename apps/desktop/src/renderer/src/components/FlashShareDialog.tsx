/**
 * 闪传分享弹窗 —— 把 sharelink 嵌进一个竖屏小窗口展示。
 *
 * 头部只留标题 + 关闭，不露地址栏 / 前进后退，看着不像浏览器窗口。加载 QQ 分享页
 * 时注入安卓 QQ 的 UA，让服务端按手机 Web 版页面返回。
 *
 * 安全：`<webview>` 不挂主窗口 preload、不开 nodeIntegration，远程页面拿不到应用的
 * tRPC 特权桥 —— 与 EmbeddedBrowserView 的隔离级别一致。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Loader2, X } from 'lucide-react';
import { Modal } from './Dialog';
import { useThemeStore } from '../state/theme';

/** QQ 安卓 Web 版 UA —— 分享页按手机版渲染。 */
const QQ_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; V2238A Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36 V1_AND_SQ_9.1.65_6256_YYB_D QQ/9.1.65.12345 NetType/5G WebP/0.4.0';

export function FlashShareDialog({
  title,
  url,
  onClose,
}: {
  title: string;
  url: string;
  onClose: () => void;
}): ReactElement {
  const webviewRef = useRef<HTMLElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // React 不认识 boolean 的 allowpopups，用 DOM 属性显式设一次（同 EmbeddedBrowserView）；
  // 分享页里「用 QQ 打开」之类的子弹窗由此能弹出。
  useEffect(() => {
    const el = webviewRef.current;
    if (!el) return;
    el.setAttribute('allowpopups', 'true');
    const onStart = (): void => setLoading(true);
    const onStop = (): void => setLoading(false);
    const onFail = (event: Event): void => {
      // 只认主 frame 的失败，子资源（广告/埋点）失败不打扰用户。
      const detail = (event as CustomEvent<{ isMainFrame?: boolean }>).detail;
      if (detail?.isMainFrame === false) return;
      setLoading(false);
      setError('页面加载失败，可能链接已失效');
    };
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-fail-load', onFail);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-fail-load', onFail);
    };
  }, []);

  // QQ 分享页原生支持 prefers-color-scheme 深色。打开时把进程级 nativeTheme 同步到
  // WeQ 当前深浅（resolved），让页面跟随应用主题；关闭时恢复为偏好，避免连带影响
  // 空间/频道等其他 webview（写死 dark 会把整个应用在浅色模式下带深）。
  useEffect(() => {
    void window.weq?.flashShare?.setTheme?.(useThemeStore.getState().resolved);
    return () => {
      void window.weq?.flashShare?.setTheme?.(useThemeStore.getState().preference);
    };
  }, []);

  return (
    <Modal onClose={onClose} width={430}>
      <div className="weq-flash-share">
        <div className="weq-flash-share-head">
          <span className="weq-flash-share-title" title={title}>
            {title || 'QQ闪传'}
          </span>
          <button
            type="button"
            className="weq-flash-share-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <X size={16} strokeWidth={1.9} aria-hidden />
          </button>
        </div>
        <div className="weq-flash-share-body">
          {error ? (
            <div className="weq-flash-share-error">
              <p>{error}</p>
            </div>
          ) : (
            <>
              <webview
                ref={webviewRef}
                src={url}
                partition="flash-share"
                useragent={QQ_MOBILE_UA}
                className="weq-flash-share-webview"
              />
              {loading ? (
                <div className="weq-flash-share-loading">
                  <Loader2 size={22} strokeWidth={1.9} className="weq-spin" aria-hidden />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
