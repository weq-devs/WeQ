/**
 * 年度装扮页 —— 「这一年，你最喜欢用的装扮」。
 *
 * 这一页刻意**不是**三张类目榜。40801 那一列记的本来就是一整套（气泡 + 字体 + 挂件），
 * 所以聚合单位是「套」，画法也是「把那套穿回身上」。
 *
 * 版面是一间「装扮展柜」：左边是这一页真正的主角 —— 最爱的那一套穿回自己身上
 * （头像 + 挂件 + 真气泡，气泡里的字用那套字体），下面跟着穿它的巨数；
 * 右边则是三类单品展柜：气泡 / 字体 / 挂件各自把用过的那几款「收」成一格，
 * 单品只做干净的商品陈列 —— 挂件不挂头像、气泡不装字、字体不写真消息。
 * 页面底部保留一行注脚：这套三件的款名，与「也拿来写这份报告？」的换字交互。
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
import type { DressItemUsage, DressKindData, DressOutfit, DressPageData } from '@weq/service';
import { isAllTimeYear, reportEraLabel } from '@weq/service/report-time';
import { PageFrame, type ReportPageProps } from '../pageFrame';
import { Odometer, usePrefersReducedMotion } from '../Odometer';
import { useReportView } from '../reportContext';
import { useDressAssets, type DressAssets } from '../useDressAssets';
import { useSelfFace, type SelfFace } from '../useSelfFace';
import { reportFontFamily } from '../reportFont';
import { DressBubble } from '../DressBubble';

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

  return (
    <PageFrame page={page} active={active} ghost={isAllTimeYear(year) ? 'ALL' : year}>
      <div className="weq-dress">
        {hero ? (
          <>
            <DressWindow
              outfit={hero}
              data={data}
              assets={assets}
              face={face}
              active={active}
              reduce={reduce}
              era={reportEraLabel(year)}
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

/** 展柜每类最多陈列多少款。再多只留一个「+N」暗格，不把版面堆满。 */
const CASE_MAX = 5;

/** 三类单品各自的展柜文案与量词。 */
const KIND_META: Record<
  'bubble' | 'font' | 'widget',
  { title: string; unit: string; verb: string; empty: string }
> = {
  bubble: {
    title: '气泡',
    unit: '款',
    verb: '用过',
    empty: '这一年没有换过气泡，聊天一直保持素净。',
  },
  font: {
    title: '字体',
    unit: '款',
    verb: '用过',
    empty: '这一年聊天一直用系统默认字，没换过新字。',
  },
  widget: {
    title: '挂件',
    unit: '款',
    verb: '戴过',
    empty: '这一年头像上没有挂过新挂件。',
  },
};

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
 * 主体 —— 把「最爱这身」与三类单品展柜放进同一扇橱窗。
 *
 * 左边仍保持「一个人在说话」的几何（头像在左、气泡在右，挂件按聊天页比例罩在
 * 头像上），下方接穿这身的巨数与一句装扮率小注；右边就是展柜，三类各占一格，
 * 单品全部做干净的商品陈列，不重复「整套穿上」的画面。
 */
function DressWindow({
  outfit,
  data,
  assets,
  face,
  active,
  reduce,
  era,
}: {
  outfit: DressOutfit;
  data: DressPageData;
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
  /** 装扮率可能极小（0.x% 被整数化掉），与旧数据带同一档显示成 <1%。 */
  const coverage = data.totalSent > 0 ? Math.round((data.decorated / data.totalSent) * 100) : 0;
  const coverageText = coverage > 0 ? fmt(coverage) : '<1';
  const heroDigits = String(Math.max(0, Math.round(outfit.count))).length;
  const heroNumClass = `weq-dress-hero-num${
    heroDigits >= 9 ? ' is-xl' : heroDigits >= 7 ? ' is-long' : ''
  }`;

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

      <div className="weq-dress-window">
        <div className="weq-dress-hero-col">
          <div className="weq-dress-say">
            <SelfAvatar face={face} widget={widget} widgetId={outfit.widgetId} />
            <div className="weq-dress-say-bubble">
              <DressBubble
                skin={skin}
                scale={0.34}
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

          <p className="weq-dress-punch">
            <Odometer value={outfit.count} active={active} className={heroNumClass} />
            <span className="weq-dress-hero-unit">条消息 · 穿这身</span>
          </p>
          <p className="weq-dress-hero-mini">
            全年 <b className="weq-number">{coverageText}%</b> 的发言带着装扮
            {data.outfitCount > 0 ? (
              <>
                <i aria-hidden>·</i>换过 <b className="weq-number">{fmt(data.outfitCount)}</b> 身
              </>
            ) : null}
          </p>
        </div>

        <DressShowcase data={data} assets={assets} />
      </div>
    </section>
  );
}

