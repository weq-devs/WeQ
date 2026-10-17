/**
 * 妙妙工具 → QQ 登陆账号管理。
 *
 * 一页把「这台机器上 QQ 认得哪些号」讲清楚，并提供三个动作：
 *
 *   1. **移除快登**：清掉该账号在 `login.db` 里缓存的 a1 —— 下次 QQ 启动它不再
 *      出现在快速登录列表，要重新输密码 / 扫码。
 *   2. **删除账号（真删）**：把该行从 `login.db` 删掉。**聊天记录 / 账号目录不动**，
 *      这个按钮的语义是"这台机器上别再出现这个号"。
 *   3. **随机更换 guid**：让本机在服务端眼里变成一台新设备。
 *
 * 三条写路径共用一个闸门：**必须在所有 QQ 实例都退出时才能执行**。`login.db`
 * 与 msf 下的设备标识文件都由 QQ 常驻读写，在线时改会被它覆盖回去（用户看到的是
 * "点了没反应"）。闸门用 QQ 自己记的 `launcherCounts`（实例数）判断，所以界面上
 * 直接把这个事实摆出来：顶部一条状态条 + 按钮置灰 + 说明为什么。
 *
 * 颜色全部走 design token（含 `--weq-accent-effective`），深色是独立一套覆盖（钩在
 * `html[data-theme="dark"]` 上，不用 Tailwind 的 `dark:`），样式表在同名 `.css` 里。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Fingerprint,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from './QqAvatar';
import { useToast } from './Toast';
import '../styles/login-account.css';

/** 与主进程 `LoginAccountEntry` 对齐（渲染层只认"主进程答应给的形状"）。 */
interface LoginAccountRow {
  uin: string;
  uid: string;
  userName: string;
  avatarUrl: string;
  lastLoginAt: number;
  hasA1: boolean;
  a1Bytes: number;
  dataDir: string | null;
  dbPaths: string[];
}

interface OverviewView {
  accounts: LoginAccountRow[];
  guid: string | null;
  qqInstanceCount: number;
  canWrite: boolean;
  dataRoot: string | null;
  supported: boolean;
}

type BusyAction = 'refresh' | 'a1' | 'delete' | 'guid';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function humanTime(sec: number): string {
  if (!sec) return '从未登录';
  try {
    return new Date(sec * 1000).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(sec);
  }
}

/** 只显示 guid 的头尾，中间省略 —— 32 位全铺出来会把一行撑爆。 */
function shortGuid(guid: string): string {
  return guid.length > 20 ? `${guid.slice(0, 10)}…${guid.slice(-8)}` : guid;
}

