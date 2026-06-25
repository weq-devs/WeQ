// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	Award,
	Check,
	CheckCheck,
	Crosshair,
	Filter,
	Heart,
	RefreshCw,
	Search,
	Trophy,
	UserRound,
	Users,
	Users2,
	X,
} from "lucide-react";
import { trpc, client } from "../../trpc/client";
import { closeFromScrim, useEscapeToClose } from "@renderer/im-template/template";
import { GraphCanvas } from "./GraphCanvas";
import { buildGraph, communityColor, personAvatar, groupAvatar } from "./graphModel";
import { RankingModal, type RankingKind } from "./RankingModal";
import type { GraphMode, GraphSettings, GroupFilterMode, RelationGraphData } from "./types";
import "./relationGraph.css";

const RANK_BUTTONS: Array<{ kind: RankingKind; label: string; icon: JSX.Element }> = [
	{ kind: "intimacy", label: "好友亲密度排行", icon: <Heart size={14} /> },
	{ kind: "common", label: "共同群聊数排行", icon: <Users2 size={14} /> },
	{ kind: "memberLevel", label: "群成员等级排行", icon: <Award size={14} /> },
];

const COMMON_THRESHOLD_RANGES: Record<
	GraphMode,
	{ min: number; max: number; label: string }
> = {
	people: { min: 2, max: 10, label: "连线阈值 · 共同群" },
	groups: { min: 5, max: 30, label: "连线阈值 · 共同好友" },
};

const DEFAULT_SETTINGS: GraphSettings = {
	mode: "people",
	nodeLimit: 100,
	minCommon: 2,
	friendsOnly: false,
	intimacySize: true,
	intimacyPull: false,
	groupLevelSize: false,
	groupLevelPull: false,
	groupFilterMode: "all",
	groupFilter: [],
};

/**
 * Embedded relation graph: lives in the contacts main area's reserved space.
 * The mode switch + refresh float over the top-left of the canvas; the bottom
 * bar carries the tunable knobs (sliders / toggles / group filter).
 */
