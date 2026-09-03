/**
 * 导出灯箱：在右侧选好对象后弹出，收集本次导出的细项后确认。
 *
 * 重构后是「宽面板 + 分板块」：左侧一列放时间范围与补全选项，右侧一列放
 * 导出格式 / 导出内容 / 扩展功能，底部为操作条。所有配置都在本组件内部
 * draft，只有点「开始导出」才回传给父组件。
 *
 * 板块：
 *   1. 时间范围 —— 常驻精简月历，预设区间直接在日历上高亮。
 *   2. 导出格式 —— 多选（至少一种；媒体只导出一份，不会随格式重复）。
 *   3. 导出内容 —— 消息（必选）/ 媒体资源（子选项：图片·语音·视频·文件·
 *      QQ系统表情）/ 头像 / 装扮数据（子选项：气泡·字体·挂件）。
 *   4. 补全选项 —— 补全媒体资源（需在线 QQ + 已选导出媒体）、漫游消息、
 *      本地未缓存的装扮资源。
 *   5. 扩展功能 —— 导出后自动保存、语音转写（需已配置转录模型）。
 */

import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  CalendarClock,
  Check,
  FileText,
  Film,
  FolderOpen,
  Heart,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  RefreshCw,
  Smile,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import { Card, Row, Toggle } from '../../components/settings/controls';
import { client } from '../../trpc/client';
import { useToast } from '../../components/Toast';
import { Segmented } from './widgets';
import { TimeRangePicker } from './TimeRangePicker';
import { closeFromScrim, useEscapeToClose } from '../../im-template/template/modalUtils';
import {
  DEFAULT_MEDIA_KINDS,
  DEFAULT_OPTIONS,
  DEFAULT_SCHEDULE,
  FRIEND_FORMATS,
  FULL_FORMATS,
  MEDIA_KIND_LABELS,
  MEMBER_FORMATS,
  QZONE_FORMATS,
  type ExportFormat,
  type ExportOptions,
  type MediaKinds,
  type Schedule,
} from './types';

export type LightboxVariant = 'full' | 'guild' | 'qzone' | 'scheduled' | 'album' | 'contacts';

export interface LightboxResult {
  /** 灯箱里多选的导出格式（至少一种）。 */
  formats: ExportFormat[];
  options: ExportOptions;
  schedule?: Schedule;
  downloadPath?: string | null;
}

/** 每种媒体子选项的展示图标。 */
const MEDIA_ICONS: Record<keyof MediaKinds, ReactElement> = {
  image: <ImageIcon size={13} />,
  voice: <Mic size={13} />,
  video: <Film size={13} />,
  file: <FileText size={13} />,
  sysface: <Smile size={13} />,
};

/** 补全选项（4.1）的四种媒体。 */
const COMPLETE_KINDS = [
  { key: 'completeMedia' as const, label: '图片' },
  { key: 'downloadPtt' as const, label: '语音' },
  { key: 'downloadVideo' as const, label: '视频' },
  { key: 'downloadFile' as const, label: '文件/群文件' },
];

