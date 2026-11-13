/** The unified search dropdown under the sidebar search box. */

import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
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
  Sparkles,
  Smile,
  UserRound,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import { isLookupNumber } from '../../hooks/useNumberLookup';
import { NumberLookupResults, type OpenNumberProfile } from './NumberLookupResults';
import '../../styles/search-scope.css';
import { SearchResultCard } from './SearchResultCard';
import { SearchSectionSkeleton } from './SearchSkeleton';
import {
  isQzoneSearchCategory,
  rankContentSearchHits,
  rankFileSearchHits,
  DEFAULT_SEARCH_SOURCES,
  searchCategoriesForSources,
  type SearchSource,
} from '@weq/service/search-policy';
import { AppSearchResults } from './AppSearchResults';
import { appSearchEntryRank, searchAppEntries, type AppSearchEntry } from './appSearchCatalog';
import { restoreSearchPosition, type SearchPosition } from './searchPosition';
import {
  CATEGORY_META,
  CONTENT_CATEGORY_ORDER,
  SEARCH_CATEGORY_ORDER,
  searchHitKey,
  searchHitNameRank,
  searchHitSource,
  isSlowSearchCategory,
  type SearchCategory,
  type SearchHit,
  type QuickSearchResult,
  type SlowSearchResult,
  type SearchCategoryStates,
  type ContentSearchHit,
} from './types';

const scopeIcons: Record<SearchCategory, LucideIcon> = {
  contact: UserRound,
  group: UsersRound,
  conversation: MessagesSquare,
  friend: UserRound,
  groupMember: UsersRound,
  chatRecord: MessageSquare,
  file: File,
  qzone: Globe,
  collection: Bookmark,
  qzonePost: Globe,
  qzoneAlbum: Globe,
  otherQzonePost: Globe,
  otherQzoneAlbum: Globe,
  groupAlbum: Images,
  groupFile: FolderOpen,
  mailMessage: Mail,
  guildMessage: Hash,
  groupBulletin: MessagesSquare,
  groupEssence: MessagesSquare,
  flashFile: FolderOpen,
  qzoneComment: Globe,
  otherQzoneComment: Globe,
  qzonePublicComment: Globe,
  cloneMessage: MessagesSquare,
  assistantMessage: Bot,
  marketEmoji: Smile,
};

const scopeOptions = SEARCH_CATEGORY_ORDER.map((category) => ({
  id: category,
  Icon: scopeIcons[category],
  label: CATEGORY_META[category].label,
  categories: [category],
}));
const scopeIds = scopeOptions.map((option) => option.id);
const sourceOptions: Array<{ id: SearchSource; Icon: LucideIcon; label: string }> = [
  { id: 'qq', Icon: MessagesSquare, label: 'QQ' },
  { id: 'clone', Icon: Bot, label: '克隆' },
  { id: 'assistant', Icon: Sparkles, label: 'WeQ 助手' },
  { id: 'app', Icon: Settings2, label: '功能与设置' },
];

