/**
 * 设置 → 帮助 → 反馈 bug。
 *
 * 顶部 banner（bug_banner.png，底部渐变模糊）；中间是反馈前须知、数据库
 * hexdump 工具（前 200 字节 + 复制）、标题 + Markdown 正文（编辑/预览，GitHub
 * 式模板：清单 + 系统版本 + weq 版本 + 错误描述 + 预期描述）。
 *
 * 底部三个出口：
 *   1. 打开 GitHub issue 页面（带标题与正文预填）
 *   2. 用本地 gh 直接创建 issue（正文末尾自动附上两份最新日志）
 *   3. 打包到缓存目录的新建文件夹 + 打开目录 + QQ 深链接
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Database,
  ExternalLink,
  Eye,
  FileCode2,
  Github,
  Info,
  Loader2,
  MessageCircle,
  PencilLine,
  RefreshCw,
  Send,
  Terminal,
} from 'lucide-react';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { trpc, client } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { shikiCodeHighlighter } from '../../views/agentlab/shikiHighlighter';
import { IconPicker } from '../ui/iconPicker';
import bugBanner from '@resources/brand/bug_banner.png';

const REMARK_PLUGINS = [remarkGfm];
const PLUGINS = { code: shikiCodeHighlighter };

const REPO = 'H3CoF6/WeQ';
const REPO_ISSUES = `https://github.com/${REPO}/issues`;
const QQ_DEEP_LINK =
  'tencent://ntqq-open/?subCmd=flashTransfer&action=openTransPage&actionParams={"fileSetId":"","allChecked":"","selectedItems":"","sourceType":"share"}';

interface HexdumpView {
  path: string;
  name: string;
  raw: string;
  lines: Array<{ offset: string; hex: string; ascii: string }>;
  totalBytes: number;
}

/** 模板标记 → 对应正文里的 checkbox 文案。 */
const CHECKBOX_MARKS: ReadonlyArray<{
  key: 'isBug' | 'knowCause' | 'willingPr';
  label: string;
  hint: string;
}> = [
  {
    key: 'isBug',
    label: '我反馈的是一个 bug',
    hint: 'feature 意见请删除本模板，前往 issue 或 QQ 群交流',
  },
  { key: 'knowCause', label: '我知道错误的原因', hint: '' },
  { key: 'willingPr', label: '我愿意 PR 修复', hint: '' },
];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** 翻转正文里 `- [ ]/- [x] 文案` 这一行。 */
function toggleCheckboxInBody(body: string, label: string, checked: boolean): string {
  const pattern = new RegExp(
    `^- \\[( |x)\\] ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`,
    'gm',
  );
  const mark = checked ? 'x' : ' ';
  if (pattern.test(body)) {
    return body.replace(pattern, `- [${mark}] ${label}`);
  }
  return `${body.trimEnd()}\n- [${mark}] ${label}\n`;
}

