// @ts-nocheck
/**
 * 排行榜灯箱：联系人关系图谱设置面板里三个排行入口共用的弹窗。
 *
 *  - 好友亲密度排行：走后端 listFriendsByIntimacy 单条分页查询，纳入「全部好友」
 *    （以 buddy_list 为准，不再受关系图节点范围限制），滚动到底加载下一页。
 *  - 共同群聊数排行：直接复用已经拉好的 getRelationGraph 数据（nodes.groupCount
 *    就是「与你的共同群数」），纯前端排序、滚动分批渐显，不再发请求。
 *  - 群成员等级排行：先选群，再走后端 listGroupMembersByLevel 单条分页查询，
 *    滚动到底加载下一页（绝不一次性拉全群 / 不串行逐个查）。
 *
 * 视觉沿用黑白名单选择器（{@link GroupPickerModal}）：scrim + Esc 关闭 +
 * 可搜索列表，#0099ff 主题、细描边、小圆角。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Award, ChevronLeft, Heart, Search, Users2, X } from "lucide-react";
import { client } from "../../trpc/client";
import { closeFromScrim, useEscapeToClose } from "../../im-template/template/modalUtils";
import { groupAvatar, personAvatar } from "./graphModel";

export type RankingKind = "intimacy" | "common" | "memberLevel";

const RANK_META: Record<RankingKind, { title: string; sub: string; icon: JSX.Element }> = {
	intimacy: { title: "好友亲密度排行", sub: "全部好友 · 按亲密度从高到低", icon: <Heart size={15} /> },
	common: { title: "共同群聊数排行", sub: "按与你共同所在的群聊数排序", icon: <Users2 size={15} /> },
	memberLevel: { title: "群成员等级排行", sub: "选择群聊查看成员活跃等级排行", icon: <Award size={15} /> },
};

/** 共同群：每次滚动渐显的条数（数据已全在内存里）。 */
const CLIENT_STEP = 30;
/** 后端分页（亲密度 / 群成员等级）单页条数。 */
const PAGE = 50;

function nearBottom(el: HTMLElement): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

export function RankingModal({
	kind,
	data,
	onClose,
}: {
	kind: RankingKind;
	data: { nodes?: any[]; groups?: any[] } | null;
	onClose: () => void;
}) {
	useEscapeToClose(onClose);
	const meta = RANK_META[kind];
	const [group, setGroup] = useState<any | null>(null);

	const subtitle = kind === "memberLevel" && group ? group.name || group.code : meta.sub;

	return (
		<div
			className="modal-scrim weq-graph-modal-scrim"
			role="presentation"
			onMouseDown={closeFromScrim(onClose)}
		>
			<section className="weq-rank" role="dialog" aria-modal="true">
				<header className="weq-rank-head">
					<span className="weq-rank-head-icon">{meta.icon}</span>
					<div className="weq-rank-head-text">
						<strong>{meta.title}</strong>
						<span title={subtitle}>{subtitle}</span>
					</div>
					<button className="weq-rank-close" type="button" onClick={onClose} title="关闭">
						<X size={18} />
					</button>
				</header>

				{kind === "intimacy" ? (
					<FriendIntimacyList />
				) : kind === "common" ? (
					<CommonGroupList nodes={data?.nodes ?? []} />
				) : group ? (
					<MemberLevelList group={group} onBack={() => setGroup(null)} />
				) : (
					<GroupChooser groups={data?.groups ?? []} onPick={setGroup} />
				)}
			</section>
		</div>
	);
}

/**
 * 后端分页 + 滚动到底加载的通用拉取逻辑。`resetKey` 变化时清空重拉（如换群）；
 * `fetchPage(offset)` 返回一页（带 uid 的对象数组），不足整页即视为到底。游标 /
 * 在途标记用 ref 维护，避免闭包过期与切换途中回填错数据。
 */
