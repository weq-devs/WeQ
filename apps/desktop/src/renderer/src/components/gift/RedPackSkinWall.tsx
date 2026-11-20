import { NumericText } from '../NumericText';
import { dateFormatter } from '@weq/time';
/**
 * 红包封面展柜 —— 个性装扮里的「红包封面」一栏。
 *
 * 数据**只来自仓库里的 `resources/redpack/skins.json`**：不联网、不要求 QQ 在线、
 * 不经账号会话（路由 `account.redpack.catalog` 纯读内存索引）。所以这是与「聊天背景」
 * 同等的一栏本地内容。
 *
 * 图片仍由主进程代取并落盘（`weq-media://redbag?id=…&v=…`，只认本地目录里记的 URL），
 * 渲染进程不直连 CDN。
 *
 * 布局沿用礼物墙那套观感：头部工具栏 + 卡片网格 + 骨架 / 空态。封面是 2:3 的竖图，
 * 所以卡片固定宽高比 + contain，点开看弹层大图。
 */

import { useMemo, type ReactElement } from 'react';
import { Gift as GiftIcon, Wallet, RefreshCw } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { redPackSkinUrl } from '../../lib/resourceUrl';
import { ShimmerImage } from '../ShimmerImage';
import { DressSearchForm } from '../DressSearchForm';
import { openMediaPreview } from '../mediaPreviewStore.shared';
import { usePageState } from '../PageSnapshots.shared';
import { PageScrollSnapshot } from '../PageScrollSnapshot';
import { pageValue } from '../../lib/pageSnapshots';
import '../../styles/redpack-wall.css';

type Variant = 'preview' | 'popup' | 'background' | 'image';

interface SkinCard {
  id: number;
  name: string;
  variants: Variant[];
  jumpText: string;
  jumpUrl: string;
}

const SKELETON_KEYS = Array.from({ length: 12 }, (_, index) => `redpack-skel-${index}`);

/** 卡片优先用的图字段顺序：封面 → 原始竖版 → 弹层。 */
const PRIMARY_ORDER: Variant[] = ['preview', 'image', 'popup', 'background'];

function primaryVariant(skin: SkinCard): Variant | null {
  return PRIMARY_ORDER.find((variant) => skin.variants.includes(variant)) ?? null;
}

export function RedPackSkinWall(): ReactElement {
  const [draft, setDraft] = usePageState('redpack:draft', '', pageValue.string);
  const [keyword, setKeyword] = usePageState('redpack:keyword', '', pageValue.string);
  const listScope = `redpack:list:${keyword}`;

  const query = trpc.account.redpack.catalog.useQuery(
    { keyword },
    { staleTime: 5 * 60_000, retry: false },
  );

  const skins = (query.data?.skins ?? []) as SkinCard[];
  const total = query.data?.total ?? 0;
  const generatedAt = query.data?.generatedAt ?? 0;

  function open(skin: SkinCard, ownerDocument: Document) {
    const src = redPackSkinUrl(skin.id, 'large');
    openMediaPreview({
      ownerDocument,
      items: [
        {
          key: src,
          kind: 'image',
          src,
          title: `${skin.name} · 红包封面`,
        },
      ],
    });
  }

  const updated = useMemo(() => {
    if (!generatedAt) return '';
    try {
      return dateFormatter.format(new Date(generatedAt * 1000));
    } catch {
      return '';
    }
  }, [generatedAt]);

  return (
    <>
      <div className="weq-dress-toolbar">
        <span className="weq-redpack-wall-count" role="status">
          {keyword ? (
            <NumericText>{`命中 ${skins.length} / ${total}`}</NumericText>
          ) : (
            <NumericText>{`共 ${total} 只`}</NumericText>
          )}
          {updated ? <em> · 目录更新于 {updated}</em> : null}
        </span>
        <div className="weq-dress-toolbar-controls">
          <DressSearchForm
            label="搜索红包封面"
            value={draft}
            onChange={setDraft}
            onSearch={setKeyword}
            maxLength={64}
          />
        </div>
      </div>

      <PageScrollSnapshot key={listScope} snapshotKey={listScope} className="weq-dress-body">
        {query.isInitialLoading ? (
          <div className="weq-redpack-wall-grid" aria-hidden>
            {SKELETON_KEYS.map((key) => (
              <div className="weq-redpack-wall-skel" key={key} />
            ))}
          </div>
        ) : query.error ? (
          <div className="weq-redpack-wall-state">
            <Wallet size={26} strokeWidth={1.6} />
            <p>红包封面目录读不出来</p>
            <span>{query.error instanceof Error ? query.error.message : String(query.error)}</span>
            <button type="button" onClick={() => void query.refetch()} className="weq-retry-button">
              <RefreshCw size={14} aria-hidden />
              重试
            </button>
          </div>
        ) : skins.length === 0 ? (
          <div className="weq-redpack-wall-state">
            <GiftIcon size={26} strokeWidth={1.6} />
            <p>{keyword ? '没有匹配的封面' : '本地目录是空的'}</p>
            <span>
              {keyword
                ? '换个关键词试试，或者清空搜索看全部。'
                : 'resources/redpack/skins.json 不存在或没有条目 —— 运行 pnpm tsx scripts/fetch_red_pack_skins.ts 抓一份。'}
            </span>
          </div>
        ) : (
          <div className="weq-redpack-wall-grid">
            {skins.map((skin) => {
              const variant = primaryVariant(skin);
              return (
                <button
                  key={skin.id}
                  type="button"
                  className="weq-redpack-wall-card"
                  onClick={(event) => open(skin, event.currentTarget.ownerDocument)}
                  disabled={!variant}
                  title={variant ? `${skin.name} · 查看封面` : skin.name}
                >
                  <span className="weq-redpack-wall-media weq-media-frame">
                    {variant ? (
                      <ShimmerImage
                        src={redPackSkinUrl(skin.id, variant)}
                        alt={`${skin.name} 红包封面`}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span className="weq-redpack-wall-noimg">
                        <GiftIcon size={18} strokeWidth={1.6} />
                      </span>
                    )}
                  </span>
                  <span className="weq-redpack-wall-meta">
                    <strong>{skin.name}</strong>
                    <small>
                      #<span className="weq-number weq-number-inherit">{skin.id}</span>
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </PageScrollSnapshot>
    </>
  );
}
