/**
 * 好友/群友「互动标识」内容 —— 联系人详情内嵌展示，兼容独立浮层。
 *
 * 数据走 `account.mutualMark.get`（ti.qq.com 互动标识聚合页，需在线 QQ 发包），
 * 按分类（任务标识 / 惊喜标识 / 限定标识 / 幸运字符）分组展示，每行三枚大图标。
 * 图标是 QQ CDN 直链，点亮态与灰态由服务端给的 URL 区分（`…_0_0_big.png` 点亮、
 * `…_0_1_big.png` 未点亮），未点亮时再压一点透明度让灰态更明显。
 *
 * 单个标识的等级浮层显式绑定图标按钮，内嵌模式也能正确定位。
 */
import { useState } from 'react';
import { Award, Loader2, WifiOff, X } from 'lucide-react';
import type { FriendMark } from '@weq/service';
import { MutualMarkLevelDialog } from './MutualMarkLevelDialog';
import { trpc } from '../trpc/client';
import { cn } from '../im-template/template/classNames';
import { OverlayLayer } from './OverlayLayer';
import { useTabActive } from './RetainedTabs';
import { useViewState } from '../state/view';
import type { ProfileExtInfo } from '../im-template/template/types';
import { collectionImageUrl } from '../lib/resourceUrl';
import { profileCode } from '@weq/protocol/profile-values';
import '../styles/profile-cache.css';

type CachedMark = ProfileExtInfo['interactMarks'][number];
export function usableCachedMarks(marks: readonly CachedMark[]) {
  const found = new Map<string, CachedMark>();
  for (const mark of marks) {
    const id = profileCode(mark.markId);
    const type = mark.type?.trim();
    if (id === null && !type) continue;
    const key = `${type ?? ''}:${id ?? ''}`;
    if (!found.has(key)) found.set(key, mark);
  }
  return [...found.values()];
}

function CachedMarkCell({ mark }: { mark: CachedMark }) {
  const [failed, setFailed] = useState(false);
  const name =
    profileCode(mark.markId) !== null ? `互动标识 ${mark.markId}` : `互动标识（${mark.type}）`;
  return (
    <div className="weq-mutual-cell">
      <span className="weq-cached-mark-icon">
        {mark.iconUrl && !failed ? (
          <img src={collectionImageUrl(mark.iconUrl)} alt={name} onError={() => setFailed(true)} />
        ) : (
          <Award size={30} />
        )}
      </span>
      <span className="weq-mutual-name">{name}</span>
      <span className="weq-mutual-state">本地缓存</span>
    </div>
  );
}

export function CachedMutualMarks({ marks }: { marks: readonly CachedMark[] }) {
  return (
    <div className="weq-mutual-grid">
      {usableCachedMarks(marks).map((mark) => (
        <CachedMarkCell key={`${mark.type}:${mark.markId}:${mark.iconUrl}`} mark={mark} />
      ))}
    </div>
  );
}

