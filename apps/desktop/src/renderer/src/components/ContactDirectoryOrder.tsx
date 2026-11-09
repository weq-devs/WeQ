import { ArrowDownWideNarrow, ArrowUpWideNarrow } from 'lucide-react';
import type { useContactDirectoryOrder } from '../hooks/useContactDirectoryOrder';
import '../styles/contact-directory-order.css';
import { ContactCacheRefreshDialog } from './ContactRefreshButton';

export function ContactDirectoryOrder({
  order,
}: {
  order: ReturnType<typeof useContactDirectoryOrder>;
}) {
  return (
    <>
      <div className="weq-directory-order">
        <label>
          分组依据
          <select
            value={order.preferences.grouping}
            onChange={(event) => order.change({ grouping: event.target.value })}
          >
            {Object.entries(order.groupingOptions).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          排序依据
          <select
            value={order.preferences.sort}
            onChange={(event) => order.change({ sort: event.target.value })}
          >
            {Object.entries(order.sortOptions).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
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
        ) : order.needsOnline && order.progress?.status === 'running' ? (
          <small role="status">
            缓存更新中 {order.progress.done}/{order.progress.total}
          </small>
        ) : order.needsOnline && order.progress?.status === 'paused' ? (
          <small role="status">缓存更新已暂停，等待 QQ 在线</small>
        ) : null}
      </div>
      {order.refreshRequest && <ContactCacheRefreshDialog stale onClose={order.closeRefresh} />}
    </>
  );
}