/** 一个小型多选 chip 组。 */
function KindChips({
  options,
  selected,
  onToggle,
  disabled,
}: {
  options: Array<{ key: string; label: ReactNode }>;
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  disabled?: boolean;
}): ReactElement {
  return (
    <div className={`weq-exp-kinds${disabled ? ' is-disabled' : ''}`}>
      {options.map((opt) => {
        const on = selected.has(opt.key);
        return (
          <button
            key={opt.key}
            type="button"
            className={`weq-exp-kind${on ? ' is-on' : ''}`}
            disabled={disabled}
            onClick={() => onToggle(opt.key)}
            aria-pressed={on}
          >
            {on ? <Check size={12} /> : <span className="weq-exp-kind-dot" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** 「大按钮」样式的主开关行：图标 + 标题 + 说明 + 开关。 */
function MasterRow({
  icon,
  label,
  desc,
  checked,
  onChange,
  disabled,
  badge,
}: {
  icon: ReactNode;
  label: ReactNode;
  desc?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  badge?: ReactNode;
}): ReactElement {
  return (
    <div className={`weq-exp-master${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}>
      <span className="weq-exp-master-icon">{icon}</span>
      <span className="weq-exp-master-main">
        <span className="weq-exp-master-label">
          {label}
          {badge ? <span className="weq-exp-master-badge">{badge}</span> : null}
        </span>
        {desc ? <span className="weq-exp-master-desc">{desc}</span> : null}
      </span>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/** 补全选项的统一样式行：步骤徽标 + 标题/说明 + 右侧控件（chips 或开关）。 */
function StepRow({
  step,
  title,
  desc,
  control,
  wide,
}: {
  step: string;
  title: ReactNode;
  desc?: ReactNode;
  control: ReactNode;
  /** true = 控件独占下一行（chips 类多选项）。 */
  wide?: boolean;
}): ReactElement {
  return (
    <div className="weq-exp-step-row">
      <div className="weq-exp-step-head">
        <span className="weq-exp-block-step">{step}</span>
        <span className="weq-exp-step-main">
          <span className="weq-exp-step-title">{title}</span>
          {desc ? <span className="weq-exp-step-desc">{desc}</span> : null}
        </span>
        {!wide ? <span className="weq-exp-step-ctrl">{control}</span> : null}
      </div>
      {wide ? <div className="weq-exp-step-wide">{control}</div> : null}
    </div>
  );
}

export function ExportLightbox({
  variant,
  headline,
  summary,
  contactScope = 'friends',
  initialOptions = DEFAULT_OPTIONS,
  initialFormats,
  initialSchedule = DEFAULT_SCHEDULE,
  submitting = false,
  onPickPath,
  onClose,
  onConfirm,
}: {
  variant: LightboxVariant;
  headline: string;
  summary: string;
  /** 联系人导出范围（决定灯箱内可选格式：好友含 vCard）。 */
  contactScope?: 'friends' | 'group';
  initialOptions?: ExportOptions;
  /** 上次使用的导出格式；缺失或不在当前变体可选范围内时退回默认格式。 */
  initialFormats?: ExportFormat[];
  initialSchedule?: Schedule;
  submitting?: boolean;
  /** Optional async directory picker; returns the chosen path or null. */
  onPickPath?: () => Promise<string | null>;
  onClose: () => void;
  onConfirm: (result: LightboxResult) => void;
}): ReactElement {
  useEscapeToClose(onClose);
  const pushToast = useToast((s) => s.push);
  const [opts, setOpts] = useState<ExportOptions>(initialOptions);
  const [schedule, setSchedule] = useState<Schedule>(initialSchedule);
  const [path, setPath] = useState<string | null>(null);
  const [pickingPath, setPickingPath] = useState(false);

  // 灯箱打开时探测：QQ 在线实例（4.1 可点击前提）+ 语音转录模型（5.2 前提）。
  const [qqOnline, setQqOnline] = useState<boolean | null>(null);
  const [voiceModelReady, setVoiceModelReady] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void client.account.getGroupAlbumAccessState.query().then((s) => {
      if (!cancelled) setQqOnline(s.qqOnline);
    });
    void (async () => {
      try {
        const settings = await client.bootstrap.getSettings.query();
        const modelId = settings.voiceTranscribe.modelId;
        if (!modelId) {
          if (!cancelled) setVoiceModelReady(false);
          return;
        }
        const models = await client.bootstrap.voiceModels.query();
        const model = models.find((m) => m.id === modelId);
        if (!cancelled) setVoiceModelReady(Boolean(model?.downloaded));
      } catch {
        if (!cancelled) setVoiceModelReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isAlbum = variant === 'album';
  const isQzone = variant === 'qzone';
  const isGuild = variant === 'guild';
  const isScheduled = variant === 'scheduled';
  const isContacts = variant === 'contacts';
  const isMessageFlow = !isAlbum && !isQzone && !isContacts;

  /** 该变体可选的格式。 */
  const formatOptions = useMemo(
    () =>
      variant === 'qzone'
        ? QZONE_FORMATS
        : variant === 'contacts'
          ? contactScope === 'friends'
            ? FRIEND_FORMATS
            : MEMBER_FORMATS
          : FULL_FORMATS,
    [variant, contactScope],
  );
  const [formats, setFormats] = useState<ExportFormat[]>(() => {
    const allowed = initialFormats?.filter((f) => formatOptions.some((o) => o.value === f));
    return allowed && allowed.length > 0 ? allowed : [formatOptions[0]!.value];
  });

  /** QQ 空间 HTML 导出靠本地配图 + 评论/点赞渲染：选中 HTML 时锁定
   *  「下载配图」与「评论与点赞」为开。 */
  const htmlForced = isQzone && formats.includes('html');

  function patch(next: Partial<ExportOptions>): void {
    setOpts((o) => ({ ...o, ...next }));
  }

  // 切到 HTML 时自动补开配图下载 + 评论/点赞拉取，避免产出渲染不全的 html。
  useEffect(() => {
    if (!htmlForced) return;
    setOpts((o) => ({ ...o, exportMedia: true, qzoneInteractions: true }));
  }, [htmlForced]);

  /** 切换某个导出格式（至少保留一种）。 */
  function toggleFormat(f: ExportFormat): void {
    setFormats((prev) => {
      if (prev.includes(f)) {
        if (prev.length === 1) {
          pushToast({ tone: 'warning', title: '至少保留一种导出格式', ttl: 3200 });
          return prev;
        }
        return prev.filter((x) => x !== f);
      }
      return [...prev, f];
    });
  }

  /** 切换媒体子类；开启媒体大按钮时默认全选。 */
  function toggleMediaKind(kind: keyof MediaKinds): void {
    patch({
      mediaKinds: {
        ...opts.mediaKinds,
        [kind]: !opts.mediaKinds[kind],
      },
    });
  }

  function toggleDressKind(kind: 'bubble' | 'font' | 'widget'): void {
    patch({ dress: { ...opts.dress, [kind]: !opts.dress[kind] } });
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
      formats,
      options: opts,
      schedule: isScheduled ? schedule : undefined,
      downloadPath: isAlbum ? path : undefined,
    });
  }

  const selectedMediaKinds = new Set(
    (Object.keys(MEDIA_KIND_LABELS) as Array<keyof MediaKinds>).filter((k) => opts.mediaKinds[k]),
  );
  const selectedDressKinds = new Set(
    ['bubble', 'font', 'widget'].filter((k) => opts.dress[k as keyof typeof opts.dress]),
  );
  const hasDress = opts.dress.bubble || opts.dress.font || opts.dress.widget;
  const selectedCompleteKinds = new Set(
    COMPLETE_KINDS.filter((c) => opts[c.key]).map((c) => c.key),
  );
  /** ChatLab 只支持 JSON / JSONL。 */
  const chatlabAllowed = formats.every((f) => f === 'json' || f === 'jsonl');

  function toggleChatlab(v: boolean): void {
    if (v) {
      // 开启 ChatLab 时只保留 json / jsonl（优先 json）。
      const kept = formats.filter((f) => f === 'json' || f === 'jsonl');
      setFormats(kept.length > 0 ? kept : ['json']);
      patch({ chatlab: true });
    } else {
      patch({ chatlab: false });
    }
  }

  return (
    <div
      className="modal-scrim weq-exp-modal-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className="weq-exp-dialog is-wide"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
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
          {isAlbum ? (
            <div className="weq-exp-album-pane">
              <Card title="下载目录">
                <Row
                  label={
                    <span className="weq-exp-path" title={path ?? undefined}>
                      <FolderOpen size={14} aria-hidden />
                      <span className="weq-exp-path-txt">{path ?? '未选择，开始导出时选择'}</span>
                    </span>
                  }
                  control={
                    <button
                      type="button"
                      className="weq-exp-btn"
                      disabled={pickingPath}
                      onClick={() => void pickPath()}
                    >
                      {pickingPath ? (
                        <Loader2 size={14} className="weq-exp-spin" />
                      ) : (
                        <FolderOpen size={14} />
                      )}
                      选择目录
                    </button>
                  }
                />
              </Card>

              <Card title="相册选择">
                <div className="weq-exp-placeholder">
                  <span>相册列表将从群空间加载</span>
                  <small>该接口尚未接入，目前默认导出全部相册</small>
                </div>
              </Card>

              <Card title="时间范围">
                <TimeRangePicker
                  value={opts.range}
                  onChange={(range) => patch({ range })}
                  mode="single"
                />
              </Card>
            </div>
          ) : (
            <>
              {/* 左列：时间范围 + 补全选项 */}
              <div className="weq-exp-col">
                {!isContacts ? (
                  <Card title="时间范围">
                    <TimeRangePicker
                      value={opts.range}
                      onChange={(range) => patch({ range })}
                      mode={isScheduled ? 'scheduled' : 'single'}
                    />
                  </Card>
                ) : (
                  <Card title="导出联系人">
                    <div className="weq-exp-placeholder">
                      <span>导出好友列表 / 群成员列表（QQ号、昵称、备注、分组、角色等）</span>
                      <small>
                        数据来自本地资料库，无需在线 QQ。开启「导出头像」后，头像存入同目录 avatars/
                        子文件夹（导出结果保存为文件夹）。
                      </small>
                    </div>
                  </Card>
                )}

                {/* 补全选项（仅完整消息 / 定时；空间/联系人/相册无消息补全维度） */}
                {isMessageFlow ? (
                  <Card title="补全选项">
                    <StepRow
                      step="4.1"
                      title="补全缺失的媒体资源"
                      desc={
                        !opts.exportMedia || !qqOnline
                          ? !opts.exportMedia
                            ? '需先开启「导出内容 → 媒体资源」'
                            : qqOnline === null
                              ? '正在检查 QQ 在线状态…'
                              : '需登录在线 QQ 实例后可用'
                          : '本地缓存缺失时从云端补齐'
                      }
                      control={
                        <KindChips
                          options={COMPLETE_KINDS}
                          selected={selectedCompleteKinds}
                          onToggle={(key) => patch({ [key]: !opts[key as keyof typeof opts] })}
                          disabled={!opts.exportMedia || !qqOnline}
                        />
                      }
                      wide
                    />
                    <StepRow
                      step="4.2"
                      title={isGuild ? '拉取漫游消息' : '补充拉取的漫游消息'}
                      desc={
                        isGuild
                          ? '频道私聊仅导出本机已有的消息记录，不支持漫游消息拉取'
                          : '扫描本地缓存中的漫游消息一并导出（未在线时也会读取缓存数据库）'
                      }
                      control={
                        <Toggle
                          checked={isGuild ? false : opts.completeMessages}
                          disabled={isGuild}
                          onChange={(v) => patch({ completeMessages: v })}
                        />
                      }
                    />
                    <StepRow
                      step="4.3"
                      title="下载本地未缓存的装扮资源"
                      desc={
                        !hasDress
                          ? '需先在「导出内容 → 装扮数据」勾选类别'
                          : '装扮导出时在线补齐缺失资源（关闭则只导出已缓存的部分）'
                      }
                      control={
                        <Toggle
                          checked={opts.completeDress}
                          disabled={!hasDress}
                          onChange={(v) => patch({ completeDress: v })}
                        />
                      }
                    />
                  </Card>
                ) : null}
              </div>

              {/* 右列：格式 + 内容 + 扩展 */}
              <div className="weq-exp-col">
                {isQzone ? (
                  <Card title="QQ 空间导出">
                    <div className="weq-exp-placeholder">
                      <span>
                        导出该空间的说说（内容 / 时间 / 评论数 / 配图 / 视频；可选导出自己）
                      </span>
                      <small>
                        需登录该账号的 QQ 客户端。配图与视频存入 media/；HTML
                        格式会强制下载媒体并本地引用（离线可看）；评论与点赞从动态页解析，仅覆盖翻到的动态，可能不全。
                      </small>
                    </div>
                  </Card>
                ) : null}

                {/* 导出格式（多选；相册的格式仍走外部选择器） */}
                {!isAlbum ? (
                  <Card title="导出格式">
                    <div className="weq-exp-format-grid">
                      {formatOptions.map((f) => {
                        const on = formats.includes(f.value);
                        const blocked = opts.chatlab && f.value !== 'json' && f.value !== 'jsonl';
                        return (
                          <button
                            key={f.value}
                            type="button"
                            className={`weq-exp-format${on ? ' is-on' : ''}${blocked ? ' is-blocked' : ''}`}
                            onClick={() => {
                              if (blocked) {
                                pushToast({
                                  tone: 'warning',
                                  title: 'ChatLab 仅支持 JSON / JSONL',
                                  ttl: 3000,
                                });
                                return;
                              }
                              toggleFormat(f.value);
                            }}
                            aria-pressed={on}
                            disabled={blocked}
                          >
                            {on ? <Check size={13} /> : null}
                            {f.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="weq-exp-block-hint">
                      {isMessageFlow
                        ? '多选时每个格式各产出一份消息文件，媒体资源只导出一份，不会重复。'
                        : '多选时每个格式各产出一份文件。'}
                    </p>
                  </Card>
                ) : null}

                {/* 导出内容 */}
                {!isAlbum ? (
                  <Card title="导出内容">
                    {isQzone ? (
                      <>
                        <MasterRow
                          icon={<ImageIcon size={17} />}
                          label="下载媒体（配图 / 视频）"
                          desc={
                            htmlForced
                              ? 'HTML 导出需要本地媒体，已随格式强制开启'
                              : '说说正文始终导出；配图与视频开启后存入 media/ 子目录'
                          }
                          checked={opts.exportMedia}
                          disabled={htmlForced}
                          onChange={(v) => patch({ exportMedia: v })}
                        />
                        <MasterRow
                          icon={<Heart size={17} />}
                          label="评论与点赞"
                          desc={
                            htmlForced
                              ? 'HTML 导出包含评论与点赞，已随格式强制开启'
                              : '按说说逐条补拉评论（含回复）与点赞用户，写进导出文件（尽力而为，可能不全）'
                          }
                          checked={htmlForced || opts.qzoneInteractions}
                          disabled={htmlForced}
                          onChange={(v) => patch({ qzoneInteractions: v })}
                        />
                      </>
                    ) : isContacts ? (
                      <MasterRow
                        icon={<UserRound size={17} />}
                        label="头像"
                        desc="联系人头像存入 avatars/ 子目录"
                        checked={opts.exportAvatar}
                        onChange={(v) => patch({ exportAvatar: v })}
                      />
                    ) : (
                      <>
                        <MasterRow
                          icon={<MessageSquare size={17} />}
                          label="消息"
                          desc="聊天记录正文（必选，始终导出）"
                          checked
                          disabled
                          onChange={() => undefined}
                          badge="必选"
                        />
                        <MasterRow
                          icon={<ImageIcon size={17} />}
                          label="媒体资源"
                          desc="图片 / 语音 / 视频 / 文件 / QQ系统表情"
                          checked={opts.exportMedia}
                          onChange={(v) => {
                            patch({
                              exportMedia: v,
                              // 开启时默认全选子类；关闭时清空。
                              mediaKinds: v
                                ? { ...DEFAULT_MEDIA_KINDS }
                                : {
                                    image: false,
                                    voice: false,
                                    video: false,
                                    file: false,
                                    sysface: false,
                                  },
                            });
                          }}
                        />
                        {opts.exportMedia ? (
                          <div className="weq-exp-kinds-wrap">
                            <KindChips
                              options={(
                                Object.keys(MEDIA_KIND_LABELS) as Array<keyof MediaKinds>
                              ).map((k) => ({
                                key: k,
                                label: (
                                  <>
                                    {MEDIA_ICONS[k]}
                                    {MEDIA_KIND_LABELS[k]}
                                  </>
                                ),
                              }))}
                              selected={selectedMediaKinds}
                              onToggle={(key) => toggleMediaKind(key as keyof MediaKinds)}
                            />
                          </div>
                        ) : null}

                        <MasterRow
                          icon={<UserRound size={17} />}
                          label="头像"
                          desc="发送者头像存入 avatars/ 子目录"
                          checked={opts.exportAvatar}
                          onChange={(v) => patch({ exportAvatar: v })}
                        />

                        <MasterRow
                          icon={<Sparkles size={17} />}
                          label="装扮数据"
                          desc="气泡 / 字体 / 挂件（仅会话实际使用到的款）"
                          checked={opts.dress.bubble || opts.dress.font || opts.dress.widget}
                          onChange={(v) =>
                            patch({
                              dress: v
                                ? { bubble: true, font: true, widget: true }
                                : { bubble: false, font: false, widget: false },
                            })
                          }
                        />
                        {opts.dress.bubble || opts.dress.font || opts.dress.widget ? (
                          <div className="weq-exp-kinds-wrap">
                            <KindChips
                              options={[
                                { key: 'bubble', label: '气泡' },
                                { key: 'font', label: '字体' },
                                { key: 'widget', label: '挂件' },
                              ]}
                              selected={selectedDressKinds}
                              onToggle={(key) =>
                                toggleDressKind(key as 'bubble' | 'font' | 'widget')
                              }
                            />
                          </div>
                        ) : null}
                      </>
                    )}
                  </Card>
                ) : null}

                {/* 扩展功能 */}
                {isMessageFlow ? (
                  <Card title="扩展功能">
                    {isScheduled ? (
                      <p className="weq-exp-block-hint">
                        定时任务暂不支持自动保存；手动触发后可在任务列表逐个保存。
                      </p>
                    ) : (
                      <Row
                        label="导出后自动保存"
                        desc="完成后弹出保存路径"
                        control={
                          <Toggle
                            checked={opts.autoSave}
                            onChange={(v) => patch({ autoSave: v })}
                          />
                        }
                      />
                    )}
                    <Row
                      label="语音转写"
                      desc={
                        voiceModelReady === false
                          ? '需先在「设置 → 语音转录」下载并选择模型'
                          : '将语音消息转录为文字一并保存'
                      }
                      control={
                        <Toggle
                          checked={opts.transcribeVoice}
                          disabled={voiceModelReady === false}
                          onChange={(v) => patch({ transcribeVoice: v })}
                        />
                      }
                    />
                    <Row
                      label="ChatLab 格式"
                      desc={
                        chatlabAllowed
                          ? '导出为 ChatLab 交换格式（成员 / 角色 / 消息已标准化）'
                          : '仅支持 JSON / JSONL 格式'
                      }
                      control={
                        <Toggle
                          checked={opts.chatlab}
                          disabled={!chatlabAllowed}
                          onChange={(v) => toggleChatlab(v)}
                        />
                      }
                    />
                  </Card>
                ) : null}

                {/* 定时设置 */}
                {isScheduled ? (
                  <Card title="定时设置">
                    <Segmented
                      value={schedule.mode}
                      onChange={(mode) =>
                        setSchedule((s) => ({ ...s, mode: mode as Schedule['mode'] }))
                      }
                      options={[
                        { value: 'daily', label: '每天定时', icon: <CalendarClock size={13} /> },
                        { value: 'interval', label: '间隔执行', icon: <RefreshCw size={13} /> },
                      ]}
                    />
                    {schedule.mode === 'daily' ? (
                      <Row
                        label="执行时间"
                        desc="每天到点自动导出一次"
                        control={
                          <span className="weq-exp-num">
                            <CalendarClock size={14} aria-hidden />
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
                                setSchedule((s) => ({
                                  ...s,
                                  intervalHours: Math.max(1, Number(e.target.value) || 1),
                                }))
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
            </>
          )}
        </div>

        <footer className="weq-exp-dialog-foot">
          <span className="weq-exp-dialog-foot-note">
            {isMessageFlow
              ? `${formats.length} 种格式${opts.exportMedia ? ' · 含媒体' : ''}${opts.exportAvatar ? ' · 头像' : ''}${
                  opts.dress.bubble || opts.dress.font || opts.dress.widget ? ' · 装扮' : ''
                }`
              : isQzone
                ? `${formats.length} 种格式${opts.exportMedia ? ' · 含配图' : ''}${opts.qzoneInteractions ? ' · 含评论/赞' : ''}`
                : isContacts
                  ? `${formats.length} 种格式${opts.exportAvatar ? ' · 含头像' : ''}`
                  : null}
          </span>
          <button type="button" className="weq-exp-btn" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="weq-exp-btn is-primary"
            onClick={confirm}
            disabled={submitting}
          >
            {submitting ? <Loader2 size={15} className="weq-exp-spin" /> : null}
            {isScheduled ? '创建定时任务' : '开始导出'}
          </button>
        </footer>
      </section>
    </div>
  );
}
