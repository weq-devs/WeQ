/**
 * 导出表情包面板（导出中心 · emojipack 模式）。
 *
 * 两条来源：
 *   - 我的表情   emoji.db 收藏 + 本地 personal_emoji；缺原图用 CDN 补，补不到退缩略图；
 *   - 收到的表情 扫描本地 emoji-recv；只有缩略图的用缩略图补一份。
 *
 * 面板顶部是两张来源卡（统计 + 预览格 + 勾选），底部「导出」按钮起一个任务。
 * 图片字节不过 tRPC —— 预览走 weq-media://cemoji；进度与保存复用下方任务列表。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Check, Download, Heart, Inbox, Loader2, Sparkles } from 'lucide-react';
import type { EmojiExportScope, EmojiPreviewAddress, EmojiScopeSummary } from '@weq/service';
import { trpc, client } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { mediaUrl } from '../../lib/resourceUrl';
import { ShimmerImage } from '../../components/ShimmerImage';

/** cemoji 预览地址。 */
function cemojiUrl(addr: EmojiPreviewAddress): string {
  return mediaUrl('cemoji', {
    scope: addr.scope,
    bucket: addr.bucket,
    v: addr.variant,
    file: addr.file,
  });
}

const SCOPE_META: Record<
  EmojiExportScope,
  { label: string; desc: string; icon: ReactElement; tone: string }
> = {
  own: {
    label: '我的表情',
    desc: '收藏 / 自己添加的自定义表情（缺原图自动补全）',
    icon: <Heart size={16} />,
    tone: 'own',
  },
  received: {
    label: '收到的表情',
    desc: '聊天里收到的自定义表情（本地目录，缩略图补全）',
    icon: <Inbox size={16} />,
    tone: 'recv',
  },
};

/** 面板里的固定来源顺序。 */
const SCOPES: EmojiExportScope[] = ['own', 'received'];

export function EmojiPackExportPane({ onStarted }: { onStarted: () => void }): ReactElement {
  const dialog = useAppDialog();
  const summary = trpc.account.emojiPack.summary.useQuery(undefined, { staleTime: 20_000 });
  const [selected, setSelected] = useState<Set<EmojiExportScope>>(new Set(['own', 'received']));
  const [submitting, setSubmitting] = useState(false);

  const data = summary.data as { own: EmojiScopeSummary; received: EmojiScopeSummary } | undefined;

  const toggle = (scope: EmojiExportScope): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const selectedTotal = useMemo(() => {
    if (!data) return 0;
    let n = 0;
    for (const s of SCOPES) if (selected.has(s)) n += data[s].total;
    return n;
  }, [data, selected]);

  async function start(): Promise<void> {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      await client.account.emojiPack.startExport.mutate({ scopes: [...selected] });
      onStarted();
      dialog.info(
        '已开始导出',
        '导出任务已加入下方「导出任务列表」，完成后点任务上的「保存文件夹…」保存到本地。',
      );
    } catch (e) {
      dialog.error('启动导出失败', e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="weq-epk">
      <div className="weq-epk-head">
        <Sparkles size={15} />
        <span>
          选择要导出的表情来源；自己的表情会优先用原图，缺失时自动下载补全，再退缩略图兜底。
        </span>
      </div>

      <div className="weq-epk-scroll">
        <div className="weq-epk-grid">
          {SCOPES.map((scope) => (
            <ScopeCard
              key={scope}
              scope={scope}
              summary={data?.[scope]}
              loading={summary.isLoading}
              checked={selected.has(scope)}
              onToggle={() => toggle(scope)}
            />
          ))}
        </div>
      </div>

      <div className="weq-epk-actions">
        <span className="weq-epk-actions-count">
          {selected.size === 0
            ? '请至少选择一种来源'
            : `已选 ${selected.size} 种来源 · 约 ${selectedTotal.toLocaleString('en-US')} 张`}
        </span>
        <button
          type="button"
          className="weq-epk-start"
          disabled={selected.size === 0 || submitting || summary.isLoading}
          onClick={() => void start()}
        >
          {submitting ? <Loader2 size={15} className="is-spin" /> : <Download size={15} />}
          导出
        </button>
      </div>
    </div>
  );
}

/** 一张来源卡：标题 + 统计条 + 预览格 + 勾选层。 */
function ScopeCard({
  scope,
  summary,
  loading,
  checked,
  onToggle,
}: {
  scope: EmojiExportScope;
  summary?: EmojiScopeSummary;
  loading: boolean;
  checked: boolean;
  onToggle: () => void;
}): ReactElement {
  const meta = SCOPE_META[scope];
  const sample = summary?.sample ?? [];
  return (
    <div className={`weq-epk-card is-${meta.tone}${checked ? ' is-checked' : ''}`}>
      <button
        type="button"
        className="weq-epk-card-head"
        onClick={onToggle}
        aria-pressed={checked}
        title={checked ? '取消选择' : '选择'}
      >
        <span className="weq-epk-card-check">{checked ? <Check size={13} /> : null}</span>
        <span className="weq-epk-card-icon">{meta.icon}</span>
        <span className="weq-epk-card-titles">
          <strong>{meta.label}</strong>
          <small>{meta.desc}</small>
        </span>
        <span className="weq-epk-card-count">
          {loading ? '…' : `${(summary?.total ?? 0).toLocaleString('en-US')} 张`}
        </span>
      </button>

      <div className="weq-epk-card-stats">
        <Stat label="原图" value={summary?.withOri ?? 0} />
        <Stat label="缩略图" value={summary?.thumbOnly ?? 0} />
        <Stat label="可下载" value={summary?.downloadable ?? 0} />
        {summary && summary.missing > 0 ? <Stat label="缺失" value={summary.missing} warn /> : null}
      </div>

      <div className="weq-epk-stage">
        {loading && sample.length === 0 ? (
          <div className="weq-epk-stage-empty">加载中…</div>
        ) : sample.length === 0 ? (
          <div className="weq-epk-stage-empty">本地暂无该来源的表情</div>
        ) : (
          <div className="weq-epk-cells">
            {sample.map((addr) => (
              <PreviewCell key={`${addr.scope}:${addr.bucket}:${addr.key}`} addr={addr} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: number;
  warn?: boolean;
}): ReactElement {
  return (
    <span className={`weq-epk-stat${warn ? ' is-warn' : ''}`}>
      <em>{label}</em>
      <b>{value.toLocaleString('en-US')}</b>
    </span>
  );
}

/** 一张预览表情：cemoji 缩略图 / 原图，失败显示占位。 */
function PreviewCell({ addr }: { addr: EmojiPreviewAddress }): ReactElement {
  const [broken, setBroken] = useState(false);
  return (
    <span className="weq-epk-cell">
      {broken ? (
        <Sparkles size={16} strokeWidth={1.3} className="weq-epk-cell-fallback" />
      ) : (
        <ShimmerImage
          src={cemojiUrl(addr)}
          alt={addr.file}
          loading="lazy"
          draggable={false}
          onError={() => setBroken(true)}
        />
      )}
    </span>
  );
}
