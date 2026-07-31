/**
 * 网页版的 QQ 空间 / QQ 频道入口 —— 一张「在新标签页打开」的卡片。
 *
 * 桌面版把这两个站点嵌在 `<webview>` 里（见 EmbeddedBrowserView），浏览器里做不到：
 * user.qzone.qq.com 与 pd.qq.com 都发 X-Frame-Options，iframe 会被拒；跨站 cookie
 * 也不是我们能替浏览器写的。
 *
 * 所以改为：点击时向后端现取一条 ptlogin2 跳转 URL（带一次性 clientKey），交给浏览器
 * 开新标签。302 链在浏览器里跑完，登录 cookie 落进浏览器自己的 jar —— 等价于用户
 * 手动登录了一次，之后再访问都是登录态。
 *
 * QQ 没在线（拿不到 clientKey）时后端退回裸地址，用户自己在新标签里登录。
 */

import { useState, type ReactElement } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useDialog } from '../components/Dialog';

export function ExternalSiteView({
  site,
  label,
  desc,
  icon,
}: {
  site: 'qzone' | 'channel';
  label: string;
  desc: string;
  icon: ReactElement;
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const resolve = trpc.account.getExternalSiteUrl.useMutation();
  const [autoLogin, setAutoLogin] = useState<boolean | null>(null);

  async function open(): Promise<void> {
    try {
      const res = await resolve.mutateAsync({ site });
      setAutoLogin(res.autoLogin);
      // 先开窗再等异步会被拦截器挡下，所以这里接受「用户点击→请求→开窗」的延迟。
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      showError(`打开${label}失败`, e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="weq-extsite">
      <div className="weq-extsite-card">
        <span className="weq-extsite-icon">{icon}</span>
        <h2 className="weq-extsite-title">{label}</h2>
        <p className="weq-extsite-desc">{desc}</p>
        <button
          type="button"
          className="weq-extsite-btn"
          onClick={() => void open()}
          disabled={resolve.isLoading}
        >
          {resolve.isLoading ? (
            <Loader2 size={16} strokeWidth={1.9} className="weq-spin" aria-hidden />
          ) : (
            <ExternalLink size={16} strokeWidth={1.9} aria-hidden />
          )}
          在新标签页打开
        </button>
        <p className="weq-extsite-hint">
          {autoLogin === false
            ? '当前账号的 QQ 未在线，无法免登录跳转 —— 新标签里需要自己登录一次。'
            : '会带上当前账号的登录跳转，在新标签里直接是登录态。'}
        </p>
      </div>
    </div>
  );
}
