/**
 * 年度装扮页 —— 「这一年，你最喜欢用的装扮」。
 *
 * 这一页刻意**不是**三张类目榜。40801 那一列记的本来就是一整套（气泡 + 字体 + 挂件），
 * 所以聚合单位是「套」，画法也是「把那套穿回身上」。
 *
 * 版面像总览页一样有一条叙事线，从上往下依次是：
 *  - **样张** —— 最爱的那一套穿回自己身上：头像（+ 挂件）+ 一只真气泡，气泡里的字
 *    用那套的字体。它先回答「这身到底长什么样」。
 *  - **巨数** —— 这一年穿这身发出的消息条数（总览页同一套巨型里程表语言）。这条数
 *    永远不为零：能翻到这一页，就说明至少有一句真话是穿着它说出去的。
 *  - **数据带** —— 气泡 / 字体 / 挂件各用过几款 + 全年装扮率，抄总览页底部数据带的
 *    版式。带之上不再叠第二层统计，避免又回到「数据面板」。
 *  - **注脚行** —— 这套三件的款名，右端保留「也拿来写这份报告？」的换字交互。
 *
 * 全页不出现任何装扮编号：用户看不懂 itemId，看得懂的是气泡长什么样、字是什么形状。
 * 款名有就写，没有就不写。
 *
 * 资源全部走 `weq-media://` 本地协议（气泡九宫格 PNG / 字体 ttf / 挂件帧）。
 * **拿不到就静默退化**（气泡退成描边框、字体退回衬线、挂件不画），不提示、不报错 ——
 * 年度报告是「打开就看」的东西，「需要登录 QQ 客户端」那类话属于装扮商城页。
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';
import { Check } from 'lucide-react';
import type { DressOutfit, DressPageData } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer, usePrefersReducedMotion } from '../Odometer';
import { useReportView } from '../reportContext';
import { useDressAssets, type DressAssets } from '../useDressAssets';
import { useSelfFace, type SelfFace } from '../useSelfFace';
import { reportFontFamily } from '../reportFont';
import { DressBubble, HERO_SCALE } from '../DressBubble';

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

/** 主体气泡里写什么：优先用那套说过的最长一句真话，一句都没采到才用兜底文案。 */
const HERO_FALLBACK = '这一年，我最爱这身';

export function DressPage({ page, data, active }: ReportPageProps<DressPageData>): ReactElement {
  const { year } = data;
  const reduce = usePrefersReducedMotion();
  const assets = useDressAssets(data);
  const face = useSelfFace();
  const { reportFontId, setReportFontId } = useReportView();

  /** 最爱的那一套 —— 样张与巨数的共同来源。 */
  const hero = data.outfits[0] ?? null;

  /** 这一年有多少比例的发言穿着装扮 —— 数据带的一格。 */
  const coverage = data.totalSent > 0 ? Math.round((data.decorated / data.totalSent) * 100) : 0;

  return (
    <PageFrame page={page} active={active} ghost={isAllTimeYear(year) ? 'ALL' : year}>
      <div className="weq-dress">
        {hero ? (
          <>
            <HeroOutfit
              outfit={hero}
              assets={assets}
              face={face}
              active={active}
              reduce={reduce}
              era={reportEraLabel(year)}
            />

            <p className="weq-dress-punch weq-report-line" style={{ '--i': 3 } as CSSProperties}>
              <Odometer value={hero.count} active={active} className="weq-dress-hero-num" />
              <span className="weq-dress-hero-unit">条消息使用这身装扮</span>
            </p>

            <DressBand
              bubbleKinds={data.bubble.distinct}
              fontKinds={data.font.distinct}
              widgetKinds={data.widget.distinct}
              outfitKinds={data.outfitCount}
              coverage={coverage}
            />

            <DressFoot
              note={wornAs(hero)}
              fontId={hero.fontId}
              fontName={hero.fontName}
              fontReady={hero.fontId > 0 && assets.fonts.has(hero.fontId)}
              fontAdopted={reportFontId === hero.fontId}
              onAdoptFont={setReportFontId}
            />
          </>
        ) : null}
      </div>
    </PageFrame>
  );
}

