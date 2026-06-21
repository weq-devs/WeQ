// @ts-nocheck
// Build the rendered graph (nodes + edges + communities) from the raw relation
// data and the current control-panel settings. Pure, no React / canvas.

import { cachedAvatarUrl } from "../../lib/avatarCache";
import type {
	BuiltGraph,
	GEdge,
	GNode,
	GraphSettings,
	RawNode,
	RelationGraphData,
} from "./types";

/** Friends carry a base intimacy of 100; non-friends a flat 80 (weight model). */
const NON_FRIEND_WEIGHT = 80;
const FRIEND_BASE_WEIGHT = 100;

/** The synthetic "me" node id (present in both modes, pinned to centre). */
export const SELF_ID = "__self__";
const SELF_RADIUS = 26;

// Avatars are routed through the `weq-avatar://` protocol (disk-cached in the
// main process) instead of hitting the QQ CDN directly on every render. The
// graph paints 100+ tiny (10–24px) avatars at once, so request the SMALL size
// (`s=100`) — `s=0` returns the full-res original (tens–hundreds of KB each),
// which is what made first load crawl.
export function personAvatar(uin: string): string | null {
	if (!uin || uin === "0") return null;
	return cachedAvatarUrl(`https://thirdqq.qlogo.cn/g?b=sdk&s=100&nk=${uin}`);
}

export function groupAvatar(code: string): string | null {
	return code ? cachedAvatarUrl(`https://p.qlogo.cn/gh/${code}/${code}/100`) : null;
}

