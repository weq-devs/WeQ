/**
 * 清理释放 — a full-screen overlay for reclaiming disk space from the account's
 * nt_data resource trees. Mirrors {@link ResourceAnalyticsDialog}'s look (portal
 * overlay, accent-themed) but is DESTRUCTIVE.
 *
 * Flow: on open it scans every deletable target for its on-disk size, then offers
 * five presets (完全安全清理 / 清理原图 / 清理缩略 / 清理 File 目录 / 全部清理) plus a
 * 自定义 panel. Picking a mode moves to a review step listing exactly what will be
 * deleted + the total; a `caution`-containing mode arms a red button, and 全部清理
 * additionally requires typing 「确认清理」. Executing calls
 * `account.resourceCleanup.cleanup`, then invalidates `account.*` so every
 * resource browser + 整体分析 rescans from disk.
 *
 * The 「下载文件」listing is NOT a target here, so no mode can ever remove the
 * user's own downloaded files.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Loader2,
  Trash2,
  ShieldCheck,
  Image as ImageIcon,
  Images,
  Folder,
  Film,
  AudioLines,
  Cloud,
  Store,
  Smile,
  Sticker,
  ChevronLeft,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Layers,
} from 'lucide-react';
import type { CleanupTargetStat, CleanupVariant, CleanupResult } from '@weq/service';
import { client, trpc } from '../../trpc/client';
import { fmtBytes } from './FileResourceShared';

/** One deletion instruction (target + how much). */
interface Instruction {
  id: string;
  variant: CleanupVariant;
}

/** A preset cleanup mode. */
interface Preset {
  id: string;
  label: string;
  icon: ReactNode;
  desc: string;
  /** true → red button + a caution notice (contains 不可再生 content). */
  danger: boolean;
  /** true → also requires typing the confirm phrase (全部清理 only). */
  extreme?: boolean;
  /** Build the instruction list from the scanned targets. */
  build: (targets: CleanupTargetStat[]) => Instruction[];
}

const VARIANT_TARGET_IDS = ['pic', 'video', 'emojiRecv', 'personalEmoji'] as const;

const PRESETS: Preset[] = [
  {
    id: 'safe',
    label: '完全安全清理',
    icon: <ShieldCheck size={20} />,
    desc: '清理头像、商城表情、图片墙、QQ空间、关联表情等完全可再生的缓存，QQ 会在需要时自动重新下载。',
    danger: false,
    build: (targets) => targets.filter((t) => t.tier === 'safe').map((t) => ({ id: t.id, variant: 'all' })),
  },
  {
    id: 'ori',
    label: '清理原图',
    icon: <ImageIcon size={20} />,
    desc: '删除图片 / 视频 / 表情的原始文件，保留缩略图预览。释放空间最多，但原图过期后可能无法恢复。',
    danger: true,
    build: (targets) =>
      targets
        .filter((t) => VARIANT_TARGET_IDS.includes(t.id as (typeof VARIANT_TARGET_IDS)[number]) && t.ori.files > 0)
        .map((t) => ({ id: t.id, variant: 'ori' })),
  },
  {
    id: 'thumb',
    label: '清理缩略',
    icon: <Images size={20} />,
    desc: '删除图片 / 视频 / 表情的缩略图预览，保留原始文件。需要时会重新生成。',
    danger: false,
    build: (targets) =>
      targets
        .filter((t) => VARIANT_TARGET_IDS.includes(t.id as (typeof VARIANT_TARGET_IDS)[number]) && t.thumb.files > 0)
        .map((t) => ({ id: t.id, variant: 'thumb' })),
  },
  {
    id: 'file',
    label: '清理 File 目录',
    icon: <Folder size={20} />,
    desc: '清理 nt_data/File 聊天文件缓存。不影响你在「下载文件」里主动下载保存的文件。',
    danger: true,
    build: () => [{ id: 'file', variant: 'all' }],
  },
  {
    id: 'all',
    label: '全部清理',
    icon: <Trash2 size={20} />,
    desc: '清理全部本地资源缓存，包括聊天图片、视频、语音等不可再生内容。危险操作，请务必谨慎。',
    danger: true,
    extreme: true,
    build: (targets) => targets.map((t) => ({ id: t.id, variant: 'all' })),
  },
];