export function RelationGraphView() {
	const [settings, setSettings] = useState<GraphSettings>(DEFAULT_SETTINGS);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [override, setOverride] = useState<RelationGraphData | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [rankOpen, setRankOpen] = useState<RankingKind | null>(null);
	const previousModeRef = useRef<GraphMode>(DEFAULT_SETTINGS.mode);

	const query = trpc.account.getRelationGraph.useQuery(undefined, {
		staleTime: Infinity,
		refetchOnWindowFocus: false,
	});
	const data = override ?? query.data;

	useEffect(() => {
		setSelectedId(null);
		setSettings((current) => {
			const previousMode = previousModeRef.current;
			if (previousMode === current.mode) return current;
			previousModeRef.current = current.mode;
			return {
				...current,
				minCommon: scaleCommonThreshold(
					current.minCommon,
					COMMON_THRESHOLD_RANGES[previousMode],
					COMMON_THRESHOLD_RANGES[current.mode],
				),
			};
		});
	}, [settings.mode]);

	const graph = useMemo(() => buildGraph(data, settings), [data, settings]);
	const selected = useMemo(
		() => graph.nodes.find((n) => n.id === selectedId) ?? null,
		[graph, selectedId],
	);
	const groupOptions = data?.groups ?? [];

	async function refresh() {
		setRefreshing(true);
		try {
			const fresh = await client.account.getRelationGraph.query({ force: true });
			setOverride(fresh);
		} catch (err) {
			console.error("[relation-graph] refresh failed", err);
		} finally {
			setRefreshing(false);
		}
	}

	function patch(next: Partial<GraphSettings>) {
		setSettings((s) => ({ ...s, ...next }));
	}

	const loading = query.isLoading || refreshing;
	const isPeople = settings.mode === "people";
	const commonRange = COMMON_THRESHOLD_RANGES[settings.mode];
	const hasNodes = graph.nodes.some((n) => n.kind !== "self");
	const filterActive = settings.groupFilterMode !== "all";

	return (
		<section className="weq-graph-embed">
			<div className="weq-graph-stage">
				{data ? (
					<div className="weq-graph-overlay">
						<div className="weq-graph-overlay-bar">
							<Segmented
								value={settings.mode}
								onChange={(mode) => patch({ mode: mode as GraphMode })}
								options={[
									{ value: "people", label: "群友圈子", icon: <UserRound size={13} /> },
									{ value: "groups", label: "群聊网络", icon: <Users size={13} /> },
								]}
							/>
							<button
								className="weq-graph-icon-btn"
								type="button"
								onClick={refresh}
								disabled={loading}
								title="重新扫描群成员，重建关系网"
							>
								<RefreshCw size={15} className={refreshing ? "weq-spin" : ""} />
							</button>
						</div>
						<span className="weq-graph-overlay-stat">
							{graph.nodes.length} 节点 · {graph.edges.length} 连线 · {graph.communityCount} 圈子
						</span>
					</div>
				) : null}

				{loading ? (
					<div className="weq-graph-state">
						<div className="weq-graph-spinner" />
						<span>正在扫描群成员、计算关系网…首次较慢，之后会缓存。</span>
					</div>
				) : !hasNodes ? (
					<div className="weq-graph-state">
						<Crosshair size={26} />
						<span>当前条件下没有可显示的节点，试试降低阈值或调整过滤。</span>
					</div>
				) : (
					<GraphCanvas
						graph={graph}
						selectedId={selectedId}
						onSelect={(node) =>
							setSelectedId(node && node.kind !== "self" ? node.id : null)
						}
					/>
				)}

				{selected ? (
					<DetailCard node={selected} onClose={() => setSelectedId(null)} />
				) : null}
			</div>

			<div className="weq-graph-controls">
				<div className="weq-graph-col weq-graph-col-sliders">
					<RangeControl
						value={settings.nodeLimit}
						min={10}
						max={200}
						step={5}
						onCommit={(v) => patch({ nodeLimit: v })}
						label="节点数量"
					/>
					<RangeControl
						value={settings.minCommon}
						min={commonRange.min}
						max={commonRange.max}
						step={1}
						onCommit={(v) => patch({ minCommon: v })}
						label={commonRange.label}
						unit="≥"
					/>
				</div>

				{isPeople ? (
					<div className="weq-graph-col">
						<span className="weq-graph-col-label">好友权重</span>
						<Toggle
							label="仅显示好友"
							checked={settings.friendsOnly}
							onChange={(v) => patch({ friendsOnly: v })}
						/>
						<Toggle
							label="亲密度决定大小"
							checked={settings.intimacySize}
							onChange={(v) => patch({ intimacySize: v })}
						/>
						<Toggle
							label="亲密度决定拉力"
							checked={settings.intimacyPull}
							onChange={(v) => patch({ intimacyPull: v })}
						/>
					</div>
				) : (
					<div className="weq-graph-col">
						<span className="weq-graph-col-label">群聊权重</span>
						<Toggle
							label="等级决定大小"
							checked={settings.groupLevelSize}
							onChange={(v) => patch({ groupLevelSize: v })}
						/>
						<Toggle
							label="等级决定拉力"
							checked={settings.groupLevelPull}
							onChange={(v) => patch({ groupLevelPull: v })}
						/>
					</div>
				)}

				<div className="weq-graph-col weq-graph-col-filter">
					<span className="weq-graph-col-label">
						<Filter size={13} />
						群过滤
					</span>
					<Segmented
						small
						value={settings.groupFilterMode}
						onChange={(m) => patch({ groupFilterMode: m as GroupFilterMode })}
						options={[
							{ value: "all", label: "全部" },
							{ value: "whitelist", label: "白名单" },
							{ value: "blacklist", label: "黑名单" },
						]}
					/>
					<button
						className="weq-graph-pick-btn"
						type="button"
						disabled={!filterActive || groupOptions.length === 0}
						onClick={() => setPickerOpen(true)}
					>
						<span>
							{filterActive ? "选择群聊" : "全部群聊参与计算"}
						</span>
						{filterActive ? (
							<span className="weq-graph-pick-count">{settings.groupFilter.length}</span>
						) : null}
					</button>
					<p className="weq-graph-hint">
						{settings.groupFilterMode === "whitelist"
							? "只统计选中的群。"
							: settings.groupFilterMode === "blacklist"
								? "排除选中的群。"
								: "纳入全部群聊参与计算。"}
					</p>
				</div>

				<div className="weq-graph-col weq-graph-col-rank">
					<span className="weq-graph-col-label">
						<Trophy size={13} />
						排行榜
					</span>
					{RANK_BUTTONS.map((btn) => (
						<button
							key={btn.kind}
							type="button"
							className="weq-graph-rank-btn"
							// 亲密度排行直接查后端、不依赖关系图；共同群 / 群成员等级要先有图数据。
							disabled={btn.kind !== "intimacy" && !data}
							onClick={() => setRankOpen(btn.kind)}
						>
							{btn.icon}
							<span>{btn.label}</span>
						</button>
					))}
				</div>
			</div>

			{pickerOpen ? (
				<GroupPickerModal
					groups={groupOptions}
					mode={settings.groupFilterMode}
					value={settings.groupFilter}
					onClose={() => setPickerOpen(false)}
					onConfirm={(codes) => {
						patch({ groupFilter: codes });
						setPickerOpen(false);
					}}
				/>
			) : null}

			{rankOpen ? (
				<RankingModal kind={rankOpen} data={data} onClose={() => setRankOpen(null)} />
			) : null}
		</section>
	);
}

