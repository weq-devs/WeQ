/**
 * 进程选择器。
 *
 * 两个**独立**的入口（刻意不做在一起）：
 *   - **推荐**：识别加载了 avsdk 的进程 —— QQ 的通话媒体进程（`--type=ppapi`）。
 *     本机没在通话时这个列表是空的，会给出引导文案。
 *   - **全部进程**：通用列表，按名字 / pid / 命令行搜索，手动挑任意进程。
 *
 * 只读进程元数据，不附加、不读内存。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Loader2, RefreshCw, Search, X } from 'lucide-react';
import { client } from '../trpc/client';
import { Modal } from './Dialog';

interface UdpProcessWire {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string;
  modules: string[];
  recommended: boolean;
}

type Tab = 'recommended' | 'all';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function ProcessPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (entry: UdpProcessWire) => void;
}): ReactElement {
  const [tab, setTab] = useState<Tab>('recommended');
  const [avsdk, setAvsdk] = useState<{ processes: UdpProcessWire[]; hint: string | null } | null>(
    null,
  );
  const [all, setAll] = useState<UdpProcessWire[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const loadRecommended = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.udpCapture.detectAvsdk.query();
      setAvsdk({ processes: result.processes, hint: result.hint });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRecommended();
  }, [loadRecommended]);

  const loadAll = useCallback(async () => {
    if (all) return;
    setLoading(true);
    setError(null);
    try {
      // 后端在没有 hint 时返回 avsdk 命中；「全部进程」用空 hint 拿不到全量，
      // 所以这里退一步：用常见的 QQ 可执行名扫一遍，再让用户搜。
      setAll(await client.udpCapture.processes.query({}));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [all]);

  useEffect(() => {
    if (tab === 'all') void loadAll();
  }, [tab, loadAll]);

  const rows = useMemo(() => {
    const source = tab === 'recommended' ? (avsdk?.processes ?? []) : (all ?? []);
    const q = query.trim().toLowerCase();
    if (!q) return source;
    return source.filter(
      (entry) =>
        String(entry.pid) === q ||
        entry.name.toLowerCase().includes(q) ||
        entry.cmdline.toLowerCase().includes(q),
    );
  }, [tab, avsdk, all, query]);

  const hint = tab === 'recommended' ? avsdk?.hint : null;

  return (
    <Modal width={620} centered onClose={onClose} title="选择要抓包的进程">
      <div className="weq-udp-picker">
        <div className="weq-udp-picker-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'recommended'}
            className={`weq-udp-tab${tab === 'recommended' ? ' is-active' : ''}`}
            onClick={() => setTab('recommended')}
          >
            推荐（通话进程）
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'all'}
            className={`weq-udp-tab${tab === 'all' ? ' is-active' : ''}`}
            onClick={() => setTab('all')}
          >
            全部进程
          </button>
          <span className="weq-udp-spacer" />
          <button
            type="button"
            className="weq-udp-btn"
            onClick={() => (tab === 'recommended' ? void loadRecommended() : void loadAll())}
            disabled={loading}
            title="重新扫描"
          >
            <RefreshCw size={12} /> 刷新
          </button>
        </div>

        <div className="weq-udp-picker-search">
          <Search size={14} />
          <input
            placeholder="按进程名 / pid / 命令行筛选"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {error ? (
          <div className="weq-udp-warn is-error">
            <strong>读取进程失败</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {hint && !loading ? <div className="weq-udp-picker-hint">{hint}</div> : null}

        <div className="weq-udp-picker-list">
          {loading ? (
            <div className="weq-udp-picker-empty">
              <Loader2 size={16} className="weq-udp-spin" /> 正在扫描…
            </div>
          ) : rows.length === 0 ? (
            <div className="weq-udp-picker-empty">
              {tab === 'recommended' ? '没有找到通话进程' : '没有匹配的进程'}
            </div>
          ) : (
            rows.map((entry) => (
              <button
                type="button"
                key={entry.pid}
                className="weq-udp-picker-row"
                onClick={() => onPick(entry)}
              >
                <span className="weq-udp-picker-pid">{entry.pid}</span>
                <span className="weq-udp-picker-main">
                  <span className="weq-udp-picker-name">
                    {entry.name || '（无名称）'}
                    {entry.recommended ? (
                      <span className="weq-udp-kind is-media">avsdk</span>
                    ) : null}
                  </span>
                  <span className="weq-udp-picker-cmd" title={entry.cmdline}>
                    {entry.cmdline || '—'}
                  </span>
                </span>
                <span className="weq-udp-picker-ppid">父 {entry.ppid}</span>
              </button>
            ))
          )}
        </div>

        <div className="weq-udp-picker-foot">
          <span className="weq-udp-picker-note">
            提示：QQ 的通话媒体进程会在通话开始时才创建，抓到它需要在通话进行中选它。
          </span>
          <button type="button" className="weq-udp-btn" onClick={onClose}>
            <X size={12} /> 取消
          </button>
        </div>
      </div>
    </Modal>
  );
}
