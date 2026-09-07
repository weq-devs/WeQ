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
  onClose,
}: {
  year: number;
  slides: ExportSlide[];
  onClose: () => void;
}): ReactElement {
  const pushToast = useToast((s) => s.push);
  const selfFace = useSelfFace();

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

  function toggle(index: number): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function share(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const picked = slides
        .map((s, i) => ({ s, i }))
        .filter(({ i }) => selected.has(i))
        .map(({ s }) => ({
          pageId: s.page.id,
          title: s.page.title,
          description: s.page.description,
          category: s.page.category,
          data: s.data,
        }));
      const result = await client.account.annualReport.shareQzone.mutate({
        year,
        content: content.trim(),
        slides: picked,
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
                  selfFace.avatarUrl
                    ? { backgroundImage: `url(${selfFace.avatarUrl})` }
                    : undefined
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
            <button
              type="button"
              className="weq-qzshare-cancel"
              disabled={busy}
              onClick={onClose}
            >
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
    document.body,
  );
}
