import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { Heart, Lock, Play, Quote } from 'lucide-react';
import type { QzoneMemoriesPageData, ReportQzonePost } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer, usePrefersReducedMotion } from '../Odometer';
import { albumMediaUrl } from '../../../lib/resourceUrl';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

const MONTHS = [
  '一月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '十一月',
  '十二月',
];

function fmtMonthDay(sec: number, withYear = false): string {
  if (!sec) return '';
  const date = new Date(sec * 1000);
  const label = `${MONTHS[date.getMonth()]}${date.getDate()}日`;
  return withYear ? `${date.getFullYear()}年${label}` : label;
}

/** 说说富文本里的提及/表情 token 只做安全文本展示；长文截成一句有回忆感的摘录。 */
function quoteOf(post: ReportQzonePost): string {
  const clean = post.content
    .replace(/@\{uin:[^,]+,[^}]+\}/g, '@朋友')
    .replace(/\[em\]e\d+\[\/em\]/g, '[表情]')
    .replace(/\[([^\]\n]{1,12})\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean) return clean.length > 64 ? `${clean.slice(0, 64)}…` : clean;
  if (post.images.length > 0) return '一条没有配文字的照片说说。';
  if (post.hasVideo) return '一段留在空间里的视频。';
  return '这一天，你只在空间里安静地路过。';
}

/** 一条说说可展示的封面：图片优先，视频封面兜底；都拿不到返回空串。 */
function coverOf(post: ReportQzonePost): string {
  return post.images[0] ?? post.videoCover ?? '';
}

/**
 * QQ 空间回忆 —— 年度报告正文的最后一页（end 之前）。
 *
 * 主体不是一张数据卡，而是「你一共写过 N 条说说」这个巨大的 N：它被 Odometer
 * 一格一格摇出来，像把空间那本老相册重新翻了一遍。下面是一条会呼吸的「时光
 * 画廊」：帧片自动放映，悬停即暂停，还可以左右拖动回看 —— 滑到哪一帧，顶上的
 * 小注就跟着念出那一天的日期与体裁。有图的看图，没图的看字，全部都是当年那个
 * 你的碎片。颜色取 QQ 空间一贯的云海蓝，收在整份暖调报告的末段，像合上相册前
 * 最后一眼远方的天空。
 */