export function LoginAccountPanel(): ReactElement {
  const toast = useToast();
  const [overview, setOverview] = useState<OverviewView | null>(null);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedGuid, setCopiedGuid] = useState(false);
  /** 正在等二次确认的账号（删除是不可逆的，必须点两下）。 */
  const [confirmDeleteUin, setConfirmDeleteUin] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setBusy('refresh');
    setError(null);
    try {
      setOverview(await client.wonderfulTools.loginAccountsOverview.query());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const accounts = overview?.accounts ?? [];
  const quickLoginCount = useMemo(() => accounts.filter((a) => a.hasA1).length, [accounts]);
  const canWrite = overview?.canWrite === true;

  /** 写操作的统一包装：成功后刷新列表并弹一条 toast。 */
  const runWrite = useCallback(
    async (
      kind: BusyAction,
      action: () => Promise<unknown>,
      success: { title: string; detail?: string },
    ): Promise<void> => {
      setBusy(kind);
      setError(null);
      try {
        await action();
        await load();
        toast.push({ tone: 'success', title: success.title, detail: success.detail });
      } catch (e) {
        const message = errMsg(e);
        setError(message);
        toast.push({ tone: 'error', title: '操作失败', detail: message });
      } finally {
        setBusy(null);
      }
    },
    [load, toast],
  );

  function copyGuid(): void {
    if (!overview?.guid) return;
    void navigator.clipboard.writeText(overview.guid).then(() => {
      setCopiedGuid(true);
      window.setTimeout(() => setCopiedGuid(false), 1400);
    });
  }

  return (
    <div className="weq-login-acc">
      {/* ── 设备身份：本机 guid 是服务端认设备的依据 ── */}
      <section className="weq-login-acc-identity">
        <div className="weq-login-acc-identity-main">
          <span className="weq-login-acc-identity-icon">
            <Fingerprint size={16} strokeWidth={1.9} />
          </span>
          <div className="weq-login-acc-identity-text">
            <span className="weq-login-acc-identity-label">本机设备标识（guid）</span>
            <code className="weq-login-acc-identity-value">
              {overview?.guid ? shortGuid(overview.guid) : '未读取到'}
            </code>
          </div>
          {overview?.guid ? (
            <button
              type="button"
              className="weq-login-acc-icon-btn"
              onClick={copyGuid}
              title="复制完整 guid"
            >
              {copiedGuid ? <Check size={14} /> : <Copy size={14} />}
            </button>
          ) : null}
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            disabled={!canWrite || busy !== null || overview?.supported !== true}
            title={
              overview?.supported === false
                ? '当前原生产物不支持更换 guid，请更新 nt_helper 产物后重试'
                : canWrite
                  ? '随机换一个设备 guid'
                  : '需要先完全退出 QQ'
            }
            onClick={() =>
              void runWrite('guid', () => client.wonderfulTools.loginAccountRotateGuid.mutate(), {
                title: '已更换设备 guid',
                detail: '下次登录时服务端会把本机当成一台新设备。',
              })
            }
          >
            {busy === 'guid' ? <Loader2 size={13} className="weq-spin" /> : <RefreshCw size={13} />}
            随机更换
          </button>
        </div>
        <p className="weq-login-acc-identity-hint">
          {overview?.supported === false
            ? '当前原生产物没有更换 guid 的能力，请更新 nt_helper 产物后重试。'
            : '换一个 guid 会让本机被识别为新设备；QQ 自己的登录状态不受影响。'}
        </p>
        {overview?.dataRoot ? (
          <p className="weq-login-acc-root" title={overview.dataRoot}>
            {overview.dataRoot}
          </p>
        ) : null}
      </section>

      {/* ── 写操作闸门：QQ 实例数 ── */}
      {canWrite ? (
        <div className="weq-login-acc-gate is-ready">
          <ShieldCheck size={14} strokeWidth={1.9} />
          <span>当前没有 QQ 在运行，可以安全修改登录数据。</span>
        </div>
      ) : (
        <div className="weq-login-acc-gate is-blocked">
          <AlertTriangle size={14} strokeWidth={1.9} />
          <span>
            检测到 {overview?.qqInstanceCount ?? '若干'} 个 QQ 实例正在运行 —— 请先
            <b>完全退出 QQ</b>。
          </span>
        </div>
      )}

      {/* ── 账号列表工具条 ── */}
      <div className="weq-login-acc-bar">
        <span className="weq-login-acc-count">
          共 {accounts.length} 个账号
          {quickLoginCount > 0 ? ` · ${quickLoginCount} 个可快速登录` : ''}
        </span>
        <button
          type="button"
          className="weq-wtools-refresh"
          onClick={() => void load()}
          disabled={busy !== null}
        >
          {busy === 'refresh' ? (
            <Loader2 size={13} className="weq-spin" />
          ) : (
            <RefreshCw size={13} />
          )}
          刷新
        </button>
      </div>

      {/* ── 列表 ── */}
      <div className="weq-login-acc-list">
        {busy === 'refresh' && !overview ? (
          <div className="weq-login-acc-state">
            <Loader2 size={20} className="weq-spin" />
            <span>正在读取登录记录…</span>
          </div>
        ) : error && !overview ? (
          <div className="weq-login-acc-state is-error">{error}</div>
        ) : accounts.length === 0 ? (
          <div className="weq-login-acc-state">没有读到任何登录记录，请先在 QQ 里登录过账号。</div>
        ) : (
          accounts.map((acc) => (
            <article key={acc.uin} className="weq-login-acc-card">
              <QqAvatar
                uin={acc.uin}
                url={acc.avatarUrl}
                size={40}
                className="weq-login-acc-avatar"
              />
              <div className="weq-login-acc-info">
                <div className="weq-login-acc-title">
                  <strong>{acc.userName || acc.uin}</strong>
                  <span className="weq-login-acc-uin">{acc.uin}</span>
                  {acc.hasA1 ? (
                    <span className="weq-login-acc-badge" title="login.db 里有缓存的 a1">
                      快速登录
                    </span>
                  ) : null}
                </div>
                <div className="weq-login-acc-meta">
                  <span>上次登录 {humanTime(acc.lastLoginAt)}</span>
                  {acc.dbPaths.length > 1 ? <span>{acc.dbPaths.length} 处登录记录</span> : null}
                  {acc.dataDir ? null : (
                    <span className="weq-login-acc-meta-warn">数据目录已不存在</span>
                  )}
                </div>
              </div>
              <div className="weq-login-acc-actions">
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={!canWrite || busy !== null || !acc.hasA1}
                  title={
                    acc.hasA1 ? '清掉缓存的 a1，下次需重新登录' : '这个账号没有缓存 a1，无需移除'
                  }
                  onClick={() =>
                    void runWrite(
                      'a1',
                      () => client.wonderfulTools.loginAccountRemoveA1.mutate({ uin: acc.uin }),
                      { title: `已移除 ${acc.userName || acc.uin} 的快速登录` },
                    )
                  }
                >
                  {busy === 'a1' ? (
                    <Loader2 size={13} className="weq-spin" />
                  ) : (
                    <LogOut size={13} />
                  )}
                  移除快登
                </button>
                {confirmDeleteUin === acc.uin ? (
                  <>
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-danger"
                      disabled={busy !== null}
                      onClick={() => {
                        setConfirmDeleteUin(null);
                        void runWrite(
                          'delete',
                          () => client.wonderfulTools.loginAccountDelete.mutate({ uin: acc.uin }),
                          {
                            title: `已删除账号 ${acc.userName || acc.uin}`,
                            detail: '聊天记录与账号目录未改动。',
                          },
                        );
                      }}
                    >
                      {busy === 'delete' ? (
                        <Loader2 size={13} className="weq-spin" />
                      ) : (
                        <Trash2 size={13} />
                      )}
                      确认删除
                    </button>
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      onClick={() => setConfirmDeleteUin(null)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft weq-set-btn-del"
                    disabled={!canWrite || busy !== null}
                    title="从 login.db 中删除该账号（不删聊天记录）"
                    onClick={() => setConfirmDeleteUin(acc.uin)}
                  >
                    <Trash2 size={13} />
                    删除
                  </button>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      {error && overview ? <div className="weq-login-acc-inline-error">{error}</div> : null}

      <p className="weq-login-acc-foot">
        <KeyRound size={12} strokeWidth={1.9} />
        删除账号只清理 QQ 的登录记录，聊天记录与数据目录保持不动。
      </p>
    </div>
  );
}
