import { EmptyState } from '../EmptyState';
import { Settings2, SearchX } from 'lucide-react';
import { highlightText } from './SearchResultCard';
import { searchAppEntries, type AppSearchEntry } from './appSearchCatalog';
import '../../styles/app-search.css';

export function AppSearchResults({
  keyword,
  onSelect,
  expanded = false,
  onExpand,
  entries = searchAppEntries(keyword),
}: {
  keyword: string;
  onSelect: (entry: AppSearchEntry) => void;
  expanded?: boolean;
  onExpand: () => void;
  entries?: AppSearchEntry[];
}) {
  return (
    <div className="weq-search-section weq-app-search">
      <div className="weq-search-section-header">
        <span className="weq-search-section-name">功能与设置</span>
        {!expanded && entries.length > 6 ? (
          <button type="button" className="weq-search-more" onClick={onExpand}>
            更多
          </button>
        ) : null}
      </div>
      {!entries.length ? <EmptyState variant="inline" icon={<SearchX />} title="无结果" /> : null}
      {(expanded ? entries : entries.slice(0, 6)).map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="option"
          className="weq-search-row"
          data-search-hit-key={`app:${entry.id}`}
          onClick={() => onSelect(entry)}
        >
          <span className="weq-search-avatar weq-search-source-icon">
            <Settings2 size={20} />
          </span>
          <span className="weq-search-text">
            <span className="weq-search-name">{highlightText(entry.title, keyword)}</span>
            <span className="weq-search-snippet">{entry.path}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
