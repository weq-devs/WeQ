import { useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { Heart, Lock, Play, Quote } from 'lucide-react';
import type { QzoneMemoriesPageData, ReportQzonePost } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer } from '../Odometer';
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
 * 一格一格摇出来，像把空间那本老相册重新翻了一遍。下面一条窄窄的「时光胶片」
 * 无限跑动，把最近/最早的说说混成一帧帧画面 —— 有图的看图，没图的看字，全部
 * 都只是当年那个你的碎片。颜色取 QQ 空间一贯的云海蓝，收在整份暖调报告的末段，
 * 像合上相册前最后一眼远方的天空。
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
          <section className="weq-qz-reel weq-report-line" style={{ '--i': 6 } as CSSProperties}>
            <p className="weq-qz-reel-in">
              时光胶片 · {allTime ? '往回翻，每一帧都是你' : `这一年，你留在空间里的画面`}
            </p>
            <div className="weq-qz-reel-mask">
              <div className="weq-qz-reel-track" data-enter={active ? 'in' : 'out'} aria-hidden>
                {[0, 1].map((copy) =>
                  gallery.map(({ post, instance }) => (
                    <ReelCard
                      key={`${copy}:${post.tid}:${instance}`}
                      post={post}
                      showYear={allTime}
                    />
                  )),
                )}
              </div>
            </div>
          </section>
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

/** 胶片上的一帧：有图看图，没图时文字与引号本身就是画面。 */
function ReelCard({ post, showYear }: { post: ReportQzonePost; showYear: boolean }): ReactElement {
  const [broken, setBroken] = useState(false);
  const src = coverOf(post);
  const hasCover = src !== '' && !broken;
  const liked = post.likeCount != null && post.likeCount > 0;

  return (
    <figure className={`weq-qz-frame${hasCover ? ' has-cover' : ' is-text'}`}>
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
