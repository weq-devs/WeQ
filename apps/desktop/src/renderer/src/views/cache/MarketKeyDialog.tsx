/**
 * 商城表情包「密钥计算器」——独立弹窗，两种查密钥方式，与当前浏览的包解耦：
 *
 *   时间戳 → 密钥：本地按 `md5(str(秒级时间戳))[:16]` 派生（纯演示解密原理，离线）。
 *   pack_id → 密钥：在线查询 native `getMarketFaceKey`（读种子 / updateTime 附近爆破），
 *                   查到后可「查看该表情包」跳转到详情页浏览其表情。
 *
 * 照搬头像资源页「算路径」计算器的交互与视觉（主题色统一）。
 */

import { useCallback, useState, type ReactElement } from 'react';
import { X, Search, Clock, Package, Copy, Check, Eye } from 'lucide-react';
import type { MarketPackKey } from '@weq/service';
import { Modal } from '../../components/Dialog';
import { client } from '../../trpc/client';
import { keySourceLabel } from './MarketPackExplorer';

type Mode = 'timestamp' | 'packId';

export function MarketKeyDialog({
  onClose,
  onView,
}: {
  onClose: () => void;
  /** 用户在 pack_id 模式查到密钥后点「查看该表情包」——跳转详情页。 */
  onView: (packId: string) => void;
}): ReactElement {
  const [mode, setMode] = useState<Mode>('timestamp');
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MarketPackKey | null>(null);
  const [queriedPackId, setQueriedPackId] = useState<string | null>(null);

  const run = useCallback(async (): Promise<void> => {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      setError(mode === 'timestamp' ? '请输入纯数字的秒级时间戳' : '请输入纯数字的 pack_id');
      setResult(null);
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setQueriedPackId(null);
    try {
      if (mode === 'timestamp') {
        // 任意 packId 占位即可——给了 timestamp 就走本地 md5 派生，不查网络。
        const r = await client.account.marketEmoji.getPackKey.query({
          packId: '1',
          timestamp: Number(trimmed),
        });
        if (!r) setError('派生失败');
        else setResult(r);
      } else {
        const r = await client.account.marketEmoji.getPackKey.query({ packId: trimmed });
        if (!r) setError('未能查到该表情包的密钥（付费包可能需要在线 QQ，或包不存在）');
        else {
          setResult(r);
          setQueriedPackId(trimmed);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [mode, value]);

  const switchMode = (m: Mode): void => {
    setMode(m);
    setValue('');
    setError(null);
    setResult(null);
    setQueriedPackId(null);
  };

  return (
    <Modal onClose={onClose} labelledBy="weq-mkey-title" width={452}>
      <div className="weq-avpath">
        <div className="weq-avpath-head">
          <h3 id="weq-mkey-title" className="weq-avpath-title">
            商城表情包密钥计算器
          </h3>
          <button className="weq-dialog-x" onClick={onClose} aria-label="关闭">
            <X size={16} strokeWidth={1.9} aria-hidden />
          </button>
        </div>

        {/* 模式切换 + 输入 */}
        <div className="weq-avpath-form">
          <div className="weq-avpath-seg">
            <button
              type="button"
              className={`weq-avpath-segbtn${mode === 'timestamp' ? ' is-on' : ''}`}
              onClick={() => switchMode('timestamp')}
            >
              <Clock size={14} /> 时间戳
            </button>
            <button
              type="button"
              className={`weq-avpath-segbtn${mode === 'packId' ? ' is-on' : ''}`}
              onClick={() => switchMode('packId')}
            >
              <Package size={14} /> pack_id
            </button>
          </div>
          <input
            className="weq-avpath-input"
            value={value}
            inputMode="numeric"
            placeholder={mode === 'timestamp' ? '输入秒级时间戳' : '输入表情包 pack_id'}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run();
            }}
          />
          <button className="weq-action-primary weq-avpath-go" onClick={() => void run()} disabled={loading}>
            <Search size={14} /> {loading ? '计算中…' : mode === 'timestamp' ? '派生' : '查询'}
          </button>
        </div>

        {/* 算法依据（常驻） */}
        <div className="weq-avpath-algo">
          <span className="weq-avpath-algo-label">算法依据</span>
          <code className="weq-avpath-algo-code">key = md5( str(秒级时间戳) )[:16]</code>
          <p className="weq-avpath-algo-note">
            {mode === 'timestamp' ? (
              <>本地直接派生：把时间戳做 MD5，取十六进制摘要前 16 个字符即为 QQTEA 密钥。</>
            ) : (
              <>
                在线查询：由 <b>pack_id</b> 取包元数据，读种子时间戳或在 <b>updateTime</b>{' '}
                附近的时间窗内爆破，命中后再套上式派生密钥。
              </>
            )}
          </p>
        </div>

        {error ? <div className="weq-avpath-error">{error}</div> : null}

        {result ? (
          <KeyResult
            result={result}
            packId={queriedPackId}
            onView={queriedPackId ? () => onView(queriedPackId) : undefined}
          />
        ) : null}
      </div>
    </Modal>
  );
}

function KeyResult({
  result,
  packId,
  onView,
}: {
  result: MarketPackKey;
  packId: string | null;
  onView?: () => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(result.key).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [result.key]);

  return (
    <div className="weq-avpath-result">
      <div className="weq-avpath-fields">
        <div className="weq-avpath-field">
          <span className="weq-avpath-field-label">密钥</span>
          <div className="weq-avpath-field-val weq-avpath-pathrow">
            <span className="weq-avpath-mono weq-avpath-hash">{result.key}</span>
            <button className="weq-avpath-copy" onClick={copy} title="复制密钥" aria-label="复制密钥">
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </div>
        <div className="weq-avpath-field">
          <span className="weq-avpath-field-label">时间戳</span>
          <div className="weq-avpath-field-val">
            <span className="weq-avpath-mono">{result.timestamp}</span>
            <em className="weq-avpath-nick">（{keySourceLabel(result.source)}）</em>
          </div>
        </div>
        {packId ? (
          <div className="weq-avpath-field">
            <span className="weq-avpath-field-label">pack_id</span>
            <div className="weq-avpath-field-val weq-avpath-pathrow">
              <span className="weq-avpath-mono">{packId}</span>
              {onView ? (
                <button type="button" className="weq-mpack-view-btn" onClick={onView}>
                  <Eye size={13} /> 查看该表情包
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
