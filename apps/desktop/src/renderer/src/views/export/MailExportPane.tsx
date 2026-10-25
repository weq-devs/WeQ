import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Search, X } from 'lucide-react';
import type { ExportOutputPlan, ExportSavePolicy } from '@weq/service';
import type { MailSummary } from '@weq/service/mail';
import type { ContentSelection } from '../../../../shared/content_selection';
import { client, trpc } from '../../trpc/client';
import { ExportSaveActions } from '../../components/ExportSaveActions';
import { useToast } from '../../components/Toast';
import { WindowedList } from '../../components/WindowedList';
import { formatMailTime } from '../mail/content';
import '../../styles/mail-export.css';

export function MailExportPane({
  initialSelection,
  prepareSave,
  isCurrent,
  onStarted,
  disabled = false,
}: {
  initialSelection?: ContentSelection;
  prepareSave: (
    intent?: ExportSavePolicy,
    output?: ExportOutputPlan,
  ) => Promise<ExportSavePolicy | null>;
  isCurrent: () => boolean;
  onStarted: () => void;
  disabled?: boolean;
}) {
  const account = trpc.account.getAccountConfig.useQuery();
  const [selectedIds] = useState(() =>
    initialSelection?.owner.kind === 'mail-messages' && initialSelection.scope.type === 'items'
      ? [...new Set(initialSelection.scope.ids)]
      : null,
  );
  const [all, setAll] = useState(selectedIds === null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [sender, setSender] = useState('');
  const [subject, setSubject] = useState('');
  const [preview, setPreview] = useState<{ key: string; items: MailSummary[] } | null>(null);
  const [querying, setQuerying] = useState(false);
  const queryRequest = useRef<string | null>(null);
  // 日期统一按北京时间解释；结束日期包含当天。
  const startTime = start ? Date.parse(`${start}T00:00:00+08:00`) / 1000 : undefined;
  const endTime = end ? Date.parse(`${end}T00:00:00+08:00`) / 1000 + 86400 : undefined;
  const validRange = startTime === undefined || endTime === undefined || startTime < endTime;
  const ready = Boolean(account.data?.uin && account.data.configId);
  const key = JSON.stringify([
    account.data?.uin,
    account.data?.configId,
    all,
    start,
    end,
    sender,
    subject,
  ]);
  const items = preview?.key === key ? preview.items : null;
  const selfUin = account.data?.uin;
  const cancelQuery = useCallback(() => {
    if (queryRequest.current && selfUin)
      void client.mail.cancel.mutate({ selfUin, requestId: queryRequest.current }).catch(() => {});
    queryRequest.current = null;
  }, [selfUin]);
  useEffect(() => {
    setPreview((previous) => (previous?.key === key ? previous : null));
    setQuerying(false);
    setError('');
    return cancelQuery;
  }, [key, cancelQuery]);
  const canQuery =
    !disabled && ready && !busy && !querying && validRange && (all || Boolean(selectedIds?.length));
  const canExport = canQuery && Boolean(items?.length);
  async function query() {
    if (!canQuery || queryRequest.current || !account.data) return;
    const requestId = crypto.randomUUID();
    queryRequest.current = requestId;
    setQuerying(true);
    setPreview(null);
    setError('');
    try {
      const rows = await client.mail.previewExport.mutate({
        selfUin: account.data.uin,
        expectedAccountConfigId: account.data.configId,
        requestId,
        ids: all ? null : selectedIds,
        filter: { startTime, endTime, sender: sender.trim(), subject: subject.trim() },
      });
      if (queryRequest.current === requestId && isCurrent()) setPreview({ key, items: rows });
    } catch (reason) {
      if (queryRequest.current === requestId && isCurrent())
        setError(reason instanceof Error ? reason.message : '待导出列表读取失败');
    } finally {
      if (queryRequest.current === requestId) {
        queryRequest.current = null;
        setQuerying(false);
      }
    }
  }
  async function submit(intent?: ExportSavePolicy) {
    if (!canExport || pending.current || !account.data || !items) return;
    const target = {
      selfUin: account.data.uin,
      expectedAccountConfigId: account.data.configId,
      ids: items.map((item) => item.id),
      expandThreads: false,
    };
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const savePolicy = await prepareSave(intent, {
        kind: 'bundle',
        name: `邮件导出-${items.length}封`,
      });
      if (!savePolicy || !isCurrent()) return;
      await client.mail.exportMessages.mutate({ ...target, savePolicy });
      if (isCurrent()) {
        useToast.getState().push({ tone: 'info', title: '邮件导出任务已创建' });
        onStarted();
      }
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : '邮件导出失败');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="weq-mail-export" aria-label="邮件导出范围">
      <div className="weq-exp-cats-list" role="radiogroup" aria-label="邮件范围">
        <label className="weq-message-scope-mode">
          <input type="radio" checked={all} disabled={busy} onChange={() => setAll(true)} />
          所有邮件
        </label>
        {selectedIds !== null ? (
          <label className="weq-message-scope-mode">
            <input type="radio" checked={!all} disabled={busy} onChange={() => setAll(false)} />
            已选 {selectedIds.length} 封邮件
          </label>
        ) : null}
      </div>
      <div className="weq-mail-export-filters">
        <label>
          开始日期（北京时间）
          <input
            type="date"
            value={start}
            disabled={busy}
            onChange={(event) => setStart(event.target.value)}
          />
        </label>
        <label>
          结束日期（含当天）
          <input
            type="date"
            value={end}
            disabled={busy}
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
        <label>
          发件人
          <input
            type="search"
            placeholder="姓名或邮箱"
            maxLength={254}
            value={sender}
            disabled={busy}
            onChange={(event) => setSender(event.target.value)}
          />
        </label>
        <label>
          主题
          <input
            type="search"
            placeholder="主题关键词"
            maxLength={1000}
            value={subject}
            disabled={busy}
            onChange={(event) => setSubject(event.target.value)}
          />
        </label>
      </div>
      {!validRange ? <p role="alert">结束日期不能早于开始日期</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="weq-mail-export-preview">
        <header>
          <strong role="status">
            {querying ? '正在查询邮件…' : items ? `待导出 ${items.length} 封邮件` : '待导出邮件'}
          </strong>
          {querying ? (
            <button
              type="button"
              title="取消查询"
              aria-label="取消查询"
              onClick={() => {
                cancelQuery();
                setQuerying(false);
              }}
            >
              <X size={15} />
            </button>
          ) : (
            <button type="button" disabled={!canQuery} onClick={() => void query()}>
              <Search size={15} />
              {items ? '重新查询' : '查询邮件'}
            </button>
          )}
        </header>
        {items ? (
          items.length ? (
            <WindowedList
              items={items}
              height={280}
              rowHeight={64}
              itemKey={(item) => item.id}
              label="待导出邮件列表"
              renderItem={(item) => (
                <article className="weq-mail-export-row">
                  <strong title={item.subject}>{item.subject || '无主题'}</strong>
                  <span title={`${item.sender.name} ${item.sender.email}`}>
                    {item.sender.name || item.sender.email}
                  </span>
                  <time>{formatMailTime(item.time)}</time>
                </article>
              )}
            />
          ) : (
            <p>没有符合条件的邮件</p>
          )
        ) : null}
      </div>
      <footer className="weq-exp-pane-foot">
        <span className="weq-exp-foot-hint">HTML 正文 · JSON 元数据 · 附件</span>
        <div className="weq-save-action-group">
          <button
            type="button"
            className="weq-exp-primary"
            disabled={!canExport}
            onClick={() => void submit()}
          >
            <Download size={15} />
            {busy ? '准备中…' : '导出邮件'}
          </button>
          <ExportSaveActions disabled={!canExport} onSelect={(intent) => void submit(intent)} />
        </div>
      </footer>
    </section>
  );
}
