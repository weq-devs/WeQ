/**
 * 商城表情包浏览器（本地资源 → 商城表情包分类）。
 *
 * 与「商城表情」磁盘浏览器（MarketEmojiExplorer，直接读 nt_data/Emoji/marketface
 * 文件）不同：这里读 emoji.db 的 market_emoticon_package_table 拿到「我添加的表情包
 * 清单」，再对每个包在线拉 android.json 补全来源(feetype)/介绍/表情列表，点进去看
 * 该包全部表情——图片走 CDN 加密流 + QQTEA 解密（packId 自动恢复密钥）。
 *
 *   列表：一包一张大卡片（封面 + 名称 + 介绍 + 来源徽章：免费/付费/SVIP/VIP）
 *   详情：顶部信息条（来源/介绍/密钥 + 解密原理）+ 表情网格
 *   密钥计算器：独立弹窗——时间戳→密钥（本地 md5）/ pack_id→密钥（在线查询，可跳转查看）
 *
 * 图片字节不过 tRPC —— <img> 指向 weq-media://mface?...&enc=tea（见 media_protocol）。
 */

import { useState, type ReactElement } from 'react';
import { ArrowLeft, KeyRound, RefreshCw, ChevronDown, Store, Sparkles, Calculator } from 'lucide-react';
import type { MarketEmoticonPackage, MarketPackFeeType } from '@weq/service';
import { trpc } from '../../trpc/client';
import { mediaUrl } from '../../lib/resourceUrl';
import { MarketKeyDialog } from './MarketKeyDialog';

/** 来源徽章元信息（文案 + 色调 class 后缀）。 */
const FEE_META: Record<MarketPackFeeType, { label: string; tone: string }> = {
  free: { label: '免费', tone: 'free' },
  paid: { label: '付费', tone: 'paid' },
  svip: { label: 'SVIP', tone: 'svip' },
  vip: { label: 'VIP', tone: 'vip' },
  unknown: { label: '未知', tone: 'unknown' },
};

/** weq-media URL：商城表情包的一张表情（TEA 解密路径，密钥后端自动恢复）。 */
function packImageUrl(packId: string, hash: string): string {
  return mediaUrl('mface', { pack: packId, hash, enc: 'tea' });
}

export function MarketPackExplorer(): ReactElement {
  const [openPackId, setOpenPackId] = useState<string | null>(null);
  const [showKeyTool, setShowKeyTool] = useState(false);
  const packages = trpc.account.marketEmoji.listPackages.useQuery();

  const keyDialog = showKeyTool ? (
    <MarketKeyDialog
      onClose={() => setShowKeyTool(false)}
      onView={(packId) => {
        setOpenPackId(packId);
        setShowKeyTool(false);
      }}
    />
  ) : null;

  if (openPackId) {
    return (
      <>
        <PackDetail
          packId={openPackId}
          onBack={() => setOpenPackId(null)}
          onOpenKeyTool={() => setShowKeyTool(true)}
        />
        {keyDialog}
      </>
    );
  }

  const list = packages.data ?? [];

  if (packages.isLoading) {
    return <div className="weq-cache-grid-state">读取本地表情包清单中…</div>;
  }
  if (packages.error) {
    return <div className="weq-cache-grid-state is-error">{packages.error.message}</div>;
  }

  return (
    <div className="weq-mpack">
      <div className="weq-mpack-bar">
        <span className="weq-cache-data-name">商城表情包</span>
        <span className="weq-cache-data-meta">
          {list.length} 个 · 点击表情包在线获取表情列表并解密查看
        </span>
        <button type="button" className="weq-mpack-keytool-btn" onClick={() => setShowKeyTool(true)}>
          <Calculator size={14} /> 密钥计算器
        </button>
      </div>
      {list.length === 0 ? (
        <div className="weq-cache-grid-state">未找到本地添加的商城表情包</div>
      ) : (
        <div className="weq-cache-avatar-scroll">
          <div className="weq-mpack-grid">
            {list.map((pkg) => (
              <PackCard key={pkg.packId} pkg={pkg} onOpen={() => setOpenPackId(pkg.packId)} />
            ))}
          </div>
        </div>
      )}
      {keyDialog}
    </div>
  );
}

/** 列表大卡片：封面(首张表情) + 名称 + 介绍 + 来源徽章。详情懒加载补全。 */
function PackCard({ pkg, onOpen }: { pkg: MarketEmoticonPackage; onOpen: () => void }): ReactElement {
  const detail = trpc.account.marketEmoji.getPackDetail.useQuery({ packId: pkg.packId });
  const [broken, setBroken] = useState(false);

  const fee = FEE_META[detail.data?.feeType ?? 'unknown'];
  const cover = detail.data?.items[0]?.hash;
  const summary = detail.data?.summary || pkg.summary;

  return (
    <button type="button" className="weq-mpack-card" onClick={onOpen} title={pkg.name}>
      <span className="weq-mpack-cover">
        {cover && !broken ? (
          <img
            src={packImageUrl(pkg.packId, cover)}
            alt={pkg.name}
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
          />
        ) : (
          <Store size={30} strokeWidth={1.3} className="weq-mpack-cover-fallback" />
        )}
        <em className={`weq-mpack-fee is-${fee.tone}`}>{fee.label}</em>
      </span>
      <span className="weq-mpack-info">
        <strong className="weq-mpack-name">{pkg.name || `表情包 ${pkg.packId}`}</strong>
        <small className="weq-mpack-summary">{summary || '暂无介绍'}</small>
        <span className="weq-mpack-foot">
          <code>#{pkg.packId}</code>
          {detail.data ? <span>{detail.data.count} 张</span> : <span className="weq-mpack-loading">…</span>}
        </span>
      </span>
    </button>
  );
}

