import { ArrowRight, ChevronDown, Settings2 } from 'lucide-react';
import { highlightText } from './SearchResultCard';
import { searchAppEntries, type AppSearchEntry } from './appSearchCatalog';
import '../../styles/app-search.css';

export function AppSearchResults({
  keyword,
  onSelect,
  expanded = false,
  onExpand,
}: {
  keyword: string;
  onSelect: (entry: AppSearchEntry) => void;
  expanded?: boolean;
  onExpand: () => void;
}) {
  const entries = searchAppEntries(keyword);
  return (
    <div className="weq-search-section weq-app-search">
      <div className="weq-search-section-header">
        <span className="weq-search-section-name">功能与设置</span>
        <span className="weq-app-search-count">{entries.length}</span>
      </div>
      {!entries.length ? <div className="weq-search-empty">无结果</div> : null}
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
          <ArrowRight size={14} className="weq-app-search-arrow" aria-hidden />
        </button>
      ))}
      {entries.length > 6 && !expanded ? (
        <button type="button" className="weq-app-search-expand" onClick={onExpand}>
          <ChevronDown size={14} />
          更多功能与设置（{entries.length - 6}）
        </button>
      ) : null}
    </div>
  );
}
