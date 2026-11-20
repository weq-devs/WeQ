import type { ReactNode } from 'react';
import { FormSelect } from './FormSelect';
import { ArrowDownWideNarrow, ArrowUpWideNarrow } from 'lucide-react';
import type { useContactDirectoryOrder } from '../hooks/useContactDirectoryOrder';
import '../styles/contact-directory-order.css';
import { ContactCacheRefreshDialog } from './ContactRefreshButton';

export function ContactDirectoryOrder({
  order,
  filters,
}: {
  order: ReturnType<typeof useContactDirectoryOrder>;
  filters?: ReactNode;
}) {
  return (
    <>
      <div className="weq-directory-order">
        {filters}
        <label>
          分组依据
          <FormSelect
            className="weq-set-select"
            value={order.preferences.grouping}
            onChange={(event) => order.change({ grouping: event.target.value })}
          >
            {Object.entries(order.groupingOptions).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </FormSelect>
        </label>
        <label>
          排序依据
          <FormSelect
            className="weq-set-select"
            value={order.preferences.sort}
            title={order.sortOptions[order.preferences.sort as keyof typeof order.sortOptions]}
            onChange={(event) => order.change({ sort: event.target.value })}
          >
            {Object.entries(order.sortOptions).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </FormSelect>
        </label>
        <button
          type="button"
          title={order.preferences.descending ? '降序，点击改为升序' : '升序，点击改为降序'}
          aria-label={order.preferences.descending ? '改为升序' : '改为降序'}
          onClick={() => order.change({ descending: !order.preferences.descending })}
        >
          {order.preferences.descending ? (
            <ArrowDownWideNarrow size={16} />
          ) : (
            <ArrowUpWideNarrow size={16} />
          )}
        </button>
        {order.error ? (
          <small role="alert">{order.error}</small>
        ) : order.progress?.status === 'running' ? (
          <small role="status">
            好友/群信息缓存更新中{' '}
            <span className="weq-number weq-number-inherit">{order.progress.done}</span>/
            <span className="weq-number weq-number-inherit">{order.progress.total}</span>
          </small>
        ) : order.progress?.status === 'paused' ? (
          <small role="status">好友/群信息缓存更新已暂停，等待 QQ 在线</small>
        ) : null}
      </div>
      {order.refreshRequest && (
        <ContactCacheRefreshDialog
          stale
          fields={order.refreshRequest.fields}
          onClose={order.closeRefresh}
        />
      )}
    </>
  );
}