export function QzoneMemoriesPage({
  page,
  data,
  active,
}: ReportPageProps<QzoneMemoriesPageData>): ReactElement {
  const allTime = isAllTimeYear(data.year);
  const highlight = data.highlight;
  const gallery = useMemo(() => {
    if (data.gallery.length === 0) return [];
    // 条数太少时先把素材重复到 8 帧，保证胶片跑动时两端画面不间断。
    const base =
      data.gallery.length >= 8
        ? data.gallery
        : Array.from({ length: Math.ceil(8 / data.gallery.length) }, () => data.gallery).flat();
    return base.map((post, instance) => ({ post, instance }));
  }, [data.gallery]);
  const metricName = highlight?.metric === 'like' ? '赞' : '评论';
  const heroPost = highlight?.post;
  const firstYear = data.firstPostTime
    ? `${new Date(data.firstPostTime * 1000).getFullYear()} 年`
    : '';

  return (
    <PageFrame page={page} active={active} ghost="忆" tone="#3a77b6">
      <div className="weq-qz">
        <header className="weq-qz-kicker weq-report-line" style={{ '--i': 1 } as CSSProperties}>
          <span>{reportEraLabel(data.year)} · QQ空间回忆</span>
          <span className="weq-qz-kicker-meta">
            {allTime && firstYear ? (
              <>
                <b className="weq-number">{firstYear.replace(' ', '')}</b> 起<i aria-hidden>/</i>
              </>
            ) : null}
            <b className="weq-number">{fmt(data.total)}</b> 条说说
          </span>
        </header>

        <section className="weq-qz-hero">
          <p className="weq-qz-lede weq-report-line" style={{ '--i': 2 } as CSSProperties}>
            {allTime
              ? '这一路，你把生活寄放在空间里'
              : `${data.year} 这一年，你把生活的一部分寄存在空间里`}
          </p>
          <div className="weq-qz-countline weq-report-line" style={{ '--i': 3 } as CSSProperties}>
            <Odometer value={data.total} active={active} className="weq-qz-count" />
            <span className="weq-qz-unit" aria-hidden>
              <b>条</b>
              <i>写下的说说</i>
            </span>
          </div>
          <p className="weq-qz-mood weq-report-line" style={{ '--i': 4 } as CSSProperties}>
            它们未必被很多人看见，却都替你记着那时的你。
          </p>
        </section>

        {highlight && heroPost ? (
          <section className="weq-qz-gem weq-report-line" style={{ '--i': 5 } as CSSProperties}>
            <div className="weq-qz-gem-copy">
              <p className="weq-qz-gem-eyebrow">
                {metricName === '赞' ? '被赞得最多的一条' : '被评论最多的一条'}
                {heroPost.isPrivate ? (
                  <span className="weq-qz-private" title="仅自己可见">
                    <Lock size={9} aria-hidden />
                    仅自己
                  </span>
                ) : null}
              </p>
              <p className="weq-qz-gem-quote">“{quoteOf(heroPost)}”</p>
              <p className="weq-qz-gem-meta">
                {fmtMonthDay(heroPost.time, allTime)}
                <span aria-hidden>·</span>
                <b className="weq-number">{fmt(highlight.count)}</b>{' '}
                {metricName === '赞' ? '次赞' : '条评论'}
              </p>
            </div>
            <GemCover post={heroPost} metricName={metricName} />
          </section>
        ) : (
          <section
            className="weq-qz-gem weq-qz-gem-empty weq-report-line"
            style={{ '--i': 5 } as CSSProperties}
          >
            <p className="weq-qz-gem-eyebrow">没有一条被点名的说说</p>
            <p className="weq-qz-gem-quote">
              “还没人给你的心情点赞、留言——但你发过的每一帧，都值得再看一次。”
            </p>
          </section>
        )}

        {gallery.length > 0 ? (
          <QzoneReel items={gallery} active={active} allTime={allTime} />
        ) : null}
      </div>
    </PageFrame>
  );
}

/** 冠军说的配图：图片优先，视频封面兜底，都拿不到时不占位。 */
function GemCover({
  post,
  metricName,
}: {
  post: ReportQzonePost;
  metricName: string;
}): ReactElement {
  const [broken, setBroken] = useState(false);
  const src = coverOf(post);
  if (!src || broken) {
    return <div className="weq-qz-gem-cover is-empty" aria-hidden />;
  }
  return (
    <div className="weq-qz-gem-cover">
      <img src={albumMediaUrl(src)} alt="" loading="lazy" onError={() => setBroken(true)} />
      {post.hasVideo ? (
        <span className="weq-qz-video-badge" aria-label="视频">
          <Play size={9} fill="currentcolor" aria-hidden />
          视频
        </span>
      ) : null}
      {post.likeCount != null && post.likeCount > 0 && metricName === '赞' ? (
        <span className="weq-qz-gem-like" aria-hidden>
          <Heart size={10} fill="currentcolor" />
          {fmt(post.likeCount)}
        </span>
      ) : null}
    </div>
  );
}

/** 画廊里的一格。 */
type ReelItem = { post: ReportQzonePost; instance: number };

/** 自动放映速度（px/s）—— 慢到能看清每一帧，又不停成一张海报。 */
const REEL_SPEED = 24;
/** 横向拖动超过这个像素数才算「回看」，普通点击不抢事件。 */
const REEL_DRAG_START = 5;

/** 一帧的体裁标签：顶上的小注随焦点帧更新。 */
function postKindLabel(post: ReportQzonePost): string {
  if (post.images.length > 0) return '照片';
  if (post.hasVideo) return '视频';
  return '文字';
}