/**
 * Lightbox group picker for the white/black-list — draft selection lives here
 * and only commits to the graph on 确认. Modelled on the contacts detail card /
 * create-group modal (scrim + escape-to-close + searchable checklist).
 */
function GroupPickerModal({ groups, mode, value, onClose, onConfirm }) {
	const [draft, setDraft] = useState<Set<string>>(() => new Set(value));
	const [query, setQuery] = useState("");
	useEscapeToClose(onClose);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return groups;
		return groups.filter(
			(g) => g.name.toLowerCase().includes(q) || g.code.includes(q),
		);
	}, [groups, query]);

	const allSelected =
		filtered.length > 0 && filtered.every((g) => draft.has(g.code));

	function toggle(code: string) {
		setDraft((cur) => {
			const next = new Set(cur);
			if (next.has(code)) next.delete(code);
			else next.add(code);
			return next;
		});
	}

	function toggleAll() {
		setDraft((cur) => {
			const next = new Set(cur);
			if (allSelected) {
				for (const g of filtered) next.delete(g.code);
			} else {
				for (const g of filtered) next.add(g.code);
			}
			return next;
		});
	}

	const title = mode === "blacklist" ? "选择要排除的群" : "选择要统计的群";

	return (
		<div className="modal-scrim weq-graph-modal-scrim" role="presentation" onMouseDown={closeFromScrim(onClose)}>
			<section className="weq-grouppick" role="dialog" aria-modal="true">
				<header className="weq-grouppick-head">
					<div>
						<strong>{title}</strong>
						<span>{mode === "blacklist" ? "黑名单" : "白名单"} · 共 {groups.length} 个群</span>
					</div>
					<button className="weq-grouppick-close" type="button" onClick={onClose} title="关闭">
						<X size={18} />
					</button>
				</header>

				<div className="weq-grouppick-search">
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

				<button className="weq-grouppick-all" type="button" onClick={toggleAll}>
					<CheckCheck size={15} />
					{allSelected ? "取消全选" : "全选"}
					<span>{filtered.length} 个</span>
				</button>

				<div className="weq-grouppick-list">
					{filtered.length === 0 ? (
						<p className="weq-grouppick-empty">没有匹配的群聊</p>
					) : (
						filtered.map((g) => {
							const checked = draft.has(g.code);
							const avatar = groupAvatar(g.code);
							return (
								<button
									key={g.code}
									type="button"
									className={`weq-grouppick-row${checked ? " is-on" : ""}`}
									onClick={() => toggle(g.code)}
								>
									<span className="weq-grouppick-avatar">
										{avatar ? (
											<img src={avatar} alt="" referrerPolicy="no-referrer" />
										) : (
											<span>{(g.name || "?").slice(0, 1)}</span>
										)}
									</span>
									<span className="weq-grouppick-meta">
										<strong title={g.name}>{g.name || g.code}</strong>
										<small>命中 {g.sharedCount} 位 · {g.memberCount} 人</small>
									</span>
									<span className="weq-grouppick-check">
										{checked ? <Check size={14} /> : null}
									</span>
								</button>
							);
						})
					)}
				</div>

				<footer className="weq-grouppick-foot">
					<span>已选 {draft.size} 个</span>
					<div>
						<button className="weq-grouppick-btn" type="button" onClick={onClose}>
							取消
						</button>
						<button
							className="weq-grouppick-btn is-primary"
							type="button"
							onClick={() => onConfirm(Array.from(draft))}
						>
							确认
						</button>
					</div>
				</footer>
			</section>
		</div>
	);
}