const CONFIRM_PHRASE = '确认清理';

/** Per-target icon for the 自定义 list + review rows. */
const TARGET_ICONS: Record<string, ReactNode> = {
  avatar: <ImageIcon size={15} />,
  marketface: <Store size={15} />,
  photoWall: <Images size={15} />,
  qzone: <Cloud size={15} />,
  emojiRelated: <Smile size={15} />,
  pic: <ImageIcon size={15} />,
  video: <Film size={15} />,
  emojiRecv: <Sticker size={15} />,
  personalEmoji: <Sticker size={15} />,
  ptt: <AudioLines size={15} />,
  file: <Folder size={15} />,
};

/** Bytes a single instruction would free, given the scanned target. */
function instructionBytes(t: CleanupTargetStat, variant: CleanupVariant): number {
  if (variant === 'ori') return t.ori.bytes;
  if (variant === 'thumb') return t.thumb.bytes;
  return t.bytes;
}

/** Total bytes a set of instructions would free. */
function estimateBytes(targets: CleanupTargetStat[], instructions: Instruction[]): number {
  let total = 0;
  for (const ins of instructions) {
    const t = targets.find((x) => x.id === ins.id);
    if (t) total += instructionBytes(t, ins.variant);
  }
  return total;
}

const VARIANT_LABEL: Record<CleanupVariant, string> = { all: '全部', ori: '仅原图', thumb: '仅缩略' };

