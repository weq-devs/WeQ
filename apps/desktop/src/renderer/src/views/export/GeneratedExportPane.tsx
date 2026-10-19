import { useMemo, useState } from 'react';
import { Download, RotateCw, Search } from 'lucide-react';
import type { ExportSavePolicy, GeneratedContentTarget } from '@weq/service';
import { client, trpc } from '../../trpc/client';
import { WindowedList } from '../../components/WindowedList';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { useTabActive } from '../../components/RetainedTabs';
import {
  generatedContentContainer,
  generatedContentIdentity,
  type ContentSelection,
} from '../../../../shared/content_selection';
import { BACKEND_FORMATS, type BackendFormat } from './types';
import '../../styles/generated-export.css';

const FORMATS: BackendFormat[] = [...BACKEND_FORMATS];
export function GeneratedExportPane({
  initialSelection,
  prepareSave,
  isCurrent,
  onStarted,
}: {
  initialSelection?: ContentSelection;
  prepareSave: () => Promise<ExportSavePolicy | null>;
  isCurrent: () => boolean;
  onStarted: () => void;
}) {
  const active = useTabActive();
  const account = trpc.account.getAccountConfig.useQuery();
  const binding = {
    expectedAccountUin: account.data?.uin ?? '',
    expectedAccountConfigId: account.data?.configId ?? '',
  };
  const ready = Boolean(binding.expectedAccountUin && binding.expectedAccountConfigId);
  const [target, setTarget] = useState<GeneratedContentTarget | null>(() =>
    generatedContentIdentity(initialSelection),
  );
  const [scopes, setScopes] = useState<Record<string, string[]>>(() => {
    const identity = generatedContentIdentity(initialSelection);
    return identity && initialSelection?.scope.type === 'items'
      ? { [generatedContentContainer(identity)]: [...new Set(initialSelection.scope.ids)] }
      : {};
  });
  const [keyword, setKeyword] = useState('');
  const [formats, setFormats] = useState(new Set<BackendFormat>(['json']));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sessions = trpc.account.generatedConversations.useQuery(binding, {
    enabled: active && ready,
  });
  const content = trpc.account.generatedConversation.useQuery(
    { ...binding, target: target ?? { kind: 'assistant', ownerId: 'assistant', sessionId: '_' } },
    { enabled: active && ready && Boolean(target), staleTime: 0 },
  );
  const key = target ? generatedContentContainer(target) : '';
  const ids = scopes[key];
  const rows = content.data?.messages ?? [];
  const selected = new Set(ids ?? []);
  const messageMulti = useMultiSelection({
    ids: rows.map((row) => row.id),
    selected,
    onChange: (next) => setScopes((current) => ({ ...current, [key]: [...next] })),
    disabled: !target || ids === undefined || busy,
  });
  const formatMulti = useMultiSelection({
    ids: FORMATS,
    selected: formats,
    onChange: setFormats,
    disabled: busy,
  });
  const visible = useMemo(
    () =>
      (sessions.data ?? []).filter((session) =>
        `${session.title} ${session.sessionTitle}`
          .toLocaleLowerCase()
          .includes(keyword.trim().toLocaleLowerCase()),
      ),
    [sessions.data, keyword],
  );
  const missing =
    !content.data || content.isFetching
      ? []
      : (ids?.filter((id) => !rows.some((row) => row.id === id)) ?? []);
  async function submit() {
    if (
      !target ||
      !ready ||
      busy ||
      !formats.size ||
      ids?.length === 0 ||
      missing.length ||
      !content.data
    )
      return;
    const frozen = {
      ...binding,
      target: { ...target },
      messageIds: ids === undefined ? undefined : [...ids],
      formats: [...formats],
    };
    setBusy(true);
    setError('');
    try {
      const savePolicy = await prepareSave();
      if (!savePolicy || !isCurrent()) return;
      await client.account.startGeneratedExport.mutate({ ...frozen, savePolicy });
      if (isCurrent()) onStarted();
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="weq-generated-export" aria-label="本地生成对话导出">
      <div className="weq-generated-export-body">
        <div className="weq-generated-export-sessions">
          <label className="weq-message-scope-search">
            <Search size={15} />
            <input
              aria-label="查找生成对话"
              placeholder="查找对话"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>
          {sessions.isError || account.isError ? (
            <div role="alert">
              对话列表读取失败
              <button
                type="button"
                title="重试读取生成对话"
                aria-label="重试读取生成对话"
                onClick={() => {
                  void account.refetch();
                  void sessions.refetch();
                }}
              >
                <RotateCw size={14} />
              </button>
            </div>
          ) : null}
          {sessions.isLoading && ready ? <p role="status">加载对话…</p> : null}
          <WindowedList
            items={visible}
            height={320}
            rowHeight={64}
            itemKey={generatedContentContainer}
            label="生成对话列表"
            scrollToKey={key}
            resetKey={keyword}
            renderItem={(session) => (
              <button
                type="button"
                className="weq-generated-export-row"
                disabled={busy}
                aria-pressed={generatedContentContainer(session) === key}
                onClick={() =>
                  setTarget({
                    kind: session.kind,
                    ownerId: session.ownerId,
                    sessionId: session.sessionId,
                  })
                }
              >
                <strong>{session.title}</strong>
                <span>
                  {session.sessionTitle} · {session.count} 条
                </span>
              </button>
            )}
          />
          {!sessions.isLoading && !sessions.isError && !visible.length ? (
            <p>没有本地生成对话</p>
          ) : null}
        </div>
        <div className="weq-generated-export-messages" {...messageMulti.rootProps}>
          {!target ? (
            <p>请选择对话</p>
          ) : content.isError ? (
            <div role="alert">
              记录读取失败，原选择保留
              <button
                type="button"
                title="重试读取生成记录"
                aria-label="重试读取生成记录"
                onClick={() => void content.refetch()}
              >
                <RotateCw size={14} />
              </button>
            </div>
          ) : (
            <>
              <header className="weq-generated-export-range">
                <label className="weq-message-scope-mode">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={ids !== undefined}
                    onChange={(event) =>
                      setScopes((current) => {
                        const next = { ...current };
                        if (event.target.checked) next[key] = [];
                        else delete next[key];
                        return next;
                      })
                    }
                  />
                  <span>
                    {ids === undefined ? '整场持久对话' : `精确选中 ${ids.length} 条消息`}
                  </span>
                </label>
                <button
                  type="button"
                  className="weq-set-iconbtn"
                  title="刷新生成记录"
                  aria-label="刷新生成记录"
                  disabled={busy || content.isFetching}
                  onClick={() => void content.refetch()}
                >
                  <RotateCw size={15} />
                </button>
              </header>
              {content.isFetching ? <p role="status">读取记录…</p> : null}
              <WindowedList
                items={rows}
                height={320}
                rowHeight={64}
                itemKey={(row) => row.id}
                resetKey={key}
                scrollToKey={messageMulti.focusRequest?.id}
                scrollRevision={messageMulti.focusRequest?.revision}
                label="生成消息范围"
                renderItem={(row) => (
                  <label className="weq-generated-export-row" {...messageMulti.itemProps(row.id)}>
                    <input
                      type="checkbox"
                      disabled={ids === undefined || busy}
                      checked={selected.has(row.id)}
                      readOnly
                    />
                    <span>
                      <strong title={row.senderId}>
                        {row.role === 'user' || row.senderKind === 'user'
                          ? '我'
                          : row.role === 'assistant' || row.senderKind === 'persona'
                            ? target.kind === 'assistant'
                              ? '助手'
                              : '克隆体'
                            : '记录'}
                      </strong>
                      <span title={row.text}>{row.text || '[空正文]'}</span>
                    </span>
                  </label>
                )}
              />
              {missing.length ? (
                <p role="alert">
                  {missing.length} 条已选记录不存在或尚未持久化，请刷新或重新选择。
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <footer className="weq-generated-export-foot">
        <div role="group" aria-label="生成对话导出格式" {...formatMulti.rootProps}>
          {FORMATS.map((format) => (
            <label key={format} {...formatMulti.itemProps(format)}>
              <input type="checkbox" readOnly checked={formats.has(format)} disabled={busy} />
              {format.toUpperCase()}
            </label>
          ))}
        </div>
        <button
          type="button"
          className="weq-exp-primary"
          disabled={
            !ready ||
            !target ||
            !content.data ||
            content.isFetching ||
            content.isError ||
            busy ||
            !formats.size ||
            ids?.length === 0 ||
            missing.length > 0
          }
          onClick={() => void submit()}
        >
          <Download size={15} />
          {busy ? '准备中…' : '导出生成对话'}
        </button>
      </footer>
    </section>
  );
}
