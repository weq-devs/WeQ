/**
 * 「一键分享到 QQ 空间」预览灯箱。
 *
 * 用户在结尾页点「分享到空间」后弹出：逐页预览将要发出的卡片（一页一图，
 * 不用长图），文案可改、图片不可改；可勾选要发的页面（说说上限 9 张）与
 * 可见权限。确认后走 `annualReport.shareQzone`：主进程逐页渲染 PNG → 逐张
 * 上传 Qzone 图床 → 发表说说。
 *
 * 「发表」不在灯箱里等：点下去就关灯箱、先给一条 toast 回执，任务在后台跑完
 * 再把那条 toast 就地推进成结果（见 share）。截图九页 + 逐张上传慢起来要一两
 * 分钟，让用户对着一个转圈按钮干等是这一页最糟的体验。
 *
 * 预览刻意做成「卡片缩略 + 页名」的轻量清单，而不是把报告 deck 复刻一遍 ——
 * 灯箱的职责是让用户确认发什么、配什么字，不是再看一次报告。
 *
 * 样式走 annual-report.css 的报告令牌（--rp-*），深浅模式自动跟随。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Check, Earth, Lock, Users, X } from 'lucide-react';
import { client } from '../../trpc/client';
import { useToast } from '../../components/Toast';
import { useSelfFace } from './useSelfFace';
import { useReportView } from './reportContext';
import type { ExportSlide } from './exportHtml';

/** 说说一次最多带 9 张图（Qzone 服务端限制）。 */
const QZONE_MAX_IMAGES = 9;
/**
 * 「正在分享」那条 toast 的存活时长。
 *
 * 截图 + 逐张上传 + 发表全在主进程里跑，九张图一两分钟是常态，所以进度提示挂一个
 * 很长的 ttl —— 否则它会在任务还在跑的时候自己溜走，用户回到「没有回执」的状态。
 * 任务结束时就地更新成结果，ttl 收回正常的十秒（见 Toast.tsx 的 ttl 重置）。
 */
const SHARE_PROGRESS_TTL_MS = 15 * 60 * 1000;

/**
 * 同一时刻只允许一份分享在跑。
 *
 * 灯箱一点就关了，界面上不再有「正在发表」这个禁用态，但主进程那条「截图 →
 * 上传 → 发表」的流水线可能还跑着：用户再点一次会原模原样发出第二条说说。
 * 模块级标志顶住重复提交（比放在组件里可靠 —— 灯箱每次打开都重新挂载）。
 */
let shareInFlight = false;

/** 默认分享文案 —— 用户可改。指向项目仓库。 */
function defaultShareText(year: number): string {
  return year === 0
    ? '我的全部 QQ 聊天记录报告出炉了，由 WEQ 从本机记录里算出来的。\n也来生成你的：github.com/H3CoF6/WeQ'
    : `我的 ${year} 年度聊天报告出炉了，由 WEQ 从本机记录里算出来的。\n也来生成你的：github.com/H3CoF6/WeQ`;
}

type UgcRight = 1 | 4 | 64;

const UGC_RIGHT_OPTIONS: Array<{ value: UgcRight; label: string; icon: typeof Earth }> = [
  { value: 1, label: '所有人可见', icon: Earth },
  { value: 4, label: '好友可见', icon: Users },
  { value: 64, label: '仅自己可见', icon: Lock },
];

