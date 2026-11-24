import { EmptyState } from '../EmptyState';
import { SearchX } from 'lucide-react';
import { createSearchHighlighter } from './SearchResultCard.shared';
import { appSearchIcon, searchAppEntries, type AppSearchEntry } from './appSearchCatalog';
import { useDevelopmentDressTools } from '../../hooks/useDevelopmentDressTools';
import '../../styles/app-search.css';

export function AppSearchResults({
  keyword,
  onSelect,
  expanded = false,
  onExpand,
  entries: providedEntries,
}: {
  keyword: string;
  onSelect: (entry: AppSearchEntry) => void;
  expanded?: boolean;
  onExpand: () => void;
  entries?: AppSearchEntry[];
}) {
  const developmentDressTools = useDevelopmentDressTools();
  const entries = (providedEntries ?? searchAppEntries(keyword, developmentDressTools)).filter(
    (entry) => entry.target.kind !== 'dressup' || developmentDressTools,
  );
  const names = createSearchHighlighter(keyword, true);
  const paths = createSearchHighlighter(keyword);
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
      {(expanded ? entries : entries.slice(0, 6)).map((entry) => {
        const Icon = appSearchIcon(entry.target);
        return (
          <button
            key={entry.id}
            type="button"
            role="option"
            className="weq-search-row"
            data-search-hit-key={`app:${entry.id}`}
            data-search-keep-open={
              entry.target.kind === 'group-files' ||
              entry.target.kind === 'group-albums' ||
              undefined
            }
            onClick={() => onSelect(entry)}
          >
            <span className="weq-search-avatar weq-search-source-icon" aria-hidden>
              <Icon size={20} strokeWidth={1.8} />
            </span>
            <span className="weq-search-text">
              <span className="weq-search-name">{names.render(entry.title)}</span>
              <span className="weq-search-snippet">{paths.render(entry.path)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
