/**
 * 年度装扮页 —— 「这一年，你最喜欢用的装扮」。
 *
 * 这一页刻意**不是**三张类目榜。40801 那一列记的本来就是一整套（气泡 + 字体 + 挂件），
 * 所以聚合单位是「套」，画法也是「把那套穿回身上」。
 *
 * 版面分两层，先后出现，不并排：
 *
 *   - **主体**（第一眼）：最爱的那一套独占整个画幅。自己的头像（无论有没有挂件都画）
 *     \+ 挂件叠在上面，右边是一只贴到 0.62 的巨大真气泡，气泡里的字用那套的字体。
 *     四周大片留白 —— 这一页只有一个主角，留白就是它的底座。
 *   - **底账**（准备翻页时）：滚到底再往下推一次，统计与回忆流像一块幕布从画幅
 *     下方切上来：装扮率的超大百分比 + 气泡/字体/挂件各用过几款 + 一条横向滚动的
 *     真实消息带（每条都用它**当年真正穿的那套**重画）。再往下才真的翻页，往上
 *     收回幕布。主体在幕后退进景深但不消失 —— 它始终是这一页的主角。
 *
 * 全页不出现任何装扮编号：用户看不懂 itemId，看得懂的是气泡长什么样、字是什么形状。
 * 款名有就写，没有就不写。
 *
 * 资源全部走 `weq-media://` 本地协议（气泡九宫格 PNG / 字体 ttf / 挂件帧）。
 * **拿不到就静默退化**（气泡退成描边框、字体退回衬线、挂件不画），不提示、不报错 ——
 * 年度报告是「打开就看」的东西，「需要登录 QQ 客户端」那类话属于装扮商城页。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
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

/** 回忆带至少要有几条才滚得动；不够就静态列出来，免得看见接缝。 */
const SCROLL_MIN = 5;

/** 回忆带一屏最多参与多少条 —— 再多也看不完，只是白占内存和布局计算。 */
const SCROLL_MAX = 28;

export function DressPage({ page, data, active }: ReportPageProps<DressPageData>): ReactElement {
  const { year } = data;
  const reduce = usePrefersReducedMotion();
  const assets = useDressAssets(data);
  const face = useSelfFace();
  const { reportFontId, setReportFontId, registerPageGuard } = useReportView();

  /** 最爱的那一套 —— 这一页的绝对主角。 */
  const hero = data.outfits[0] ?? null;

  /**
   * 回忆带的条目：把每套的采样摊平成「一句话 + 它当年那套装扮」。
   *
   * 按套轮转取样（第一轮各取第 1 句，第二轮各取第 2 句…）而不是把主角那套的
   * 24 句一次倒完 —— 滚过去的气泡要换着样子，才像翻自己的聊天记录。
   */
  const memories = useMemo(() => flattenSamples(data.outfits), [data.outfits]);

  /**
   * 底账幕布是否已经切上来。
   *
   * 状态同时存进 ref：翻页守卫是注册给舞台的一个函数，它读到的必须是**当下**的
   * 开合状态，而不是注册那一刻闭包捕获的旧值（否则第二次向下推还会再「开」一次，
   * 永远翻不到下一页）。
   */
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const setOpenBoth = useCallback((next: boolean) => {
    openRef.current = next;
    setOpen(next);
  }, []);

  /**
   * 翻页守卫 —— 这一页「向下」的第一下不翻页，而是把底账切上来；第二下才走。
   * 向上先收幕布，再往上才回到上一页。
   *
   * 只在这一页是当前页时注册；翻走时 dispose 顺手把幕布收回，翻回来又是干净的
   * 「先看主体」——报告是看的，不是仪表盘。
   */
  useEffect(() => {
    if (!active) {
      setOpenBoth(false);
      return undefined;
    }
    const dispose = registerPageGuard((direction) => {
      if (direction === 1 && !openRef.current) {
        setOpenBoth(true);
        return true;
      }
      if (direction === -1 && openRef.current) {
        setOpenBoth(false);
        return true;
      }
      return false;
    });
    return () => {
      dispose();
      setOpenBoth(false);
    };
  }, [active, registerPageGuard, setOpenBoth]);

  const coverage = data.totalSent > 0 ? Math.round((data.decorated / data.totalSent) * 100) : 0;

  return (
    <PageFrame page={page} active={active} ghost={isAllTimeYear(year) ? 'ALL' : year}>
      <div className="weq-dress" data-open={open ? 'yes' : 'no'}>
        {/* 主体层。底账切上来时整层退进景深（上移 + 收小 + 压暗），但绝不隐藏。 */}
        <div className="weq-dress-stage">
          {hero ? (
            <HeroOutfit
              outfit={hero}
              assets={assets}
              face={face}
              active={active}
              reduce={reduce}
              era={reportEraLabel(year)}
            />
          ) : null}

          {hero && hero.fontId > 0 ? (
            <FontAdoption
              fontId={hero.fontId}
              fontName={hero.fontName}
              ready={assets.fonts.has(hero.fontId)}
              adopted={reportFontId === hero.fontId}
              onAdopt={setReportFontId}
            />
          ) : null}
        </div>

        {/* 「还有」提示 —— 幕布没上来时告诉用户往下推还有东西，上来后就该消失。 */}
        <p className="weq-dress-more" aria-hidden={open}>
          <span className="weq-dress-more-rule" aria-hidden />
          再往下，看看这一年的全部行头
        </p>

        <LedgerCurtain
          open={open}
          active={active}
          reduce={reduce}
          coverage={coverage}
          decorated={data.decorated}
          outfitCount={data.outfitCount}
          bubbleKinds={data.bubble.distinct}
          fontKinds={data.font.distinct}
          widgetKinds={data.widget.distinct}
          memories={memories}
          assets={assets}
          onClose={() => setOpenBoth(false)}
        />
      </div>
    </PageFrame>
  );
}