export function ResourceCleanupDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  const utils = trpc.useUtils();
  const [targets, setTargets] = useState<CleanupTargetStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // pick → confirm → running → done
  const [stage, setStage] = useState<'pick' | 'confirm' | 'running' | 'done'>('pick');
  const [chosen, setChosen] = useState<{ preset: Preset; instructions: Instruction[] } | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [customSel, setCustomSel] = useState<Record<string, CleanupVariant>>({});
  const [phrase, setPhrase] = useState('');
  const [result, setResult] = useState<CleanupResult | null>(null);

  const runRef = useRef(0);

  const resetState = useCallback((): void => {
    setStage('pick');
    setChosen(null);
    setCustomMode(false);
    setCustomSel({});
    setPhrase('');
    setResult(null);
  }, []);

  const scan = useCallback(async (): Promise<void> => {
    const run = ++runRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await client.account.resourceCleanup.listTargets.query();
      if (run !== runRef.current) return;
      setTargets(list);
    } catch (e) {
      if (run === runRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (run === runRef.current) setLoading(false);
    }
  }, []);

  // Fresh scan + reset every time the dialog opens.
  useEffect(() => {
    if (open) {
      resetState();
      void scan();
    } else {
      runRef.current += 1;
    }
  }, [open, scan, resetState]);

  // ESC to close (except mid-run — don't lose a delete in flight).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && stage !== 'running') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, stage]);

  const totalBytes = useMemo(() => targets.reduce((s, t) => s + t.bytes, 0), [targets]);

  // Custom selection → instruction list.
  const customInstructions = useMemo<Instruction[]>(
    () => Object.entries(customSel).map(([id, variant]) => ({ id, variant })),
    [customSel],
  );

  if (!open || typeof document === 'undefined') return null;

  const pickPreset = (preset: Preset): void => {
    const instructions = preset.build(targets).filter((ins) => {
      const t = targets.find((x) => x.id === ins.id);
      return t?.present && instructionBytes(t, ins.variant) >= 0 && t.files > 0;
    });
    setChosen({ preset, instructions });
    setPhrase('');
    setStage('confirm');
  };

  const pickCustom = (): void => {
    const anyCaution = customInstructions.some((ins) => targets.find((t) => t.id === ins.id)?.tier === 'caution');
    const preset: Preset = {
      id: 'custom',
      label: '自定义清理',
      icon: <Sparkles size={20} />,
      desc: '仅清理你勾选的资源。',
      danger: anyCaution,
      build: () => customInstructions,
    };
    setChosen({ preset, instructions: customInstructions });
    setPhrase('');
    setStage('confirm');
  };

  const runCleanup = async (): Promise<void> => {
    if (!chosen) return;
    setStage('running');
    try {
      const res = await client.account.resourceCleanup.cleanup.mutate({ instructions: chosen.instructions });
      setResult(res);
      setStage('done');
      // Every browser + 整体分析 reads these trees — force a rescan on next open.
      void utils.account.invalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage('confirm');
    }
  };

  const toggleCustom = (t: CleanupTargetStat): void => {
    setCustomSel((prev) => {
      const next = { ...prev };
      if (next[t.id]) delete next[t.id];
      else next[t.id] = 'all';
      return next;
    });
  };

  const setCustomVariant = (id: string, variant: CleanupVariant): void => {
    setCustomSel((prev) => ({ ...prev, [id]: variant }));
  };

  return createPortal(
    <div
      className="weq-ra-layer weq-anim-fade"
      onMouseDown={() => {
        if (stage !== 'running') onClose();
      }}
    >
      <div className="weq-ra-dialog weq-clean-dialog weq-anim-pop" onMouseDown={(e) => e.stopPropagation()}>
        <header className="weq-ra-head">
          <div className="weq-ra-head-title">
            <Trash2 size={18} />
            <div>
              <strong>清理释放本地资源</strong>
              <small>删除 QQ 本地缓存以释放磁盘空间，可再生资源会自动重新下载</small>
            </div>
          </div>
          <div className="weq-ra-head-actions">
            {loading ? <Loader2 size={14} className="weq-spin" /> : null}
            <span className="weq-clean-total">共 {fmtBytes(totalBytes)}</span>
            <button
              type="button"
              className="weq-ra-close"
              onClick={onClose}
              disabled={stage === 'running'}
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {error ? (
          <div className="weq-ra-error">
            <AlertTriangle size={14} /> {error}
          </div>
        ) : null}

        <div className="weq-ra-body weq-clean-body">
          {stage === 'pick' ? (
            <PickStage
              targets={targets}
              loading={loading}
              customMode={customMode}
              customSel={customSel}
              customInstructions={customInstructions}
              onEnterCustom={() => setCustomMode(true)}
              onLeaveCustom={() => {
                setCustomMode(false);
                setCustomSel({});
              }}
              onToggleCustom={toggleCustom}
              onSetVariant={setCustomVariant}
              onPickPreset={pickPreset}
              onConfirmCustom={pickCustom}
            />
          ) : null}

          {stage === 'confirm' && chosen ? (
            <ConfirmStage
              targets={targets}
              chosen={chosen}
              phrase={phrase}
              onPhrase={setPhrase}
              onBack={() => {
                setStage('pick');
                setError(null);
              }}
              onRun={() => void runCleanup()}
            />
          ) : null}

          {stage === 'running' ? (
            <div className="weq-clean-running">
              <Loader2 size={26} className="weq-spin" />
              <strong>正在清理…</strong>
              <span>正在删除文件并释放空间，请稍候</span>
            </div>
          ) : null}

          {stage === 'done' && result ? (
            <DoneStage
              result={result}
              onClose={onClose}
              onAgain={() => {
                resetState();
                void scan();
              }}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── pick stage ───────────────────────────────────────────────────────────────

function PickStage({
  targets,
  loading,
  customMode,
  customSel,
  customInstructions,
  onEnterCustom,
  onLeaveCustom,
  onToggleCustom,
  onSetVariant,
  onPickPreset,
  onConfirmCustom,
}: {
  targets: CleanupTargetStat[];
  loading: boolean;
  customMode: boolean;
  customSel: Record<string, CleanupVariant>;
  customInstructions: Instruction[];
  onEnterCustom: () => void;
  onLeaveCustom: () => void;
  onToggleCustom: (t: CleanupTargetStat) => void;
  onSetVariant: (id: string, v: CleanupVariant) => void;
  onPickPreset: (p: Preset) => void;
  onConfirmCustom: () => void;
}): ReactElement {
  if (customMode) {
    const selBytes = estimateBytes(targets, customInstructions);
    const anySel = customInstructions.length > 0;
    return (
      <div className="weq-clean-custom">
        <button type="button" className="weq-clean-back" onClick={onLeaveCustom}>
          <ChevronLeft size={15} /> 返回清理模式
        </button>
        <div className="weq-clean-target-list">
          {targets.map((t) => {
            const sel = customSel[t.id];
            const on = sel !== undefined;
            const disabled = !t.present || t.files === 0;
            return (
              <div key={t.id} className={`weq-clean-target${on ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}>
                <button
                  type="button"
                  className="weq-clean-target-main"
                  onClick={() => !disabled && onToggleCustom(t)}
                  disabled={disabled}
                >
                  <span className={`weq-clean-check${on ? ' is-on' : ''}`}>{on ? <CheckCircle2 size={16} /> : null}</span>
                  <span className="weq-clean-target-icon">{TARGET_ICONS[t.id]}</span>
                  <span className="weq-clean-target-text">
                    <strong>
                      {t.label}
                      <em className={`weq-clean-tier is-${t.tier}`}>{t.tier === 'safe' ? '可再生' : '谨慎'}</em>
                    </strong>
                    <small>{t.desc}</small>
                  </span>
                  <span className="weq-clean-target-size">{disabled ? '空' : fmtBytes(t.bytes)}</span>
                </button>
                {on && t.hasVariants ? (
                  <div className="weq-clean-variants">
                    {(['all', 'ori', 'thumb'] as CleanupVariant[]).map((v) => (
                      <button
                        key={v}
                        type="button"
                        className={sel === v ? 'is-on' : ''}
                        onClick={() => onSetVariant(t.id, v)}
                      >
                        {VARIANT_LABEL[v]}
                        <i>
                          {v === 'all' ? fmtBytes(t.bytes) : v === 'ori' ? fmtBytes(t.ori.bytes) : fmtBytes(t.thumb.bytes)}
                        </i>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="weq-clean-custom-foot">
          <span>
            已选 <strong>{customInstructions.length}</strong> 项 · 预计释放 <strong>{fmtBytes(selBytes)}</strong>
          </span>
          <button type="button" className="weq-clean-go is-danger" disabled={!anySel} onClick={onConfirmCustom}>
            <Trash2 size={15} /> 清理所选
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="weq-clean-modes">
      {PRESETS.map((p) => {
        const instructions = p.build(targets);
        const bytes = estimateBytes(targets, instructions);
        const empty = !loading && bytes === 0;
        return (
          <button
            key={p.id}
            type="button"
            className={`weq-clean-mode${p.danger ? ' is-danger' : ''}${p.extreme ? ' is-extreme' : ''}`}
            onClick={() => onPickPreset(p)}
            disabled={empty}
          >
            <span className="weq-clean-mode-icon">{p.icon}</span>
            <span className="weq-clean-mode-body">
              <strong>{p.label}</strong>
              <small>{p.desc}</small>
            </span>
            <span className="weq-clean-mode-size">
              {loading ? <Loader2 size={13} className="weq-spin" /> : empty ? '无可清理' : `约 ${fmtBytes(bytes)}`}
            </span>
          </button>
        );
      })}
      <button type="button" className="weq-clean-mode is-custom" onClick={onEnterCustom}>
        <span className="weq-clean-mode-icon">
          <Sparkles size={20} />
        </span>
        <span className="weq-clean-mode-body">
          <strong>自定义清理</strong>
          <small>自由勾选要清理的资源，并选择清理原图或缩略。</small>
        </span>
        <span className="weq-clean-mode-size">
          <ChevronLeft size={15} style={{ transform: 'rotate(180deg)' }} />
        </span>
      </button>
    </div>
  );
}

// ── confirm stage ────────────────────────────────────────────────────────────

function ConfirmStage({
  targets,
  chosen,
  phrase,
  onPhrase,
  onBack,
  onRun,
}: {
  targets: CleanupTargetStat[];
  chosen: { preset: Preset; instructions: Instruction[] };
  phrase: string;
  onPhrase: (v: string) => void;
  onBack: () => void;
  onRun: () => void;
}): ReactElement {
  const { preset, instructions } = chosen;
  const bytes = estimateBytes(targets, instructions);
  const rows = instructions
    .map((ins) => {
      const t = targets.find((x) => x.id === ins.id);
      return t ? { t, variant: ins.variant, bytes: instructionBytes(t, ins.variant) } : null;
    })
    .filter((r): r is { t: CleanupTargetStat; variant: CleanupVariant; bytes: number } => r !== null)
    .sort((a, b) => b.bytes - a.bytes);

  const phraseOk = !preset.extreme || phrase.trim() === CONFIRM_PHRASE;
  const nothing = rows.length === 0;

  return (
    <div className="weq-clean-confirm">
      <button type="button" className="weq-clean-back" onClick={onBack}>
        <ChevronLeft size={15} /> 重新选择
      </button>

      <div className={`weq-clean-summary${preset.danger ? ' is-danger' : ''}`}>
        <span className="weq-clean-summary-icon">{preset.danger ? <AlertTriangle size={20} /> : <ShieldCheck size={20} />}</span>
        <div>
          <strong>{preset.label}</strong>
          <p>{preset.desc}</p>
        </div>
        <span className="weq-clean-summary-size">
          <b>{fmtBytes(bytes)}</b>
          <small>预计释放</small>
        </span>
      </div>

      {nothing ? (
        <div className="weq-clean-empty">没有可清理的内容。</div>
      ) : (
        <div className="weq-clean-review">
          {rows.map(({ t, variant, bytes: b }) => (
            <div className="weq-clean-review-row" key={`${t.id}:${variant}`}>
              <span className="weq-clean-target-icon">{TARGET_ICONS[t.id]}</span>
              <span className="weq-clean-review-label">{t.label}</span>
              {t.hasVariants ? <em className="weq-clean-review-variant">{VARIANT_LABEL[variant]}</em> : null}
              <span className="weq-clean-review-size">{fmtBytes(b)}</span>
            </div>
          ))}
        </div>
      )}

      {preset.extreme ? (
        <label className="weq-clean-phrase">
          <span>
            这是危险操作，将删除聊天图片 / 视频 / 语音等不可再生内容。请输入 <b>{CONFIRM_PHRASE}</b> 以确认：
          </span>
          <input
            type="text"
            value={phrase}
            onChange={(e) => onPhrase(e.target.value)}
            placeholder={CONFIRM_PHRASE}
            autoFocus
          />
        </label>
      ) : null}

      <div className="weq-clean-confirm-foot">
        <button type="button" className="weq-clean-cancel" onClick={onBack}>
          取消
        </button>
        <button
          type="button"
          className={`weq-clean-go${preset.danger ? ' is-danger' : ''}`}
          disabled={nothing || !phraseOk}
          onClick={onRun}
        >
          <Trash2 size={15} /> 确认清理 {fmtBytes(bytes)}
        </button>
      </div>
    </div>
  );
}

// ── done stage ───────────────────────────────────────────────────────────────

function DoneStage({
  result,
  onClose,
  onAgain,
}: {
  result: CleanupResult;
  onClose: () => void;
  onAgain: () => void;
}): ReactElement {
  const failed = result.perTarget.reduce((s, t) => s + t.failed, 0);
  return (
    <div className="weq-clean-done">
      <span className="weq-clean-done-icon">
        <CheckCircle2 size={40} strokeWidth={1.5} />
      </span>
      <strong className="weq-clean-done-title">已释放 {fmtBytes(result.freedBytes)}</strong>
      <p className="weq-clean-done-desc">
        清理完成，共处理 {result.perTarget.length} 项资源。
        {failed > 0 ? `有 ${failed} 个文件因被占用未能删除（可关闭 QQ 后重试）。` : ''}
      </p>
      <div className="weq-clean-done-actions">
        <button type="button" className="weq-clean-cancel" onClick={onAgain}>
          <Layers size={15} /> 继续清理
        </button>
        <button type="button" className="weq-clean-go" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  );
}
