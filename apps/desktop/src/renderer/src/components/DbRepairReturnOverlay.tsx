/**
 * 「修复完成，N 秒后回到首页」的浮动提示。
 *
 * 挂载在 `App`，与 BootstrapView / MainView 同层级（**不是**妙妙工具弹窗里），所以关掉
 * 弹窗、切回首页都不会把它弄丢 —— 理由见 `state/dbRepairReturn.ts`。
 *
 * 为什么非要回首页：修复在替换库文件前会先 `clearAccount()`（Windows 上 `rename` 会被
 * 占用挡住；Linux 上旧 inode 还在被读）。那一刻起主进程里账号已经关了，而渲染层还停在
 * 主界面上 —— 用户看到的就是「会话列表都在、头像没有、点会话读不到消息」。重新走一次
 * `openAccount`（也就是从首页重新打开）就完全正常。所以这里不是"建议"，是必须。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { DB_REPAIR_RETURN_SECONDS, useDbRepairReturn } from '../state/dbRepairReturn';
import { leaveAccountForBootstrap } from '../lib/leaveAccount';
import { useToast } from './Toast';

export function DbRepairReturnOverlay(): ReactElement | null {
  const pending = useDbRepairReturn((s) => s.pending);
  const disarm = useDbRepairReturn((s) => s.disarm);
  const pushToast = useToast((s) => s.push);
  const queryClient = useQueryClient();
  const [left, setLeft] = useState(DB_REPAIR_RETURN_SECONDS);
  const [leaving, setLeaving] = useState(false);
  /** 守卫：`go` 只能跑一次（倒计时与「立即返回」可能同时到）。 */
  const goRef = useRef(false);

  // 每次 arm 都从 `pending.seconds` 重新开始倒数（修完一次又修一次也能正确重来）。
  const seconds = pending?.seconds ?? DB_REPAIR_RETURN_SECONDS;
  useEffect(() => {
    if (!pending) return;
    goRef.current = false;
    setLeaving(false);
    setLeft(seconds);
  }, [pending, seconds]);

  /** 关账号 + 清账号级缓存 + 回首页；失败也要走完，否则用户卡在坏界面里。 */
  const go = useCallback(async (): Promise<void> => {
    if (goRef.current) return;
    goRef.current = true;
    setLeaving(true);
    // 直接读 store（而不是闭包里的 `pending`）：这样 `go` 的引用永远是稳定的，
    // 计时器不会因为它换了个身份而被重建。
    const warn = useDbRepairReturn.getState().pending?.tone === 'warn';
    try {
      await leaveAccountForBootstrap(queryClient);
      pushToast({
        tone: 'info',
        title: '已回到启动页',
        detail: warn
          ? '回到首页重新打开这个账号再试一次 —— 这次没能替换成功。'
          : '回到首页重新打开这个账号，修复后的数据库就会生效（头像、消息都恢复正常）。',
      });
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '退回启动页失败',
        detail: `${e instanceof Error ? e.message : String(e)}（可以在左下角账号菜单里手动「退出」）`,
      });
    } finally {
      disarm();
    }
  }, [disarm, pushToast, queryClient]);

  // 倒计时：one-second step，走到 0 就自己回首页。依赖里的 `go` 是 `useCallback`
  // 稳定引用（它的依赖也都是稳定的 store action / queryClient），不会让计时器重建。
  useEffect(() => {
    if (!pending || leaving) return undefined;
    if (left <= 0) {
      void go();
      return undefined;
    }
    const timer = window.setTimeout(() => setLeft((current) => current - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [pending, leaving, left, go]);

  if (!pending) return null;

  return (
    <div
      className={`weq-rp-return${pending.tone === 'warn' ? ' is-warn' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="weq-rp-return-icon" aria-hidden>
        {leaving ? (
          <Loader2 size={18} strokeWidth={2} className="weq-spin" />
        ) : pending.tone === 'warn' ? (
          <AlertTriangle size={18} strokeWidth={2} />
        ) : (
          <CheckCircle2 size={18} strokeWidth={2} />
        )}
      </span>
      <span className="weq-rp-return-text">
        <strong>{pending.title}</strong>
        <span>{pending.detail}</span>
        <span className="weq-rp-return-count">
          {leaving ? '正在回到启动页…' : `${left} 秒后自动回到启动页`}
        </span>
      </span>
      <button
        type="button"
        className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
        disabled={leaving}
        onClick={() => void go()}
      >
        立即返回
      </button>
    </div>
  );
}
