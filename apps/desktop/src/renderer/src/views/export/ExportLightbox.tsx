/**
 * 导出灯箱：在右侧选好对象后弹出，收集本次导出的细项后确认。
 *
 * 草稿状态全部在本组件内部，只有点「开始导出」才回传给父组件（沿用关系图
 * GroupPickerModal 的 draft-then-commit 模式）。按 variant 决定显示哪些区块：
 *   full / chatlab → 时间范围 + 媒体选项 + 语音转写
 *   html           → 时间范围
 *   scheduled      → 上述 + 定时设置
 *   album          → 下载目录 + 相册选择 + 时间范围
 */

import { useState, type ReactElement } from 'react';
import { CalendarClock, Clock, FolderOpen, Loader2, Repeat, X } from 'lucide-react';
import { Card, Row, Toggle } from '../../components/settings/controls';
import { Segmented } from './widgets';
import { TimeRangePicker } from './TimeRangePicker';
import { closeFromScrim, useEscapeToClose } from '../../im-template/template/modalUtils';
import {
  DEFAULT_OPTIONS,
  DEFAULT_SCHEDULE,
  type ExportOptions,
  type Schedule,
} from './types';

export type LightboxVariant = 'full' | 'chatlab' | 'html' | 'scheduled' | 'album';

export interface LightboxResult {
  options: ExportOptions;
  schedule?: Schedule;
  downloadPath?: string | null;
}

