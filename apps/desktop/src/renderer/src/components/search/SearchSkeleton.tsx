/** Shimmer skeleton rows used while a search category is still loading. */

import type { ReactElement } from 'react';

export function SearchSkeletonRow(): ReactElement {
  return (
    <div className="weq-search-skeleton" aria-hidden>
      <span className="weq-search-skeleton-avatar" />
      <span className="weq-search-skeleton-lines">
        <span className="weq-search-skeleton-line" />
        <span className="weq-search-skeleton-line weq-search-skeleton-line-short" />
      </span>
    </div>
  );
}

/** A single skeleton (the dropdown shows one per loading category). */
export function SearchSectionSkeleton(): ReactElement {
  return <SearchSkeletonRow />;
}

/** Full-page skeleton for the "more" modal / chat-record modal. */
export function SearchListSkeleton({ rows = 5 }: { rows?: number }): ReactElement {
  return (
    <div className="weq-search-skeleton-list">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
        <SearchSkeletonRow key={i} />
      ))}
    </div>
  );
}