/**
 * 主体 —— 「这一年我最爱这身」，独占整个画幅。
 *
 * 版面是「一个人在说话」：左边自己的头像（+ 挂件），右边一只巨大的真气泡。头像与
 * 挂件的几何照搬聊天页（挂件 = 头像的 2 倍、绝对居中、上偏 4/56 的比例），只是整体
 * 放大 —— 比例不动，中心对齐不动，所以放到多大都不会歪。
 *
 * 页脚只留两样：穿了多少条消息，和这套三件的款名。**总量统计一律搬进底账幕布** ——
 * 这一层的任务是让人看见那一年别人看到的自己，不是报数。
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
        {era}，我最爱这身
        <span className="weq-dress-kicker-rule" aria-hidden />
      </p>

      <div className="weq-dress-say">
        <SelfAvatar face={face} widget={widget} widgetId={outfit.widgetId} size="hero" />
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

      <div className="weq-dress-hero-foot">
        <div className="weq-dress-hero-count">
          <Odometer value={outfit.count} active={active} className="weq-dress-hero-num" />
          <span className="weq-dress-hero-unit">条消息穿着它</span>
        </div>
        <p className="weq-dress-hero-note">
          {[
            outfit.bubbleName && `气泡「${outfit.bubbleName}」`,
            outfit.fontName && `字体「${outfit.fontName}」`,
            outfit.widgetName && `挂件「${outfit.widgetName}」`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
    </section>
  );
}

/**
 * 底账幕布 —— 准备翻页时从画幅下方切上来的那一层。
 *
 * 内容是这一页所有「数」和所有「别的那些身」：
 *   - 装扮率的超大百分比（这一层的主角，也是整页唯一的巨型数字对手戏）；
 *   - 气泡 / 字体 / 挂件各用过几款 + 一共换过几身；
 *   - 一条横向滚动的真实消息带，每条穿着它当年那套。
 *
 * 横向滚动是刻意的：翻页是纵向的，幕布是横向的，两种运动不打架 —— 用户不会把
 * 「带子在动」误当成「页面在滑」。
 *
 * `aria-hidden` 跟着开合走：幕布没上来时它对读屏不存在，免得念出一屏没在画面上
 * 的数字。整层用 `inert` 语义的等价做法（`aria-hidden` + `pointer-events: none`），
 * 因为 React 19 之前 `inert` 不是标准属性。
 */
