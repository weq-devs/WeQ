// Shared types for the relation-graph feature.

/** One user from `account.getRelationGraph` (wire shape, all IPC-safe). */
export interface RawNode {
  uid: string;
  uin: string;
  nick: string;
  card: string;
  groupCount: number;
  groupCodes: string[];
  intimacy: number;
  isFriend: boolean;
}

export interface RawGroup {
  code: string;
  name: string;
  memberCount: number;
  sharedCount: number;
  /** My own member level in this group (0 when unknown). */
  myLevel: number;
}

export interface RelationGraphData {
  selfUin: string;
  nodes: RawNode[];
  groups: RawGroup[];
  scannedGroups: number;
  builtAt: number;
}

/** 两种力图 + 两张群成员重合图（和弦 / 矩阵）。 */
export type GraphMode = 'people' | 'groups' | 'chord' | 'matrix';
export type GroupFilterMode = 'all' | 'whitelist' | 'blacklist';
/** 重合图的极值方向：看「大重叠」还是「小重叠」。 */
export type OverlapDirection = 'large' | 'small';

/** All user-tunable knobs from the control panel. */
export interface GraphSettings {
  mode: GraphMode;
  /** Max nodes drawn (≤ 500). */
  nodeLimit: number;
  /** Edge threshold: shared groups (people) or shared members (groups). */
  minCommon: number;
  /** People mode: drop non-friends. */
  friendsOnly: boolean;
  /** People mode: node size driven by intimacy weight. */
  intimacySize: boolean;
  /** People mode: intimacy drives the spring pull toward the "me" node. */
  intimacyPull: boolean;
  /** Groups mode: node size driven by my member level in the group. */
  groupLevelSize: boolean;
  /** Groups mode: my member level drives the spring pull toward the "me" node. */
  groupLevelPull: boolean;
  groupFilterMode: GroupFilterMode;
  /** Selected group codes for the white/black list. */
  groupFilter: string[];
  // ---- 重合图（和弦 / 矩阵）----
  /** 参与重合计算的群数（按重合总量取前 N 个）。 */
  overlapGroupLimit: number;
  /** 重合人数阈值：看大重叠时是下限，看小重叠时是上限。 */
  overlapThreshold: number;
  overlapDirection: OverlapDirection;
  /** 重合图的群排序方式。 */
  overlapSort: 'overlap' | 'size' | 'name';
  /** 图上显示群头像（矩阵行首 / 和弦弧内）。 */
  showAvatars: boolean;
  /** 矩阵格子里还写不写数值（格子够大时）。 */
  showValues: boolean;
}

/** A node in the rendered/simulated graph. */
export interface GNode {
  id: string;
  kind: 'person' | 'group' | 'self';
  label: string;
  /** Self node is pinned to the canvas centre by the layout. */
  pinned?: boolean;
  avatarUrl: string | null;
  community: number;
  /** Size driver (importance). */
  weight: number;
  radius: number;
  // people refs
  uin?: string;
  isFriend?: boolean;
  intimacy?: number;
  groupCount?: number;
  // group refs
  code?: string;
  memberCount?: number;
  sharedCount?: number;
  myLevel?: number;
  // simulation state (mutated in place by the layout)
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}

export interface GEdge {
  source: string;
  target: string;
  weight: number;
  /** Preferred spring length (shorter = stronger tie). */
  dist: number;
  /** Optional per-edge spring strength (self edges are weaker). */
  strength?: number;
}

export interface BuiltGraph {
  nodes: GNode[];
  edges: GEdge[];
  communityCount: number;
}