function DetailCard({ node, onClose }) {
	const avatar =
		node.kind === "person" ? personAvatar(node.uin ?? "") : groupAvatar(node.code ?? "");
	return (
		<div className="weq-graph-detail">
			<button className="weq-graph-detail-close" type="button" onClick={onClose}>
				<X size={14} />
			</button>
			<div className="weq-graph-detail-head">
				<span
					className="weq-graph-detail-avatar"
					style={{ borderColor: communityColor(node.community) }}
				>
					{avatar ? (
						<img src={avatar} alt="" referrerPolicy="no-referrer" />
					) : (
						<span>{(node.label || "?").slice(0, 1)}</span>
					)}
				</span>
				<div className="weq-graph-detail-id">
					<strong title={node.label}>{node.label}</strong>
					<span>{node.kind === "person" ? node.uin : `群 ${node.code}`}</span>
				</div>
			</div>
			<div className="weq-graph-detail-rows">
				{node.kind === "person" ? (
					<>
						<DetailRow label="关系" value={node.isFriend ? "好友" : "群友"} />
						<DetailRow label="共同群数" value={String(node.groupCount ?? 0)} />
						{node.intimacy ? (
							<DetailRow label="亲密度" value={String(node.intimacy)} accent />
						) : null}
					</>
				) : (
					<>
						<DetailRow label="群成员" value={`${node.memberCount ?? 0} 人`} />
						<DetailRow label="命中成员" value={`${node.sharedCount ?? 0} 位`} accent />
						{node.myLevel ? (
							<DetailRow label="我的等级" value={String(node.myLevel)} accent />
						) : null}
					</>
				)}
				<DetailRow label="所属圈子" value={`#${node.community + 1}`} />
			</div>
		</div>
	);
}

function DetailRow({ label, value, accent }) {
	return (
		<div className="weq-graph-detail-row">
			<span>{label}</span>
			<strong className={accent ? "is-accent" : ""}>{value}</strong>
		</div>
	);
}

/**
 * Slider with a local "live" value (so the thumb follows the cursor smoothly)
 * and a debounced commit — the expensive graph rebuild only fires ~140ms after
 * the user stops dragging, so dragging never feels stuck. The filled track is
 * driven by a `--pct` CSS var so the progress reads at a glance.
 */
function RangeControl({ value, min, max, step, onCommit, label, unit }) {
	const [local, setLocal] = useState(value);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		setLocal(clampNumber(value, min, max));
	}, [value, min, max]);

	useEffect(() => () => {
		if (timer.current) clearTimeout(timer.current);
	}, []);

	function change(v: number) {
		const next = clampNumber(v, min, max);
		setLocal(next);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => onCommit(next), 140);
	}

	const clampedLocal = clampNumber(local, min, max);
	const pct = ((clampedLocal - min) / (max - min)) * 100;

	return (
		<label className="weq-graph-slider">
			<span className="weq-graph-slider-top">
				<span className="weq-graph-slider-label">{label}</span>
				<span className="weq-graph-slider-value">
					{unit ? `${unit} ` : ""}
					{clampedLocal}
				</span>
			</span>
			<input
				className="weq-graph-range"
				style={{ "--pct": `${pct}%` } as React.CSSProperties}
				type="range"
				min={min}
				max={max}
				step={step}
				value={clampedLocal}
				onChange={(e) => change(Number(e.target.value))}
			/>
		</label>
	);
}

function scaleCommonThreshold(value: number, from: { min: number; max: number }, to: { min: number; max: number }) {
	const pct = (value - from.min) / Math.max(1, from.max - from.min);
	const scaled = to.min + pct * (to.max - to.min);
	return Math.round(Math.min(Math.max(scaled, to.min), to.max));
}

function clampNumber(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

function Segmented({ value, onChange, options, small }) {
	return (
		<div className={`weq-graph-seg${small ? " is-small" : ""}`}>
			{options.map((opt) => (
				<button
					key={opt.value}
					type="button"
					className={opt.value === value ? "is-active" : ""}
					onClick={() => onChange(opt.value)}
				>
					{opt.icon}
					{opt.label}
				</button>
			))}
		</div>
	);
}

function Toggle({ label, checked, onChange }) {
	return (
		<button
			type="button"
			className={`weq-graph-toggle${checked ? " is-on" : ""}`}
			role="switch"
			aria-checked={checked}
			onClick={() => onChange(!checked)}
		>
			<span>{label}</span>
			<span className="weq-graph-toggle-track">
				<span className="weq-graph-toggle-knob" />
			</span>
		</button>
	);
}
