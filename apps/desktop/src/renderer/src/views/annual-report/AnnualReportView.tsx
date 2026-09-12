import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import {
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Maximize2,
  Minimize2,
  RefreshCw,
} from 'lucide-react';
import type { ReportManifest } from '@weq/service';
import { ALL_TIME_YEAR, reportEraLabel, reportPeriodLabel } from '@weq/service/report-time';
import { client, trpc } from '../../trpc/client';
import { AnnualReportStage } from './AnnualReportStage';
import { AnnualReportEntry } from './AnnualReportEntry';
import { renderReportPage } from './pageRegistry';
import { applyReportFont, clearReportFont } from './reportFont';
import {
  ReportViewContext,
  type PageTurnGuard,
  type ReportViewContextValue,
} from './reportContext';
import '../../styles/annual-report.css';

type PageState = { status: 'idle' | 'loading' | 'ok' | 'error'; data?: unknown; error?: string };

const SLIDE_TRANSITION =
  'opacity 900ms cubic-bezier(0.16, 1, 0.3, 1), transform 1000ms cubic-bezier(0.16, 1, 0.3, 1), filter 900ms cubic-bezier(0.16, 1, 0.3, 1)';

/** 年份选择海报永久占据轨道第 0 页：所有真页的虚拟索引 = 实际索引 + 1。 */
const PAGE_OFFSET = 1;

/**
 * 每页真正的等待工作。年度报告页面共享同一批内存缓存，但每个页面的统计仍然
 * 各自要扫自己的那几列 / 解自己的正文 —— 这里把它翻译成人话，告诉用户主进程
 * 此刻卡在哪一步，而不是只转一个圈。
 */
function computationDescription(pageId: string): string {
  switch (pageId) {
    case 'overview':
      return '正在扫描私聊与群聊消息，统计这一年发出 / 收到多少条';
    case 'dress':
      return '正在扫描这一年发出的消息，统计用过的气泡、字体与挂件';
    case 'spark':
      return '正在按「会话 × 日期」扫私聊记录，找最忙的一天与最长火花';
    case 'friends':
      return '正在把同一天的私聊记录归到每个好友，排出好友榜';
    case 'openers':
      return '正在按 5 小时静默间隔切分私聊，数每段聊天由谁先开口';
    case 'rhythm':
      return '正在把发出的消息按星期与小时归桶，还原你的作息';
    case 'voice':
      return '正在逐条解码你发出的消息并分词，最慢的一页，请稍候';
    case 'home':
      return '正在统计各群发言量，并读取说得最多的那个群的正文';
    case 'at':
      return '正在扫描群消息正文，数你 @ 过谁、谁在人群里喊过你';
    case 'poke':
      return '正在扫描群消息正文，数戳一戳与被戳的那些一下';
    case 'echo':
      return '正在扫描群消息正文，找那些被大家接住的同一句话';
    case 'months':
      return '正在把私聊按月分桶，排出每个月的聊天第一名';
    case 'mate':
      return '正在扫群成员与好友名册，计算跨群兴趣重合度';
    case 'qzone':
      return '正在从你的 QQ 空间逐页拉取说说（需要 QQ 在线）';
    case 'end':
      return '正在收尾这一份报告';
    default:
      return '正在本地统计这一年';
  }
}

/**
 * 相邻页做「景深退场」：往后压一点、糊掉、压暗。翻页时前一页像被推进暗处，
 * 而不是两张卡片并排滑动 —— 这是报告的电影感来源之一。
 *
 * 上下两侧刻意**不对称**：已翻过的页（delta < 0）往上退进景深，还没到的页
 * （delta > 0）从下方抬起来，位移幅度比退场那侧大一档。对称的话翻上翻下看起来
 * 一模一样，方向感就丢了 —— 这一点位移差正是「往下翻」的实感来源。
 */