function usePagedRanking(
	resetKey: string,
	pageSize: number,
	fetchPage: (offset: number) => Promise<any[]>,
) {
	const fetchRef = useRef(fetchPage);
	fetchRef.current = fetchPage;
	const [items, setItems] = useState<any[]>([]);
	const [loading, setLoading] = useState(true);
	const [hasMore, setHasMore] = useState(true);
	const ref = useRef({ offset: 0, busy: false, more: true, key: resetKey });

	const loadMore = useCallback(async () => {
		const s = ref.current;
		if (s.busy || !s.more) return;
		s.busy = true;
		setLoading(true);
		const key = s.key;
		try {
			const page = await fetchRef.current(s.offset);
			if (ref.current.key !== key) return; // 加载途中已 reset，丢弃
			s.offset += page.length;
			s.more = page.length >= pageSize;
			setHasMore(s.more);
			setItems((cur) => {
				const known = new Set(cur.map((m) => m.uid));
				return [...cur, ...page.filter((m) => !known.has(m.uid))];
			});
		} catch (err) {
			console.error("[ranking] page load failed", err);
			s.more = false;
			setHasMore(false);
		} finally {
			if (ref.current.key === key) setLoading(false);
			s.busy = false;
		}
	}, [pageSize]);

	useEffect(() => {
		ref.current = { offset: 0, busy: false, more: true, key: resetKey };
		setItems([]);
		setHasMore(true);
		setLoading(true);
		void loadMore();
	}, [resetKey, loadMore]);

	return { items, loading, hasMore, loadMore };
}

/** 滚动列表的底部状态（加载中 / 空 / 到底）。 */
function ListTail({ loading, empty, hasMore, emptyText }: any) {
	if (loading) {
		return (
			<div className="weq-rank-loading">
				<span className="weq-rank-spinner" />
				加载中…
			</div>
		);
	}
	if (empty) return <p className="weq-rank-empty">{emptyText}</p>;
	if (!hasMore) return <p className="weq-rank-end">已到底部</p>;
	return null;
}

/** 好友亲密度排行：后端分页，纳入全部好友。 */
function FriendIntimacyList() {
	const { items, loading, hasMore, loadMore } = usePagedRanking("friends", PAGE, (offset) =>
		client.account.listFriendsByIntimacy.query({ limit: PAGE, offset }),
	);
	const onScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			if (nearBottom(e.currentTarget)) void loadMore();
		},
		[loadMore],
	);

	return (
		<>
			<div className="weq-rank-list" onScroll={onScroll}>
				{items.map((f, i) => (
					<RankRow
						key={f.uid}
						rank={i + 1}
						avatar={personAvatar(f.uin)}
						title={f.remark || f.nick || f.uin || f.uid}
						value={String(f.intimacy ?? 0)}
					/>
				))}
				<ListTail
					loading={loading}
					empty={items.length === 0}
					hasMore={hasMore}
					emptyText="暂无好友数据"
				/>
			</div>
			<footer className="weq-rank-foot">
				<span>已加载 {items.length} 位好友</span>
				<span>亲密度排行</span>
			</footer>
		</>
	);
}

/** 群成员等级排行：后端分页 + 滚动到底加载。 */
function MemberLevelList({ group, onBack }: { group: any; onBack: () => void }) {
	const groupCode = group.code as string;
	const { items: members, loading, hasMore, loadMore } = usePagedRanking(groupCode, PAGE, (offset) =>
		client.account.listGroupMembersByLevel.query({ groupCode, limit: PAGE, offset }),
	);
	const onScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			if (nearBottom(e.currentTarget)) void loadMore();
		},
		[loadMore],
	);

	return (
		<>
			<div className="weq-rank-groupbar">
				<button type="button" className="weq-rank-back" onClick={onBack}>
					<ChevronLeft size={15} />
					换群
				</button>
				<span className="weq-rank-groupname" title={group.name}>
					{group.name || groupCode}
				</span>
				<span className="weq-rank-groupcount">{group.memberCount} 人</span>
			</div>
			<div className="weq-rank-list" onScroll={onScroll}>
				{members.map((m, i) => (
					<RankRow
						key={m.uid}
						rank={i + 1}
						avatar={personAvatar(m.uin)}
						title={m.card || m.nick || m.uin || m.uid}
						subtitle={m.customTitle || (m.adminFlag ? "管理员" : null)}
						value={`Lv.${m.memberLevel ?? 0}`}
					/>
				))}
				<ListTail
					loading={loading}
					empty={members.length === 0}
					hasMore={hasMore}
					emptyText="该群暂无成员等级数据"
				/>
			</div>
			<footer className="weq-rank-foot">
				<span>已加载 {members.length} 人</span>
				<span>等级排行</span>
			</footer>
		</>
	);
}

