import type { ReactNode } from 'react';
import type { useContactDirectoryOrder } from '../hooks/useContactDirectoryOrder';
import { ContactCacheRefreshDialog } from './ContactRefreshButton';
import { DirectoryMenu, DirectorySortMenu } from './DirectorySortMenu';
import { FormSelect } from './FormSelect';

export function ContactDirectoryOrder({
  order,
  filters,
  filtersApplied = false,
  filtersDisabled = false,
  active = true,
}: {
  order: ReturnType<typeof useContactDirectoryOrder>;
  filters?: ReactNode;
  filtersApplied?: boolean;
  filtersDisabled?: boolean;
  active?: boolean;
}) {
  const { grouping, sort, descending } = order.preferences;
  return (
    <>
      <div className="weq-directory-order">
        <div className="weq-directory-order-buttons">
          {filters && (
            <DirectoryMenu
              label="筛选"
              active={active}
              disabled={filtersDisabled}
              highlighted={filtersApplied}
            >
              {filters}
            </DirectoryMenu>
          )}
          <FormSelect
            className="weq-set-btn weq-directory-menu-button"
            aria-label="分组依据"
            triggerLabel="分组"
            disabled={!active}
            value={grouping}
            onChange={(event) => order.change({ grouping: event.target.value })}
          >
            {Object.entries(order.groupingOptions).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </FormSelect>
          <DirectorySortMenu
            active={active}
            options={order.sortOptions}
            sort={sort}
            descending={descending}
            onSort={(sort) => order.change({ sort })}
            onDirection={(descending) => order.change({ descending })}
          />
        </div>
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
