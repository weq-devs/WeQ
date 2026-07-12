/**
 * 头像缓存路径计算器 — enter a QQ number, see exactly where QQ cached that
 * avatar on disk, and WHY (the hash derivation is shown as the rationale).
 *
 *   friend:  uin --profile_info_v6--> uid ┐
 *   group:   uin == uid (numeric)         ├─> hash = md5(md5(md5(uid)+uid)+uid)
 *                                         ┘   path = avatar/<scope>/<hash[:2]>/[b_|s_]<hash>
 *
 * The path + on-disk presence come from `account.avatarResource.computePath`;
 * the preview points at the same `weq-media://avatar` protocol the grid uses.
 */

import { useCallback, useState, type ReactElement } from 'react';
import { X, Search, User, Users, Copy, Check } from 'lucide-react';
import type { AvatarPathProbe } from '@weq/service';
import { Modal } from '../../components/Dialog';
import { client } from '../../trpc/client';

type Kind = 'user' | 'group';

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** weq-media URL for the resolved avatar (by hash — same as the grid). */
function previewSrc(probe: AvatarPathProbe, variant: 'big' | 'small'): string {
  return `weq-media://avatar?scope=${probe.scope}&hash=${probe.hash}&v=${variant}`;
}

export function AvatarPathDialog({ onClose }: { onClose: () => void }): ReactElement {
  const [kind, setKind] = useState<Kind>('user');
  const [qq, setQq] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<AvatarPathProbe | null>(null);

  const run = useCallback(async (): Promise<void> => {
    const trimmed = qq.trim();
    if (!/^\d+$/.test(trimmed)) {
      setError('请输入纯数字的 QQ 号 / 群号');
      setProbe(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await client.account.avatarResource.computePath.query({ kind, qq: trimmed });
      setProbe(result);
      if (!result.resolved) {
        setError(
          kind === 'user'
            ? '未在 profile_info_v6 找到该 QQ 的资料，无法解析 uid（不是好友或资料未缓存）'
            : '无效的群号',
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProbe(null);
    } finally {
      setLoading(false);
    }
  }, [kind, qq]);

  return (
    <Modal onClose={onClose} labelledBy="weq-avpath-title" width={452}>
      <div className="weq-avpath">
        <div className="weq-avpath-head">
          <h3 id="weq-avpath-title" className="weq-avpath-title">
            头像缓存路径计算器
          </h3>
          <button className="weq-dialog-x" onClick={onClose} aria-label="关闭">
            <X size={16} strokeWidth={1.9} aria-hidden />
          </button>
        </div>

        {/* kind toggle + input */}
        <div className="weq-avpath-form">
          <div className="weq-avpath-seg">
            <button
              type="button"
              className={`weq-avpath-segbtn${kind === 'user' ? ' is-on' : ''}`}
              onClick={() => setKind('user')}
            >
              <User size={14} /> 好友
            </button>
            <button
              type="button"
              className={`weq-avpath-segbtn${kind === 'group' ? ' is-on' : ''}`}
              onClick={() => setKind('group')}
            >
              <Users size={14} /> 群聊
            </button>
          </div>
          <input
            className="weq-avpath-input"
            value={qq}
            inputMode="numeric"
            placeholder={kind === 'user' ? '输入 QQ 号' : '输入群号'}
            onChange={(e) => setQq(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run();
            }}
          />
          <button className="weq-action-primary weq-avpath-go" onClick={() => void run()} disabled={loading}>
            <Search size={14} /> {loading ? '计算中…' : '计算'}
          </button>
        </div>

        {/* algorithm — shown as the rationale, always visible */}
        <div className="weq-avpath-algo">
          <span className="weq-avpath-algo-label">算法依据</span>
          <code className="weq-avpath-algo-code">
            hash = md5( md5( md5(uid) + uid ) + uid )
          </code>
          <code className="weq-avpath-algo-code">
            path = avatar/&lt;scope&gt;/&lt;hash 前两位&gt;/（b_大图 | s_缩略图）+ hash
          </code>
          <p className="weq-avpath-algo-note">
            好友：uin 经 <b>profile_info_v6</b> 表查出 uid；群聊：uin 即 uid（纯数字）。三重 MD5 均为十六进制字符串拼接。
          </p>
        </div>

        {error ? <div className="weq-avpath-error">{error}</div> : null}

        {probe && probe.resolved ? <ProbeResult probe={probe} /> : null}
      </div>
    </Modal>
  );
}

function ProbeResult({ probe }: { probe: AvatarPathProbe }): ReactElement {
  const onDisk = probe.hasBig || probe.hasSmall;
  const [variant, setVariant] = useState<'big' | 'small'>(probe.hasBig ? 'big' : 'small');

  return (
    <div className="weq-avpath-result">
      <div className="weq-avpath-preview">
        {onDisk ? (
          <img
            src={previewSrc(probe, variant)}
            alt={probe.hash}
            onError={() => {
              if (variant === 'big' && probe.hasSmall) setVariant('small');
            }}
          />
        ) : (
          <span className="weq-avpath-preview-empty">本地无缓存</span>
        )}
      </div>

      <div className="weq-avpath-fields">
        <Field label="uid">
          <span className="weq-avpath-mono">{probe.uid}</span>
          {probe.nick ? <em className="weq-avpath-nick">（{probe.nick}）</em> : null}
        </Field>
        <Field label="hash">
          <span className="weq-avpath-mono weq-avpath-hash">{probe.hash}</span>
        </Field>
        <PathRow label="大图" rel={probe.bigRel} on={probe.hasBig} bytes={probe.bigBytes} />
        <PathRow label="缩略图" rel={probe.smallRel} on={probe.hasSmall} bytes={probe.smallBytes} />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): ReactElement {
  return (
    <div className="weq-avpath-field">
      <span className="weq-avpath-field-label">{label}</span>
      <div className="weq-avpath-field-val">{children}</div>
    </div>
  );
}

function PathRow({
  label,
  rel,
  on,
  bytes,
}: {
  label: string;
  rel: string;
  on: boolean;
  bytes: number;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(rel).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [rel]);

  return (
    <div className="weq-avpath-field">
      <span className="weq-avpath-field-label">
        {label}
        <span className={`weq-avpath-badge is-${on ? 'on' : 'off'}`}>
          {on ? fmtBytes(bytes) : '缺失'}
        </span>
      </span>
      <div className="weq-avpath-field-val weq-avpath-pathrow">
        <span className="weq-avpath-mono weq-avpath-path">{rel}</span>
        <button className="weq-avpath-copy" onClick={copy} title="复制路径" aria-label="复制路径">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}