/** 单个标识单元：大图标（点击看全部等级）+ 名称 + 点亮/累计天数 + 状态。 */
function MarkCell({
  mark,
  onOpen,
}: {
  mark: FriendMark;
  onOpen: (mark: FriendMark, anchor: HTMLButtonElement) => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const chips: string[] = [];
  if (mark.isLightup) {
    if (mark.level > 0) chips.push(`Lv.${mark.level}`);
    chips.push('已点亮');
  } else {
    chips.push('未点亮');
  }
  if (mark.isWearing) chips.push('佩戴中');

  const days = [
    mark.lightupDays > 0 ? `点亮 ${mark.lightupDays} 天` : null,
    mark.actDays > 0 ? `累计 ${mark.actDays} 天` : null,
  ].filter((x): x is string => Boolean(x));

  return (
    <div
      className={cn('weq-mutual-cell', !mark.isLightup && 'is-off')}
      title={mark.intro || mark.name}
    >
      <button
        type="button"
        className="weq-mutual-icon"
        title="查看全部等级"
        aria-label={`查看 ${mark.name} 的全部等级`}
        onClick={(event) => onOpen(mark, event.currentTarget)}
      >
        {mark.iconUrl && failedUrl !== mark.iconUrl ? (
          <img
            src={collectionImageUrl(mark.iconUrl)}
            alt={mark.name}
            loading="lazy"
            onError={() => setFailedUrl(mark.iconUrl)}
          />
        ) : (
          <Award size={30} />
        )}
      </button>
      <span className="weq-mutual-name">{mark.name}</span>
      {days.length ? <span className="weq-mutual-days">{days.join(' · ')}</span> : null}
      <span className={cn('weq-mutual-state', mark.isLightup && 'is-lit')}>
        {chips.join(' · ')}
      </span>
    </div>
  );
}

export function MutualMarkDialog({
  uin,
  name,
  onClose,
  embedded = false,
  cachedMarks = [],
}: {
  /** 目标 QQ 号（互动标识接口只认 uin）。 */
  uin: string;
  /** 对方昵称/备注，用于标题。 */
  name: string;
  onClose: () => void;
  embedded?: boolean;
  cachedMarks?: readonly CachedMark[];
}) {
  const active = useTabActive();
  const account = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: active && Boolean(account),
  });
  const configId = config.data?.uin === account ? config.data.configId : undefined;
  const [levelMark, setLevelMark] = useState<{
    scope: string;
    mark: FriendMark;
    anchor: HTMLButtonElement;
  } | null>(null);

  const query = trpc.account.mutualMark.get.useQuery(
    { uin, expectedAccountUin: account ?? '', expectedAccountConfigId: configId ?? '' },
    // 票据失败多半是离线/风控而不是抖动，重试只会让用户多等一轮。
    {
      enabled: active && Boolean(account && configId),
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60_000,
      keepPreviousData: false,
    },
  );

  const data = query.data;
  const categories = (data?.categories ?? []).filter((cat) => cat.marks.length > 0);
  const localMarks = usableCachedMarks(cachedMarks);
  const onlineReady = Boolean(account && configId && query.isSuccess && data);
  const levelScope = JSON.stringify([account, configId, uin, query.dataUpdatedAt]);

  const content = (
    <section
      className={
        embedded ? 'weq-mutual-dialog weq-contact-marks' : 'weq-mutual-dialog weq-anim-pop'
      }
      role={embedded ? 'region' : 'dialog'}
      aria-label={`${name} 的互动标识`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {!embedded ? (
        <button
          className="weq-profile-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      ) : null}

      {/* 内嵌进资料页时，分区标题（互动标识）与身份区已经在这里，不再重复一遍标题和 QQ 号。 */}
      {embedded ? null : (
        <header className="weq-mutual-head">
          <h2>互动标识</h2>
          <p>
            {name} <span className="weq-number">{uin}</span>
          </p>
        </header>
      )}

      {!onlineReady && localMarks.length ? (
        <div className="weq-mutual-body">
          <CachedMutualMarks marks={localMarks} />
          {query.error || config.error ? (
            <p className="weq-mutual-status" role="status">
              在线更新失败，显示本地缓存。
            </p>
          ) : (
            <p className="weq-mutual-status" role="status">
              正在更新互动标识…
            </p>
          )}
        </div>
      ) : query.isLoading && !config.error ? (
        <div className="weq-mutual-status">
          <Loader2 size={16} className="weq-spin" />
          正在获取互动标识…
        </div>
      ) : query.error || config.error || !onlineReady || !data ? (
        <div className="weq-mutual-status is-error">
          <WifiOff size={15} />
          {query.error?.message ?? config.error?.message ?? '获取失败，请稍后再试。'}
        </div>
      ) : (
        <div className="weq-mutual-body">
          {categories.length === 0 ? <p className="weq-mutual-status">暂无互动标识</p> : null}
          {data.totalNum > 0 ? (
            <p className="weq-mutual-summary">
              共 {data.totalNum} 个标识 · 已点亮 {data.lightUpNum} · 稀有 {data.rarityNum}
            </p>
          ) : null}
          {categories.map((cat) => (
            <section key={cat.id || cat.name} className="weq-mutual-cat">
              {!embedded || cat.name !== '互动标识' ? (
                <h3>
                  {cat.name}
                  <span className="weq-mutual-cat-count">
                    {cat.lightUpNum}/{cat.totalNum}
                  </span>
                </h3>
              ) : null}
              <div className="weq-mutual-grid">
                {cat.marks.map((mark) => (
                  <MarkCell
                    key={mark.id || mark.name}
                    mark={mark}
                    onOpen={(mark, anchor) => setLevelMark({ scope: levelScope, mark, anchor })}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {onlineReady && levelMark?.scope === levelScope ? (
        <MutualMarkLevelDialog
          mark={levelMark.mark}
          anchor={levelMark.anchor}
          onClose={() => setLevelMark(null)}
        />
      ) : null}
    </section>
  );
  return embedded ? (
    content
  ) : (
    <OverlayLayer
      presentation="popover"
      className="weq-profile-layer weq-mutual-layer"
      onClose={onClose}
    >
      {content}
    </OverlayLayer>
  );
}
