/**
 * 首次运行引导 —— 欢迎使用 WeQ 说明框.
 *
 * 在「打开账号之后」（而不是软件启动时）弹出一次。用户必须点击「开始使用」
 * 才能关闭（无 ESC / 点遮罩关闭），确认后写入全局配置
 * `welcomeAcknowledged=true` + `welcomePolicyVersion`，之后不再出现。
 *
 * v2.0.0 起这个框还承担一个职责：**征询是否扫描 QQ 内存**。以前
 * `autoAttachQq` 默认开启，用户根本不知道可以关；现在默认关闭，由本框
 * 把「扫描内存能解锁什么」讲清楚后交由用户自己勾选（默认预勾选 = 推荐）。
 * 开关状态随「开始使用」一起经 `acknowledgeWelcome` 落盘。
 *
 * 版本门：`bootstrap.getWelcomeAcknowledged` 会把「确认过的策略版本低于当前版本」
 * 的旧配置视为「未确认」，因此升级到 v2.0.0 时所有用户的这个框都会重新弹一次
 * （见 service 的 WELCOME_POLICY_VERSION）。
 *
 * 挂载点：App.tsx，仅当 `view === 'main'`（即已进入账号）时渲染，因此自动进入
 * 与手动进入两条路径都会覆盖到。是否显示由本组件内部根据
 * `bootstrap.getWelcomeAcknowledged` 决定。
 */

import { useState, type ReactElement } from 'react';
import { Check, Github, KeyRound, Loader2, ScrollText, ShieldCheck, Sparkles } from 'lucide-react';
import { trpc } from '../trpc/client';
import { Modal } from './Dialog';
import { Toggle } from './settings/controls';
import logoUrl from '@resources/brand/logo.png';

const REPO_URL = 'https://github.com/H3CoF6/WeQ';

/** 扫描 QQ 内存能解锁的在线能力（本框的核心说服点）。 */
const MEMORY_SCAN_FEATURES: ReadonlyArray<{ title: string; desc: string }> = [
  { title: '拉取漫游消息', desc: '把本地数据库里没有的历史聊天记录补回来' },
  { title: '下载本地不存在的媒体', desc: '图片 / 语音 / 视频 / 文件，缺失时按需补全' },
  { title: '发送消息', desc: '直接在 WeQ 里回复、撤回、发送媒体' },
  { title: '群操作与群管理', desc: '进群、审批入群、禁言、发公告等' },
  { title: '一键反馈 bug', desc: '把问题直接带回开发者，无需手动整理' },
  { title: '群相册 / 空间 / 装扮', desc: '配合 rKey、ClientKey 等凭证查看在线内容' },
];

export function WelcomeDialog(): ReactElement | null {
  const ack = trpc.bootstrap.getWelcomeAcknowledged.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const acknowledge = trpc.bootstrap.acknowledgeWelcome.useMutation();
  // Hide immediately on confirm even before the persist round-trips, so the
  // button never feels laggy. The query result gates the *first* show.
  const [dismissed, setDismissed] = useState(false);
  // 默认勾选（推荐）：告知用户可以关闭，但大多数人的目标就是完整体验。
  const [allowMemoryScan, setAllowMemoryScan] = useState(true);

  // Wait for a definitive `false` before showing — while loading (`undefined`)
  // or once acknowledged (`true`) we render nothing.
  if (dismissed || ack.data !== false) return null;

  async function onConfirm(): Promise<void> {
    setDismissed(true);
    try {
      await acknowledge.mutateAsync({ allowMemoryScan });
    } catch {
      // Persisting is best-effort: we already closed the dialog for this
      // session. Worst case it shows again next launch — acceptable.
    }
  }

  return (
    <Modal labelledBy="weq-welcome-title" width="min(760px, calc(100vw - 3rem))">
      <div className="weq-welcome">
        <header className="weq-welcome-hero">
          <span className="weq-welcome-badge">
            <Sparkles size={13} strokeWidth={2} aria-hidden />
            新版本 · 完整体验
          </span>
          <img src={logoUrl} alt="" width={52} height={52} className="weq-welcome-logo" />
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
                WeQ 完全自主解密、解析本地 QQ 数据库读取聊天记录。基础查看与导出无需任何额外权限，
                完全在本机离线完成。
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

          {/* 重点：扫描 QQ 内存的知情同意 */}
          <section className="weq-welcome-scan">
            <header className="weq-welcome-scan-head">
              <span className="weq-welcome-scan-ico">
                <ShieldCheck size={18} strokeWidth={1.9} aria-hidden />
              </span>
              <div className="weq-welcome-scan-head-text">
                <strong>开启完整体验（推荐）</strong>
                <p>扫描登录中的 QQ 进程内存可获得在线能力。不开启也能正常浏览与导出。</p>
              </div>
            </header>

            <ul className="weq-welcome-scan-list">
              {MEMORY_SCAN_FEATURES.map((feature) => (
                <li key={feature.title} className="weq-welcome-scan-item">
                  <Check
                    size={13}
                    strokeWidth={2.6}
                    aria-hidden
                    className="weq-welcome-scan-check"
                  />
                  <span>
                    <b>{feature.title}</b>
                    <em>{feature.desc}</em>
                  </span>
                </li>
              ))}
            </ul>

            <div className="weq-welcome-scan-toggle">
              <div className="weq-welcome-scan-toggle-text">
                <span>允许扫描 QQ 内存</span>
                <small>
                  凭证只在本机处理，不上传；Linux / macOS 首次可能需要一次管理员密码。随时可在
                  「设置 → 账号基础」关闭。
                </small>
              </div>
              <Toggle
                checked={allowMemoryScan}
                onChange={setAllowMemoryScan}
                label="允许扫描 QQ 内存"
              />
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
                读取内存、数据库读取/修改均存在风险，开发者不对由此造成的任何后果负责。
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
            {allowMemoryScan ? '开启完整体验并开始使用' : '以离线模式开始使用'}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