/**
 * 时光画廊 —— 一条能停下来、能往回翻的「放映带」。
 *
 * 自动放映用 rAF 推进而不是 CSS 动画：悬停 / 拖动时随时暂停，拖动增量与放映增量
 * 落在同一个偏移量上，松手后从当前帧继续，不会跳回动画起点。轨道画两遍同样的
 * 帧实现无缝循环；偏移量始终锁在中间一份副本附近，左右都能拖而不露底。
 *
 * 焦点帧（正在经过画廊中央的那一格）会轻轻浮起，顶上的小注同步念出它的日期与
 * 体裁 —— 画廊不再是纯装饰，而是这页最后一段可以「翻着看」的回忆。
 */
function QzoneReel({
  items,
  active,
  allTime,
}: {
  items: ReelItem[];
  active: boolean;
  allTime: boolean;
}): ReactElement {
  const reduce = usePrefersReducedMotion();
  const maskRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** 相对「中间那份副本起点」的偏移（px）。正数表示轨道向左放映。 */
  const rawRef = useRef(0);
  const geometryRef = useRef<{ perCopy: number; step: number; viewWidth: number } | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startRaw: number;
    moved: boolean;
  } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  const reel = useMemo(() => [...items, ...items], [items]);
  const count = items.length;
  const total = reel.length;

  const applyTransform = useCallback(() => {
    const track = trackRef.current;
    const mask = maskRef.current;
    if (!track || !mask || count === 0) return;

    let geometry = geometryRef.current;
    if (!geometry) {
      const scrollWidth = track.scrollWidth;
      if (!scrollWidth || scrollWidth <= 0) return;
      geometry = {
        perCopy: scrollWidth / 2,
        step: scrollWidth / 2 / count,
        viewWidth: mask.clientWidth,
      };
      geometryRef.current = geometry;
    }

    // 只让偏移在中间那份副本附近游走：到边界就折回，轨道两端的画面本是一样。
    const edge = geometry.perCopy * 0.48;
    let raw = rawRef.current;
    if (raw > edge) raw -= geometry.perCopy;
    else if (raw < -edge) raw += geometry.perCopy;
    rawRef.current = raw;

    const translate = geometry.perCopy + raw;
    track.style.transform = `translate3d(${-translate}px, 0, 0)`;

    // 画廊中央对应的帧。夹在 [0, total) 内，跨过副本边界时焦点自然交给下一份。
    const centerX = translate + geometry.viewWidth / 2;
    const rawIndex = Math.round(centerX / geometry.step - 0.5);
    const next = Math.max(0, Math.min(total - 1, rawIndex));
    setFocusIndex((prev) => (prev === next ? prev : next));
  }, [count, total]);

  // 页激活 / 系统减少动态变化时：回到中间副本并停下或开始放映。
  useEffect(() => {
    geometryRef.current = null;
    rawRef.current = 0;
    setFocusIndex(0);
    if (active && count > 0) applyTransform();
    setPlaying(active && !reduce && count > 0);
  }, [active, reduce, count, applyTransform]);

  // 放映循环：悬停 / 拖动时暂停，离开或松手后接着当前帧继续。
  useEffect(() => {
    if (!playing || hovering || dragging) return undefined;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number): void => {
      const dt = Math.min(now - last, 80);
      last = now;
      rawRef.current += (dt / 1000) * REEL_SPEED;
      applyTransform();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, hovering, dragging, applyTransform]);

  // 画幅变化（窗口 / 导出尺寸）后重新测量帧宽，偏移不漂。
  useEffect(() => {
    const mask = maskRef.current;
    if (!mask) return undefined;
    const observer = new ResizeObserver(() => {
      geometryRef.current = null;
      applyTransform();
    });
    observer.observe(mask);
    return () => observer.disconnect();
  }, [applyTransform]);

  function onPointerDown(event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startRaw: rawRef.current,
      moved: false,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < REEL_DRAG_START) return;
    if (!drag.moved) {
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    // 已确认为画廊内横向拖动：不再让舞台把这串事件误判成上下翻页手势。
    event.stopPropagation();
    rawRef.current = drag.startRaw - dx;
    applyTransform();
  }

  function endDrag(event: React.PointerEvent<HTMLElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }

  const focusItem = reel[Math.max(0, Math.min(total - 1, focusIndex))];
  const liveLabel = focusItem
    ? `${fmtMonthDay(focusItem.post.time, allTime)} · ${postKindLabel(focusItem.post)}`
    : allTime
      ? '往回翻，每一帧都是你'
      : '这一年，你留在空间里的画面';

  return (
    <section
      className="weq-qz-reel weq-report-line"
      style={{ '--i': 6 } as CSSProperties}
      data-hovering={hovering ? 'yes' : 'no'}
      data-dragging={dragging ? 'yes' : 'no'}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') setHovering(true);
      }}
      onPointerLeave={() => {
        setHovering(false);
        setHoverIndex(null);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <p className="weq-qz-reel-in">
        <span className="weq-qz-reel-title">时光画廊</span>
        <span className="weq-qz-reel-live" aria-live="polite">
          {liveLabel}
        </span>
        <span className="weq-qz-reel-hint" aria-hidden>
          悬停暂停 · 拖动回看
        </span>
      </p>
      <div className="weq-qz-reel-mask" ref={maskRef}>
        <div className="weq-qz-reel-track" ref={trackRef} aria-hidden>
          {[0, 1].map((copy) =>
            items.map(({ post, instance }, index) => {
              const cardIndex = copy * count + index;
              return (
                <ReelCard
                  key={`${copy}:${post.tid}:${instance}`}
                  post={post}
                  showYear={allTime}
                  focused={focusIndex === cardIndex}
                  hovered={hoverIndex === cardIndex}
                  onHoverEnter={() => setHoverIndex(cardIndex)}
                  onHoverLeave={() => setHoverIndex((prev) => (prev === cardIndex ? null : prev))}
                />
              );
            }),
          )}
        </div>
      </div>
    </section>
  );
}

