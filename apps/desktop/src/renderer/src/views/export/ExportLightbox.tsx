/**
 * 导出灯箱：在右侧选好对象后弹出，收集本次导出的细项后确认。
 *
 * 草稿状态全部在本组件内部，只有点「开始导出」才回传给父组件（沿用关系图
 * GroupPickerModal 的 draft-then-commit 模式）。按 variant 决定显示哪些区块：
 *   full / chatlab → 时间范围 + 媒体选项 + 语音转写（HTML 现为 full 的一种格式）
 *   scheduled      → 上述 + 定时设置
 *   qzone          → 时间范围 + 是否下载配图（好友空间说说）
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

export type LightboxVariant = 'full' | 'chatlab' | 'qzone' | 'scheduled' | 'album' | 'contacts';

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
  const isQzone = variant === 'qzone';
  const isScheduled = variant === 'scheduled';
  const isContacts = variant === 'contacts';

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

          {/* 好友空间说明 */}
          {isQzone ? (
            <Card title="好友 QQ 空间导出">
              <div className="weq-exp-placeholder">
                <span>导出该好友已发表的说说（内容 / 时间 / 评论数 / 配图链接）</span>
                <small>
                  需登录该账号的 QQ 客户端。开启下方「下载配图」后，说说图片存入同目录 media/ 子文件夹；
                  否则仅在文件中保留图片链接。
                </small>
              </div>
            </Card>
          ) : null}

          {/* ChatLab 说明 */}
          {variant === 'chatlab' ? (
            <Card title="ChatLab 标准格式">
              <div className="weq-exp-placeholder">
                <span>导出为 ChatLab 交换格式（成员 / 角色 / 消息已标准化）</span>
                <small>
                  可被 ChatLab 解析分析。媒体在消息内以 [图片]/[文件:名] 等标签呈现；
                  开启下方「语音自动转写」后，语音转写结果写入 transcripts.json（按语音文件名关联）。
                </small>
              </div>
            </Card>
          ) : null}

          {/* 联系人导出说明 + 头像 */}
          {isContacts ? (
            <Card title="导出联系人">
              <div className="weq-exp-placeholder">
                <span>导出好友列表 / 群成员列表（QQ号、昵称、备注、分组、角色等）</span>
                <small>
                  数据来自本地资料库，无需在线 QQ。开启下方「导出头像」后，头像存入同目录
                  avatars/ 子文件夹（导出结果保存为文件夹）。
                </small>
              </div>
              <Row
                label="导出头像"
                desc="联系人头像存入 avatars/ 子目录（缓存优先，缺失走 CDN 补齐）"
                control={<Toggle checked={opts.exportAvatar} onChange={(v) => patch({ exportAvatar: v })} />}
              />
            </Card>
          ) : null}

          {/* 时间范围（联系人无时间维度，不显示） */}
          {!isContacts ? (
            <Card title="时间范围">
              <TimeRangePicker
                value={opts.range}
                onChange={(range) => patch({ range })}
                mode={isScheduled ? 'scheduled' : 'single'}
              />
            </Card>
          ) : null}

          {/* 好友空间：只需「是否下载配图」一个开关 */}
          {isQzone ? (
            <Card title="媒体">
              <Row
                label="下载配图"
                desc="将说说中的图片下载到 media/ 子目录（导出结果保存为文件夹）"
                control={<Toggle checked={opts.exportMedia} onChange={(v) => patch({ exportMedia: v })} />}
              />
            </Card>
          ) : null}

          {/* 媒体 / 内容选项（完整消息 / ChatLab / 定时；HTML 也支持） */}
          {!isAlbum && !isQzone && !isContacts ? (
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
                desc="需先开启「补全缺失媒体」"
                control={
                  <Toggle
                    checked={opts.downloadVideo && opts.completeMedia}
                    disabled={!opts.exportMedia || !opts.completeMedia}
                    onChange={(v) => patch({ downloadVideo: v })}
                  />
                }
              />
              <Row
                indent
                label="下载文件"
                desc="需先开启「补全缺失媒体」"
                control={
                  <Toggle
                    checked={opts.downloadFile && opts.completeMedia}
                    disabled={!opts.exportMedia || !opts.completeMedia}
                    onChange={(v) => patch({ downloadFile: v })}
                  />
                }
              />
              <Row
                label="导出头像"
                desc="发送者头像存入 avatars/ 子目录（缓存优先，缺失走 CDN 补齐）；导出结果将保存为文件夹"
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
