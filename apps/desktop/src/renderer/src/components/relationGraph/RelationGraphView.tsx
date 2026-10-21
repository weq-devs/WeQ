// @ts-nocheck
/**
 * 联系人页的关系图谱区。
 *
 * 默认落地是 {@link RelationHome}（名片背景 + 一个显眼的「查看群交集」入口），
 * 点进去才切到四种视图：
 *  - 群友圈子 / 群聊网络：原来的 d3 力图（{@link GraphCanvas}）；
 *  - 和弦图 / 重叠矩阵：群成员重合的两张图（{@link OverlapChord} / {@link OverlapMatrix}），
 *    二者共用 {@link buildOverlapModel} 的同一份重合数据。
 *
 * 下方控制条按「力图 / 重合图」两套设置切换，但布局骨架不变（左滑杆、中开关、
 * 右排行），避免用户换个视图就要重新找按钮。
 */
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Award,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  Crosshair,
  Heart,
  LayoutGrid,
  RefreshCw,
  Search,
  Table2,
  Trophy,
  UserRound,
  Users,
  Users2,
  Waypoints,
  X,
} from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { GraphCanvas } from './GraphCanvas';
import { OverlayLayer } from '../OverlayLayer';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import {
  buildGraph,
  buildOverlapModel,
  communityColor,
  personAvatar,
  groupAvatar,
} from './graphModel';
import { RankingModal, type RankingKind } from './RankingModal';
import { RelationHome } from './RelationHome';
import { OverlapChord } from './OverlapChord';
import { OverlapMatrix } from './OverlapMatrix';
import { OverlapPairCard, type OverlapPairSelection } from './OverlapPairCard';
import type {
  GraphMode,
  GraphSettings,
  GroupFilterMode,
  OverlapDirection,
  RawNode,
  RelationGraphData,
} from './types';
import './relationGraph.css';

const RANK_BUTTONS: Array<{ kind: RankingKind; label: string; icon: JSX.Element }> = [
  { kind: 'intimacy', label: '好友亲密度排行', icon: <Heart size={14} /> },
  { kind: 'common', label: '共同群聊数排行', icon: <Users2 size={14} /> },
  { kind: 'memberLevel', label: '群成员等级排行', icon: <Award size={14} /> },
  { kind: 'groupActivity', label: '群聊活跃度排行', icon: <Activity size={14} /> },
];

const MODE_OPTIONS: Array<{ value: GraphMode; label: string; icon: JSX.Element }> = [
  { value: 'people', label: '群友圈子', icon: <UserRound size={13} /> },
  { value: 'groups', label: '群聊网络', icon: <Users size={13} /> },
  { value: 'chord', label: '和弦', icon: <Waypoints size={13} /> },
  { value: 'matrix', label: '重叠矩阵', icon: <Table2 size={13} /> },
];

const COMMON_THRESHOLD_RANGES: Record<
  'people' | 'groups',
  { min: number; max: number; label: string }
> = {
  people: { min: 2, max: 10, label: '连线阈值 · 共同群' },
  groups: { min: 5, max: 30, label: '连线阈值 · 共同好友' },
};

const DEFAULT_SETTINGS: GraphSettings = {
  mode: 'people',
  nodeLimit: 100,
  minCommon: 2,
  friendsOnly: false,
  intimacySize: true,
  intimacyPull: false,
  groupLevelSize: false,
  groupLevelPull: false,
  groupFilterMode: 'all',
  groupFilter: [],
  overlapGroupLimit: 30,
  overlapThreshold: 3,
  overlapDirection: 'large',
  overlapSort: 'overlap',
  showAvatars: true,
  showValues: true,
};

const isOverlapMode = (mode: GraphMode): mode is 'chord' | 'matrix' =>
  mode === 'chord' || mode === 'matrix';

/**
 * 联系人主区域的关系图谱。首屏是门面，进入后才渲染图；离开再回来仍保留上次的
 * 视图与设置（组件不卸载，只在内部切 `entered`）。
 */