/** 装扮展柜 —— 用过的那几款气泡 / 字体 / 挂件，像商品一样一格一格收好。 */
function DressShowcase({
  data,
  assets,
}: {
  data: DressPageData;
  assets: DressAssets;
}): ReactElement {
  return (
    <aside className="weq-dress-showcase" aria-label="这一年用过的装扮单品">
      <div className="weq-dress-showcase-head">
        <b>装扮展柜</b>
        <span>用过的，都值得收好</span>
      </div>
      <ShowcaseShelf kind="bubble" kindData={data.bubble} assets={assets} />
      <ShowcaseShelf kind="font" kindData={data.font} assets={assets} />
      <ShowcaseShelf kind="widget" kindData={data.widget} assets={assets} />
    </aside>
  );
}

/** 展柜的一格：左端类别标签 + 右侧该类的商品陈列行。 */
function ShowcaseShelf({
  kind,
  kindData,
  assets,
}: {
  kind: 'bubble' | 'font' | 'widget';
  kindData: DressKindData;
  assets: DressAssets;
}): ReactElement {
  const meta = KIND_META[kind];
  const items = kindData.items.slice(0, CASE_MAX);
  const more = Math.max(0, kindData.distinct - items.length);

  if (items.length === 0) {
    return (
      <div className="weq-dress-shelf is-empty">
        <div className="weq-dress-shelf-label">
          <b>{meta.title}</b>
          <span className="weq-dress-shelf-count">
            <i className="weq-number">0</i>
            {meta.unit}
          </span>
        </div>
        <p className="weq-dress-shelf-empty">{meta.empty}</p>
      </div>
    );
  }

  return (
    <div className="weq-dress-shelf">
      <div className="weq-dress-shelf-label">
        <b>{meta.title}</b>
        <span className="weq-dress-shelf-count">
          <i className="weq-number">{fmt(kindData.distinct)}</i>
          {meta.unit}
        </span>
      </div>

      <ul className="weq-dress-shelf-items">
        {items.map((item) => (
          <li className="weq-dress-item" key={item.itemId}>
            <CaseArt kind={kind} item={item} assets={assets} />
            <p className="weq-dress-item-meta">
              {item.name ? <em title={item.name}>{item.name}</em> : <i aria-hidden />}
              <span>
                {meta.verb} {fmt(item.count)} 次
              </span>
            </p>
          </li>
        ))}
        {more > 0 ? (
          <li className="weq-dress-item is-more" aria-hidden>
            <b>+{fmt(more)}</b>
            <span>{meta.unit}</span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * 单品陈列 —— 干净的商品图：
 *  - 气泡只画空泡（不装字）；
 *  - 字体用「款名」自己写自己（不写真消息），拿不到资源就退回默认衬线；
 *  - 挂件只画挂件（不带头像），静态图 / 逐帧动画都走聊天页同一条渲染链。
 */
function CaseArt({
  kind,
  item,
  assets,
}: {
  kind: 'bubble' | 'font' | 'widget';
  item: DressItemUsage;
  assets: DressAssets;
}): ReactElement {
  if (kind === 'bubble') {
    const skin = assets.bubbles.get(item.itemId) ?? null;
    return (
      <div className="weq-dress-item-art is-bubble" aria-hidden>
        <DressBubble skin={skin} scale={0.27} className="is-case">
          {null}
        </DressBubble>
      </div>
    );
  }

  if (kind === 'font') {
    const ready = assets.fonts.has(item.itemId);
    return (
      <span className="weq-dress-item-art is-font" aria-hidden>
        <span
          className="weq-dress-item-sample"
          style={
            ready
              ? { fontFamily: `"${reportFontFamily(item.itemId)}", var(--rp-serif)` }
              : undefined
          }
        >
          {item.name || '这款字'}
        </span>
      </span>
    );
  }

  return (
    <span className="weq-dress-item-art is-widget">
      <CasePendant widgetId={item.itemId} widget={assets.widgets.get(item.itemId) ?? null} />
    </span>
  );
}

/** 展柜里的挂件：动画款直接挂帧 CSS 选择器，静态款画普通 <img>。 */
function CasePendant({
  widgetId,
  widget,
}: {
  widgetId: number;
  widget: { animated: boolean; frameCount?: number; url?: string } | null;
}): ReactElement | null {
  const [broken, setBroken] = useState(false);
  if (widget?.animated) {
    return <span className="weq-dress-face-pendant is-case" data-widget={widgetId} aria-hidden />;
  }
  const url = widget?.url;
  if (!url || broken) return null;
  return (
    <img
      className="weq-dress-face-pendant is-case"
      src={url}
      alt=""
      aria-hidden
      onError={() => setBroken(true)}
    />
  );
}

/**
 * 页脚 —— 一行注脚。左边这套三件的款名（没有商城元数据就省略，用空位顶住右边），
 * 右边是「也拿来写这份报告？」。这是唯一还留在页面里的交互，压在展柜之下收尾。
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