function slideStyle(pageIndex: number, index: number): CSSProperties {
  const delta = pageIndex - index;
  const distance = Math.abs(delta);
  const shift = delta < 0 ? distance * -4 : distance * 7;
  return {
    opacity: distance > 1 ? 0 : 1 - distance * 0.82,
    transform: `scale(${1 - distance * 0.08}) translateY(${shift}%)`,
    filter: distance > 0 ? 'blur(14px)' : 'none',
    transition: SLIDE_TRANSITION,
    zIndex: distance === 0 ? 2 : 1,
    pointerEvents: distance === 0 ? 'auto' : 'none',
  };
}

/**
 * 整页等待态 —— 一个带完成百分比的大进度圈。年份可选列表出现之后，剩下的
 * “等待”基本都发生在某一页的统计上：已完成页数 / 总页数就是能稳定给出的进度，
 * 正在算的那页再由 {@link computationDescription} 告诉用户具体在扫什么。
 */
function ReportPageLoading({
  page,
  order,
  readyCount,
  total,
  queued,
  active,
}: {
  page: ReportManifest['pages'][number];
  order: number;
  readyCount: number;
  total: number;
  queued: boolean;
  active: boolean;
}): ReactElement {
  const realPercent = total > 0 ? Math.round((readyCount / total) * 100) : 0;
  /**
   * 真实进度只在「某一页统计完成」的瞬间才前进；第一页常常要在主进程里扫十几秒，
   * 这期间 0/12 的环一动不动，根本看不出是进度条。所以叠一层**模拟进度**：从当前
   * 真实进度起步，向 92% 渐近爬升（永远到不了 100%，不会假装算完），真实进度一旦
   * 追上来就取真实值 —— 展示值 = max(真实, 模拟)。只在当前页可见时才跑动画。
   */
  const [simulated, setSimulated] = useState(realPercent);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      // 每帧把模拟值向 92% 逼近一截：约 0.6s 到 10%、3.5s 到 50%、8s 到 80%，
      // 再长也不会假满。环本身有 700ms 的 stroke-dashoffset 过渡，看起来是顺滑推进。
      setSimulated((current) => Math.min(92, current + (92 - current) * (1 - Math.exp(-dt * 0.2))));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const percent = Math.max(realPercent, Math.round(simulated));
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - percent / 100);
  return (
    <div className="weq-report-page-status is-progress" role="status" aria-live="polite">
      <div
        className="weq-report-page-ring"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`年度报告已生成 ${percent}%`}
      >
        <svg viewBox="0 0 104 104" aria-hidden>
          <circle className="weq-report-page-ring-track" cx="52" cy="52" r={radius} />
          <circle
            className="weq-report-page-ring-bar"
            cx="52"
            cy="52"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 52 52)"
          />
        </svg>
        <span className="weq-report-page-ring-percent weq-number">
          {percent}
          <i>%</i>
        </span>
      </div>
      <p className="weq-report-page-status-title">
        {queued ? '排队等待统计' : '正在整理'}第 {order} 页 · {page.title}
      </p>
      <p className="weq-report-page-status-desc">{computationDescription(page.id)}</p>
      <p className="weq-report-page-status-meta">
        已完成 {readyCount} / {total} 页 · 全部在本机计算
      </p>
    </div>
  );
}

export function AnnualReportView(): ReactElement {
  /**
   * `null` = 还没选过，让服务端决定开屏口径（最近一个真的有数据的年份）。
   * 不再默认 `new Date().getFullYear()` —— 今年可能一条都没发过，那样开屏
   * 就落在一个空报告上。选定之后才带上 `year` 查询。
   */
  const [year, setYear] = useState<number | null>(null);
  const manifestQuery = trpc.account.annualReport.getManifest.useQuery(
    year == null ? {} : { year },
    {
      refetchOnWindowFocus: false,
      staleTime: 60_000,
      // 切年份时保留上一份目录继续展示、后台静默换新：availableYears（可选年份
      // 列表）本就不随年份变化，不该陪着闪一次 skeleton。
      keepPreviousData: true,
    },
  );
  /** 服务端回填的口径 —— 首次加载时它就是「开屏该看哪一段」的答案。 */
  const effectiveYear = year ?? manifestQuery.data?.year ?? ALL_TIME_YEAR;

  return (
    <ReportDeckView
      year={effectiveYear}
      manifest={manifestQuery.data ?? null}
      manifestLoading={manifestQuery.isLoading}
      manifestFetching={manifestQuery.isFetching}
      manifestError={manifestQuery.error?.message ?? null}
      onSelectYear={setYear}
    />
  );
}