function LedgerCurtain({
  open,
  active,
  reduce,
  coverage,
  decorated,
  outfitCount,
  bubbleKinds,
  fontKinds,
  widgetKinds,
  memories,
  assets,
  onClose,
}: {
  open: boolean;
  active: boolean;
  reduce: boolean;
  coverage: number;
  decorated: number;
  outfitCount: number;
  bubbleKinds: number;
  fontKinds: number;
  widgetKinds: number;
  memories: Memory[];
  assets: DressAssets;
  onClose: () => void;
}): ReactElement {
  return (
    <aside className="weq-dress-ledger" data-open={open ? 'yes' : 'no'} aria-hidden={!open}>
      {/* 切屏的那道亮边：幕布上沿的一条扫光，只在开合的一瞬间看得见。 */}
      <span className="weq-dress-ledger-edge" aria-hidden />

      <div className="weq-dress-ledger-inner">
        <div className="weq-dress-ledger-head">
          <div className="weq-dress-rate">
            <Odometer
              value={coverage}
              active={open && active}
              className="weq-dress-rate-num"
              durationMs={1100}
            />
            <span className="weq-dress-rate-pct" aria-hidden>
              %
            </span>
            <span className="weq-dress-rate-label">
              的发言
              <em>穿着装扮</em>
            </span>
          </div>

          <dl className="weq-dress-kinds">
            <KindCell label="气泡" value={bubbleKinds} />
            <KindCell label="字体" value={fontKinds} />
            <KindCell label="挂件" value={widgetKinds} />
            <KindCell label="换过" value={outfitCount} unit="身" />
          </dl>
        </div>

        <p className="weq-dress-ledger-note">
          {fmt(decorated)} 条消息被打扮过
          {coverage > 0 ? null : '（这一段几乎没穿）'}
        </p>

        <MemoryBand memories={memories} assets={assets} running={open} reduce={reduce} />

        <button type="button" className="weq-dress-ledger-close" onClick={onClose}>
          收起 · 回到那一身
        </button>
      </div>
    </aside>
  );
}

/** 底账里的一格计数：「气泡 12 款」。`unit` 默认「款」。 */
function KindCell({
  label,
  value,
  unit = '款',
}: {
  label: string;
  value: number;
  unit?: string;
}): ReactElement {
  return (
    <div className="weq-dress-kind">
      <dt>{label}</dt>
      <dd>
        <span className="weq-number">{fmt(value)}</span>
        <i>{unit}</i>
      </dd>
    </div>
  );
}

/**
 * 自己的头像 + 挂件。
 *
 * 几何与聊天页同源（`im-template/styles/chat.css` 的 `.weq-avatar-pendant`）：舞台是
 * 正方形 inline-grid、`place-items: center`，挂件绝对居中后按头像的 2 倍铺开、上偏
 * 一点点。这里把三个量都换成相对 `--sz` 的比例，`is-hero` 只需要改 `--sz` 就整体放大，
 * 中心对齐和上偏比例自动跟着走。
 *
 * 挂件缺席（没装 / 资源没解析出来）只画头像 —— 头像永远在。
 */