export function ExportLightbox({
  variant,
  headline,
  summary,
  initialOptions = DEFAULT_OPTIONS,
  initialSchedule = DEFAULT_SCHEDULE,
  submitting = false,
  onPickPath,
  onClose,
  onConfirm,
}: {
  variant: LightboxVariant;
  headline: string;
  summary: string;
  initialOptions?: ExportOptions;
  initialSchedule?: Schedule;
  submitting?: boolean;
  /** Optional async directory picker; returns the chosen path or null. */
  onPickPath?: () => Promise<string | null>;
  onClose: () => void;
  onConfirm: (result: LightboxResult) => void;
}): ReactElement {
  useEscapeToClose(onClose);
  const [opts, setOpts] = useState<ExportOptions>(initialOptions);
  const [schedule, setSchedule] = useState<Schedule>(initialSchedule);
  const [path, setPath] = useState<string | null>(null);
  const [pickingPath, setPickingPath] = useState(false);

  const isAlbum = variant === 'album';
  const isHtml = variant === 'html';
  const isScheduled = variant === 'scheduled';

  function patch(next: Partial<ExportOptions>): void {
    setOpts((o) => ({ ...o, ...next }));
  }

  async function pickPath(): Promise<void> {
    if (!onPickPath) return;
    setPickingPath(true);
    try {
      const chosen = await onPickPath();
      if (chosen) setPath(chosen);
    } finally {
      setPickingPath(false);
    }
  }

  function confirm(): void {
    onConfirm({
      options: opts,
      schedule: isScheduled ? schedule : undefined,
      downloadPath: isAlbum ? path : undefined,
    });
  }

  return (
    <div className="modal-scrim weq-exp-modal-scrim" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <section className="weq-exp-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="weq-exp-dialog-head">
          <div className="weq-exp-dialog-title">
            <strong>{headline}</strong>
            <span title={summary}>{summary}</span>
          </div>
          <button type="button" className="weq-exp-dialog-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="weq-exp-dialog-body">
          {/* 下载目录（群相册） */}
          {isAlbum ? (
            <Card title="下载目录">
              <Row
                label={
                  <span className="weq-exp-path" title={path ?? undefined}>
                    <FolderOpen size={14} aria-hidden />
                    <span className="weq-exp-path-txt">{path ?? '未选择，开始导出时选择'}</span>
                  </span>
                }
                control={
                  <button type="button" className="weq-exp-btn" disabled={pickingPath} onClick={() => void pickPath()}>
                    {pickingPath ? <Loader2 size={14} className="weq-exp-spin" /> : <FolderOpen size={14} />}
                    选择目录
                  </button>
                }
              />
            </Card>
          ) : null}

          {/* 相册选择（占位，待群空间接口） */}
          {isAlbum ? (
            <Card title="相册选择">
              <div className="weq-exp-placeholder">
                <span>相册列表将从群空间加载</span>
                <small>该接口尚未接入，目前默认导出全部相册</small>
              </div>
            </Card>
          ) : null}

          {/* 时间范围 */}
          <Card title="时间范围">
            <TimeRangePicker value={opts.range} onChange={(range) => patch({ range })} />
          </Card>

          {/* 媒体 / 内容选项（非相册模式） */}
          {!isAlbum && !isHtml ? (
            <Card title="媒体与内容">
              <Row
                label="导出媒体文件"
                desc="图片、表情、视频、文件等随消息一并导出"
                control={<Toggle checked={opts.exportMedia} onChange={(v) => patch({ exportMedia: v })} />}
              />
              <Row
                indent
                label="补全缺失媒体"
                desc="本地缓存缺失时尝试重新下载（需 rkey）"
                control={
                  <Toggle
                    checked={opts.completeMedia}
                    disabled={!opts.exportMedia}
                    onChange={(v) => patch({ completeMedia: v })}
                  />
                }
              />
              <Row
                indent
                label="下载视频"
                control={
                  <Toggle
                    checked={opts.downloadVideo}
                    disabled={!opts.exportMedia}
                    onChange={(v) => patch({ downloadVideo: v })}
                  />
                }
              />
              <Row
                indent
                label="下载文件"
                control={
                  <Toggle
                    checked={opts.downloadFile}
                    disabled={!opts.exportMedia}
                    onChange={(v) => patch({ downloadFile: v })}
                  />
                }
              />
              <Row
                indent
                label="单文件大小上限"
                desc="超过该大小的媒体跳过下载，0 表示不限制"
                control={
                  <span className="weq-exp-num">
                    <input
                      type="number"
                      min={0}
                      max={4096}
                      value={opts.sizeCapMb}
                      disabled={!opts.exportMedia}
                      onChange={(e) => patch({ sizeCapMb: Math.max(0, Number(e.target.value) || 0) })}
                    />
                    <span>MB</span>
                  </span>
                }
              />
              <Row
                label="导出头像"
                desc="保存发送者头像到媒体目录"
                control={<Toggle checked={opts.exportAvatar} onChange={(v) => patch({ exportAvatar: v })} />}
              />
              <Row
                label="语音自动转写"
                desc="将语音消息转录为文字一并保存"
                control={<Toggle checked={opts.transcribeVoice} onChange={(v) => patch({ transcribeVoice: v })} />}
              />
            </Card>
          ) : null}

          {/* 定时设置 */}
          {isScheduled ? (
            <Card title="定时设置">
              <Segmented
                value={schedule.mode}
                onChange={(mode) => setSchedule((s) => ({ ...s, mode: mode as Schedule['mode'] }))}
                options={[
                  { value: 'daily', label: '每天定时', icon: <CalendarClock size={13} /> },
                  { value: 'interval', label: '间隔执行', icon: <Repeat size={13} /> },
                ]}
              />
              {schedule.mode === 'daily' ? (
                <Row
                  label="执行时间"
                  desc="每天到点自动导出一次"
                  control={
                    <span className="weq-exp-num">
                      <Clock size={14} aria-hidden />
                      <input
                        type="time"
                        value={schedule.time}
                        onChange={(e) => setSchedule((s) => ({ ...s, time: e.target.value }))}
                      />
                    </span>
                  }
                />
              ) : (
                <Row
                  label="执行间隔"
                  desc="每隔指定小时数自动导出一次"
                  control={
                    <span className="weq-exp-num">
                      <span>每</span>
                      <input
                        type="number"
                        min={1}
                        max={168}
                        value={schedule.intervalHours}
                        onChange={(e) =>
                          setSchedule((s) => ({ ...s, intervalHours: Math.max(1, Number(e.target.value) || 1) }))
                        }
                      />
                      <span>小时</span>
                    </span>
                  }
                />
              )}
            </Card>
          ) : null}
        </div>

        <footer className="weq-exp-dialog-foot">
          <button type="button" className="weq-exp-btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="button" className="weq-exp-btn is-primary" onClick={confirm} disabled={submitting}>
            {submitting ? <Loader2 size={15} className="weq-exp-spin" /> : null}
            {isScheduled ? '创建定时任务' : '开始导出'}
          </button>
        </footer>
      </section>
    </div>
  );
}
