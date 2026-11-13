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

import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { Gift as GiftIcon, Search, Wallet, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { redPackSkinUrl } from '../../lib/resourceUrl';
import { openMediaPreview } from '../mediaPreviewStore';
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
  const [draft, setDraft] = useState('');
  const [keyword, setKeyword] = useState('');

  const query = trpc.account.redpack.catalog.useQuery(
    { keyword },
    { staleTime: 5 * 60_000, retry: false },
  );

  const skins = (query.data?.skins ?? []) as SkinCard[];
  const total = query.data?.total ?? 0;
  const generatedAt = query.data?.generatedAt ?? 0;

  const submitted = useCallback(() => {
    setKeyword(draft.trim());
  }, [draft]);

  const open = useCallback((skin: SkinCard) => {
    const variant = primaryVariant(skin);
    const large =
      skin.variants.includes('popup') && skin.variants.includes('preview') ? 'popup' : variant;
    if (!large) return;
    openMediaPreview({
      items: [
        {
          key: redPackSkinUrl(skin.id, large),
          kind: 'image',
          src: redPackSkinUrl(skin.id, large),
          title: `${skin.name} · 红包封面`,
        },
      ],
    });
  }, []);

  const updated = useMemo(() => {
    if (!generatedAt) return '';
    try {
      return dateFormatter.format(new Date(generatedAt * 1000));
    } catch {
      return '';
    }
  }, [generatedAt]);

  return (
    <div className="weq-redpack-wall">
      <div className="weq-redpack-wall-head">
        <form
          className="weq-redpack-wall-search"
          onSubmit={(event) => {
            event.preventDefault();
            submitted();
          }}
        >
          <Search size={14} strokeWidth={1.9} />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="搜索红包封面名，回车确认"
            aria-label="搜索红包封面"
            spellCheck={false}
          />
          {draft ? (
            <button
              type="button"
              className="weq-redpack-wall-clear"
              title="清空"
              aria-label="清空搜索"
              onClick={() => {
                setDraft('');
                setKeyword('');
              }}
            >
              <X size={12} strokeWidth={2} />
            </button>
          ) : null}
        </form>
        <span className="weq-redpack-wall-count">
          {keyword ? `命中 ${skins.length} / ${total}` : `共 ${total} 只`}
          {updated ? <em> · 目录更新于 {updated}</em> : null}
        </span>
      </div>

      <div className="weq-redpack-wall-body">
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
            <button type="button" onClick={() => void query.refetch()}>
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
              const clickable = Boolean(variant) && Boolean(skin.variants.includes('popup'));
              return (
                <button
                  key={skin.id}
                  type="button"
                  className="weq-redpack-wall-card"
                  onClick={() => (clickable ? open(skin) : undefined)}
                  disabled={!clickable}
                  title={clickable ? `${skin.name} · 点击看大图` : `${skin.name}（无大图）`}
                >
                  <span className="weq-redpack-wall-media">
                    {variant ? (
                      <img
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
                    <small>#{skin.id}</small>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