function ReportDeckView({
  year,
  manifest,
  manifestLoading,
  manifestFetching,
  manifestError,
  onSelectYear,
}: {
  year: number;
  manifest: ReportManifest | null;
  manifestLoading: boolean;
  manifestFetching: boolean;
  manifestError: string | null;
  onSelectYear: (year: number) => void;
}): ReactElement {
  /**
   * manifest 里现在只带“候选页”（不再逐页探测资格）。真正会出现在 deck 里的
   * 页存在 `pages` state 里：某页 `getPageData` 返回 `unavailable` 时把它摘掉，
   * 这样年份选择不用等整份报告的资格扫描，翻页也不会遇到“今年没有这页”的哑页。
   */
  const candidatePages = useMemo(() => manifest?.pages ?? [], [manifest?.pages]);
  const [pages, setPages] = useState<ReportManifest['pages']>(candidatePages);
  /** 该口径下所有候选页都因没有「自己发出的消息」被摘掉（可能有收到的消息）。 */
  const noOwnData = candidatePages.length > 0 && pages.length === 0;
  /**
   * 年份选择海报**永久**挂在轨道第 0 页：向下滚直接进第一张真页，向上滚随时
   * 滚回海报 —— 不需要「点一下 → 去另一页 → 再开始」，也不需要在滚过后摘车厢、
   * 平移索引。所有真页的虚拟索引恒定 +1（`PAGE_OFFSET`）。
   */
  const [index, setIndex] = useState(0);
  const [states, setStates] = useState<Record<string, PageState>>({});
  const generationRef = useRef(0);
  const cacheRef = useRef(new Map<string, unknown>());
  /** 全屏播放的宿主：元素级全屏请求打在报告根节点上，应用自己的标题栏与图标栏留在外面。 */
  const rootRef = useRef<HTMLDivElement>(null);
  /** 报告内的浮层宿主（目前只有 QQ 空间分享灯箱）—— 详见 ReportViewContextValue。 */
  const overlayHostRef = useRef<HTMLDivElement>(null);
  /** 由 fullscreenchange 同步，不自己猜：Esc 退出时按钮文案也要跟着回正。 */
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** 摘页时要知道 pageId 在当前 deck 里的位置；放在 ref 里避免让 loadPage 随页变化重建。 */
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  /**
   * 报告主字体。装扮页选中「最爱字体」后写在这里，作用于整份报告 —— 已经翻过的
   * 总览页、这一页、结尾页，以及之后加入的任何一页。换年份 / 离开报告时还原。
   */
  const [reportFontId, setReportFontIdState] = useState(0);
  /**
   * 当前页注册的翻页守卫（目前没有页面注册，机制为后续交互页保留）。
   * 存在 ref 里而不是 state：注册/注销发生在页面的 effect 里，用 state 会让
   * context value 变化再触发页面重渲，绕回来又重新注册。
   */
  const guardRef = useRef<PageTurnGuard | null>(null);
  const registerPageGuard = useCallback((guard: PageTurnGuard) => {
    guardRef.current = guard;
    return () => {
      // 只清掉自己那个 —— 翻页时新页可能已经先注册上来了。
      if (guardRef.current === guard) guardRef.current = null;
    };
  }, []);
  const runPageGuard = useCallback(
    (direction: 1 | -1) => guardRef.current?.(direction) ?? false,
    [],
  );

  const setReportFontId = useCallback((itemId: number | null) => {
    // applyReportFont 会先把 ttf 加载好再落 CSS；失败时静默还原（返回 false），
    // 所以 state 以它的返回值为准，不以点击意图为准。
    void applyReportFont(itemId).then((ok) => {
      setReportFontIdState(ok && itemId ? itemId : 0);
    });
  }, []);

  useEffect(() => {
    setIndex(0);
    setStates({});
    cacheRef.current.clear();
    generationRef.current += 1;
    setReportFontIdState(0);
    clearReportFont();
    setPages(candidatePages);
  }, [year, candidatePages]);

  /**
   * 全屏播放：把整个报告根节点交给 Fullscreen API。
   *
   * 用元素级全屏而不是「把窗口拉大」—— 报告根节点之外还有应用自己的标题栏和
   * 左侧图标栏，元素级全屏能把它们一起挡在 fullscreen 层之外，只留报告本身。
   * 退出有两条路：浏览器原生的 Esc，或再点一次这个按钮；两条路都触发
   * fullscreenchange，按钮文案据此同步。
   */
  const toggleFullscreen = useCallback(() => {
    const element = rootRef.current;
    if (!element) return;
    if (document.fullscreenElement === element) {
      void document.exitFullscreen();
      return;
    }
    if (typeof element.requestFullscreen !== 'function') return;
    // 被浏览器拒绝（不是用户手势、权限策略等）时静默 —— 报告本身照常可用。
    void element.requestFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    const onFullscreenChange = (): void => {
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  // 离开报告时把注入的换字样式收干净，别影响应用其余部分。
  useEffect(() => clearReportFont, []);

  // 报告是全视口的固定舞台：进来时把页面滚回顶部，上一屏可能已经滚到别处。
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  /** 回到第 0 页（年份选择海报）。错误/空态用它兜底：海报是常驻的第 0 页。 */
  const backToEntry = useCallback(() => setIndex(0), []);

  /** 本页今年没有数据：把它从 deck 摘掉，并保持“当前正在看的内容”不跳变。 */
  const dropUnavailablePage = useCallback((pageId: string): void => {
    const currentPages = pagesRef.current;
    const removed = currentPages.findIndex((page) => page.id === pageId) + 1;
    if (removed === 0) return;
    const nextPages = currentPages.filter((page) => page.id !== pageId);
    setPages(nextPages);
    // removed 是「含海报在内的虚拟序号」：当前页在其后不动，在其前要整体前移一位；
    // 当前页恰好就是被摘的那页时，让后一页填进同一槽位（摘掉末页则退回上一页）。
    setIndex((current) => {
      let next = current;
      if (removed < current) next = current - 1;
      else if (removed === current) next = Math.min(current, nextPages.length);
      return Math.max(0, Math.min(next, nextPages.length));
    });
    setStates((current) => {
      const rest = { ...current };
      delete rest[pageId];
      return rest;
    });
  }, []);

  /** 加载一页；成功/失败都 resolve，让顺序队列继续往下走。 */
  const loadPage = useCallback(
    async (pageId: string, force = false): Promise<void> => {
      const currentGeneration = generationRef.current;
      const key = `${year}:${pageId}`;
      if (!force && cacheRef.current.has(key)) {
        setStates((current) => ({
          ...current,
          [pageId]: { status: 'ok', data: cacheRef.current.get(key) },
        }));
        return;
      }
      setStates((current) => ({ ...current, [pageId]: { status: 'loading' } }));
      try {
        const result = await client.account.annualReport.getPageData.query({ year, pageId });
        if (generationRef.current !== currentGeneration) return;
        if (result.status === 'ok') {
          cacheRef.current.set(key, result.data);
          setStates((current) => ({ ...current, [pageId]: { status: 'ok', data: result.data } }));
        } else if (result.status === 'unavailable') {
          dropUnavailablePage(pageId);
        } else {
          setStates((current) => ({
            ...current,
            [pageId]: { status: 'error', error: result.error?.message ?? '页面加载失败' },
          }));
        }
      } catch (error) {
        if (generationRef.current !== currentGeneration) return;
        setStates((current) => ({
          ...current,
          [pageId]: {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    },
    [year, dropUnavailablePage],
  );

  // 顺序加载：第 1 页好了立即显示，然后 2、3、4… 依次补齐。
  // 只在真的滚进报告后开始：年份海报停留时点刻度不该触发整份统计的数据库扫描，
  // 那些扫描会和「切年份」的动画抢 CPU，是选年份掉帧的隐性来源之一。
  useEffect(() => {
    if (pages.length === 0 || index === 0) return;
    let cancelled = false;
    const generation = generationRef.current;
    (async () => {
      for (const page of pages) {
        if (cancelled || generation !== generationRef.current) return;
        await loadPage(page.id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [index, pages, loadPage]);

  // 翻到还没加载的页时立即加载（不用等队列轮到）。
  useEffect(() => {
    const active = pages[index - PAGE_OFFSET];
    if (!active) return;
    void loadPage(active.id);
  }, [index, pages, loadPage]);

  const moveTo = useCallback(
    (next: number) => {
      setIndex(Math.max(0, Math.min(pages.length, next)));
    },
    [pages.length],
  );

  const scopeLabel = useMemo(() => {
    const scope = manifest?.scope;
    if (!scope) return '';
    return [scope.includeC2c && '私聊', scope.includeGroups && '群聊'].filter(Boolean).join(' + ');
  }, [manifest?.scope]);

  const contextValue = useMemo<ReportViewContextValue>(
    () => ({
      year,
      scopeLabel,
      slides: pages
        .filter((page) => states[page.id]?.status === 'ok')
        .map((page) => ({ page, data: states[page.id]?.data })),
      reportFontId,
      setReportFontId,
      registerPageGuard,
      overlayHostRef,
    }),
    [
      year,
      scopeLabel,
      pages,
      states,
      reportFontId,
      setReportFontId,
      registerPageGuard,
      overlayHostRef,
    ],
  );

  if (manifestLoading && !manifest) {
    return (
      <div className="weq-report-root weq-report-loading">
        <LoaderCircle className="weq-report-spin" size={32} aria-label="正在加载年度报告" />
      </div>
    );
  }
  if (!manifest) {
    return (
      <div className="weq-report-root weq-report-error">
        <p>年度报告目录加载失败</p>
        <button type="button" onClick={backToEntry}>
          <RefreshCw size={16} />
          返回重试
        </button>
      </div>
    );
  }
  if (candidatePages.length === 0) {
    return (
      <div className="weq-report-root weq-report-empty">
        <p>
          {reportEraLabel(year)}没有可展示的卡片 —— 至少需要发出过一条私聊或群聊消息，报告才会出现。
        </p>
        <button type="button" onClick={backToEntry}>
          换个年份
        </button>
      </div>
    );
  }

  /** 第 0 页（年份选择海报）是否正在画面上：是的话 chrome 与刻度轨让位。 */
  const onEntry = index === 0;

  return (
    <div className="weq-report-root is-deck" ref={rootRef} data-entry={onEntry ? 'yes' : 'no'}>
      <div className="weq-report-chrome">
        <button
          type="button"
          className="weq-report-fullscreen"
          onClick={toggleFullscreen}
          aria-pressed={isFullscreen}
          aria-label={isFullscreen ? '退出全屏播放' : '全屏播放'}
          title={isFullscreen ? '退出全屏（Esc）' : '全屏播放'}
        >
          {isFullscreen ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
          <span>{isFullscreen ? '退出全屏' : '全屏播放'}</span>
        </button>
        <div className="weq-report-brand">
          <span
            className={`weq-report-brand-year${year === ALL_TIME_YEAR ? ' is-all-time' : ' weq-number'}`}
          >
            {reportPeriodLabel(year)}
          </span>
          <span className="weq-report-brand-name">
            {year === ALL_TIME_YEAR ? '全部记录' : '年度报告'}
          </span>
          {scopeLabel ? <span className="weq-report-brand-scope">{scopeLabel}</span> : null}
        </div>
        <div className="weq-report-progress">
          <span className="weq-number">{String(Math.max(1, index)).padStart(2, '0')}</span>
          <span className="weq-report-progress-slash" aria-hidden>
            /
          </span>
          <span className="weq-report-progress-total weq-number">
            {String(pages.length).padStart(2, '0')}
          </span>
        </div>
      </div>

      <ReportViewContext.Provider value={contextValue}>
        <AnnualReportStage
          index={index}
          count={pages.length + 1}
          onIndexChange={moveTo}
          guard={runPageGuard}
        >
          <div
            className={`weq-report-slide${index === 0 ? ' is-active' : ''}`}
            style={slideStyle(0, index)}
            aria-hidden={index !== 0}
          >
            <div className="weq-report-entry-wrap">
              <AnnualReportEntry
                manifest={manifest}
                loading={manifestLoading}
                isFetching={manifestFetching}
                error={manifestError}
                noOwnData={noOwnData}
                selectedYear={year}
                onSelectYear={onSelectYear}
                onGenerate={() => moveTo(1)}
              />
            </div>
          </div>
          {pages.map((page, pageIndex) => {
            const virtualIndex = pageIndex + PAGE_OFFSET;
            const state = states[page.id] ?? { status: 'idle' as const };
            const active = virtualIndex === index;
            return (
              <div
                className={`weq-report-slide${active ? ' is-active' : ''}`}
                key={page.id}
                style={slideStyle(virtualIndex, index)}
                aria-hidden={!active}
              >
                {state.status === 'loading' || state.status === 'idle' ? (
                  <ReportPageLoading
                    page={page}
                    order={pageIndex + 1}
                    readyCount={pages.filter((item) => states[item.id]?.status === 'ok').length}
                    total={pages.length}
                    queued={state.status === 'idle'}
                    active={active}
                  />
                ) : null}
                {state.status === 'error' ? (
                  <div className="weq-report-page-status">
                    <p>{state.error}</p>
                    <button type="button" onClick={() => void loadPage(page.id, true)}>
                      <RefreshCw size={16} />
                      重试
                    </button>
                  </div>
                ) : null}
                {state.status === 'ok' ? renderReportPage(page, state.data, active) : null}
              </div>
            );
          })}
        </AnnualReportStage>
      </ReportViewContext.Provider>

      <div className="weq-report-rail" aria-label="报告翻页">
        <button
          type="button"
          className="weq-report-rail-arrow"
          onClick={() => moveTo(index - 1)}
          disabled={index === 0}
          aria-label="上一页"
        >
          <ChevronUp size={16} aria-hidden />
        </button>
        <div className="weq-report-ticks">
          {pages.map((page, pageIndex) => (
            <button
              key={page.id}
              type="button"
              className={`weq-report-tick${pageIndex + PAGE_OFFSET === index ? ' is-active' : ''}`}
              onClick={() => moveTo(pageIndex + PAGE_OFFSET)}
              aria-label={`第 ${pageIndex + 1} 页：${page.title}`}
              aria-current={pageIndex + PAGE_OFFSET === index}
            >
              <span className="weq-report-tick-name" aria-hidden>
                {page.title}
              </span>
              <span className="weq-report-tick-mark" aria-hidden />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="weq-report-rail-arrow"
          onClick={() => moveTo(index + 1)}
          disabled={index === pages.length}
          aria-label="下一页"
        >
          <ChevronDown size={16} aria-hidden />
        </button>
      </div>
      <div className="weq-report-hint" data-visible={index === 1 ? 'yes' : 'no'}>
        <span className="weq-report-hint-arrow" aria-hidden />
        向下滑动继续
      </div>
      {/* 报告内的浮层宿主 —— 全屏播放时分享灯箱挂这里，否则仍挂 body。详见 reportContext.ts。 */}
      <div className="weq-report-overlay" ref={overlayHostRef} />
    </div>
  );
}
