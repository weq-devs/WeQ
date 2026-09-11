/**
 * 「一键分享到 QQ 空间」预览灯箱。
 *
 * 用户在结尾页点「分享到空间」后弹出：逐页预览将要发出的卡片（一页一图，
 * 不用长图），文案可改、图片不可改；可勾选要发的页面（说说上限 9 张）与
 * 可见权限。确认后走 `annualReport.shareQzone`：主进程逐页渲染 PNG → 逐张
 * 上传 Qzone 图床 → 发表说说。
 *
 * 预览刻意做成「卡片缩略 + 页名」的轻量清单，而不是把报告 deck 复刻一遍 ——
 * 灯箱的职责是让用户确认发什么、配什么字，不是再看一次报告。
 *
 * 样式走 annual-report.css 的报告令牌（--rp-*），深浅模式自动跟随。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Check, Earth, LoaderCircle, Lock, Users, X } from 'lucide-react';
import { client } from '../../trpc/client';
import { useToast } from '../../components/Toast';
import { useSelfFace } from './useSelfFace';
import { useReportView } from './reportContext';
import type { ExportSlide } from './exportHtml';

/** 说说一次最多带 9 张图（Qzone 服务端限制）。 */
const QZONE_MAX_IMAGES = 9;

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
  const [busy, setBusy] = useState(false);
  const overLimit = selected.size > QZONE_MAX_IMAGES;
  const canSubmit = !busy && selected.size > 0 && content.trim().length > 0 && !overLimit;

  // Esc 关灯箱；发说说期间不关。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // 灯箱开着时挡掉报告的翻页手势：滚轮/键盘/拖拽都会先被这里吃掉，
  // 底下的年度报告不再跟着灯箱一起滚。
  useEffect(() => {
    const stop = (event: Event): void => event.stopPropagation();
    // 捕获阶段拦截滚轮与触摸，事件根本到不了舞台宿主。
    window.addEventListener('wheel', stop, { capture: true });
    window.addEventListener('touchmove', stop, { capture: true });
    window.addEventListener('keydown', stop, { capture: true });
    return () => {
      window.removeEventListener('wheel', stop, { capture: true });
      window.removeEventListener('touchmove', stop, { capture: true });
      window.removeEventListener('keydown', stop, { capture: true });
    };
  }, []);

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

  async function share(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    try {
      // 图片由主进程从同一份 HTML 里逐页截图：`orderedSelected` 是已勾选页在
      // 报告顺序里的下标，主进程按它取第 N 张 `.slide`，顺序与九宫格预览一致。
      const result = await client.account.annualReport.shareQzone.mutate({
        year,
        content: content.trim(),
        html: await getHtml(),
        slideIndexes: orderedSelected,
        ugcRight,
      });
      pushToast({
        tone: 'success',
        title: '已分享到 QQ 空间',
        detail: `说说已发表（${result.images} 张图）`,
      });
      onClose();
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '分享失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="weq-qzshare-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="分享到 QQ 空间"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div className="weq-qzshare-card" onClick={(e) => e.stopPropagation()}>
        <header className="weq-qzshare-head">
          <div className="weq-qzshare-title">
            <span className="weq-qzshare-title-main">分享到 QQ 空间</span>
            <span className="weq-qzshare-title-sub">一页一张图 · 最多 9 张</span>
          </div>
          <button
            type="button"
            className="weq-qzshare-close"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
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
            <button type="button" className="weq-qzshare-cancel" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="weq-qzshare-send"
              disabled={!canSubmit}
              onClick={() => void share()}
            >
              {busy ? <LoaderCircle className="weq-report-spin" size={16} aria-hidden /> : null}
              {busy ? '正在发表…' : '发表说说'}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    portalTarget,
  );
}
