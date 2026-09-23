/**
 * 群资料面板的「群内成员搜索」——服务端按关键字搜全群，分页返回。
 *
 * 面板以前只在**已加载的成员分页**里做客户端过滤：一个排在第 5 页的成员，得先
 * 把前面 4 页全拉下来才可能被搜到；而且过滤后列表短于容器，没有滚动条，连
 * 「滚动到底加载更多」都触发不了，看起来就是「搜索根本不会加载更多」。
 *
 * 现在匹配交给 `group_member3` 上的 LIKE（见 GroupMemberDb.searchMembersInGroup），
 * 一次查询就能看到全群，分页只用来续拉**匹配结果**。关键字按 `DEBOUNCE_MS` 防抖，
 * 旧请求用 run 序号作废（与 UnifiedSearchModal 同一套路）。缓存活在 MainView
 * 生命周期内，切号随重挂清空。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../trpc/client';
import type { GroupMember } from '../im-template/template/types';

/** 每页匹配数 —— 30 条约占满面板可见高度，能顺手触发一次续拉。 */
const PAGE_SIZE = 30;
/** 输入停顿多久才发查询。 */
const DEBOUNCE_MS = 250;

export interface GroupMemberSearchView {
  /** 结果对应的关键字（面板输入框的受控值，未 trim）。 */
  keyword: string;
  /** 已翻到的匹配成员，已映射成模板层 GroupMember。 */
  members: GroupMember[];
  /** 关键字非空但结果还没跟上（防抖中 / 请求在飞 / 按了清除）。 */
  loading: boolean;
  /** 首屏已有结果、正在追加下一页。 */
  loadingMore: boolean;
  /** 服务端匹配总数（不是已加载数）。 */
  total: number;
  /** 还有下一页可拉。 */
  hasMore: boolean;
  error: string | null;
}

export interface GroupMemberSearch {
  view: GroupMemberSearchView;
  /** 追加下一页。结果/关键字变化时会自动作废在飞的旧请求。 */
  loadMore: () => void;
}

/**
 * @param groupCode 当前群号；空则视为未在群聊（清空状态）。
 * @param keyword 面板输入框的关键字（由上层持有，受控）。
 * @param mapWire wire → 模板层 GroupMember 的映射，在 MainView 里与成员分页共用。
 */
export function useGroupMemberSearch<T extends { uid: string }>(
  groupCode: string | undefined,
  keyword: string,
  mapWire: (member: T) => GroupMember,
): GroupMemberSearch {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 当前 items 属于哪一组 (群, 关键字) —— 与实时值不同就说明结果还是旧的，
  // 首屏别闪上一个关键字的结果（防抖窗口里也要显示 loading）。
  const [resultKey, setResultKey] = useState('');
  const runRef = useRef(0);

  const query = groupCode ?? '';
  const needle = keyword.trim();
  const key = `${query}\u0000${needle}`;

  const fetchPage = useCallback(
    async (run: number, code: string, kw: string, offset: number, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const page = await client.account.searchGroupMembers.query({
          groupCode: code,
          keyword: kw,
          limit: PAGE_SIZE,
          offset,
        });
        if (run !== runRef.current) return;
        // 与 useGroupMemberResolver 同一套路：wire 由调用方（MainView）声明形状。
        const members = page.members as unknown as T[];
        setTotal(page.total);
        setError(null);
        setResultKey(`${code}\u0000${kw}`);
        setItems((prev) => {
          if (!append) return members;
          const seen = new Set(prev.map((member) => member.uid));
          return [...prev, ...members.filter((member) => !seen.has(member.uid))];
        });
      } catch (err) {
        if (run !== runRef.current) return;
        console.error('[group-member-search] searchGroupMembers failed', err);
        setError(err instanceof Error ? err.message : String(err));
        if (!append) {
          setItems([]);
          setTotal(0);
        }
      } finally {
        if (run === runRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    // 关键字 / 群变了：立刻作废在飞的旧查询，再防抖发新查询。
    const run = ++runRef.current;
    if (!query || !needle) {
      setItems([]);
      setTotal(0);
      setError(null);
      setLoading(false);
      setLoadingMore(false);
      setResultKey('');
      return undefined;
    }
    setLoading(true);
    const timer = window.setTimeout(
      () => void fetchPage(run, query, needle, 0, false),
      DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [query, needle, fetchPage]);

  const loadMore = useCallback((): void => {
    if (!query || !needle || loading || loadingMore) return;
    if (items.length >= total) return;
    void fetchPage(++runRef.current, query, needle, items.length, true);
  }, [fetchPage, query, needle, items.length, total, loading, loadingMore]);

  const stale = key !== resultKey;
  const members = useMemo(() => items.map(mapWire), [items, mapWire]);

  const view = useMemo<GroupMemberSearchView>(
    () => ({
      keyword,
      members,
      // 结果还没跟上时（防抖窗口 / 请求在飞）也要显示加载态，别闪旧关键字的结果。
      loading: loading || (needle !== '' && stale),
      loadingMore,
      total,
      hasMore: stale ? false : items.length < total,
      error: stale ? null : error,
    }),
    [keyword, members, loading, needle, stale, loadingMore, total, items.length, error],
  );

  return { view, loadMore };
}
