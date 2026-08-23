/**
 * 项目交流群 → 「反馈 bug」弹窗。
 *
 * 两条路径：
 *   1. 新 bug —— 标题 + Markdown 正文，正文与两份最新日志打包到缓存目录，
 *      以闪传发到群聊（拿到 filesetId 立即发送，上传后台继续）。
 *   2. 已有 GitHub issue/PR —— 从 GitHub 拉取列表选择，或手动输入标题 + 编号；
 *      以图文 Ark 卡片发出（标题 = issue/pr #N，预览图 = 群头像）。
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Bug,
  CircleAlert,
  Eye,
  Github,
  GitPullRequest,
  Loader2,
  MessageCircle,
  PencilLine,
  RefreshCw,
  Send,
  X,
} from 'lucide-react';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { trpc, client } from '../trpc/client';
import { Modal, useDialog } from './Dialog';
import { useToast } from './Toast';
import { IconPicker } from './ui/iconPicker';
import { shikiCodeHighlighter } from '../views/agentlab/shikiHighlighter';
import { useThemeStore } from '../state/theme';
import bugBanner from '@resources/brand/bug_banner.png';
import bugBannerDark from '@resources/brand/bug_banner_2.png';
import '../styles/group-bug.css';

const REMARK_PLUGINS = [remarkGfm];
const PLUGINS = { code: shikiCodeHighlighter };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** issue / PR 种类图标（PR 紫、Issue 主题色）。 */
function kindIcon(kind: 'issue' | 'pr'): ReactElement {
  return kind === 'pr' ? (
    <span className="weq-picker-kind-icon is-pr">
      <GitPullRequest size={13} aria-hidden />
    </span>
  ) : (
    <span className="weq-picker-kind-icon is-issue">
      <CircleAlert size={13} aria-hidden />
    </span>
  );
}