/** 共同群聊数排行：从已拉好的关系图节点纯前端排序，滚动分批渐显。 */
function CommonGroupList({ nodes }: { nodes: any[] }) {
	const ranked = useMemo(
		() =>
			nodes
				.map((n) => ({ node: n, metric: n.groupCount || 0 }))
				.sort((a, b) => b.metric - a.metric),
		[nodes],
	);

	const [shown, setShown] = useState(CLIENT_STEP);
	useEffect(() => {
		setShown(CLIENT_STEP);
	}, [ranked]);

	const visible = ranked.slice(0, shown);
	const hasMore = shown < ranked.length;
	const onScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			if (hasMore && nearBottom(e.currentTarget)) setShown((s) => s + CLIENT_STEP);
		},
		[hasMore],
	);

	return (
		<>
			<div className="weq-rank-list" onScroll={onScroll}>
				{ranked.length === 0 ? (
					<p className="weq-rank-empty">暂无共同群聊数据</p>
				) : (
					visible.map(({ node, metric }, i) => (
						<RankRow
							key={node.uid}
							rank={i + 1}
							avatar={personAvatar(node.uin)}
							title={node.nick || node.card || node.uin || node.uid}
							subtitle={node.isFriend ? "好友" : "群友"}
							value={`${metric} 群`}
						/>
					))
				)}
			</div>
			<footer className="weq-rank-foot">
				<span>共 {ranked.length} 人</span>
				{hasMore ? <span>下滑加载更多</span> : <span>已全部显示</span>}
			</footer>
		</>
	);
}

/** 群成员等级排行第一步：挑一个群（按人数从多到少，可搜索）。 */
function GroupChooser({ groups, onPick }: { groups: any[]; onPick: (g: any) => void }) {
	const [query, setQuery] = useState("");

	const sorted = useMemo(
		() => [...groups].sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0)),
		[groups],
	);
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return sorted;
		return sorted.filter((g) => (g.name || "").toLowerCase().includes(q) || g.code.includes(q));
	}, [sorted, query]);

	return (
		<>
			<div className="weq-rank-search">
				<Search size={16} />
				<input
					autoFocus
					placeholder="搜索群名称或群号"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				{query ? (
					<button type="button" title="清空" onClick={() => setQuery("")}>
						<X size={15} />
					</button>
				) : null}
			</div>
			<div className="weq-rank-list">
				{filtered.length === 0 ? (
					<p className="weq-rank-empty">没有匹配的群聊</p>
				) : (
					filtered.map((g) => {
						const avatar = groupAvatar(g.code);
						return (
							<button
								key={g.code}
								type="button"
								className="weq-rank-grouprow"
								onClick={() => onPick(g)}
							>
								<span className="weq-rank-avatar">
									{avatar ? (
										<img src={avatar} alt="" referrerPolicy="no-referrer" />
									) : (
										<span>{(g.name || "?").slice(0, 1)}</span>
									)}
								</span>
								<span className="weq-rank-meta">
									<strong title={g.name}>{g.name || g.code}</strong>
									<small>{g.memberCount} 人</small>
								</span>
								<ChevronLeft size={15} className="weq-rank-grouprow-go" />
							</button>
						);
					})
				)}
			</div>
			<footer className="weq-rank-foot">
				<span>选择一个群聊查看等级排行</span>
				<span>共 {groups.length} 群</span>
			</footer>
		</>
	);
}

function RankRow({
	rank,
	avatar,
	title,
	subtitle,
	value,
}: {
	rank: number;
	avatar: string | null;
	title: string;
	subtitle?: string | null;
	value: string;
}) {
	const top = rank <= 3 ? ` is-top is-top${rank}` : "";
	return (
		<div className="weq-rank-row">
			<span className={`weq-rank-num${top}`}>{rank}</span>
			<span className="weq-rank-avatar">
				{avatar ? (
					<img src={avatar} alt="" referrerPolicy="no-referrer" />
				) : (
					<span>{(title || "?").slice(0, 1)}</span>
				)}
			</span>
			<span className="weq-rank-meta">
				<strong title={title}>{title}</strong>
				{subtitle ? <small>{subtitle}</small> : null}
			</span>
			<span className="weq-rank-value">{value}</span>
		</div>
	);
}
