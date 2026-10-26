/** The unified search dropdown under the sidebar search box. */

import { useCallback, useRef, useState, type ReactElement } from 'react';
import {
  Bookmark,
  Bot,
  File,
  FolderOpen,
  Globe,
  Hash,
  Images,
  Layers,
  Mail,
  MessageSquare,
  MessagesSquare,
  RotateCw,
  Settings2,
  Smile,
  UserRound,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import '../../styles/search-scope.css';
import { SearchResultCard } from './SearchResultCard';
import { SearchSectionSkeleton } from './SearchSkeleton';
import { rankFileSearchHits } from '@weq/service/search-policy';
import { AppSearchResults } from './AppSearchResults';
import type { AppSearchEntry } from './appSearchCatalog';
import { restoreSearchPosition, type SearchPosition } from './searchPosition';
import {
  CATEGORY_META,
  CONTENT_CATEGORY_ORDER,
  isContentSearchCategory,
  contentCoverageText,
  SEARCH_CATEGORY_ORDER,
  searchHitKey,
  searchHitNameRank,
  isSlowSearchCategory,
  type SearchCategory,
  type SearchHit,
  type QuickSearchResult,
  type SlowSearchResult,
} from './types';

const scopeIcons: Record<SearchCategory, LucideIcon> = {
  contact: UserRound,
  group: UsersRound,
  conversation: MessagesSquare,
  friend: UserRound,
  groupMember: UsersRound,
  chatRecord: MessageSquare,
  file: File,
  collection: Bookmark,
  qzonePost: Globe,
  qzoneAlbum: Globe,
  otherQzonePost: Globe,
  otherQzoneAlbum: Globe,
  groupAlbum: Images,
  groupFile: FolderOpen,
  mailMessage: Mail,
  guildMessage: Hash,
  cloneMessage: MessagesSquare,
  assistantMessage: Bot,
  marketEmoji: Smile,
};

const scopeOptions = SEARCH_CATEGORY_ORDER.flatMap((category) => {
  if (category === 'qzoneAlbum' || category === 'otherQzoneAlbum') return [];
  return [
    {
      id: category,
      Icon: scopeIcons[category],
      label:
        category === 'qzonePost'
          ? '个人空间'
          : category === 'otherQzonePost'
            ? '他人空间'
            : CATEGORY_META[category].label,
      categories:
        category === 'qzonePost'
          ? (['qzonePost', 'qzoneAlbum'] as SearchCategory[])
          : category === 'otherQzonePost'
            ? (['otherQzonePost', 'otherQzoneAlbum'] as SearchCategory[])
            : [category],
    },
  ];
});

export function SearchDropdown({
  keyword,
  quick,
  quickLoading,
  slow,
  slowLoading,
  categories,
  onCategoriesChange,
  quickError = false,
  slowError = false,
  onRetry,
  onSelect,
  onMore,
  initialPosition,
  onNavigate,
  appSearchEnabled = false,
  onAppSearchEnabledChange,
  onSelectAppEntry,
}: {
  keyword: string;
  quick: QuickSearchResult | null;
  quickLoading: boolean;
  slow: SlowSearchResult | null;
  slowLoading: boolean;
  categories: readonly SearchCategory[];
  onCategoriesChange: (categories: SearchCategory[]) => void;
  quickError?: boolean;
  slowError?: boolean;
  onRetry?: () => void;
  onSelect: (hit: SearchHit) => void;
  onMore: (category: SearchCategory) => void;
  initialPosition?: SearchPosition;
  onNavigate?: (position: SearchPosition) => void;
  appSearchEnabled?: boolean;
  onAppSearchEnabledChange?: (enabled: boolean) => void;
  onSelectAppEntry?: (entry: AppSearchEntry) => void;
}): ReactElement {
  const hasKeyword = keyword.trim().length > 0;
  const allSelected =
    SEARCH_CATEGORY_ORDER.every((category) => categories.includes(category)) &&
    (!onSelectAppEntry || appSearchEnabled);
  const partiallySelected = categories.length > 0 || appSearchEnabled;
  const root = useRef<HTMLDivElement | null>(null);
  const position = useRef(initialPosition);
  const [expandedAppKeyword, setExpandedAppKeyword] = useState(
    initialPosition?.appResultsExpanded ? keyword : null,
  );
  const appResultsExpanded = expandedAppKeyword === keyword;
  const rememberPosition = (focusKey: string) =>
    onNavigate?.({
      scrollTop: root.current?.scrollTop ?? 0,
      focusKey,
      ...(appResultsExpanded ? { appResultsExpanded: true } : {}),
    });
  const attachRoot = useCallback((node: HTMLDivElement | null) => {
    root.current = node;
    if (node && position.current) {
      restoreSearchPosition(node, position.current);
      position.current = undefined;
    }
  }, []);
  // Map category → hits (or null while loading).
  const sections = new Map<SearchCategory, { hits: SearchHit[] | null; loading: boolean }>();
  sections.set('contact', {
    hits: quick ? (quick.contacts ?? []) : null,
    loading: quickLoading && !quick,
  });
  sections.set('group', {
    hits: quick ? (quick.groups ?? []) : null,
    loading: quickLoading && !quick,
  });
  sections.set('conversation', {
    hits: quick ? quick.conversations : null,
    loading: quickLoading && !quick,
  });
  sections.set('friend', { hits: quick ? quick.friends : null, loading: quickLoading && !quick });
  sections.set('groupMember', {
    hits: quick ? quick.groupMembers : null,
    loading: quickLoading && !quick,
  });
  sections.set('chatRecord', {
    hits: slow ? slow.chatRecords : null,
    loading: slowLoading && !slow,
  });
  sections.set('file', {
    hits: slow
      ? rankFileSearchHits(keyword, [
          ...slow.files,
          ...(slow.contentHits ?? []).filter((hit) => hit.category === 'groupFile'),
        ]).slice(0, 3)
      : null,
    loading: slowLoading && !slow,
  });
  sections.set('collection', {
    hits: slow ? slow.collections : null,
    loading: slowLoading && !slow,
  });
  sections.set('cloneMessage', {
    hits: slow ? slow.cloneMessages : null,
    loading: slowLoading && !slow,
  });
  sections.set('assistantMessage', {
    hits: slow ? slow.assistantMessages : null,
    loading: slowLoading && !slow,
  });
  for (const category of CONTENT_CATEGORY_ORDER)
    sections.set(category, {
      hits: slow ? (slow.contentHits ?? []).filter((hit) => hit.category === category) : null,
      loading: slowLoading && !slow,
    });

  const indexBuilding =
    categories.some((c) => c === 'chatRecord' || c === 'file') &&
    !slowLoading &&
    slow?.indexStatus === 'building';
  const scopeSelection = useMultiSelection({
    ids: scopeOptions.map((option) => option.id),
    selected: new Set(
      scopeOptions
        .filter((option) => option.categories.every((category) => categories.includes(category)))
        .map((option) => option.id),
    ),
    onChange: (next) =>
      onCategoriesChange(
        scopeOptions.filter((option) => next.has(option.id)).flatMap((option) => option.categories),
      ),
  });
  const failedFor = (category: SearchCategory) =>
    isSlowSearchCategory(category)
      ? slowError ||
        Boolean(slow?.failedCategories?.includes(category)) ||
        (category === 'file' && Boolean(slow?.failedCategories?.includes('groupFile')))
      : quickError;
  const weight = (category: SearchCategory) =>
    sections.get(category)?.hits?.length
      ? 3
      : failedFor(category)
        ? 2
        : sections.get(category)?.loading
          ? 1
          : 0;
  const orderedCategories = SEARCH_CATEGORY_ORDER.filter((category) =>
    categories.includes(category),
  ).sort(
    (left, right) =>
      weight(right) - weight(left) ||
      Math.max(
        0,
        ...(sections.get(right)?.hits ?? []).map((hit) => searchHitNameRank(hit, keyword)),
      ) -
        Math.max(
          0,
          ...(sections.get(left)?.hits ?? []).map((hit) => searchHitNameRank(hit, keyword)),
        ),
  );

  return (
    <div className="weq-search-dropdown" ref={attachRoot}>
      <div
        className="weq-search-scope"
        role="group"
        aria-label="搜索范围"
        {...scopeSelection.rootProps}
      >
        <button
          type="button"
          aria-label="全部范围"
          aria-pressed={allSelected ? true : partiallySelected ? 'mixed' : false}
          onClick={() => {
            onCategoriesChange(allSelected ? [] : [...SEARCH_CATEGORY_ORDER]);
            onAppSearchEnabledChange?.(!allSelected);
          }}
        >
          <Layers size={14} aria-hidden />
          全部
        </button>
        {onSelectAppEntry ? (
          <button
            type="button"
            aria-pressed={appSearchEnabled}
            onClick={() => onAppSearchEnabledChange?.(!appSearchEnabled)}
          >
            <Settings2 size={14} aria-hidden />
            功能与设置
          </button>
        ) : null}
        {scopeOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={option.categories.every((category) => categories.includes(category))}
            {...scopeSelection.itemProps(option.id)}
          >
            <option.Icon size={14} aria-hidden />
            {option.label}
          </button>
        ))}
      </div>
      {hasKeyword ? (
        <>
          <div className="weq-search-index-hint">
            来源：{appSearchEnabled ? '应用功能与设置 · ' : ''}当前账号 · 本地可检索记录
          </div>
          {indexBuilding ? (
            <div className="weq-search-index-hint">
              正在建立本地搜索索引，聊天记录/文件首次查询较慢…
            </div>
          ) : null}
          <div role="listbox" aria-label="搜索结果" aria-busy={quickLoading || slowLoading}>
            {categories.length === 0 && !appSearchEnabled ? (
              <div className="weq-search-empty">未选择搜索范围</div>
            ) : null}
            {appSearchEnabled && onSelectAppEntry ? (
              <AppSearchResults
                keyword={keyword}
                expanded={appResultsExpanded}
                onExpand={() => setExpandedAppKeyword(keyword)}
                onSelect={(entry) => {
                  rememberPosition(`app:${entry.id}`);
                  onSelectAppEntry(entry);
                }}
              />
            ) : null}
            {orderedCategories.map((category) => {
              const section = sections.get(category)!;
              const hits = section.hits;
              const coverage =
                category === 'file'
                  ? slow?.contentCoverage?.groupFile
                  : isContentSearchCategory(category)
                    ? slow?.contentCoverage?.[category]
                    : undefined;
              const failed = failedFor(category);
              return (
                <div className="weq-search-section" key={category}>
                  <div className="weq-search-section-header">
                    <span className="weq-search-section-name">{CATEGORY_META[category].label}</span>
                    {hits && hits.length >= 3 ? (
                      <button
                        type="button"
                        className="weq-search-more"
                        data-search-hit-key={`more:${category}`}
                        onClick={() => {
                          rememberPosition(`more:${category}`);
                          onMore(category);
                        }}
                      >
                        更多
                      </button>
                    ) : null}
                  </div>
                  {coverage ? (
                    <div className="weq-search-index-hint">
                      {category === 'file' ? '群文件目录 · ' : ''}
                      {contentCoverageText(coverage)}
                    </div>
                  ) : null}
                  {failed ? (
                    <div className="weq-search-failure" role="status">
                      <span>搜索失败</span>
                      <button
                        type="button"
                        onClick={onRetry}
                        title="重试搜索"
                        aria-label={`重试${CATEGORY_META[category].label}搜索`}
                      >
                        <RotateCw size={14} />
                      </button>
                    </div>
                  ) : null}
                  {section.loading ? (
                    <SearchSectionSkeleton />
                  ) : !hits || hits.length === 0 ? (
                    failed ? null : (
                      <div className="weq-search-empty">无结果</div>
                    )
                  ) : (
                    hits.map((hit) => (
                      <SearchResultCard
                        key={searchHitKey(hit)}
                        hit={hit}
                        keyword={keyword}
                        onSelect={(selected, focusKey) => {
                          rememberPosition(focusKey ?? searchHitKey(selected));
                          onSelect(selected);
                        }}
                      />
                    ))
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