export function QzoneShareLightbox({
  year,
  slides,
  getHtml,
  onClose,
}: {
  year: number;
  /** 已加载的页面（报告顺序），用于预览清单与勾选。 */
  slides: ExportSlide[];
  /** 现取导出用的自包含 HTML（与长图 / HTML / PDF 同一份）。 */
  getHtml: () => Promise<string>;
  onClose: () => void;
}): ReactElement {
  const pushToast = useToast((s) => s.push);
  const updateToast = useToast((s) => s.update);
  const selfFace = useSelfFace();
  const { overlayHostRef } = useReportView();
  /**
   * portal 目标只在挂载时判一次：全屏播放时报告根节点是 fullscreen element，
   * 挂在 document.body 的节点会被整个挡在 fullscreen 层外、完全看不见，所以要
   * 改挂报告自己的浮层宿主；而平常挂在 body 才能连应用图标栏一起压暗
   * （图标栏的 z-index 高于报告根）。灯箱开着时全屏开关在遮罩之下，状态不会
   * 中途改变，所以这一次判定在灯箱的生命周期里恒成立。
   */
  const [portalTarget] = useState<Element>(() => {
    const host = overlayHostRef.current;
    return host?.closest(':fullscreen') ? host : document.body;
  });

  // 默认全选；超过 9 张时按报告顺序截前 9 张。
  const initialSelected = useMemo(
    () => new Set(slides.slice(0, QZONE_MAX_IMAGES).map((_, i) => i)),
    [slides],
  );
  const [selected, setSelected] = useState<Set<number>>(initialSelected);
  const [content, setContent] = useState(() => defaultShareText(year));
  const [ugcRight, setUgcRight] = useState<UgcRight>(1);
  const overLimit = selected.size > QZONE_MAX_IMAGES;
  const canSubmit = selected.size > 0 && content.trim().length > 0 && !overLimit;

  /**
   * 灯箱开着时挡掉报告的翻页手势：滚轮 / 触摸 / 键盘都会先被这里吃掉，底下的
   * 年度报告不再跟着灯箱一起滚。
   *
   * Esc 就地处理而不是另挂一个冒泡监听：window 捕获阶段的 stopPropagation 会
   * 让挂在 window 冒泡阶段的监听器根本收不到这次按键。
   */
  useEffect(() => {
    const stop = (event: Event): void => event.stopPropagation();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      event.stopPropagation();
    };
    window.addEventListener('wheel', stop, { capture: true });
    window.addEventListener('touchmove', stop, { capture: true });
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('wheel', stop, { capture: true });
      window.removeEventListener('touchmove', stop, { capture: true });
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [onClose]);

  function toggle(index: number): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  /**
   * 发送顺序 = 报告页顺序中已勾选的那些。九宫格预览用它让用户不用猜
   * 说说里的图序：第 N 格就是第 N 张图。
   */
  const orderedSelected = useMemo(
    () => slides.map((_, i) => i).filter((i) => selected.has(i)),
    [slides, selected],
  );

  /**
   * 点「发表说说」= 立刻收灯箱 + 先给一条回执，真正的活儿在主进程里继续跑。
   *
   * 截图九页、逐张上传图床、最后发说说，全在主进程串行完成，慢的时候要一两分钟；
   * 原来把整个 mutate 摆在按钮的 loading 里等，用户只能对着一个转圈的按钮干等，
   * 还会以为是卡死了。现在按钮只管**提交意图**：灯箱马上关掉、报告回到手里，
   * 那条 toast 从「正在分享」就地推进成「已分享 / 分享失败」，慢也慢得看得见。
   *
   * 图片仍由主进程从同一份 HTML 里逐页截图：`orderedSelected` 是已勾选页在报告
   * 顺序里的下标，主进程按它取第 N 张 `.slide`，顺序与九宫格预览一致。
   */
  async function share(): Promise<void> {
    if (!canSubmit) return;
    if (shareInFlight) {
      pushToast({
        tone: 'info',
        title: '上一次分享还没发完',
        detail: '截图与上传正在后台跑，状态就在那条「正在分享」的提示里。',
      });
      onClose();
      return;
    }
    shareInFlight = true;
    const indexes = orderedSelected;
    const text = content.trim();
    const toastId = pushToast({
      tone: 'info',
      title: '正在分享到 QQ 空间…',
      detail: `已选 ${indexes.length} 张图 · 正在逐页生成并上传，可以先继续看报告`,
      ttl: SHARE_PROGRESS_TTL_MS,
    });
    onClose();
    try {
      const html = await getHtml();
      const result = await client.account.annualReport.shareQzone.mutate({
        year,
        content: text,
        html,
        slideIndexes: indexes,
        ugcRight,
      });
      updateToast(toastId, {
        tone: 'success',
        title: '已分享到 QQ 空间',
        detail: `说说已发表 · ${result.images} 张图`,
        ttl: 10000,
      });
    } catch (error) {
      updateToast(toastId, {
        tone: 'error',
        title: '分享失败',
        detail: error instanceof Error ? error.message : String(error),
        ttl: 10000,
      });
    } finally {
      shareInFlight = false;
    }
  }

  return createPortal(
    <div
      className="weq-qzshare-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="分享到 QQ 空间"
      onClick={onClose}
    >
      <div className="weq-qzshare-card" onClick={(e) => e.stopPropagation()}>
        <header className="weq-qzshare-head">
          <div className="weq-qzshare-title">
            <span className="weq-qzshare-title-main">分享到 QQ 空间</span>
            <span className="weq-qzshare-title-sub">一页一张图 · 最多 9 张</span>
          </div>
          <button type="button" className="weq-qzshare-close" aria-label="关闭" onClick={onClose}>
            <X size={17} aria-hidden />
          </button>
        </header>

        <div className="weq-qzshare-body">
          {/* ── 页面选择 + 预览 ─────────────────────────── */}
          <div className="weq-qzshare-pages">
            {slides.map((slide, i) => {
              const checked = selected.has(i);
              return (
                <button
                  key={slide.page.id}
                  type="button"
                  className={`weq-qzshare-page${checked ? ' is-checked' : ''}`}
                  aria-pressed={checked}
                  onClick={() => toggle(i)}
                >
                  <span className="weq-qzshare-page-check" aria-hidden>
                    {checked ? <Check size={12} strokeWidth={3} /> : null}
                  </span>
                  <span className="weq-qzshare-page-ghost">{slide.page.category}</span>
                  <span className="weq-qzshare-page-title">{slide.page.title}</span>
                  <span className="weq-qzshare-page-desc">{slide.page.description}</span>
                </button>
              );
            })}
          </div>

          {/* ── 文案（可改） + 权限 + 分享者预览 ─────────── */}
          <div className="weq-qzshare-compose">
            <div className="weq-qzshare-preview">
              <span
                className="weq-qzshare-avatar"
                style={
                  selfFace.avatarUrl ? { backgroundImage: `url(${selfFace.avatarUrl})` } : undefined
                }
                aria-hidden
              >
                {selfFace.avatarUrl ? null : selfFace.initial}
              </span>
              <div className="weq-qzshare-preview-meta">
                <span className="weq-qzshare-nick">{selfFace.nick || '我'}</span>
                <span className="weq-qzshare-scope">
                  {UGC_RIGHT_OPTIONS.find((o) => o.value === ugcRight)?.label}
                </span>
              </div>
            </div>
            <textarea
              className="weq-qzshare-text"
              value={content}
              maxLength={2000}
              rows={5}
              onChange={(e) => setContent(e.target.value)}
              aria-label="说说文案（可修改）"
            />
            {/* 九宫格顺序预览：第 N 格 = 发出的第 N 张图，空格是未选满的留位。 */}
            <div className="weq-qzshare-grid" aria-label="发送顺序九宫格预览">
              {Array.from({ length: QZONE_MAX_IMAGES }, (_, slot) => {
                const slideIndex = orderedSelected[slot];
                const slide = slideIndex != null ? slides[slideIndex] : null;
                return (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: 固定九槽的位次即身份，不会重排。
                    key={slot}
                    className={`weq-qzshare-grid-cell${slide ? ' is-filled' : ''}`}
                    title={slide ? `第 ${slot + 1} 张：${slide.page.title}` : '空位'}
                  >
                    {slide ? (
                      <>
                        <b className="weq-qzshare-grid-num">{slot + 1}</b>
                        <span className="weq-qzshare-grid-title">{slide.page.title}</span>
                      </>
                    ) : null}
                  </span>
                );
              })}
            </div>
            <div className="weq-qzshare-rightrow" role="radiogroup" aria-label="可见权限">
              {UGC_RIGHT_OPTIONS.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={ugcRight === option.value}
                    className={`weq-qzshare-right${ugcRight === option.value ? ' is-active' : ''}`}
                    onClick={() => setUgcRight(option.value)}
                  >
                    <Icon size={14} aria-hidden />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <footer className="weq-qzshare-foot">
          <span className={`weq-qzshare-count${overLimit ? ' is-over' : ''}`}>
            已选 {selected.size} / {QZONE_MAX_IMAGES} 张
          </span>
          <div className="weq-qzshare-actions">
            <button type="button" className="weq-qzshare-cancel" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="weq-qzshare-send"
              disabled={!canSubmit}
              onClick={() => void share()}
            >
              发表说说
            </button>
          </div>
        </footer>
      </div>
    </div>,
    portalTarget,
  );
}