function SelfAvatar({
  face,
  widget,
  widgetId,
  size,
}: {
  face: SelfFace;
  widget: { animated: boolean; frameCount?: number; url?: string } | null;
  widgetId: number;
  size: 'hero' | 'line';
}): ReactElement {
  const [broken, setBroken] = useState(false);

  return (
    <span className={`weq-dress-face is-${size}`}>
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

/** 回忆带里的一条：一句真话 + 它当年那套。 */
type Memory = { key: string; text: string; outfit: DressOutfit };

/**
 * 回忆带 —— 底账里那条横向无缝滚动的真实消息，每条都穿着它当年那套装扮。
 *
 * 内容复制两份首尾相接、轨道位移 -50% 循环：CSS 单条 animation 就能无缝，不用 JS
 * 逐帧算位置。滚动的是**真气泡 + 真字体**，所以用户看到的是「我那时候发消息就是
 * 这样的」。
 *
 * 只在幕布切上来后才跑（`running`）：幕后跑动画既看不见又白烧一份合成层。
 * 条数太少（< SCROLL_MIN）时不滚 —— 只有三四条的话循环接缝一眼就看出来了。
 */
function MemoryBand({
  memories,
  assets,
  running,
  reduce,
}: {
  memories: Memory[];
  assets: DressAssets;
  running: boolean;
  reduce: boolean;
}): ReactElement | null {
  if (memories.length === 0) return null;
  const rolling = memories.length >= SCROLL_MIN && !reduce;
  // 每条约 180px 宽，配一个跟条数成正比的时长：条数多也不会越滚越快。
  const duration = Math.max(24, Math.round(memories.length * 2.6));
  // 滚动要无缝就得有两份内容首尾相接（轨道位移 -50% 正好是一份）。第二份是纯视觉
  // 复制品：`pass` 进 key 保证两份的 key 不撞，`aria-hidden` 让读屏只念一遍。
  const lane = rolling
    ? [...memories.map((m) => ({ ...m, pass: 0 })), ...memories.map((m) => ({ ...m, pass: 1 }))]
    : memories.map((m) => ({ ...m, pass: 0 }));

  return (
    <div className="weq-dress-band" data-rolling={rolling ? 'yes' : 'no'}>
      <div
        className="weq-dress-band-lane"
        data-run={running && rolling ? 'yes' : 'no'}
        style={{ '--dur': `${duration}s` } as CSSProperties}
      >
        {lane.map((memory) => {
          const fontReady = memory.outfit.fontId > 0 && assets.fonts.has(memory.outfit.fontId);
          const skin =
            memory.outfit.bubbleId > 0
              ? (assets.bubbles.get(memory.outfit.bubbleId) ?? null)
              : null;
          return (
            <div
              className="weq-dress-band-cell"
              key={`${memory.key}@${memory.pass}`}
              aria-hidden={memory.pass > 0}
            >
              <DressBubble
                skin={skin}
                style={
                  fontReady
                    ? { fontFamily: `"${reportFontFamily(memory.outfit.fontId)}", var(--rp-sans)` }
                    : undefined
                }
              >
                {memory.text}
              </DressBubble>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 「用它当这份报告的字体？」—— 只在最爱那套带字体、且它的 ttf 真的加载成功时出现。
 *
 * 换字是即时的（整份报告，含已经翻过的总览页和之后的每一页），再点一次还原。
 * 没就绪时整块不渲染，而不是渲染一个点了没反应的按钮。
 */
function FontAdoption({
  fontId,
  fontName,
  ready,
  adopted,
  onAdopt,
}: {
  fontId: number;
  fontName: string;
  ready: boolean;
  adopted: boolean;
  onAdopt: (itemId: number | null) => void;
}): ReactElement | null {
  if (!ready) return null;
  const family = `"${reportFontFamily(fontId)}", var(--rp-serif)`;
  return (
    <div className="weq-dress-adopt weq-report-line" style={{ '--i': 6 } as CSSProperties}>
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

/** 那套说过的最长一句 —— 最长的通常最完整，也最像句人话。 */
function longest(samples: string[]): string {
  let best = '';
  for (const sample of samples) {
    if (sample.length > best.length) best = sample;
  }
  return best;
}

/**
 * 全部套装的采样 → 回忆带条目，按轮次交错。
 *
 * 第 i 轮把每套的第 i 句各取一条，所以带子上相邻的气泡多半来自不同的套装；直接
 * `flatMap` 会让主角那套的 24 句连成一片，看起来像同一条消息复制了二十遍。
 */
function flattenSamples(outfits: DressOutfit[]): Memory[] {
  const out: Memory[] = [];
  const rounds = Math.max(0, ...outfits.map((o) => o.samples.length));
  for (let round = 0; round < rounds && out.length < SCROLL_MAX; round += 1) {
    for (const outfit of outfits) {
      const text = outfit.samples[round];
      if (!text) continue;
      out.push({ key: `${outfit.key}#${round}`, text, outfit });
      if (out.length >= SCROLL_MAX) break;
    }
  }
  return out;
}
