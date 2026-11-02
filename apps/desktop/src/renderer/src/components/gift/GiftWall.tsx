/**
 * 我的礼物墙 —— 个性装扮页里的「我的礼物墙」分栏。
 *
 * 数据来自 `GiftMall/GetSendRecvWallListV2`：`is_send` 决定看收到的还是送出的，
 * 翻页靠响应里的 `extInfo` + `beginTime` 原样回传（首页 `beginTime` 取当前秒级时间戳，
 * 与抓包一致）。
 *
 * 排列用 CSS 多列瀑布流：礼物图的宽高比千奇百怪，等高网格不是裁掉就是留白，让每张
 * 按原比例落下去才像一面墙。卡片与图都刻意放大 —— 这一栏的主角是礼物本身。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Gift as GiftIcon, Loader2, WifiOff } from 'lucide-react';
import { client } from '../../trpc/client';
import { giftImageUrl } from '../../lib/resourceUrl';
import '../../styles/gift-wall.css';

type WallItem = {
  giftId: number;
  giftName: string;
  staticPic: string;
  giftPrice: number;
  time: string;
  nick: string;
  orderNum: string;
};

const SKELETON_KEYS = Array.from({ length: 8 }, (_, index) => `gift-wall-skel-${index}`);

export function GiftWall() {
  const [isSend, setIsSend] = useState(false);
  const [items, setItems] = useState<WallItem[]>([]);
  const [isEnd, setIsEnd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const cursor = useRef({
    batchInfo: '0&20',
    beginTime: Math.floor(Date.now() / 1000),
  });
  const requestId = useRef(0);

  const loadPage = useCallback(async (mode: 'reset' | 'more', send: boolean) => {
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const result = await client.account.giftMall.wall.query({
        isSend: send,
        batchInfo: mode === 'reset' ? '0&20' : cursor.current.batchInfo,
        beginTime: mode === 'reset' ? Math.floor(Date.now() / 1000) : cursor.current.beginTime,
      });
      if (id !== requestId.current) return;
      cursor.current = { batchInfo: result.extInfo, beginTime: result.beginTime };
      const list = result.giftsList as unknown as WallItem[];
      setItems((prev) => (mode === 'reset' ? list : [...prev, ...list]));
      setIsEnd(result.isEnd);
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : String(e));
      if (mode === 'reset') setItems([]);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setItems([]);
    setIsEnd(false);
    void loadPage('reset', isSend);
  }, [isSend, loadPage]);

  return (
    <div className="weq-gift-wall">
      <div className="weq-gift-wall-head">
        <div className="weq-gift-wall-switch" role="radiogroup" aria-label="礼物墙方向">
          <button
            type="button"
            role="radio"
            aria-checked={!isSend}
            className={isSend ? undefined : 'is-active'}
            onClick={() => setIsSend(false)}
          >
            收到的礼物
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isSend}
            className={isSend ? 'is-active' : undefined}
            onClick={() => setIsSend(true)}
          >
            送出的礼物
          </button>
        </div>
        {items.length > 0 ? (
          <span className="weq-gift-wall-count">已加载 {items.length} 个</span>
        ) : null}
      </div>

      <div className="weq-gift-wall-body">
        {loading && items.length === 0 ? (
          <div className="weq-gift-wall-skeleton" aria-hidden>
            {SKELETON_KEYS.map((key, index) => (
              <div
                className="weq-gift-wall-skel"
                key={key}
                // 高度错开一点，骨架也像瀑布流，出数据时不会整页跳版。
                style={{ height: 180 + (index % 3) * 46 }}
              />
            ))}
          </div>
        ) : error ? (
          <div className="weq-gift-wall-state">
            <WifiOff size={26} strokeWidth={1.6} />
            <p>礼物墙没打开</p>
            <span>{error}</span>
            <div className="weq-gift-wall-more">
              <button type="button" onClick={() => void loadPage('reset', isSend)}>
                重试
              </button>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="weq-gift-wall-state">
            <GiftIcon size={28} strokeWidth={1.5} />
            <p>{isSend ? '还没送出过礼物' : '还没收到过礼物'}</p>
            <span>
              {isSend
                ? '在私聊的「红包 / 礼物」菜单里挑一份，就会记到这里。'
                : '收到别人的礼物后，它会出现在这面墙上。'}
            </span>
          </div>
        ) : (
          <>
            <div className="weq-gift-wall-masonry">
              {' '}
              {items.map((item) => (
                // orderNum 是这一单的唯一号（同一个礼物可以被送多次），比下标稳。
                <WallCard
                  key={item.orderNum || `${item.giftId}-${item.time}`}
                  item={item}
                  isSend={isSend}
                />
              ))}
            </div>
            {!isEnd ? (
              <div className="weq-gift-wall-more">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void loadPage('more', isSend)}
                >
                  {loading ? <Loader2 size={13} className="weq-gift-wall-spin" /> : null}
                  翻更早的礼物
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** 一张墙卡：图占满宽度、原比例，下面是名字 + 对方 + 时间。 */
function WallCard({ item, isSend }: { item: WallItem; isSend: boolean }) {
  const src = giftImageUrl(item.staticPic ?? '');
  return (
    <div className="weq-gift-wall-card">
      <div className="weq-gift-wall-media">
        {src ? (
          <img src={src} alt={item.giftName} loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className="weq-gift-wall-fallback">
            <GiftIcon size={24} strokeWidth={1.5} />
            暂无图
          </span>
        )}
      </div>
      <div className="weq-gift-wall-meta">
        <span className="weq-gift-wall-meta-main">
          <strong title={item.giftName}>{item.giftName}</strong>
          <small title={`${isSend ? '送给' : '来自'} ${item.nick} · ${item.time}`}>
            {isSend ? '送给' : '来自'} {item.nick || '神秘好友'} · {item.time}
          </small>
        </span>
        <span className="weq-gift-wall-price">{item.giftPrice}</span>
      </div>
    </div>
  );
}
