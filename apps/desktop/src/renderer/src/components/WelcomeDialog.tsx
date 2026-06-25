/**
 * 首次使用引导 —— 欢迎使用 WeQ 说明框.
 *
 * 在「打开账号之后」（而不是软件启动时）弹出一次。用户必须点击「开始使用」
 * 才能关闭（无 ESC / 点遮罩关闭），确认后写入全局配置
 * `welcomeAcknowledged=true`，之后不再出现。
 *
 * 挂载点：App.tsx，仅当 `view === 'main'`（即已进入账号）时渲染，因此自动进入
 * 与手动进入两条路径都会覆盖到。是否显示由本组件内部根据
 * `bootstrap.getWelcomeAcknowledged` 决定。
 */

import { useState, type ReactElement } from 'react';
import { Github, KeyRound, ScrollText, Sparkles, Images, Loader2 } from 'lucide-react';
import { trpc } from '../trpc/client';
import { Modal } from './Dialog';
import logoUrl from '@resources/brand/logo.png';

const REPO_URL = 'https://github.com/H3CoF6/WeQ';

export function WelcomeDialog(): ReactElement | null {
  const ack = trpc.bootstrap.getWelcomeAcknowledged.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const acknowledge = trpc.bootstrap.acknowledgeWelcome.useMutation();
  // Hide immediately on confirm even before the persist round-trips, so the
  // button never feels laggy. The query result gates the *first* show.
  const [dismissed, setDismissed] = useState(false);

  // Wait for a definitive `false` before showing — while loading (`undefined`)
  // or once acknowledged (`true`) we render nothing.
  if (dismissed || ack.data !== false) return null;

  async function onConfirm(): Promise<void> {
    setDismissed(true);
    try {
      await acknowledge.mutateAsync();
    } catch {
      // Persisting is best-effort: we already closed the dialog for this
      // session. Worst case it shows again next launch — acceptable.
    }
  }

  return (
    <Modal labelledBy="weq-welcome-title" width={528}>
      <div className="weq-welcome">
        <header className="weq-welcome-hero">
          <span className="weq-welcome-badge">
            <Sparkles size={13} strokeWidth={2} aria-hidden />
            首次使用
          </span>
          <img src={logoUrl} alt="" width={64} height={64} className="weq-welcome-logo" />
          <h2 id="weq-welcome-title" className="weq-welcome-title">
            欢迎使用 WeQ
          </h2>
          <p className="weq-welcome-tagline">完全自主解密、解析本地 QQ 数据库</p>
        </header>

        <div className="weq-welcome-body">
          <section className="weq-welcome-row">
            <span className="weq-welcome-ico">
              <KeyRound size={16} strokeWidth={1.85} aria-hidden />
            </span>
            <div className="weq-welcome-text">
              <p>
                WeQ 完全自主解密、解析本地 QQ 数据库读取聊天记录，密钥等凭据的获取依赖
                hook 等手段。
              </p>
              <p className="weq-welcome-sub">
                开源、完全免费 ——{' '}
                <a href={REPO_URL} target="_blank" rel="noreferrer" className="weq-welcome-link">
                  <Github size={12} strokeWidth={1.9} aria-hidden />
                  github.com/H3CoF6/WeQ
                </a>
                。若你是付费获取的，请来仓库提 issue。
              </p>
            </div>
          </section>

          {/* 重点：醒目的高亮卡片 */}
          <section className="weq-welcome-highlight">
            <span className="weq-welcome-highlight-ico">
              <Images size={18} strokeWidth={1.9} aria-hidden />
            </span>
            <div className="weq-welcome-highlight-text">
              <strong>QQ 不会主动下载媒体文件</strong>
              <p>
                建议保持 QQ 进程登录在线，以获得更好的体验 —— 查看和导出本地尚未缓存的
                <em> 媒体 / 公告 / 相册</em>。
              </p>
            </div>
          </section>

          <section className="weq-welcome-row weq-welcome-disclaimer">
            <span className="weq-welcome-ico">
              <ScrollText size={16} strokeWidth={1.85} aria-hidden />
            </span>
            <div className="weq-welcome-text">
              <p className="weq-welcome-disclaimer-title">免责声明</p>
              <p className="weq-welcome-sub">
                仅限用于解密你自己的消息数据库，供研究与学习，不得用于其它违法或商业用途。
                hook、数据库读取/修改均存在风险，开发者不对由此造成的任何后果负责。
              </p>
            </div>
          </section>
        </div>

        <footer className="weq-welcome-foot">
          <button
            type="button"
            className="weq-action-primary weq-welcome-cta"
            onClick={() => void onConfirm()}
            disabled={acknowledge.isLoading}
          >
            {acknowledge.isLoading ? (
              <Loader2 size={14} strokeWidth={2} className="animate-spin" aria-hidden />
            ) : null}
            我已阅读并同意，开始使用
          </button>
        </footer>
      </div>
    </Modal>
  );
}