/** Per-person importance weight (friend base 100, non-friend ~80). */
export function personWeight(node: Pick<RawNode, "isFriend" | "intimacy">): number {
	if (node.isFriend) return Math.max(node.intimacy || 0, FRIEND_BASE_WEIGHT);
	return NON_FRIEND_WEIGHT;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Avatar radius from intimacy weight — a saturating exponential (1 − e^−x):
 * grows fast at low intimacy then flattens to a capped maximum, so a few very
 * close friends don't dwarf everyone. Avatars are kept small overall.
 */
function radiusByIntimacy(weight: number): number {
	const MIN_R = 10;
	const MAX_R = 24;
	const SCALE = 420;
	const t = 1 - Math.exp(-weight / SCALE);
	return MIN_R + t * (MAX_R - MIN_R);
}

function radiusBySqrt(value: number, divisor: number, min: number, max: number): number {
	const t = Math.min(Math.sqrt(Math.max(value, 0)) / divisor, 1);
	return min + t * (max - min);
}

/**
 * Group-node radius from my member level — same saturating shape as
 * {@link radiusByIntimacy} (group levels run in the tens, so a smaller scale).
 */
function radiusByLevel(level: number): number {
	const MIN_R = 10;
	const MAX_R = 24;
	const SCALE = 60;
	const t = 1 - Math.exp(-Math.max(level, 0) / SCALE);
	return MIN_R + t * (MAX_R - MIN_R);
}

/** Which group codes are allowed under the current white/black-list filter. */
function allowedGroupPredicate(settings: GraphSettings): (code: string) => boolean {
	if (settings.groupFilterMode === "all" || settings.groupFilter.length === 0) {
		return () => true;
	}
	const set = new Set(settings.groupFilter);
	return settings.groupFilterMode === "whitelist"
		? (code) => set.has(code)
		: (code) => !set.has(code);
}

function makeSelfNode(data: RelationGraphData, label: string): GNode {
	return {
		id: SELF_ID,
		kind: "self",
		label,
		// pinned: true,
		avatarUrl: personAvatar(data.selfUin),
		community: 0,
		weight: 0,
		radius: SELF_RADIUS,
		uin: data.selfUin,
		isFriend: true,
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
		fx: null,
		fy: null,
	};
}

/** People mode: one node per shared contact, edges = shared-group count. */
function buildPeople(data: RelationGraphData, settings: GraphSettings): BuiltGraph {
	const allow = allowedGroupPredicate(settings);

	const prepared: Array<{ raw: RawNode; groups: string[] }> = [];
	for (const raw of data.nodes) {
		if (settings.friendsOnly && !raw.isFriend) continue;
		const groups = raw.groupCodes.filter(allow);
		if (groups.length === 0) continue;
		prepared.push({ raw, groups });
	}

	prepared.sort((a, b) => b.groups.length - a.groups.length);
	const top = prepared.slice(0, settings.nodeLimit);

	const nodes: GNode[] = top.map((p) => {
		const intimacyWeight = personWeight(p.raw);
		return {
			id: p.raw.uid,
			kind: "person",
			label: p.raw.nick || p.raw.card || p.raw.uin || p.raw.uid,
			avatarUrl: personAvatar(p.raw.uin),
			community: 0,
			weight: intimacyWeight,
			radius: settings.intimacySize
				? radiusByIntimacy(intimacyWeight)
				: radiusBySqrt(p.groups.length, 6, 9, 18),
			uin: p.raw.uin,
			isFriend: p.raw.isFriend,
			intimacy: p.raw.intimacy,
			groupCount: p.raw.groupCount,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			fx: null,
			fy: null,
		};
	});

	const sets = top.map((p) => new Set(p.groups));
	const edges: GEdge[] = [];
	for (let i = 0; i < top.length; i++) {
		const a = sets[i];
		for (let j = i + 1; j < top.length; j++) {
			const b = sets[j];
			const [small, big] = a.size < b.size ? [a, b] : [b, a];
			let common = 0;
			for (const g of small) if (big.has(g)) common++;
			if (common >= settings.minCommon) {
				edges.push({
					source: nodes[i].id,
					target: nodes[j].id,
					weight: common,
					dist: 200 / Math.sqrt(common),
				});
			}
		}
	}

	// Communities are computed on the real contacts only (self connects to all,
	// so including it would smear every cluster together).
	const communityCount = detectCommunities(nodes, edges);

	// "Me" at the centre, linked to everyone. Two pull models:
	//  - default: more shared groups → shorter, slightly firmer link.
	//  - intimacyPull: intimacy (friend weight) decides the pull, so close
	//    friends are reeled in near the centre and acquaintances drift out.
	const self = makeSelfNode(data, "我");
	for (let i = 0; i < top.length; i++) {
		const node = nodes[i];
		const shared = top[i].groups.length;
		let dist: number;
		let strength: number;
		if (settings.intimacyPull) {
			// Saturating 0→1 on the intimacy weight; higher → reeled in closer.
			const t = 1 - Math.exp(-node.weight / 600);
			dist = 340 - t * 260; // ~340 (far) down to ~80 (very close)
			strength = 0.02 + t * 0.16; // intimate friends pull as hard as a cluster tie
		} else {
			dist = clamp(360 / Math.sqrt(shared), 60, 360);
			strength = 0.006;
		}
		edges.push({ source: SELF_ID, target: node.id, weight: shared, dist, strength });
	}
	nodes.push(self);

	return { nodes, edges, communityCount };
}

/** Group mode: one node per group, edges = members shared between two groups. */
function buildGroups(data: RelationGraphData, settings: GraphSettings): BuiltGraph {
	const allow = allowedGroupPredicate(settings);
	const groups = data.groups.filter((g) => allow(g.code));
	groups.sort((a, b) => b.sharedCount - a.sharedCount);
	const top = groups.slice(0, settings.nodeLimit);
	const allowedCodes = new Set(top.map((g) => g.code));

	const nodes: GNode[] = top.map((g) => ({
		id: g.code,
		kind: "group",
		label: g.name || g.code,
		avatarUrl: groupAvatar(g.code),
		community: 0,
		weight: g.sharedCount,
		radius: settings.groupLevelSize
			? radiusByLevel(g.myLevel)
			: radiusBySqrt(g.sharedCount, 8, 10, 22),
		code: g.code,
		memberCount: g.memberCount,
		sharedCount: g.sharedCount,
		myLevel: g.myLevel,
		x: 0,
		y: 0,
		vx: 0,
		vy: 0,
		fx: null,
		fy: null,
	}));

	// Co-occurrence: for each person, every pair of their (allowed) groups.
	const pairCount = new Map<string, number>();
	for (const person of data.nodes) {
		const codes = person.groupCodes.filter((c) => allowedCodes.has(c));
		for (let i = 0; i < codes.length; i++) {
			for (let j = i + 1; j < codes.length; j++) {
				const key = codes[i] < codes[j] ? `${codes[i]}|${codes[j]}` : `${codes[j]}|${codes[i]}`;
				pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
			}
		}
	}

	const edges: GEdge[] = [];
	for (const [key, weight] of pairCount) {
		if (weight < settings.minCommon) continue;
		const [source, target] = key.split("|");
		edges.push({ source, target, weight, dist: 220 / Math.sqrt(weight) });
	}

	const communityCount = detectCommunities(nodes, edges);

	// "Me" abstracted as a hub group. Two pull models, mirroring people mode:
	//  - default: the more common friends a group shares with me, the closer.
	//  - groupLevelPull: my member level decides the pull, so the groups I'm
	//    most active in are reeled in near the centre.
	const self = makeSelfNode(data, "我");
	for (const g of top) {
		let dist: number;
		let strength: number;
		if (settings.groupLevelPull) {
			const t = 1 - Math.exp(-Math.max(g.myLevel, 0) / 60);
			dist = 340 - t * 260; // ~340 (far) down to ~80 (very close)
			strength = 0.02 + t * 0.16;
		} else {
			dist = clamp(380 / Math.sqrt(g.sharedCount), 64, 380);
			strength = 0.006;
		}
		edges.push({ source: SELF_ID, target: g.code, weight: g.sharedCount, dist, strength });
	}
	nodes.push(self);

	return { nodes, edges, communityCount };
}

export function buildGraph(
	data: RelationGraphData | undefined,
	settings: GraphSettings,
): BuiltGraph {
	if (!data) return { nodes: [], edges: [], communityCount: 0 };
	return settings.mode === "groups"
		? buildGroups(data, settings)
		: buildPeople(data, settings);
}

/**
 * Weighted label-propagation community detection — assigns each node a
 * community id (0..k-1) by repeatedly adopting the strongest neighbour label.
 * Cheap and good enough for coloured clustering of a few hundred nodes.
 */
function detectCommunities(nodes: GNode[], edges: GEdge[]): number {
	if (nodes.length === 0) return 0;
	const adj = new Map<string, Array<{ id: string; w: number }>>();
	for (const n of nodes) adj.set(n.id, []);
	for (const e of edges) {
		adj.get(e.source)?.push({ id: e.target, w: e.weight });
		adj.get(e.target)?.push({ id: e.source, w: e.weight });
	}

	const label = new Map<string, number>();
	nodes.forEach((n, i) => label.set(n.id, i));

	for (let iter = 0; iter < 10; iter++) {
		let changed = false;
		for (const n of nodes) {
			const neighbours = adj.get(n.id);
			if (!neighbours || neighbours.length === 0) continue;
			const score = new Map<number, number>();
			for (const nb of neighbours) {
				const l = label.get(nb.id)!;
				score.set(l, (score.get(l) ?? 0) + nb.w);
			}
			let best = label.get(n.id)!;
			let bestScore = -1;
			for (const [l, s] of score) {
				if (s > bestScore || (s === bestScore && l < best)) {
					best = l;
					bestScore = s;
				}
			}
			if (best !== label.get(n.id)) {
				label.set(n.id, best);
				changed = true;
			}
		}
		if (!changed) break;
	}

	const remap = new Map<number, number>();
	let k = 0;
	for (const n of nodes) {
		const l = label.get(n.id)!;
		if (!remap.has(l)) remap.set(l, k++);
		n.community = remap.get(l)!;
	}
	return k;
}

/** A pleasant categorical palette for communities (cycled if exceeded). */
export const COMMUNITY_COLORS = [
	"#0099ff",
	"#36c08f",
	"#f6a23c",
	"#ef6f6c",
	"#9b6dff",
	"#2bb6d6",
	"#e072b8",
	"#7e8bd9",
	"#5bbf6a",
	"#d98c4a",
];

export function communityColor(community: number): string {
	return COMMUNITY_COLORS[community % COMMUNITY_COLORS.length];
}