/** 这套三件的款名连成一行。都没记过商城元数据就是空串，整行不出现。 */
function wornAs(outfit: DressOutfit): string {
  return [
    outfit.bubbleName && `气泡「${outfit.bubbleName}」`,
    outfit.fontName && `字体「${outfit.fontName}」`,
    outfit.widgetName && `挂件「${outfit.widgetName}」`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * 样张 —— 「这一年我最爱这身」的引子：头像（+ 挂件）+ 真气泡把那一身穿回自己身上。
 *
 * 版面是「一个人在说话」：头像在左、气泡在右；头像与挂件的几何照搬聊天页（挂件 =
 * 头像的 2 倍、绝对居中、上偏 4/56 的比例）—— 比例不动、中心对齐不动，缩到样张的
 * 尺度也不会歪。真正的巨数留给下面一行，这一层不抢话。
 */
function HeroOutfit({
  outfit,
  assets,
  face,
  active,
  reduce,
  era,
}: {
  outfit: DressOutfit;
  assets: DressAssets;
  face: SelfFace;
  active: boolean;
  reduce: boolean;
  era: string;
}): ReactElement {
  const [shown, setShown] = useState(false);
  const fontReady = outfit.fontId > 0 && assets.fonts.has(outfit.fontId);
  const skin = outfit.bubbleId > 0 ? (assets.bubbles.get(outfit.bubbleId) ?? null) : null;
  const widget = outfit.widgetId > 0 ? (assets.widgets.get(outfit.widgetId) ?? null) : null;
  /** 气泡里写真话：那套说过的最长一句最像「当年的自己」。 */
  const line = useMemo(() => longest(outfit.samples) || HERO_FALLBACK, [outfit.samples]);

  useEffect(() => {
    if (!active) {
      setShown(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShown(true), reduce ? 0 : 260);
    return () => window.clearTimeout(timer);
  }, [active, reduce]);

  return (
    <section className="weq-dress-hero" data-shown={shown ? 'yes' : 'no'}>
      <p className="weq-dress-kicker">
        {era}，我最爱这身装扮
        <span className="weq-dress-kicker-rule" aria-hidden />
      </p>

      <div className="weq-dress-say">
        <SelfAvatar face={face} widget={widget} widgetId={outfit.widgetId} />
        <div className="weq-dress-say-bubble">
          <DressBubble
            skin={skin}
            scale={HERO_SCALE}
            className="is-hero"
            style={
              fontReady
                ? { fontFamily: `"${reportFontFamily(outfit.fontId)}", var(--rp-serif)` }
                : undefined
            }
          >
            {line}
          </DressBubble>
        </div>
      </div>
    </section>
  );
}

/**
 * 数据带 —— 气泡 / 字体 / 挂件各用了几款 + 全年装扮率。
 *
 * 版式直接抄总览页底部那三格：发丝线分隔、33px 衬线数字、小字类目在上。这里把它
 * 撑成五格 —— 某类目有时是 0 款（比如只换字体没换挂件），0 本身就是「这一年没碰过
 * 它」，比空掉一格更清楚；末格补「换过几身」。装扮率可能极小（0.x% 被整数化掉），
 * 显示成 <1%。
 */
function DressBand({
  bubbleKinds,
  fontKinds,
  widgetKinds,
  outfitKinds,
  coverage,
}: {
  bubbleKinds: number;
  fontKinds: number;
  widgetKinds: number;
  outfitKinds: number;
  coverage: number;
}): ReactElement {
  const cells = [
    { label: '气泡', value: fmt(bubbleKinds), unit: '款' },
    { label: '字体', value: fmt(fontKinds), unit: '款' },
    { label: '挂件', value: fmt(widgetKinds), unit: '款' },
    { label: '换过', value: fmt(outfitKinds), unit: '身' },
    { label: '全年装扮率', value: coverage > 0 ? fmt(coverage) : '<1', unit: '%' },
  ];

  return (
    <dl className="weq-dress-band weq-report-line" style={{ '--i': 4 } as CSSProperties}>
      {cells.map((cell) => (
        <div className="weq-dress-band-cell" key={cell.label}>
          <dt>{cell.label}</dt>
          <dd>
            <span className="weq-number">{cell.value}</span>
            <i>{cell.unit}</i>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 页脚 —— 一行注脚。左边这套三件的款名（没有商城元数据就省略，用空位顶住右边），
 * 右边是「也拿来写这份报告？」。这是唯一还留在页面里的交互，压在数据带之下收尾。
 */
function DressFoot({
  note,
  fontId,
  fontName,
  fontReady,
  fontAdopted,
  onAdoptFont,
}: {
  note: string;
  fontId: number;
  fontName: string;
  fontReady: boolean;
  fontAdopted: boolean;
  onAdoptFont: (itemId: number | null) => void;
}): ReactElement | null {
  if (!note && !fontReady) return null;
  return (
    <footer className="weq-dress-foot weq-report-line" style={{ '--i': 5 } as CSSProperties}>
      {note ? <p className="weq-dress-hero-note">{note}</p> : <span aria-hidden />}
      {fontReady ? (
        <FontAdoption
          fontId={fontId}
          fontName={fontName}
          adopted={fontAdopted}
          onAdopt={onAdoptFont}
        />
      ) : null}
    </footer>
  );
}

/**
 * 「用它当这份报告的字体？」—— 只在最爱那套的 ttf 真的加载成功时渲染。
 *
 * 换字是即时的（整份报告，含已经翻过的总览页和之后的每一页），再点一次还原。
 * 调用方保证 `ready`，这里不再重复判。
 */
function FontAdoption({
  fontId,
  fontName,
  adopted,
  onAdopt,
}: {
  fontId: number;
  fontName: string;
  adopted: boolean;
  onAdopt: (itemId: number | null) => void;
}): ReactElement {
  const family = `"${reportFontFamily(fontId)}", var(--rp-serif)`;
  return (
    <div className="weq-dress-adopt">
      <span className="weq-dress-adopt-ask">
        {/* 用那款字体自己写自己 —— 比写出款名更能说明「换上会长这样」。 */}
        <em style={{ fontFamily: family }}>{fontName || '这款字'}</em>
        也拿来写这份报告？
      </span>
      <button
        type="button"
        className="weq-dress-adopt-btn"
        data-on={adopted ? 'yes' : 'no'}
        onClick={() => onAdopt(adopted ? null : fontId)}
      >
        {adopted ? <Check size={15} aria-hidden /> : null}
        {adopted ? '已换上 · 点此还原' : '好，换上'}
      </button>
    </div>
  );
}

/**
 * 自己的头像 + 挂件。
 *
 * 几何与聊天页同源（`im-template/styles/chat.css` 的 `.weq-avatar-pendant`）：舞台是
 * 正方形 inline-grid、`place-items: center`，挂件绝对居中后按头像的 2 倍铺开、上偏
 * 一点点。三个量都相对 `--sz`，改 `--sz` 就整体缩放，中心对齐和上偏比例自动跟着走。
 *
 * 挂件缺席（没装 / 资源没解析出来）只画头像 —— 头像永远在。
 */
function SelfAvatar({
  face,
  widget,
  widgetId,
}: {
  face: SelfFace;
  widget: { animated: boolean; frameCount?: number; url?: string } | null;
  widgetId: number;
}): ReactElement {
  const [broken, setBroken] = useState(false);

  return (
    <span className="weq-dress-face is-hero">
      {face.avatarUrl && !broken ? (
        <img
          className="weq-dress-face-img"
          src={face.avatarUrl}
          alt=""
          aria-hidden
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="weq-dress-face-img is-initial" aria-hidden>
          {face.initial}
        </span>
      )}
      <Pendant widget={widget} widgetId={widgetId} selfUrl={face.pendantUrl} />
    </span>
  );
}

/**
 * 头像挂件。三条来源按可靠度排：
 *  1. 这套装扮解析出的动画帧（keyframes 已由 useDressAssets 注入）；
 *  2. 它解析出的静态图；
 *  3. 自己当前戴的那个（`SelfPendantContext`）—— 只在这套本来就有挂件时才顶上，
 *     免得给一套没戴挂件的装扮凭空加一个。
 * 三条都没有就什么都不画。
 */
function Pendant({
  widget,
  widgetId,
  selfUrl,
}: {
  widget: { animated: boolean; frameCount?: number; url?: string } | null;
  widgetId: number;
  selfUrl: string;
}): ReactElement | null {
  const [broken, setBroken] = useState(false);

  if (widget?.animated) {
    // 帧动画的 @keyframes 由 injectReportPendantCss 注入，这里只挂选择器要的钩子。
    return (
      <span className="weq-dress-face-pendant is-animated" data-widget={widgetId} aria-hidden />
    );
  }
  const url = widget?.url || (widgetId > 0 ? selfUrl : '');
  if (!url || broken) return null;
  return (
    <img
      className="weq-dress-face-pendant"
      src={url}
      alt=""
      aria-hidden
      onError={() => setBroken(true)}
    />
  );
}

/** 那套说过的最长一句 —— 最长的通常最完整，也最像句人话。 */
function longest(samples: string[]): string {
  let best = '';
  for (const sample of samples) {
    if (sample.length > best.length) best = sample;
  }
  return best;
}