/** 胶片上的一帧：有图看图，没图时文字与引号本身就是画面。 */
function ReelCard({
  post,
  showYear,
  focused,
  hovered,
  onHoverEnter,
  onHoverLeave,
}: {
  post: ReportQzonePost;
  showYear: boolean;
  focused: boolean;
  hovered: boolean;
  onHoverEnter: () => void;
  onHoverLeave: () => void;
}): ReactElement {
  const [broken, setBroken] = useState(false);
  const src = coverOf(post);
  const hasCover = src !== '' && !broken;
  const liked = post.likeCount != null && post.likeCount > 0;

  return (
    <figure
      className={`weq-qz-frame${hasCover ? ' has-cover' : ' is-text'}`}
      data-focus={focused ? 'yes' : 'no'}
      data-hover={hovered ? 'yes' : 'no'}
      onPointerEnter={onHoverEnter}
      onPointerLeave={onHoverLeave}
    >
      {hasCover ? (
        <>
          <img src={albumMediaUrl(src)} alt="" loading="lazy" onError={() => setBroken(true)} />
          {post.hasVideo ? (
            <span className="weq-qz-video-badge" aria-label="视频">
              <Play size={9} fill="currentcolor" aria-hidden />
              视频
            </span>
          ) : null}
        </>
      ) : (
        <>
          <Quote className="weq-qz-frame-quote-mark" size={14} aria-hidden />
          {post.hasVideo ? (
            <span className="weq-qz-video-badge" aria-label="视频">
              <Play size={9} fill="currentcolor" aria-hidden />
              视频
            </span>
          ) : null}
        </>
      )}
      <figcaption>
        <span className="weq-qz-frame-date">
          {fmtMonthDay(post.time, showYear)}
          {post.isPrivate ? <Lock size={8} aria-hidden /> : null}
        </span>
        {liked ? (
          <span className="weq-qz-frame-like">
            <Heart size={8} fill="currentcolor" aria-hidden />
            {fmt(post.likeCount ?? 0)}
          </span>
        ) : null}
      </figcaption>
      <p className="weq-qz-frame-text">{quoteOf(post)}</p>
    </figure>
  );
}
