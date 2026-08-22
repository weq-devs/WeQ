/**
 * 妙妙工具 —— 主窗口「更多功能 → 妙妙工具」弹窗。
 *
 * 布局：左侧工具列表 + 右侧工具界面。第一个工具是「密钥扫描」：
 *   - 后端遍历 login.db 的全部历史账号，逐个反查 `nt_msg.db` 目录与在线
 *     QQ 进程 pid（win32 走 Restart Manager、linux 走 fcntl 写锁，由
 *     platform.resolveQqPid 统一封装）。
 *   - 在线账号卡片亮起（绿色在线点 + 高亮），离线账号置灰。
 *   - 点击卡片 → 卡片加载动画 → 对账号进程做零注入内存扫描
 *     （nt_helper scanKeyFromDatabase），展示恢复的密钥或失败原因。
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Check, Copy, KeyRound, Loader2, RefreshCw, ScanSearch, X } from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from './QqAvatar';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';

interface AccountRow {
  uin: string;
  uid: string;
  userName: string;
  avatarUrl: string;
  lastLoginAt: number;
  dbPath: string | null;
  pid: number | null;
}

interface ScanResultWire {
  success: boolean;
  key?: string;
  error?: string;
}

interface ScanResultView extends ScanResultWire {
  uin: string;
  name: string;
  pid: number | null;
}

type ToolId = 'key-scan';

const TOOLS: { id: ToolId; label: string; desc: string }[] = [
  { id: 'key-scan', label: '密钥扫描', desc: '零注入内存扫描主密钥' },
];

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

export function WonderfulToolsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  const [activeTool, setActiveTool] = useState<ToolId>('key-scan');
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanningUin, setScanningUin] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResultView | null>(null);
  const [copied, setCopied] = useState(false);

  useEscapeToClose(onClose);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await client.wonderfulTools.overview.query();
      setAccounts(rows);
      // 账号列表刷新后，旧扫描结果不再可靠。
      setResult(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setResult(null);
      setScanningUin(null);
      void loadAccounts();
    }
  }, [open, loadAccounts]);

  async function scanAccount(acc: AccountRow): Promise<void> {
    setScanningUin(acc.uin);
    setResult(null);
    try {
      const r = await client.wonderfulTools.scanKey.query({ uin: acc.uin });
      setResult({ ...r, uin: acc.uin, name: acc.userName || acc.uin, pid: acc.pid });
    } catch (e) {
      setResult({
        success: false,
        error: errMsg(e),
        uin: acc.uin,
        name: acc.userName || acc.uin,
        pid: acc.pid,
      });
    } finally {
      setScanningUin(null);
    }
  }

  function copyKey(): void {
    if (!result?.key) return;
    void navigator.clipboard.writeText(result.key).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }

  if (!open) return null;

  const onlineCount = accounts.filter((a) => a.pid !== null).length;

  return (
    <div className="weq-wtools-layer" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <div
        className="weq-wtools-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weq-wtools-title"
      >
        <button className="weq-wtools-close" onClick={onClose} title="关闭" type="button">
          <X size={18} strokeWidth={2} />
        </button>

        <div className="weq-wtools-shell">
          {/* 左栏：工具列表 */}
          <aside className="weq-wtools-nav">
            <div className="weq-wtools-brand">
              <span className="weq-wtools-brand-icon">
                <ScanSearch size={17} strokeWidth={1.8} />
              </span>
              <span>妙妙工具</span>
            </div>
            <div className="weq-wtools-nav-list" role="tablist" aria-label="工具列表">
              {TOOLS.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTool === tool.id}
                  className={`weq-wtools-nav-item${activeTool === tool.id ? ' is-active' : ''}`}
                  onClick={() => {
                    setActiveTool(tool.id);
                    setResult(null);
                    setScanningUin(null);
                  }}
                >
                  <KeyRound size={16} strokeWidth={1.8} />
                  <span>
                    <strong>{tool.label}</strong>
                    <em>{tool.desc}</em>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          {/* 右栏：工具界面 */}
          <section className="weq-wtools-pane">
            {activeTool === 'key-scan' ? (
              <>
                <header className="weq-wtools-pane-head">
                  <div className="weq-wtools-pane-title">
                    <KeyRound size={17} strokeWidth={1.9} />
                    <h2 id="weq-wtools-title">密钥扫描</h2>
                    {!loading && accounts.length > 0 ? (
                      <span className="weq-wtools-total">
                        {onlineCount} / {accounts.length} 在线
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="weq-wtools-refresh"
                    onClick={() => void loadAccounts()}
                    disabled={loading}
                  >
                    <RefreshCw size={14} strokeWidth={1.9} className={loading ? 'weq-spin' : ''} />
                    刷新
                  </button>
                </header>

                <div className="weq-wtools-pane-body">
                  {loading ? (
                    <div className="weq-wtools-state">
                      <Loader2 size={22} className="weq-spin" />
                      <span>正在读取账号与在线状态…</span>
                    </div>
                  ) : error ? (
                    <div className="weq-wtools-state is-error">{error}</div>
                  ) : accounts.length === 0 ? (
                    <div className="weq-wtools-state">
                      未在 login.db 中发现历史账号，请先在 QQ / WeQ 登录过账号。
                    </div>
                  ) : (
                    <>
                      <div className="weq-wtools-grid">
                        {accounts.map((acc) => {
                          const online = acc.pid !== null;
                          const busy = scanningUin === acc.uin;
                          return (
                            <button
                              key={acc.uin}
                              type="button"
                              className={`weq-wtools-card${online ? ' is-online' : ' is-offline'}${busy ? ' is-busy' : ''}`}
                              onClick={() => void scanAccount(acc)}
                              disabled={busy}
                              title={
                                online
                                  ? `在线 · PID ${acc.pid} · 上次登录 ${humanTime(acc.lastLoginAt)}，点击扫描密钥`
                                  : `离线账号 · 上次登录 ${humanTime(acc.lastLoginAt)}，点击尝试扫描`
                              }
                            >
                              <span className="weq-wtools-card-avatar">
                                <QqAvatar uin={acc.uin} url={acc.avatarUrl} size={44} />
                                <i className="weq-wtools-card-dot" aria-hidden />
                              </span>
                              <span className="weq-wtools-card-id">
                                <strong>{acc.userName || acc.uin}</strong>
                                <em>{acc.uin}</em>
                              </span>
                              <span className="weq-wtools-card-status">
                                {busy ? (
                                  <Loader2 size={13} className="weq-spin" aria-label="扫描中" />
                                ) : online ? (
                                  <span className="is-online-text">在线</span>
                                ) : (
                                  <span className="is-offline-text">离线</span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      <div className="weq-wtools-result">
                        {scanningUin ? (
                          <div className="weq-wtools-state">
                            <Loader2 size={20} className="weq-spin" />
                            <span>正在扫描进程内存并验证密钥…</span>
                          </div>
                        ) : result ? (
                          result.success && result.key ? (
                            <div className="weq-wtools-result-ok">
                              <div className="weq-wtools-result-head">
                                <span className="weq-wtools-result-ok-badge">扫描成功</span>
                                <span className="weq-wtools-result-meta">
                                  {result.name} · PID {result.pid ?? '-'}
                                </span>
                              </div>
                              <div className="weq-wtools-key-row">
                                <code>{result.key}</code>
                                <button
                                  type="button"
                                  className="weq-wtools-copy"
                                  onClick={copyKey}
                                  title="复制密钥"
                                >
                                  {copied ? <Check size={15} /> : <Copy size={15} />}
                                  {copied ? '已复制' : '复制'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="weq-wtools-result-err">
                              <div className="weq-wtools-result-head">
                                <span className="weq-wtools-result-err-badge">扫描未成功</span>
                                <span className="weq-wtools-result-meta">
                                  {result.name} · {result.pid ? `PID ${result.pid}` : '离线'}
                                </span>
                              </div>
                              <p>{result.error ?? '未知错误'}</p>
                            </div>
                          )
                        ) : (
                          <div className="weq-wtools-result-hint">
                            <KeyRound size={16} strokeWidth={1.7} />
                            <span>
                              点击上方账号卡片开始扫描。在线账号显示为亮色，离线账号为灰色。
                            </span>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
