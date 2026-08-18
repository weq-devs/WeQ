/**
 * 好友/群友「互动标识」灯箱 —— 从资料卡底部「查看互动标识」打开。
 *
 * 数据走 `account.mutualMark.get`（ti.qq.com 互动标识聚合页，需在线 QQ 发包），
 * 按分类（任务标识 / 惊喜标识 / 限定标识 / 幸运字符）分组展示，每行三枚大图标。
 * 图标是 QQ CDN 直链，点亮态与灰态由服务端给的 URL 区分（`…_0_0_big.png` 点亮、
 * `…_0_1_big.png` 未点亮），未点亮时再压一点透明度让灰态更明显。
 *
 * 盖在资料卡之上：好友资料灯箱遮罩 z-index 80、群成员卡 90，这里取 100（见
 * .weq-mutual-layer）。
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Award, Loader2, WifiOff, X } from 'lucide-react';
import type { FriendMark } from '@weq/service';
import { MutualMarkLevelDialog } from './MutualMarkLevelDialog';
import { trpc } from '../trpc/client';
import { cn } from '../im-template/template/classNames';
import { useEscapeToClose } from '../im-template/template/modalUtils';

/** 单个标识单元：大图标（点击看全部等级）+ 名称 + 点亮/累计天数 + 状态。 */
function MarkCell({ mark, onOpen }: { mark: FriendMark; onOpen: (mark: FriendMark) => void }) {
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
        onClick={() => onOpen(mark)}
      >
        {mark.iconUrl ? (
          <img src={mark.iconUrl} alt={mark.name} loading="lazy" />
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
}: {
  /** 目标 QQ 号（互动标识接口只认 uin）。 */
  uin: string;
  /** 对方昵称/备注，用于标题。 */
  name: string;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);

  const [levelMark, setLevelMark] = useState<FriendMark | null>(null);

  const query = trpc.account.mutualMark.get.useQuery(
    { uin },
    // 票据失败多半是离线/风控而不是抖动，重试只会让用户多等一轮。
    { retry: false, refetchOnWindowFocus: false, staleTime: 5 * 60_000 },
  );

  const data = query.data;
  const categories = (data?.categories ?? []).filter((cat) => cat.marks.length > 0);

  return createPortal(
    <div
      className="weq-profile-layer weq-mutual-layer"
      role="presentation"
      // 必须 stopPropagation：portal 挂在 body 上，但 React 事件仍沿组件树冒泡，
      // 调用方（好友资料灯箱 / 群成员卡）的遮罩也监听 mousedown 关闭自己。
      onMouseDown={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <section
        className="weq-mutual-dialog weq-anim-pop"
        role="dialog"
        aria-modal="true"
        aria-label={`${name} 的互动标识`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="weq-profile-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={16} />
        </button>

        <header className="weq-mutual-head">
          <h2>互动标识</h2>
          <p>
            {name} <span className="weq-number">{uin}</span>
          </p>
        </header>

        {query.isLoading ? (
          <div className="weq-mutual-status">
            <Loader2 size={16} className="weq-spin" />
            正在获取互动标识…
          </div>
        ) : query.error || !data ? (
          <div className="weq-mutual-status is-error">
            <WifiOff size={15} />
            {query.error?.message ?? '获取失败，请稍后再试。'}
          </div>
        ) : (
          <div className="weq-mutual-body">
            {data.totalNum > 0 ? (
              <p className="weq-mutual-summary">
                共 {data.totalNum} 个标识 · 已点亮 {data.lightUpNum} · 稀有 {data.rarityNum}
              </p>
            ) : null}
            {categories.map((cat) => (
              <section key={cat.id || cat.name} className="weq-mutual-cat">
                <h3>
                  {cat.name}
                  <span className="weq-mutual-cat-count">
                    {cat.lightUpNum}/{cat.totalNum}
                  </span>
                </h3>
                <div className="weq-mutual-grid">
                  {cat.marks.map((mark) => (
                    <MarkCell key={mark.id || mark.name} mark={mark} onOpen={setLevelMark} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {levelMark ? (
          <MutualMarkLevelDialog mark={levelMark} onClose={() => setLevelMark(null)} />
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