export function SearchDropdown({
  keyword,
  numberLookupKeyword = keyword,
  onOpenNumberProfile,
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
  categoryStates,
  numberLookupEnabled = false,
  sources,
  onSourcesChange,
}: {
  keyword: string;
  numberLookupKeyword?: string;
  onOpenNumberProfile?: OpenNumberProfile;
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
  categoryStates?: SearchCategoryStates;
  numberLookupEnabled?: boolean;
  onNumberLookupEnabledChange?: (enabled: boolean) => void;
  sources?: readonly SearchSource[];
  onSourcesChange?: (sources: SearchSource[]) => void;
}): ReactElement {
  const hasKeyword = keyword.trim().length > 0;
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [localSources, setLocalSources] = useState<SearchSource[]>(['qq', 'clone', 'assistant']);
  const activeSources = useMemo(
    () => sources ?? (appSearchEnabled ? [...localSources, 'app' as const] : localSources),
    [sources, appSearchEnabled, localSources],
  );
  const visibleCategories = useMemo(
    () => searchCategoriesForSources(activeSources),
    [activeSources],
  );
  const visibleOptions = scopeOptions.filter((option) => visibleCategories.includes(option.id));
  const changeSources = (next: SearchSource[]) => {
    if (onSourcesChange) {
      onSourcesChange(next);
      return;
    }
    if (!sources) setLocalSources(next.filter((source) => source !== 'app'));
    onAppSearchEnabledChange?.(next.includes('app'));
  };
  const appEnabled = activeSources.includes('app');
  const numberKinds = (['contact', 'group'] as const)
    .filter((category) => categories.includes(category))
    .map((category) => (category === 'contact' ? ('user' as const) : ('group' as const)));
  const lookupEnabled =
    activeSources.includes('qq') && numberLookupEnabled && numberKinds.length > 0;
  const root = useRef<HTMLDivElement | null>(null);
  const position = useRef(initialPosition);
  const [expandedAppKeyword, setExpandedAppKeyword] = useState(
    initialPosition?.appResultsExpanded ? keyword : null,
  );
  const appResultsExpanded = expandedAppKeyword === keyword;
  const appEntries = useMemo(
    () => (appEnabled ? searchAppEntries(keyword) : []),
    [keyword, appEnabled],
  );
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
  const sections = useMemo(() => {
    const contentByCategory = new Map<SearchCategory, ContentSearchHit[]>();
    const qzoneHits: ContentSearchHit[] = [];
    for (const hit of slow?.contentHits ?? []) {
      const category = hit.category;
      const bucket = contentByCategory.get(category);
      if (bucket) bucket.push(hit);
      else contentByCategory.set(category, [hit]);
      if (isQzoneSearchCategory(category)) qzoneHits.push(hit);
    }
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
      hits: slow
        ? (slow.messageHits ?? [
            ...slow.chatRecords,
            ...slow.cloneMessages,
            ...slow.assistantMessages,
          ])
        : null,
      loading: slowLoading && !slow,
    });
    sections.set('file', {
      hits: slow
        ? rankFileSearchHits(keyword, [
            ...slow.files,
            ...(contentByCategory.get('groupFile') ?? []),
            ...(contentByCategory.get('flashFile') ?? []),
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
        hits: slow ? (contentByCategory.get(category) ?? []) : null,
        loading: slowLoading && !slow,
      });
    sections.set('qzone', {
      hits: slow ? rankContentSearchHits(keyword, qzoneHits).slice(0, 3) : null,
      loading: slowLoading && !slow,
    });
    for (const [category, section] of sections) {
      if (section.hits && categories.includes(category))
        section.hits = section.hits.filter((hit) => activeSources.includes(searchHitSource(hit)));
      const status = categoryStates?.[category];
      if (status) section.loading = status.loading;
    }
    return sections;
  }, [keyword, quick, slow, quickLoading, slowLoading, categoryStates, activeSources, categories]);

  const indexBuilding =
    categories.some((c) => c === 'chatRecord' || c === 'file') &&
    !slowLoading &&
    slow?.indexStatus === 'building';
  const scopeSelection = useMultiSelection({
    ids: scopeIds.filter((category) => visibleCategories.includes(category)),
    selected: new Set(
      visibleOptions
        .filter((option) => option.categories.every((category) => categories.includes(category)))
        .map((option) => option.id),
    ),
    onChange: (next) =>
      onCategoriesChange(
        SEARCH_CATEGORY_ORDER.filter(
          (category) =>
            (!visibleCategories.includes(category) && categories.includes(category)) ||
            next.has(category),
        ),
      ),
  });
  const failedFor = (category: SearchCategory) =>
    isSlowSearchCategory(category)
      ? (categoryStates?.[category]?.error ?? slowError) ||
        Boolean(slow?.failedCategories?.includes(category)) ||
        (category === 'chatRecord' &&
          Boolean(
            slow?.failedCategories?.some(
              (source) =>
                source === 'guildMessage' ||
                source === 'cloneMessage' ||
                source === 'assistantMessage' ||
                source === 'groupBulletin' ||
                source === 'groupEssence',
            ),
          )) ||
        (category === 'file' &&
          Boolean(
            slow?.failedCategories?.some(
              (source) => source === 'groupFile' || source === 'flashFile',
            ),
          )) ||
        (category === 'qzone' && Boolean(slow?.failedCategories?.some(isQzoneSearchCategory)))
      : (categoryStates?.[category]?.error ?? quickError);
  const appSectionEnabled = appEnabled && Boolean(onSelectAppEntry);
  const hasScope =
    activeSources.length > 0 &&
    (visibleCategories.some((category) => categories.includes(category)) || appEnabled);
  const orderedCategories = useMemo(() => {
    const bestRank = (category: SearchCategory | 'app') =>
      category === 'app'
        ? Math.max(0, ...appEntries.map((entry) => appSearchEntryRank(keyword, entry)))
        : Math.max(
            0,
            ...(sections.get(category)?.hits ?? []).map((hit) => searchHitNameRank(hit, keyword)),
          );
    const hasResults = (category: SearchCategory | 'app') =>
      category === 'app' ? appEntries.length > 0 : Boolean(sections.get(category)?.hits?.length);
    const categoryOrder: Array<SearchCategory | 'app'> = [
      ...(appSectionEnabled ? ['app' as const] : []),
      ...visibleCategories.filter((category) => categories.includes(category)),
    ];
    return categoryOrder
      .map((category, index) => ({
        category,
        index,
        hasResults: hasResults(category),
        rank: bestRank(category),
      }))
      .sort(
        (a, b) =>
          Number(b.hasResults) - Number(a.hasResults) || b.rank - a.rank || a.index - b.index,
      )
      .map((item) => item.category);
  }, [appSectionEnabled, appEntries, sections, categories, keyword, visibleCategories]);

  return (
    <div className="weq-search-dropdown" ref={attachRoot}>
      <button
        type="button"
        className="weq-search-filter-toggle"
        aria-expanded={filtersExpanded}
        onClick={() => setFiltersExpanded((value) => !value)}
      >
        <Settings2 size={14} />
        <span>
          来源 {activeSources.length} · 类型{' '}
          {visibleCategories.filter((category) => categories.includes(category)).length}
        </span>
        <span>{filtersExpanded ? '收起筛选' : '筛选'}</span>
      </button>
      <div
        className={`weq-search-filters${filtersExpanded ? ' is-expanded' : ''}`}
        role="group"
        aria-label="搜索范围"
      >
        <div className="weq-search-scope" role="group" aria-label="搜索来源">
          <span className="weq-search-filter-label">来源</span>
          <button
            type="button"
            aria-label="全部来源"
            aria-pressed={
              DEFAULT_SEARCH_SOURCES.every((source) => activeSources.includes(source))
                ? true
                : activeSources.length
                  ? 'mixed'
                  : false
            }
            onClick={() =>
              changeSources(
                DEFAULT_SEARCH_SOURCES.every((source) => activeSources.includes(source))
                  ? []
                  : [...DEFAULT_SEARCH_SOURCES],
              )
            }
          >
            <Layers size={14} aria-hidden />
            {DEFAULT_SEARCH_SOURCES.every((source) => activeSources.includes(source))
              ? '清空'
              : '全部'}
          </button>
          {sourceOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={activeSources.includes(option.id)}
              onClick={() =>
                changeSources(
                  activeSources.includes(option.id)
                    ? activeSources.filter((source) => source !== option.id)
                    : [...activeSources, option.id],
                )
              }
            >
              <option.Icon size={14} aria-hidden />
              {option.label}
            </button>
          ))}
        </div>
        {visibleCategories.length > 0 ? (
          <div
            className="weq-search-scope"
            role="group"
            aria-label="搜索类型"
            {...scopeSelection.rootProps}
          >
            <span className="weq-search-filter-label">类型</span>
            <button
              type="button"
              aria-label="全部类型"
              aria-pressed={
                visibleCategories.every((category) => categories.includes(category))
                  ? true
                  : visibleCategories.some((category) => categories.includes(category))
                    ? 'mixed'
                    : false
              }
              onClick={() =>
                onCategoriesChange(
                  visibleCategories.every((category) => categories.includes(category))
                    ? categories.filter((category) => !visibleCategories.includes(category))
                    : SEARCH_CATEGORY_ORDER.filter(
                        (category) =>
                          categories.includes(category) || visibleCategories.includes(category),
                      ),
                )
              }
            >
              <Layers size={14} aria-hidden />
              {visibleCategories.every((category) => categories.includes(category))
                ? '清空'
                : '全部'}
            </button>
            {visibleOptions.map((option) => (
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
        ) : null}
      </div>
      {hasKeyword ? (
        <>
          {indexBuilding ? (
            <div className="weq-search-index-hint">
              正在校验 QQ 搜索索引，消息/文件首次查询可能较慢…
            </div>
          ) : null}
          <div role="listbox" aria-label="搜索结果" aria-busy={quickLoading || slowLoading}>
            {!hasScope ? (
              <div className="weq-search-empty">
                未选择搜索范围
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  onClick={() => {
                    changeSources([...DEFAULT_SEARCH_SOURCES]);
                    onCategoriesChange([...SEARCH_CATEGORY_ORDER]);
                  }}
                >
                  恢复全部范围
                </button>
              </div>
            ) : null}
            {hasScope &&
            !quickLoading &&
            !slowLoading &&
            !(lookupEnabled && isLookupNumber(numberLookupKeyword)) &&
            !orderedCategories.some((category) =>
              category === 'app'
                ? appEntries.length > 0
                : Boolean(sections.get(category)?.hits?.length),
            ) &&
            !orderedCategories.some(
              (category) =>
                category !== 'app' && (sections.get(category)?.loading || failedFor(category)),
            ) ? (
              <div className="weq-search-empty">没有找到相关内容</div>
            ) : null}
            {lookupEnabled && isLookupNumber(numberLookupKeyword) ? (
              <NumberLookupResults
                keyword={numberLookupKeyword}
                onOpenProfile={onOpenNumberProfile}
                kinds={numberKinds}
              />
            ) : null}
            {orderedCategories.map((category) => {
              if (category === 'app')
                return (
                  <AppSearchResults
                    key="app"
                    keyword={keyword}
                    entries={appEntries}
                    expanded={appResultsExpanded}
                    onExpand={() => setExpandedAppKeyword(keyword)}
                    onSelect={(entry) => {
                      rememberPosition(`app:${entry.id}`);
                      onSelectAppEntry?.(entry);
                    }}
                  />
                );
              const section = sections.get(category)!;
              const hits = section.hits;
              const failed = failedFor(category);
              // 多类同时选中时不再为每个空分类渲染一条「无结果」标题，
              // 只在用户收窄到单一类型时给明确空态；全部为空时由下方统一兜底。
              if (!failed && !section.loading && !hits?.length && categories.length > 1)
                return null;
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
