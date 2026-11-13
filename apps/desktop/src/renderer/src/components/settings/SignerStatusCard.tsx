import * as timeFormat from '@weq/time';
/**
 * 设置 → 诊断工具 → 「签名器」卡片。
 *
 * 完整模式发包要借 QQ `wrapper.node` 里的 VM / sign core 算 `SecSign`。两个入口
 * 的 RVA 随 QQ 版本变化，扫一次要 2.5–3 秒（140–200 MB 的模块），所以 WeQ 在
 * 启动期就把结果按「版本 + 文件 hash」缓存下来，命中时只 dlopen + 校验。
 *
 * 这块只做三件事：把状态摊开给用户看、说明当前走的是哪条签名路径、给一个手动的
 * 「重新扫描」。真正的扫描逻辑都在主进程（`bootstrap.signerStatus` / `rescanSigner`）。
 */

import { useState, type ReactElement } from 'react';
import { Info, RefreshCw, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { Card } from './controls';
import '../../styles/signer-status.css';

/** ISO → 「2026-10-16 08:39」本地时间；无效返回 null。 */
function fmtDateTime(ms: number | null | undefined): string | null {
  return ms ? timeFormat.formatDateTime(ms) || null : null;
}

function fmtRva(rva: number | null | undefined): string {
  return typeof rva === 'number' ? `0x${rva.toString(16)}` : '未定位';
}

/** 缓存状态 → 一行总结 + 图标。 */
function summarize(status: {
  state: 'hit' | 'stale' | 'missing';
  signCoreRva: number | null;
  vmRva: number | null;
  pathUsed: string | null;
}): { icon: ReactElement; text: string; tone: string } {
  if (status.state === 'missing' || status.signCoreRva === null)
    return {
      icon: <ShieldQuestion size={16} strokeWidth={1.8} aria-hidden />,
      text: '还没扫描过这个版本；启动时会自动扫，也可以点「重新扫描」。',
      tone: 'muted',
    };
  if (status.state === 'stale')
    return {
      icon: <ShieldQuestion size={16} strokeWidth={1.8} aria-hidden />,
      text: 'wrapper.node 已经变化（QQ 更新过），缓存失效，需要重新扫描。',
      tone: 'warn',
    };
  if (status.vmRva === null)
    return {
      icon: <ShieldAlert size={16} strokeWidth={1.8} aria-hidden />,
      text: '已定位 sign core，但没定位到 VM；签名会退回完整签名函数（较慢，且只发 SecSign）。',
      tone: 'warn',
    };
  return {
    icon: <ShieldCheck size={16} strokeWidth={1.8} aria-hidden />,
    text: '已定位 sign core 与 VM，签名走自建状态机（最快路径）。',
    tone: 'ok',
  };
}

export function SignerStatusCard(): ReactElement {
  const autoRefresh = useQQAutoRefresh(true);
  const status = trpc.bootstrap.signerStatus.useQuery(undefined, autoRefresh);
  const rescan = trpc.bootstrap.rescanSigner.useMutation();
  const [error, setError] = useState('');

  const data = status.data;
  const busy = status.isLoading || rescan.isPending;
  const warmup = rescan.data?.warmup ?? data?.warmup ?? null;
  const summary = data ? summarize(data) : null;

  async function onRescan(): Promise<void> {
    setError('');
    try {
      await rescan.mutateAsync();
      await status.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card
      title="签名器（wrapper.node）"
      icon={<ShieldCheck size={15} strokeWidth={1.8} />}
      settingId="signer-status"
    >
      <dl className="weq-signer-kv">
        <dt>QQ 版本</dt>
        <dd className="weq-number">{data?.version ?? '未知'}</dd>
        <dt>文件</dt>
        <dd className="weq-number weq-signer-path" title={data?.wrapperPath ?? ''}>
          {data?.wrapperPath ?? '未找到 wrapper.node'}
        </dd>
        <dt>SHA-256</dt>
        <dd className="weq-number">
          {data?.sha256 ? `${data.sha256.slice(0, 16)}…${data.sha256.slice(-8)}` : '—'}
        </dd>
        <dt>sign core RVA</dt>
        <dd className="weq-number">{fmtRva(data?.signCoreRva)}</dd>
        <dt>VM RVA</dt>
        <dd className="weq-number">
          {fmtRva(data?.vmRva)}
          {data?.vmKind ? `（${data.vmKind}）` : ''}
        </dd>
        <dt>上次确认</dt>
        <dd className="weq-number">{fmtDateTime(data?.verifiedAt) ?? '—'}</dd>
      </dl>

      {summary ? (
        <p className={`weq-set-note${summary.tone === 'warn' ? ' weq-set-note-warn' : ''}`}>
          {summary.icon} {summary.text}
        </p>
      ) : null}

      {!data?.supported ? (
        <p className="weq-set-note weq-set-note-warn">
          <Info size={12} strokeWidth={1.9} aria-hidden /> 当前内置组件不支持预热接口（较早的 native
          构建）；签名时仍会现场扫描，只是慢一些。跑一次 <code>pnpm native:fetch</code> 更新即可。
        </p>
      ) : null}

      {warmup && warmup.outcome === 'failed' ? (
        <p className="weq-set-note weq-set-note-warn">
          <Info size={12} strokeWidth={1.9} aria-hidden /> 上次扫描失败：
          {warmup.error ?? '未知原因'}
        </p>
      ) : null}

      {error ? <p className="weq-set-note weq-set-note-warn">{error}</p> : null}

      <div className="weq-set-actions">
        <button
          type="button"
          className="weq-set-btn weq-set-btn-soft"
          disabled={busy}
          onClick={() => void onRescan()}
          title="重新定位 sign core 与 VM（命中缓存时只做加载校验）"
        >
          <RefreshCw
            size={14}
            strokeWidth={1.8}
            aria-hidden
            className={busy ? 'weq-spin' : undefined}
          />
          {busy ? '扫描中…' : '重新扫描'}
        </button>
      </div>
    </Card>
  );
}
