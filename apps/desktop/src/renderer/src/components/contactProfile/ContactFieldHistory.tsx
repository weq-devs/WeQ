import { useContext, useId, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { History, X, RefreshCw } from 'lucide-react';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { client } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { Modal } from '../Dialog';
import { lazyPanel } from '../../lib/lazyPanel';
import { ContactFieldHistoryContext as Context } from '../../lib/contactFieldHistoryContext.shared';
import { fieldPhotoHistoryValue } from '../../lib/contactFieldPresentation';
import { CONTACT_HISTORY_DISPLAY_ENABLED } from '../../lib/contactHistoryVisibility';
import { ContactFieldHistoryBoundary } from '../../lib/contactFieldHistoryContext';
import { contactHistoryFieldForLabel } from './ContactFieldHistory.shared';

const FieldHistoryContent = lazyPanel<
  Parameters<typeof import('./FieldHistoryContent').FieldHistoryContent>[0]
>(
  () => import('./FieldHistoryContent').then((m) => ({ default: m.FieldHistoryContent })),
  'inline',
);

type FieldHistoryProviderProps = {
  entity: string;
  memberUid?: string;
  children: ReactNode;
};
export function ContactFieldHistoryProvider(props: FieldHistoryProviderProps) {
  return CONTACT_HISTORY_DISPLAY_ENABLED ? (
    <EnabledContactFieldHistoryProvider {...props} />
  ) : (
    <ContactFieldHistoryBoundary>{props.children}</ContactFieldHistoryBoundary>
  );
}
function EnabledContactFieldHistoryProvider({
  entity,
  memberUid,
  children,
}: FieldHistoryProviderProps) {
  const session = useQQWriteSession(`field-history:${entity}:${memberUid ?? ''}`, true);
  const active = useTabActive();
  const query = useQuery({
    queryKey: ['contact-field-summary', session.binding, entity, memberUid],
    queryFn: () =>
      client.account.contactMetrics.history.fieldSummary.query({
        ...session.binding!,
        entity,
        memberUid,
      }),
    enabled:
      active &&
      Boolean(session.binding) &&
      /^(friend|group):[\w-]+$/.test(entity) &&
      (!memberUid || /^u_[\w-]+$/.test(memberUid)),
    staleTime: 30000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (data) => (active ? (data?.pending ? 150 : 30000) : false),
  });
  return (
    <Context.Provider value={{ entity, memberUid, fields: query.data?.fields ?? [] }}>
      {children}
    </Context.Provider>
  );
}

export function ContactFieldHistoryButton(props: { field?: string; label: string }) {
  return CONTACT_HISTORY_DISPLAY_ENABLED ? <EnabledContactFieldHistoryButton {...props} /> : null;
}
function EnabledContactFieldHistoryButton({ field, label }: { field?: string; label: string }) {
  const context = useContext(Context);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const key = field ?? contactHistoryFieldForLabel[label];
  if (!context || !key || !context.fields.includes(key)) return null;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="weq-profile-field-history"
        title={`显示${label}历史`}
        aria-label={`显示${label}历史`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <History size={13} />
      </button>
      {open ? (
        <Context.Provider value={null}>
          <FieldHistoryDialog
            {...context}
            field={key}
            label={label}
            anchor={anchor.current}
            onClose={() => {
              setOpen(false);
              anchor.current?.focus({ preventScroll: true });
            }}
          />
        </Context.Provider>
      ) : null}
    </>
  );
}

function FieldHistoryDialog({
  entity,
  memberUid,
  field,
  label,
  anchor,
  onClose,
}: {
  entity: string;
  memberUid?: string;
  field: string;
  label: string;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const id = useId();
  const active = useTabActive();
  const session = useQQWriteSession(`field-versions:${entity}:${field}`, true);
  const query = useInfiniteQuery({
    queryKey: ['contact-field-versions', session.binding, entity, memberUid, field],
    queryFn: async ({ pageParam }) => {
      const page = await client.account.contactMetrics.history.fieldVersions.query({
        ...session.binding!,
        entity,
        memberUid,
        field,
        before: pageParam,
        limit: 30,
      });
      if (field !== 'photos') return page;
      // 旧索引只有照片编号；按原始版本补回已有媒体引用，不拿当前相册覆盖历史。
      for (let offset = 0; offset < page.rows.length; offset += 4) {
        await Promise.all(
          page.rows.slice(offset, offset + 4).map(async (row) => {
            try {
              const version = await client.account.contactMetrics.history.version.query({
                ...session.binding!,
                entity,
                id: row.id,
              });
              row.value = fieldPhotoHistoryValue(row.value, version.observedValue ?? version.value);
            } catch {
              // 原始媒体不可用时仍展示已保存的照片引用。
            }
          }),
        );
      }
      return page;
    },
    getNextPageParam: (page) => page.nextBefore ?? undefined,
    enabled: active && Boolean(session.binding),
    retry: false,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  return (
    <Modal
      presentation="popover"
      anchor={anchor}
      anchorPlacement="side"
      labelledBy={id}
      title={`${label}历史`}
      width={440}
      className="weq-field-history-dialog"
      onClose={onClose}
    >
      <header className="weq-field-history-header">
        <h3 id={id}>{label}历史</h3>
        <button
          type="button"
          className="icon-button"
          title="关闭历史"
          aria-label="关闭历史"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="weq-field-history-body">
        {query.isLoading ? (
          <p role="status">正在读取历史…</p>
        ) : query.error && !rows.length ? (
          <p role="alert">
            历史读取失败
            <button type="button" onClick={() => void query.refetch()} className="weq-retry-button">
              <RefreshCw size={14} aria-hidden />
              重试
            </button>
          </p>
        ) : (
          <FieldHistoryContent
            field={field}
            label={label}
            rows={rows}
            hasOlder={query.hasNextPage}
          />
        )}
        {query.error && rows.length ? <p role="alert">后续历史读取失败，已加载记录保留。</p> : null}
        {query.hasNextPage ? (
          <button
            type="button"
            className="weq-profile-section-action"
            disabled={query.isFetching}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? '正在读取…' : query.error ? '重试加载' : '加载更多'}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}