export function BugReportPanel(): ReactElement {
  const pushToast = useToast((s) => s.push);
  const showError = useDialog((s) => s.showError);
  const confirm = useDialog((s) => s.confirm);

  const version = trpc.bootstrap.getVersionInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const system = trpc.bootstrap.systemInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const ghStatus = trpc.help.ghStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const databases = trpc.account.dbExplorer.listDatabases.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [checks, setChecks] = useState({ isBug: true, knowCause: false, willingPr: false });
  const [hexdump, setHexdump] = useState<HexdumpView | null>(null);
  const [hexBusy, setHexBusy] = useState(false);
  const [copiedHex, setCopiedHex] = useState(false);
  const [submitting, setSubmitting] = useState<'gh' | 'qq' | null>(null);
  const templateFilledRef = useRef(false);

  const appVersion = version.data?.app ?? '';
  const platform = system.data?.platformKind ?? '';

  /** 生成 GitHub 式模板。 */
  const buildTemplate = useCallback((): string => {
    const platformHint =
      platform === 'win32'
        ? 'Windows 11 23H2'
        : platform === 'linux'
          ? 'Ubuntu 24.04 / 其它发行版'
          : platform === 'darwin'
            ? 'macOS 15'
            : '操作系统 + 版本';
    return [
      '- [x] 我反馈的是一个 bug（feature 意见请删除本模板，前往 issue 或 QQ 群交流）',
      '- [ ] 我知道错误的原因',
      '- [ ] 我愿意 PR 修复',
      '',
      '## 系统版本',
      platformHint,
      '',
      '## weq 版本',
      appVersion || '<填写设置 → 全局设置 显示的版本号>',
      '',
      '## 错误的功能描述',
      '<在这里描述发生了什么，附上报错文本 / 日志 / 截图>',
      '',
      '## 预期的功能描述',
      '<在这里描述期望的行为>',
      '',
    ].join('\n');
  }, [platform, appVersion]);

  // 首次进入自动填入模板（等版本信息就绪后）
  useEffect(() => {
    if (templateFilledRef.current || body) return;
    if (version.isLoading) return;
    templateFilledRef.current = true;
    setBody(buildTemplate());
  }, [buildTemplate, body, version.isLoading]);

  /** 顶部 banner 的底部渐变模糊。 */
  const bannerStyle = useMemo(
    () => ({
      backgroundImage: `linear-gradient(to bottom, rgba(16, 20, 26, 0.12) 30%, rgba(16, 20, 26, 0.72) 100%), url(${bugBanner})`,
    }),
    [],
  );

  const toggleCheck = (key: 'isBug' | 'knowCause' | 'willingPr', next: boolean): void => {
    setChecks((prev) => ({ ...prev, [key]: next }));
    const meta = CHECKBOX_MARKS.find((m) => m.key === key);
    if (meta) setBody((b) => toggleCheckboxInBody(b, meta.label, next));
  };

  const resetTemplate = (): void => {
    setChecks({ isBug: true, knowCause: false, willingPr: false });
    setBody(buildTemplate());
    pushToast({ tone: 'info', title: '已填入反馈模板' });
  };

  const loadHexdump = async (path: string): Promise<void> => {
    if (!path || hexBusy) return;
    setHexBusy(true);
    try {
      const res = await client.help.readDbHexdump.query({ path });
      setHexdump({
        path: res.path,
        name: res.name,
        raw: res.raw,
        lines: res.lines,
        totalBytes: res.totalBytes,
      });
      pushToast({
        tone: 'info',
        title: `已读取 ${res.name}`,
        detail: `前 200 字节 · 文件共 ${res.totalBytes} 字节`,
      });
    } catch (e) {
      showError('读取 hexdump 失败', errMsg(e));
    } finally {
      setHexBusy(false);
    }
  };

  const copyHex = async (): Promise<void> => {
    if (!hexdump) return;
    try {
      await navigator.clipboard.writeText(hexdump.raw);
      setCopiedHex(true);
      pushToast({ tone: 'success', title: 'hexdump 已复制到剪贴板' });
      window.setTimeout(() => setCopiedHex(false), 1500);
    } catch (e) {
      showError('复制失败', errMsg(e));
    }
  };

  const requireContent = (): { ok: boolean; title: string; body: string; error?: string } => {
    const t = title.trim();
    const b = body.trim();
    if (!t) return { ok: false, title: t, body: b, error: '请先填写标题' };
    if (!b) return { ok: false, title: t, body: b, error: '请先填写反馈内容' };
    return { ok: true, title: t, body: b };
  };

  /** 出口 1：打开 GitHub issue 页面（有标题/正文则预填，不强制填写）。 */
  const openGithubPage = async (): Promise<void> => {
    const params = new URLSearchParams();
    const t = title.trim();
    const b = body.trim();
    if (t) params.set('title', t);
    if (b) params.set('body', b);
    const query = params.toString();
    const url = query ? `${REPO_ISSUES}/new?${query}` : REPO_ISSUES;
    const res = await client.help.openExternal.mutate({ url });
    if (!res.ok) {
      pushToast({ tone: 'error', title: '打开 GitHub 失败', detail: res.error });
    } else {
      pushToast({
        tone: 'info',
        title: '已在浏览器打开 GitHub issue 页面',
        detail: '粘贴后请补充日志 / 截图后提交。',
      });
    }
  };

  /** 出口 2：用本地 gh 直接创建 issue。 */
  const submitViaGh = async (): Promise<void> => {
    const c = requireContent();
    if (!c.ok) {
      showError('内容不完整', c.error ?? '');
      return;
    }
    setSubmitting('gh');
    try {
      const status = await client.help.ghStatus.query();
      if (!status.available) {
        showError('未安装 GitHub CLI', status.error ?? '请先安装 gh 并登录。');
        return;
      }
      if (!status.authenticated) {
        const ok = await confirm(
          'GitHub CLI 未登录',
          status.error ?? '请先运行 gh auth login 完成登录，再重试。',
          {
            okLabel: '打开登录指引',
            cancelLabel: '取消',
            tone: 'warning',
          },
        );
        if (ok) {
          await client.help.openExternal.mutate({ url: 'https://cli.github.com/' });
        }
        return;
      }
      const ok = await confirm(
        '提交 GitHub Issue',
        '将通过 gh 直接创建 issue，正文末尾会自动附带两份最新日志。确认提交？',
        { okLabel: '提交', cancelLabel: '取消', tone: 'info' },
      );
      if (!ok) return;
      const res = await client.help.submitGithubIssue.mutate({ title: c.title, body: c.body });
      if (!res.ok) {
        pushToast({
          tone: 'error',
          title: '提交 issue 失败',
          detail: res.error,
        });
        return;
      }
      pushToast({
        tone: 'success',
        title: 'issue 已创建',
        detail: res.url ?? REPO_ISSUES,
      });
    } catch (e) {
      pushToast({ tone: 'error', title: '提交 issue 失败', detail: errMsg(e) });
    } finally {
      setSubmitting(null);
    }
  };

  /** 出口 3：打包到缓存目录 + 打开目录 + QQ 深链接。 */
  const submitViaQqGroup = async (): Promise<void> => {
    const c = requireContent();
    if (!c.ok) {
      showError('内容不完整', c.error ?? '');
      return;
    }
    setSubmitting('qq');
    try {
      const res = await client.help.bundleFeedback.mutate({ title: c.title, body: c.body });
      if (!res.ok) {
        pushToast({ tone: 'error', title: '打包反馈文件失败', detail: res.errors?.join('\n') });
        return;
      }
      const folderRes = await client.help.openFolder.mutate({ path: res.folder ?? '' });
      const linkRes = await client.help.openExternal.mutate({ url: QQ_DEEP_LINK });
      const parts: string[] = [];
      if (res.errors && res.errors.length > 0)
        parts.push(`部分文件未打包：${res.errors.join('；')}`);
      if (!folderRes.ok) parts.push(`打开目录失败：${folderRes.error}`);
      if (!linkRes.ok) parts.push(`唤起 QQ 失败：${linkRes.error}`);
      pushToast({
        tone: 'info',
        title: '已打包并打开反馈目录',
        detail: res.folder + (parts.length > 0 ? `\n${parts.join('\n')}` : ''),
      });
    } catch (e) {
      pushToast({ tone: 'error', title: '反馈打包失败', detail: errMsg(e) });
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="weq-help-bug">
      {/* 顶部 banner：底部渐变模糊 */}
      <div className="weq-help-bug-banner" style={bannerStyle}>
        <div className="weq-help-bug-banner-mask" aria-hidden />
        <div className="weq-help-bug-banner-text">
          <strong>反馈 Bug</strong>
          <span>你的反馈会让 WeQ 变得更好</span>
        </div>
      </div>

      {/* 反馈前须知 */}
      <section className="weq-help-bug-card">
        <div className="weq-help-bug-card-head">
          <Info size={14} aria-hidden />
          反馈前请确认
        </div>
        <ul className="weq-help-bug-tips">
          <li>
            <Github size={13} aria-hidden />
            功能建议请前往{' '}
            <button
              type="button"
              className="weq-help-inline"
              onClick={() => void client.help.openExternal.mutate({ url: REPO_ISSUES })}
            >
              GitHub issue
            </button>{' '}
            或 QQ 群交流。
          </li>
          <li>
            <AlertTriangle size={13} aria-hidden />
            反馈前务必完整阅读 {REPO} 的全部 issue，保证没有重复。
          </li>
          <li>
            <Terminal size={13} aria-hidden />
            保证使用的是最新版本，或者最新代码的构建（<code>pnpm dev</code>）。
          </li>
          <li>
            <FileCode2 size={13} aria-hidden />
            提供当天的日志；UI 问题提供截图；密钥问题提供数据库头部 hexdump（见下方工具）。
          </li>
        </ul>
      </section>

      {/* hexdump 工具 */}
      <section className="weq-help-bug-card">
        <div className="weq-help-bug-card-head">
          <Database size={14} aria-hidden />
          数据库头部 hexdump（前 200 字节）
        </div>
        <p className="weq-help-bug-sub">
          密钥 / 解密相关问题时，直接选当前账号的数据库，把头部（前 200 字节）导出出来贴进
          issue，方便排查。
        </p>
        <div className="weq-help-bug-hex-tools">
          <div className="weq-help-bug-hex-select">
            <IconPicker
              width="100%"
              maxHeight={220}
              disabled={databases.isLoading || hexBusy}
              triggerIcon={<Database size={13} aria-hidden />}
              ariaLabel="选择当前账号的数据库"
              placeholder={
                databases.isLoading
                  ? '正在读取当前账号数据库…'
                  : databases.isError
                    ? '需要先打开账号'
                    : (databases.data?.length ?? 0) === 0
                      ? '当前账号暂无数据库'
                      : '选择当前账号的数据库'
              }
              value={hexdump?.path ?? ''}
              onChange={(v) => void loadHexdump(v)}
              options={(databases.data ?? []).map((db) => ({
                value: db.path,
                label: db.name,
                detail: fmtBytes(db.bytes),
                icon: <Database size={13} aria-hidden />,
              }))}
            />
          </div>
          {hexdump ? (
            <button
              type="button"
              className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
              onClick={() => void copyHex()}
            >
              {copiedHex ? (
                <Check size={12} className="weq-set-ok" aria-hidden />
              ) : (
                <Copy size={12} aria-hidden />
              )}
              {copiedHex ? '已复制' : '复制 hexdump'}
            </button>
          ) : null}
        </div>
        {hexdump ? (
          <div className="weq-help-bug-hex">
            <div className="weq-help-bug-hex-head">
              <span>{hexdump.name} · 前 200 字节</span>
              <span>共 {hexdump.totalBytes} 字节</span>
            </div>
            <pre className="weq-help-bug-hex-body">{hexdump.raw}</pre>
          </div>
        ) : null}
      </section>

      {/* 标题 + Markdown 正文 */}
      <section className="weq-help-bug-card">
        <div className="weq-help-bug-card-head">
          <PencilLine size={14} aria-hidden />
          反馈内容（GitHub 式 Markdown）
        </div>
        <div className="weq-help-bug-title-row">
          <input
            className="weq-help-bug-title"
            value={title}
            placeholder="一句话标题，例如：导出聊天记录时闪退"
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="反馈标题"
          />
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={resetTemplate}
            title="重新填入模板"
          >
            <RefreshCw size={12} aria-hidden />
            填入模板
          </button>
        </div>

        {/* 检查清单（与正文中的 checkbox 双向同步） */}
        <div className="weq-help-bug-checks">
          {CHECKBOX_MARKS.map((meta) => (
            <button
              key={meta.key}
              type="button"
              className={`weq-set-chk${checks[meta.key] ? ' is-on' : ''}`}
              role="checkbox"
              aria-checked={checks[meta.key]}
              onClick={() => toggleCheck(meta.key, !checks[meta.key])}
              title={meta.hint || undefined}
            >
              <span className="weq-set-chk-box" aria-hidden />
              <span className="weq-set-chk-label">{meta.label}</span>
            </button>
          ))}
        </div>

        <div className="weq-help-bug-editor">
          <div className="weq-help-bug-editor-tabs">
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
            <div className="weq-help-bug-preview weq-help-md">
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
              className="weq-help-bug-textarea"
              value={body}
              spellCheck={false}
              onChange={(e) => setBody(e.target.value)}
              placeholder="支持 GitHub 风格 Markdown：# 标题、- 列表、`代码`、```代码块```"
              aria-label="反馈正文 Markdown"
            />
          )}
        </div>
      </section>

      {/* 三个出口 */}
      <section className="weq-help-bug-card">
        <div className="weq-help-bug-card-head">
          <Send size={14} aria-hidden />
          提交方式
        </div>
        <div className="weq-help-bug-actions">
          <button
            type="button"
            className="weq-help-bug-action"
            onClick={() => void openGithubPage()}
          >
            <span className="weq-help-bug-action-ico is-gh">
              <Github size={16} aria-hidden />
            </span>
            <span>
              <strong>打开 GitHub issue 页面</strong>
              <small>标题与正文已预填，浏览器确认后提交</small>
            </span>
          </button>
          <button
            type="button"
            className="weq-help-bug-action"
            disabled={submitting !== null}
            onClick={() => void submitViaGh()}
          >
            <span className="weq-help-bug-action-ico is-cli">
              {submitting === 'gh' ? (
                <Loader2 size={16} className="weq-help-log-spin" aria-hidden />
              ) : (
                <Terminal size={16} aria-hidden />
              )}
            </span>
            <span>
              <strong>用 gh 直接发起 issue</strong>
              <small>
                {ghStatus.data?.available
                  ? ghStatus.data.authenticated
                    ? '本地 GitHub CLI 可用，正文自动附带两份最新日志'
                    : 'GitHub CLI 未登录，提交前需 gh auth login'
                  : '未检测到 gh，安装 GitHub CLI 后可用'}
              </small>
            </span>
          </button>
          <button
            type="button"
            className="weq-help-bug-action"
            disabled={submitting !== null}
            onClick={() => void submitViaQqGroup()}
          >
            <span className="weq-help-bug-action-ico is-qq">
              {submitting === 'qq' ? (
                <Loader2 size={16} className="weq-help-log-spin" aria-hidden />
              ) : (
                <MessageCircle size={16} aria-hidden />
              )}
            </span>
            <span>
              <strong>在 QQ 群提出</strong>
              <small>正文与两份最新日志打包到缓存目录并打开</small>
            </span>
          </button>
        </div>
      </section>

      <p className="weq-help-bug-foot">
        <ExternalLink size={11} aria-hidden />
        提交前请再次确认没有重复 issue，且附上了当天的日志。
      </p>
    </div>
  );
}