/** 详情页：信息条（来源/介绍/密钥 + 原理）+ 表情网格。 */
function PackDetail({
  packId,
  onBack,
  onOpenKeyTool,
}: {
  packId: string;
  onBack: () => void;
  onOpenKeyTool: () => void;
}): ReactElement {
  const detail = trpc.account.marketEmoji.getPackDetail.useQuery({ packId });
  const keyInfo = trpc.account.marketEmoji.getPackKey.useQuery({ packId });
  const [showPrinciple, setShowPrinciple] = useState(false);

  const fee = FEE_META[detail.data?.feeType ?? 'unknown'];
  const items = detail.data?.items ?? [];

  return (
    <div className="weq-mpack-detail">
      <div className="weq-mpack-detail-head">
        <button type="button" className="weq-mpack-back" onClick={onBack}>
          <ArrowLeft size={15} /> 返回
        </button>
        <span className="weq-mpack-detail-title">
          {detail.data?.name || `表情包 ${packId}`}
          <em className={`weq-mpack-fee is-${fee.tone}`}>{fee.label}</em>
        </span>
        <button type="button" className="weq-mpack-keytool-btn" onClick={onOpenKeyTool}>
          <Calculator size={14} /> 密钥计算器
        </button>
      </div>

      {detail.isLoading ? (
        <div className="weq-cache-grid-state">获取表情包详情中…</div>
      ) : !detail.data ? (
        <div className="weq-cache-grid-state is-error">
          无法获取该表情包详情（网络问题或包不存在）
        </div>
      ) : (
        <>
          {/* 信息条：介绍 + 上架时间 + 密钥（当前包自动恢复）+ 可展开原理 */}
          <div className="weq-mpack-panel">
            <div className="weq-mpack-panel-row">
              <span className="weq-mpack-panel-label">介绍</span>
              <span className="weq-mpack-panel-val">{detail.data.summary || '暂无介绍'}</span>
            </div>
            <div className="weq-mpack-panel-row">
              <span className="weq-mpack-panel-label">上架时间</span>
              <span className="weq-mpack-panel-val weq-mpack-mono">
                {detail.data.updateTime
                  ? new Date(detail.data.updateTime * 1000).toLocaleString('zh-CN')
                  : '未知'}
              </span>
            </div>
            <div className="weq-mpack-panel-row">
              <span className="weq-mpack-panel-label">
                <KeyRound size={13} /> 解密密钥
              </span>
              <span className="weq-mpack-panel-val">
                {keyInfo.data ? (
                  <>
                    <code className="weq-mpack-key">{keyInfo.data.key}</code>
                    <em className="weq-mpack-key-src">
                      {keySourceLabel(keyInfo.data.source)} · 时间戳 {keyInfo.data.timestamp}
                    </em>
                  </>
                ) : keyInfo.isLoading ? (
                  <span className="weq-mpack-loading">恢复密钥中…</span>
                ) : (
                  <span className="weq-mpack-key-fail">未能恢复密钥（可用密钥计算器手动查询）</span>
                )}
              </span>
            </div>

            {/* 解密原理（可展开，放在信息条末尾，不打断密钥行） */}
            <button
              type="button"
              className={`weq-mpack-principle-toggle${showPrinciple ? ' is-open' : ''}`}
              onClick={() => setShowPrinciple((v) => !v)}
            >
              <Sparkles size={13} /> 解密原理
              <ChevronDown size={14} className="weq-mpack-chevron" />
            </button>
            {showPrinciple ? (
              <div className="weq-mpack-principle">
                <p>
                  商城表情的加密动图对所有人公开可下载，付费门禁只在「能否拿到密钥」。密钥
                  <b>完全由资源生成的秒级时间戳派生</b>，与账号无关：
                </p>
                <code className="weq-mpack-principle-code">key = md5( str(时间戳) )[:16]</code>
                <p>
                  时间戳有两条来源：① 免费/VIP 包的 xydata 元数据直接带；② 付费包拿不到时，
                  在 <b>上架时间(updateTime) 附近的时间窗内爆破</b>——用已知明文 GIF 头验证
                  TEA 前两块即可秒级命中。
                </p>
                <code className="weq-mpack-principle-code">
                  明文ᵢ = Dec( 密文ᵢ ⊕ 上块中间值 ) ⊕ 上块密文　（腾讯交织链式 TEA，非标准 CBC）
                </code>
              </div>
            ) : null}
          </div>

          {/* 表情网格 */}
          <div className="weq-cache-avatar-scroll">
            <div className="weq-mpack-emoji-grid">
              {items.map((it) => (
                <EmojiCell key={it.hash} packId={packId} hash={it.hash} name={it.name} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 一张表情：TEA 解密后的 GIF（密钥后端自动恢复）；失败显示占位。 */
function EmojiCell({ packId, hash, name }: { packId: string; hash: string; name: string }): ReactElement {
  const [broken, setBroken] = useState(false);
  return (
    <figure className="weq-mpack-emoji" title={name || hash}>
      <span className="weq-mpack-emoji-stage">
        {broken ? (
          <RefreshCw size={18} strokeWidth={1.4} className="weq-mpack-emoji-fallback" />
        ) : (
          <img
            src={packImageUrl(packId, hash)}
            alt={name || hash}
            loading="lazy"
            draggable={false}
            onError={() => setBroken(true)}
          />
        )}
      </span>
      {name ? <figcaption className="weq-mpack-emoji-name">{name}</figcaption> : null}
    </figure>
  );
}

/** 密钥来源 → 中文标签。 */
export function keySourceLabel(source: string): string {
  switch (source) {
    case 'xydata':
      return '元数据种子';
    case 'brute-force':
      return '时间窗爆破';
    case 'manual':
      return '手动派生';
    default:
      return source;
  }
}