export function RelationGraphView({
  onOpenMember,
}: {
  /** 点共同成员时交给应用层打开标准资料卡（MemberProfileCard）。 */
  onOpenMember?: (
    member: RawNode,
    anchor: { x: number; y: number },
    group?: { code: string; name: string },
  ) => void;
} = {}) {
  const [entered, setEntered] = useState(false);
  const [settings, setSettings] = useState<GraphSettings>(DEFAULT_SETTINGS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [override, setOverride] = useState<RelationGraphData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rankOpen, setRankOpen] = useState<RankingKind | null>(null);
  const [pair, setPair] = useState<OverlapPairSelection | null>(null);
  const previousModeRef = useRef<GraphMode>(DEFAULT_SETTINGS.mode);

  const query = trpc.account.getRelationGraph.useQuery(undefined, {
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const data = override ?? query.data;
  const loading = query.isLoading || refreshing;

  useEffect(() => {
    setSelectedId(null);
    setPair(null);
    setSettings((current) => {
      const previousMode = previousModeRef.current;
      if (previousMode === current.mode) return current;
      previousModeRef.current = current.mode;
      if (isOverlapMode(previousMode) || isOverlapMode(current.mode)) return current;
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

  const graph = useMemo(
    () => (isOverlapMode(settings.mode) ? null : buildGraph(data, settings)),
    [data, settings],
  );
  const overlap = useMemo(
    () => (isOverlapMode(settings.mode) ? buildOverlapModel(data, settings) : null),
    [data, settings],
  );
  const selected = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedId) ?? null,
    [graph, selectedId],
  );
  const groupOptions = data?.groups ?? [];

  async function refresh() {
    setRefreshing(true);
    try {
      const fresh = await client.account.getRelationGraph.query({ force: true });
      setOverride(fresh);
    } catch (err) {
      console.error('[relation-graph] refresh failed', err);
    } finally {
      setRefreshing(false);
    }
  }

  function patch(next: Partial<GraphSettings>) {
    setSettings((current) => ({ ...current, ...next }));
  }

  if (!entered) {
    return (
      <section className="weq-graph-embed weq-graph-embed-home">
        <RelationHome
          data={data}
          loading={loading}
          onEnter={() => setEntered(true)}
          onRefresh={refresh}
        />
      </section>
    );
  }

  const overlapMode = isOverlapMode(settings.mode);
  const mode = settings.mode;
  const commonRange = overlapMode ? null : COMMON_THRESHOLD_RANGES[mode];
  const hasNodes = graph ? graph.nodes.some((node) => node.kind !== 'self') : false;
  const filterActive = settings.groupFilterMode !== 'all';

  return (
    <section className="weq-graph-embed">
      <div className="weq-graph-stage">
        <div className="weq-graph-overlay">
          <div className="weq-graph-overlay-bar">
            <button
              className="weq-graph-icon-btn"
              type="button"
              onClick={() => setEntered(false)}
              title="回到群交集首页"
            >
              <ChevronLeft size={15} />
            </button>
            <Segmented
              value={settings.mode}
              onChange={(next) => patch({ mode: next as GraphMode })}
              options={MODE_OPTIONS}
            />
            <button
              className="weq-graph-icon-btn"
              type="button"
              onClick={refresh}
              disabled={loading}
              title="重新扫描群成员，重建关系网"
            >
              <RefreshCw size={15} className={refreshing ? 'weq-spin' : ''} />
            </button>
          </div>
          <span className="weq-graph-overlay-stat">
            {overlapMode && overlap
              ? `${overlap.groups.length} 个群 · ${overlap.totalPeople} 位群友 · ${overlap.pairs.filter((item) => item.weight > 0).length} 对群有交集`
              : graph
                ? `${graph.nodes.length} 节点 · ${graph.edges.length} 连线 · ${graph.communityCount} 圈子`
                : '暂无数据'}
          </span>
        </div>

        {loading ? (
          <div className="weq-graph-state">
            <div className="weq-graph-spinner" />
            <span>正在扫描群成员、计算关系网…首次较慢，之后会缓存。</span>
          </div>
        ) : !data ? (
          <div className="weq-graph-state">
            <Crosshair size={26} />
            <span>没能读到群成员数据，退出 QQ 登录后重试，或点右上角重新扫描。</span>
          </div>
        ) : overlapMode && overlap ? (
          mode === 'chord' ? (
            <OverlapChord
              model={overlap}
              showAvatars={settings.showAvatars}
              direction={settings.overlapDirection}
              onOpenPair={setPair}
            />
          ) : (
            <OverlapMatrix
              model={overlap}
              showAvatars={settings.showAvatars}
              showValues={settings.showValues}
              direction={settings.overlapDirection}
              threshold={settings.overlapThreshold}
              onOpenPair={setPair}
            />
          )
        ) : !hasNodes ? (
          <div className="weq-graph-state">
            <Crosshair size={26} />
            <span>当前条件下没有可显示的节点，试试降低阈值或调整过滤。</span>
          </div>
        ) : graph ? (
          <GraphCanvas
            graph={graph}
            selectedId={selectedId}
            onSelect={(node) => setSelectedId(node && node.kind !== 'self' ? node.id : null)}
            onOpenPerson={(node, anchor) =>
              onOpenMember?.(
                {
                  uid: node.id,
                  uin: node.uin ?? '',
                  nick: node.label,
                  card: '',
                  groupCount: node.groupCount ?? 0,
                  groupCodes: [],
                  intimacy: node.intimacy ?? 0,
                  isFriend: Boolean(node.isFriend),
                },
                anchor,
              )
            }
          />
        ) : null}

        {selected ? <DetailCard node={selected} onClose={() => setSelectedId(null)} /> : null}

        {overlapMode && pair && data ? (
          <OverlapPairCard
            selection={pair}
            data={data}
            onClose={() => setPair(null)}
            onOpenMember={(node, anchor, group) => onOpenMember?.(node, anchor, group)}
          />
        ) : null}
      </div>

      <div className="weq-graph-controls">
        {overlapMode && overlap ? (
          <>
            <div className="weq-graph-col weq-graph-col-sliders">
              <RangeControl
                value={settings.overlapGroupLimit}
                min={6}
                max={Math.max(6, Math.min(80, data?.groups.length || 30))}
                step={2}
                onCommit={(value) => patch({ overlapGroupLimit: value })}
                label="参与计算的群数"
              />
              <RangeControl
                value={settings.overlapThreshold}
                min={settings.overlapDirection === 'small' ? 0 : 1}
                max={Math.max(2, Math.min(60, overlap.maxWeight))}
                step={1}
                onCommit={(value) => patch({ overlapThreshold: value })}
                label={settings.overlapDirection === 'small' ? '最多共同成员' : '最少共同成员'}
                unit={settings.overlapDirection === 'small' ? '≤' : '≥'}
              />
            </div>

            <div className="weq-graph-col">
              <span className="weq-graph-col-label">看哪种重叠</span>
              <Segmented
                small
                value={settings.overlapDirection}
                onChange={(direction) => patch({ overlapDirection: direction as OverlapDirection })}
                options={[
                  { value: 'large', label: '大重叠' },
                  { value: 'small', label: '小重叠' },
                ]}
              />
              <Toggle
                label="显示群头像"
                checked={settings.showAvatars}
                onChange={(value) => patch({ showAvatars: value })}
              />
              <Toggle
                label="格子里写人数"
                checked={settings.showValues}
                onChange={(value) => patch({ showValues: value })}
              />
            </div>

            <div className="weq-graph-col weq-graph-col-filter">
              <span className="weq-graph-col-label">
                <LayoutGrid size={13} />
                排序与过滤
              </span>
              <Segmented
                small
                value={settings.overlapSort}
                onChange={(sort) => patch({ overlapSort: sort as GraphSettings['overlapSort'] })}
                options={[
                  { value: 'overlap', label: '重合总量' },
                  { value: 'size', label: '群规模' },
                  { value: 'name', label: '群名' },
                ]}
              />
              <GroupFilterButton
                active={filterActive}
                count={settings.groupFilter.length}
                onClick={() => setPickerOpen(true)}
                disabled={groupOptions.length === 0}
              />
              <p className="weq-graph-hint">
                大重叠找「同一批人在哪几个群」，小重叠找「几乎不挨着、但人群相投」的群。
              </p>
            </div>

            <div className="weq-graph-col weq-graph-col-rank">
              <span className="weq-graph-col-label">
                <Trophy size={13} />
                排行榜
              </span>
              {RANK_BUTTONS.map((button) => (
                <button
                  key={button.kind}
                  type="button"
                  className="weq-graph-rank-btn"
                  disabled={button.kind !== 'intimacy' && button.kind !== 'groupActivity' && !data}
                  onClick={() => setRankOpen(button.kind)}
                >
                  {button.icon}
                  <span>{button.label}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="weq-graph-col weq-graph-col-sliders">
              <RangeControl
                value={settings.nodeLimit}
                min={10}
                max={200}
                step={5}
                onCommit={(value) => patch({ nodeLimit: value })}
                label="节点数量"
              />
              {commonRange ? (
                <RangeControl
                  value={settings.minCommon}
                  min={commonRange.min}
                  max={commonRange.max}
                  step={1}
                  onCommit={(value) => patch({ minCommon: value })}
                  label={commonRange.label}
                  unit="≥"
                />
              ) : null}
            </div>

            {mode === 'people' ? (
              <div className="weq-graph-col">
                <span className="weq-graph-col-label">好友权重</span>
                <Toggle
                  label="仅显示好友"
                  checked={settings.friendsOnly}
                  onChange={(value) => patch({ friendsOnly: value })}
                />
                <Toggle
                  label="亲密度决定大小"
                  checked={settings.intimacySize}
                  onChange={(value) => patch({ intimacySize: value })}
                />
                <Toggle
                  label="亲密度决定拉力"
                  checked={settings.intimacyPull}
                  onChange={(value) => patch({ intimacyPull: value })}
                />
              </div>
            ) : (
              <div className="weq-graph-col">
                <span className="weq-graph-col-label">群聊权重</span>
                <Toggle
                  label="等级决定大小"
                  checked={settings.groupLevelSize}
                  onChange={(value) => patch({ groupLevelSize: value })}
                />
                <Toggle
                  label="等级决定拉力"
                  checked={settings.groupLevelPull}
                  onChange={(value) => patch({ groupLevelPull: value })}
                />
              </div>
            )}

            <div className="weq-graph-col weq-graph-col-filter">
              <span className="weq-graph-col-label">
                <LayoutGrid size={13} />
                群过滤
              </span>
              <Segmented
                small
                value={settings.groupFilterMode}
                onChange={(next) => patch({ groupFilterMode: next as GroupFilterMode })}
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'whitelist', label: '白名单' },
                  { value: 'blacklist', label: '黑名单' },
                ]}
              />
              <GroupFilterButton
                active={filterActive}
                count={settings.groupFilter.length}
                onClick={() => setPickerOpen(true)}
                disabled={!filterActive || groupOptions.length === 0}
              />
              <p className="weq-graph-hint">
                {settings.groupFilterMode === 'whitelist'
                  ? '只统计选中的群。'
                  : settings.groupFilterMode === 'blacklist'
                    ? '排除选中的群。'
                    : '纳入全部群聊参与计算。'}
              </p>
            </div>

            <div className="weq-graph-col weq-graph-col-rank">
              <span className="weq-graph-col-label">
                <Trophy size={13} />
                排行榜
              </span>
              {RANK_BUTTONS.map((button) => (
                <button
                  key={button.kind}
                  type="button"
                  className="weq-graph-rank-btn"
                  disabled={button.kind !== 'intimacy' && button.kind !== 'groupActivity' && !data}
                  onClick={() => setRankOpen(button.kind)}
                >
                  {button.icon}
                  <span>{button.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
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
        <RankingModal
          kind={rankOpen}
          data={data}
          onClose={() => setRankOpen(null)}
          onOpenMember={(member, anchor) =>
            onOpenMember?.(
              {
                uid: member.uid,
                uin: member.uin,
                nick: member.nick ?? '',
                card: member.card ?? '',
                groupCount: 0,
                groupCodes: [],
                intimacy: 0,
                isFriend: true,
              },
              anchor,
              member.groupCode
                ? { code: member.groupCode, name: member.groupName ?? '' }
                : undefined,
            )
          }
        />
      ) : null}
    </section>
  );
}

function GroupFilterButton({ active, count, onClick, disabled }) {
  return (
    <button className="weq-graph-pick-btn" type="button" disabled={disabled} onClick={onClick}>
      <span>{active ? '选择群聊' : '全部群聊参与计算'}</span>
      {active ? <span className="weq-graph-pick-count">{count}</span> : null}
      <ChevronDown size={13} className="weq-graph-pick-caret" />
    </button>
  );
}

/**
 * Lightbox group picker for the white/black-list — draft selection lives here
 * and only commits to the graph on 确认. Modelled on the contacts detail card /
 * create-group modal (scrim + escape-to-close + searchable checklist).
 */
function GroupPickerModal({ groups, mode, value, onClose, onConfirm }) {
  const [draft, setDraft] = useState<Set<string>>(() => new Set(value));
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((group) => group.name.toLowerCase().includes(q) || group.code.includes(q));
  }, [groups, query]);

  const allSelected = filtered.length > 0 && filtered.every((group) => draft.has(group.code));

  const multi = useMultiSelection({
    ids: filtered.map((group) => group.code),
    selected: draft,
    onChange: setDraft,
    onExit: onClose,
  });

  function toggleAll() {
    setDraft((current) => {
      const next = new Set(current);
      if (allSelected) {
        for (const group of filtered) next.delete(group.code);
      } else {
        for (const group of filtered) next.add(group.code);
      }
      return next;
    });
  }

  const title = mode === 'blacklist' ? '选择要排除的群' : '选择要统计的群';

  return (
    <OverlayLayer className="modal-scrim weq-graph-modal-scrim" onClose={onClose}>
      <section className="weq-grouppick" role="dialog" aria-modal="true" {...multi.rootProps}>
        <header className="weq-grouppick-head">
          <div>
            <strong>{title}</strong>
            <span>
              {mode === 'blacklist' ? '黑名单' : '白名单'} · 共 {groups.length} 个群
            </span>
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
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" title="清空" onClick={() => setQuery('')}>
              <X size={15} />
            </button>
          ) : null}
        </div>

        <button className="weq-grouppick-all" type="button" onClick={toggleAll}>
          <CheckCheck size={15} />
          {allSelected ? '取消全选' : '全选'}
          <span>{filtered.length} 个</span>
        </button>

        <div className="weq-grouppick-list">
          {filtered.length === 0 ? (
            <p className="weq-grouppick-empty">没有匹配的群聊</p>
          ) : (
            filtered.map((group) => {
              const checked = draft.has(group.code);
              const avatar = groupAvatar(group.code);
              return (
                <button
                  key={group.code}
                  type="button"
                  className={`weq-grouppick-row${checked ? ' is-on' : ''}`}
                  {...multi.itemProps(group.code)}
                >
                  <span className="weq-grouppick-avatar">
                    {avatar ? (
                      <img src={avatar} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <span>{(group.name || '?').slice(0, 1)}</span>
                    )}
                  </span>
                  <span className="weq-grouppick-meta">
                    <strong title={group.name}>{group.name || group.code}</strong>
                    <small>
                      命中 {group.sharedCount} 位 · {group.memberCount} 人
                    </small>
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
    </OverlayLayer>
  );
}

function DetailCard({ node, onClose }) {
  const avatar =
    node.kind === 'person' ? personAvatar(node.uin ?? '') : groupAvatar(node.code ?? '');
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
            <span>{(node.label || '?').slice(0, 1)}</span>
          )}
        </span>
        <div className="weq-graph-detail-id">
          <strong title={node.label}>{node.label}</strong>
          <span>{node.kind === 'person' ? node.uin : `群 ${node.code}`}</span>
        </div>
      </div>
      <div className="weq-graph-detail-rows">
        {node.kind === 'person' ? (
          <>
            <DetailRow label="关系" value={node.isFriend ? '好友' : '群友'} />
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
      <strong className={accent ? 'is-accent' : ''}>{value}</strong>
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

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function change(next: number) {
    const clamped = clampNumber(next, min, max);
    setLocal(clamped);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(clamped), 140);
  }

  const clampedLocal = clampNumber(local, min, max);
  const pct = max === min ? 100 : ((clampedLocal - min) / (max - min)) * 100;

  return (
    <label className="weq-graph-slider">
      <span className="weq-graph-slider-top">
        <span className="weq-graph-slider-label">{label}</span>
        <span className="weq-graph-slider-value">
          {unit ? `${unit} ` : ''}
          {clampedLocal}
        </span>
      </span>
      <input
        className="weq-graph-range"
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        type="range"
        min={min}
        max={max}
        step={step}
        value={clampedLocal}
        onChange={(event) => change(Number(event.target.value))}
      />
    </label>
  );
}

function scaleCommonThreshold(
  value: number,
  from: { min: number; max: number },
  to: { min: number; max: number },
) {
  const pct = (value - from.min) / Math.max(1, from.max - from.min);
  const scaled = to.min + pct * (to.max - to.min);
  return Math.round(Math.min(Math.max(scaled, to.min), to.max));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function Segmented({ value, onChange, options, small }) {
  return (
    <div className={`weq-graph-seg${small ? ' is-small' : ''}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'is-active' : ''}
          onClick={() => onChange(option.value)}
          title={option.label}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <button
      type="button"
      className={`weq-graph-toggle${checked ? ' is-on' : ''}`}
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