export function GroupBugDialog({
  groupId,
  groupName,
  onClose,
}: {
  groupId: string;
  groupName: string;
  onClose: () => void;
}): ReactElement {
  const pushToast = useToast((s) => s.push);
  const showError = useDialog((s) => s.showError);
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const version = trpc.bootstrap.getVersionInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  /** 路径选择：新 bug / 已有 issue·PR。 */
  const [mode, setMode] = useState<'new' | 'existing'>('new');

  // ── 路径 1：新 bug ─────────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [submittingFlash, setSubmittingFlash] = useState(false);

  const appVersion = version.data?.app ?? '';

  /** GitHub 式模板（与设置页反馈一致，精简版）。 */
  const buildTemplate = useCallback((): string => {
    return [
      '- [x] 我反馈的是一个 bug（feature 意见请删除本模板）',
      '- [ ] 我知道错误的原因',
      '- [ ] 我愿意 PR 修复',
      '',
      '## 系统版本',
      '<操作系统 + 版本>',
      '',
      '## weq 版本',
      appVersion || '<设置 → 全局设置 显示的版本号>',
      '',
      '## 错误的功能描述',
      '<在这里描述发生了什么，附上报错文本 / 日志 / 截图>',
      '',
      '## 预期的功能描述',
      '<在这里描述期望的行为>',
      '',
    ].join('\n');
  }, [appVersion]);

  // 首次进入自动填入模板（等版本信息就绪后）。
  useEffect(() => {
    if (body) return;
    if (version.isLoading) return;
    setBody(buildTemplate());
  }, [buildTemplate, body, version.isLoading]);

  const resetTemplate = (): void => {
    setBody(buildTemplate());
    pushToast({ tone: 'info', title: '已填入反馈模板' });
  };

  const submitNewBug = async (): Promise<void> => {
    const t = title.trim();
    const b = body.trim();
    if (!t) {
      showError('内容不完整', '请先填写标题');
      return;
    }
    if (!b) {
      showError('内容不完整', '请先填写反馈内容');
      return;
    }
    setSubmittingFlash(true);
    try {
      const res = await client.groupFeedback.submitNewBug.mutate({ groupId, title: t, body: b });
      if (!res.ok) {
        if (res.reason === 'offline') {
          pushToast({ tone: 'error', title: 'QQ 未在线', detail: res.message });
        } else if (res.reason === 'offline-mode') {
          pushToast({ tone: 'error', title: '完全离线模式已开启', detail: res.message });
        } else {
          pushToast({ tone: 'error', title: '发送失败', detail: res.message });
        }
        return;
      }
      pushToast({
        tone: 'success',
        title: '已发送到群聊',
        detail: '闪传消息已发出，文件正在后台上传；上传完成后对方即可下载。',
      });
      onClose();
    } catch (e) {
      pushToast({ tone: 'error', title: '发送失败', detail: errMsg(e) });
    } finally {
      setSubmittingFlash(false);
    }
  };

  // ── 路径 2：已有 GitHub issue/PR ──────────────────────────────
  const [issues, setIssues] = useState<Array<{
    number: number;
    title: string;
    url: string;
    kind: 'issue' | 'pr';
  }> | null>(null);
  const [issuesError, setIssuesError] = useState('');
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualNumber, setManualNumber] = useState('');
  const [manualKind, setManualKind] = useState<'issue' | 'pr'>('issue');
  const [submittingArk, setSubmittingArk] = useState(false);

  const loadIssues = async (): Promise<void> => {
    if (issuesLoading) return;
    setIssuesLoading(true);
    setIssuesError('');
    try {
      const res = await client.groupFeedback.listIssues.query();
      if (!res.ok) {
        setIssuesError(res.message);
        setIssues(null);
        setManualMode(true);
        return;
      }
      setIssues(res.items);
      setManualMode(false);
      if (res.items.length > 0) setSelectedNumber(res.items[0]!.number);
      else setManualMode(true);
    } catch (e) {
      setIssuesError(errMsg(e));
      setIssues(null);
      setManualMode(true);
    } finally {
      setIssuesLoading(false);
    }
  };

  const selectedIssue = useMemo(
    () => issues?.find((it) => it.number === selectedNumber) ?? null,
    [issues, selectedNumber],
  );

  const submitIssueArk = async (): Promise<void> => {
    const manual = manualMode || issues === null || issues.length === 0;
    const number = manual ? Number(manualNumber.trim()) : selectedNumber;
    const t = manual ? manualTitle.trim() : (selectedIssue?.title ?? '');
    if (!number || !Number.isInteger(number) || number <= 0) {
      showError('内容不完整', '请填写 issue/PR 的编号');
      return;
    }
    if (!t) {
      showError('内容不完整', '请填写 issue/PR 标题');
      return;
    }
    setSubmittingArk(true);
    try {
      const res = await client.groupFeedback.submitIssueArk.mutate({
        groupId,
        number,
        kind: manual ? manualKind : (selectedIssue?.kind ?? 'issue'),
        title: t,
      });
      if (!res.ok) {
        pushToast({
          tone: 'error',
          title:
            res.reason === 'offline-mode'
              ? '完全离线模式已开启'
              : res.reason === 'offline'
                ? 'QQ 未在线'
                : '发送失败',
          detail: res.message,
        });
        return;
      }
      pushToast({ tone: 'success', title: '卡片已发送到群聊' });
      onClose();
    } catch (e) {
      pushToast({ tone: 'error', title: '发送失败', detail: errMsg(e) });
    } finally {
      setSubmittingArk(false);
    }
  };

  const groupAvatar = `https://p.qlogo.cn/gh/${groupId}/${groupId}/0`;

  return (
    <Modal onClose={onClose} width={560}>
      <div className="weq-group-bug">
        {/* 头部：banner + 群名 */}
        <div
          className="weq-group-bug-banner"
          style={{
            backgroundImage: `linear-gradient(to bottom, rgba(16, 20, 26, 0.18) 35%, rgba(16, 20, 26, 0.78) 100%), url(${resolvedTheme === 'dark' ? bugBannerDark : bugBanner})`,
          }}
        >
          <button
            type="button"
            className="weq-group-bug-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
          >
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
          <div className="weq-group-bug-banner-text">
            <strong>
              <Bug size={15} aria-hidden />
              反馈 Bug
            </strong>
            <span>
              发送到 <b>{groupName}</b> · 帮助 WeQ 变得更好
            </span>
          </div>
        </div>

        {/* 模式切换 */}
        <div className="weq-group-bug-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'new'}
            className={mode === 'new' ? 'is-on' : ''}
            onClick={() => setMode('new')}
          >
            <PencilLine size={14} aria-hidden />
            提出新 Bug
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'existing'}
            className={mode === 'existing' ? 'is-on' : ''}
            onClick={() => setMode('existing')}
          >
            <Github size={14} aria-hidden />
            已有 Issue / PR
          </button>
        </div>

        {mode === 'new' ? (
          <div className="weq-group-bug-body">
            <div className="weq-group-bug-title-row">
              <input
                className="weq-group-bug-title"
                value={title}
                placeholder="一句话标题，例如：导出聊天记录时闪退"
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="反馈标题"
              />
              <button
                type="button"
                className="weq-group-bug-btn weq-group-bug-btn-soft"
                onClick={resetTemplate}
                title="重新填入模板"
              >
                <RefreshCw size={12} aria-hidden />
                填入模板
              </button>
            </div>

            <div className="weq-group-bug-editor">
              <div className="weq-group-bug-editor-tabs">
                <button
                  type="button"
                  className={!preview ? 'is-on' : ''}
                  onClick={() => setPreview(false)}
                >
                  <PencilLine size={12} aria-hidden />
                  编辑
                </button>
                <button
                  type="button"
                  className={preview ? 'is-on' : ''}
                  onClick={() => setPreview(true)}
                >
                  <Eye size={12} aria-hidden />
                  预览
                </button>
              </div>
              {preview ? (
                <div className="weq-group-bug-preview weq-help-md">
                  <Streamdown
                    remarkPlugins={REMARK_PLUGINS}
                    plugins={PLUGINS}
                    parseIncompleteMarkdown={false}
                  >
                    {body || '（还没有内容，点「填入模板」开始）'}
                  </Streamdown>
                </div>
              ) : (
                <textarea
                  className="weq-group-bug-textarea"
                  value={body}
                  spellCheck={false}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="支持 GitHub 风格 Markdown：# 标题、- 列表、`代码`、```代码块```"
                  aria-label="反馈正文 Markdown"
                />
              )}
            </div>

            <div className="weq-group-bug-send-row">
              <p className="weq-group-bug-hint">
                <MessageCircle size={12} aria-hidden />
                正文与两份最新日志将打包成闪传文件发送，消息先到、文件后台上传。
              </p>
              <button
                type="button"
                className="weq-group-bug-btn weq-group-bug-btn-primary"
                disabled={submittingFlash}
                onClick={() => void submitNewBug()}
              >
                {submittingFlash ? (
                  <Loader2 size={14} className="weq-group-bug-spin" aria-hidden />
                ) : (
                  <Send size={14} aria-hidden />
                )}
                {submittingFlash ? '正在发送…' : '发送到群聊'}
              </button>
            </div>
          </div>
        ) : (
          <div className="weq-group-bug-body">
            {/* 选择器 / 手动输入 */}
            <div className="weq-group-bug-issues">
              <div className="weq-group-bug-issues-head">
                <span>选择仓库里已有的 issue / PR</span>
                <div className="weq-group-bug-issues-actions">
                  <button
                    type="button"
                    className="weq-group-bug-btn weq-group-bug-btn-soft"
                    disabled={issuesLoading}
                    onClick={() => void loadIssues()}
                  >
                    {issuesLoading ? (
                      <Loader2 size={12} className="weq-group-bug-spin" aria-hidden />
                    ) : (
                      <RefreshCw size={12} aria-hidden />
                    )}
                    {issues ? '刷新列表' : '加载列表'}
                  </button>
                  <button
                    type="button"
                    className={`weq-group-bug-btn weq-group-bug-btn-soft${manualMode ? ' is-on' : ''}`}
                    onClick={() => setManualMode((m) => !m)}
                  >
                    <PencilLine size={12} aria-hidden />
                    手动输入
                  </button>
                </div>
              </div>

              {issuesError ? (
                <div className="weq-group-bug-issues-error">
                  <span>GitHub 连不上（{issuesError}），改为手动输入：</span>
                </div>
              ) : null}

              {!manualMode && issues !== null && issues.length > 0 ? (
                <IconPicker
                  width="min(440px, 100%)"
                  maxHeight={280}
                  ariaLabel="选择 issue/PR"
                  triggerIcon={selectedIssue ? kindIcon(selectedIssue.kind) : kindIcon('issue')}
                  value={String(selectedNumber ?? '')}
                  onChange={(v) => setSelectedNumber(Number(v))}
                  options={issues.map((it) => ({
                    value: String(it.number),
                    label: `#${it.number} · ${it.title}`,
                    icon: kindIcon(it.kind),
                  }))}
                />
              ) : null}

              {manualMode || issues === null || issues.length === 0 ? (
                <div className="weq-group-bug-manual">
                  <div className="weq-group-bug-manual-kind">
                    <button
                      type="button"
                      className={`weq-group-bug-kind${manualKind === 'issue' ? ' is-on' : ''}`}
                      onClick={() => setManualKind('issue')}
                    >
                      <CircleAlert size={13} aria-hidden />
                      Issue
                    </button>
                    <button
                      type="button"
                      className={`weq-group-bug-kind${manualKind === 'pr' ? ' is-on' : ''}`}
                      onClick={() => setManualKind('pr')}
                    >
                      <GitPullRequest size={13} aria-hidden />
                      PR
                    </button>
                  </div>
                  <input
                    className="weq-group-bug-title"
                    value={manualNumber}
                    placeholder="编号，例如 123"
                    inputMode="numeric"
                    onChange={(e) => setManualNumber(e.target.value.replace(/\D/g, ''))}
                    aria-label="issue/PR 编号"
                  />
                  <input
                    className="weq-group-bug-title"
                    value={manualTitle}
                    placeholder="标题（GitHub 上显示的标题）"
                    maxLength={200}
                    onChange={(e) => setManualTitle(e.target.value)}
                    aria-label="issue/PR 标题"
                  />
                </div>
              ) : null}

              {/* 卡片预览 */}
              <div className="weq-group-bug-card">
                <img
                  className="weq-group-bug-card-preview"
                  src={groupAvatar}
                  alt="群头像"
                  referrerPolicy="no-referrer"
                />
                <div className="weq-group-bug-card-main">
                  <strong>
                    {manualMode || !selectedIssue
                      ? `${manualKind === 'pr' ? 'PR' : 'Issue'} #${manualNumber || '?'}`
                      : `${selectedIssue.kind === 'pr' ? 'PR' : 'Issue'} #${selectedIssue.number}`}
                  </strong>
                  <span>
                    {manualMode || !selectedIssue ? manualTitle || '标题' : selectedIssue.title}
                  </span>
                  <small>
                    <Github size={11} aria-hidden />
                    发送到 {groupName}
                  </small>
                </div>
              </div>
            </div>

            <div className="weq-group-bug-send-row">
              <p className="weq-group-bug-hint">
                <Github size={12} aria-hidden />
                以图文卡片形式发到群里，点击即可打开对应页面。
              </p>
              <button
                type="button"
                className="weq-group-bug-btn weq-group-bug-btn-primary"
                disabled={submittingArk}
                onClick={() => void submitIssueArk()}
              >
                {submittingArk ? (
                  <Loader2 size={14} className="weq-group-bug-spin" aria-hidden />
                ) : (
                  <Send size={14} aria-hidden />
                )}
                {submittingArk ? '正在发送…' : '发送到群聊'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
