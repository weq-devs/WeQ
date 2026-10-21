// @ts-nocheck
/**
 * 群聊小团体力导图 —— 按**聊天会话**里的拉力画的一张图。
 *
 * 数据来自 `getGroupConversationGraph`（服务端按 5 分钟间隔切会话，会话内两人
 * 拉力 = 各自发言条数之积，跨会话求和）。这里只负责把它画出来：
 *
 *   - 节点 = 参与过对话的人，半径按发言量；颜色按拉力聚类（标签传播）分出小圈子；
 *   - 边 = 拉力，越强越短越粗；拉力跨了数量级，所以映射前先取 `log1p`；
 *   - 头像走 `weq-avatar://` 缓存协议，和联系人关系网同一套渲染手法。
 *
 * 交互参考联系人关系网：拖节点、滚轮缩放、悬停高亮这个人的圈子和连线。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTabActive } from './RetainedTabs';
import { useThemeStore } from '../state/theme';
import { usePrefersReducedMotion } from '../views/annual-report/Odometer';
import * as d3 from 'd3';
import { cachedAvatarUrl } from '../lib/avatarCache';
import { formatNumber } from './analyticsCharts';

interface WireNode {
  uid: string;
  uin: string;
  displayName: string;
  messageCount: number;
  conversationCount: number;
  pull: number;
}

interface WireEdge {
  source: string;
  target: string;
  pull: number;
  conversations: number;
}

export interface ConversationGraphReport {
  windowSeconds: number;
  conversationCount: number;
  messageCount: number;
  nodes: WireNode[];
  edges: WireEdge[];
  totalPairs: number;
}

interface GNode {
  id: string;
  label: string;
  avatarUrl: string | null;
  uin: string;
  messageCount: number;
  conversationCount: number;
  pull: number;
  community: number;
  radius: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}

interface GEdge {
  source: GNode | string;
  target: GNode | string;
  pull: number;
  conversations: number;
  /** 弹簧强度（log 归一化后的拉力）。 */
  strength: number;
  /** 期望弹簧长度：拉力越强越短。 */
  dist: number;
}

/**
 * 离屏导出时手动推进物理模拟的步数。
 *
 * 导出舞台是刚挂载的，force 布局会从 alpha=1 开始降温，而抓帧只等一两帧 —— 等它自然
 * 冷却的话，拍到的是一张还在飘的半成品。所以 `instant` 模式下直接同步跑完再画。
 */
const INSTANT_TICKS = 300;

/** 图里最多画多少个节点 —— 再多就糊成一团，取拉力最强的这些。 */
const MAX_NODES = 160;
/** 社区配色，和联系人关系网同款。 */
const COMMUNITY_COLORS = [
  '#0099ff',
  '#36c08f',
  '#f6a23c',
  '#ef6f6c',
  '#9b6dff',
  '#2bb6d6',
  '#e072b8',
  '#7e8bd9',
  '#5bbf6a',
  '#d98c4a',
];

function communityColor(community: number, accent = 'var(--weq-accent-effective)'): string {
  const index = community % COMMUNITY_COLORS.length;
  return index === 0 ? accent : COMMUNITY_COLORS[index]!;
}

function personAvatar(uin: string): string | null {
  return uin && uin !== '0'
    ? cachedAvatarUrl(`https://thirdqq.qlogo.cn/g?b=sdk&s=100&nk=${uin}`)
    : null;
}

/**
 * 头像缺位时的简笔人像：头 + 肩，画在节点圆内。
 *
 * 画布上没法复用 React 的默认头像（`DefaultAvatar` 是聊天消息用的卡通占位，缩到
 * 十几像素后五官糊成一团），所以这里用两笔几何图形表达「这是个人」。
 */
function drawPersonGlyph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y - radius * 0.22, radius * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y + radius * 0.62, radius * 0.62, Math.PI * 1.08, Math.PI * 1.92);
  ctx.fill();
  ctx.restore();
}

/**
 * 社区色 → 同色系的淡底。
 *
 * canvas 的 `fillStyle` 不认 `color-mix()` / CSS 变量，只能自己把十六进制拆成 rgba。
 * 社区色可能是 `var(--weq-accent-effective)`（主题色，运行时被浏览器解析成十六进制），
 * 也可能是硬编码色；解析不出来时退回中性灰底。
 */
function colorMixForGlyph(color: string): string {
  const hex = color.trim().match(/^#([\da-f]{6})$/i)?.[1];
  if (!hex) return 'rgba(128, 138, 150, 0.2)';
  const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, 0.2)`;
}

/**
 * 加权标签传播找小圈子：反复采纳邻居里权重和最大的标签。几百个节点足够用，
 * 而且完全不需要引入额外的社区发现依赖。
 */
function detectCommunities(nodes: GNode[], edges: GEdge[]): number {
  if (nodes.length === 0) return 0;
  const adj = new Map<string, Array<{ id: string; w: number }>>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.source)?.push({ id: e.target, w: e.pull });
    adj.get(e.target)?.push({ id: e.source, w: e.pull });
  }

  const label = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) label.set(nodes[i]!.id, i);

  for (let iter = 0; iter < 12; iter++) {
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

/**
 * 把上报数据整理成可模拟的图：节点按拉力裁剪到 {@link MAX_NODES}，边按 log 拉力
 * 映射成弹簧长度与强度（拉力跨数量级，线性映射会让强边把图拽成一坨）。
 */
function buildModel(report: ConversationGraphReport): {
  nodes: GNode[];
  edges: GEdge[];
  communityCount: number;
} {
  if (report.nodes.length === 0 || report.edges.length === 0) {
    return { nodes: [], edges: [], communityCount: 0 };
  }

  const keptNodes = [...report.nodes].sort((a, b) => b.pull - a.pull).slice(0, MAX_NODES);
  const allowed = new Set(keptNodes.map((n) => n.uid));
  const maxMessages = Math.max(...keptNodes.map((n) => n.messageCount), 1);
  const nodes: GNode[] = keptNodes.map((n) => {
    const t = Math.sqrt(Math.max(n.messageCount, 0)) / Math.sqrt(maxMessages);
    return {
      id: n.uid,
      label: n.displayName || n.uin || n.uid,
      avatarUrl: personAvatar(n.uin),
      uin: n.uin,
      messageCount: n.messageCount,
      conversationCount: n.conversationCount,
      pull: n.pull,
      community: 0,
      radius: 9 + t * 15,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    };
  });

  const rawEdges = report.edges.filter((e) => allowed.has(e.source) && allowed.has(e.target));
  const maxPull = Math.max(...rawEdges.map((e) => e.pull), 1);
  const logMax = Math.log1p(maxPull);
  const edges: GEdge[] = rawEdges.map((e) => {
    const t = logMax > 0 ? Math.log1p(e.pull) / logMax : 1;
    return {
      source: e.source,
      target: e.target,
      pull: e.pull,
      conversations: e.conversations,
      strength: 0.04 + 0.5 * t,
      dist: 320 - 250 * t, // 拉力越强，拉得越近
    };
  });

  const communityCount = detectCommunities(nodes, edges);
  return { nodes, edges, communityCount };
}

export function GroupConversationGraph({
  report,
  instant: forceInstant = false,
}: {
  report: ConversationGraphReport;
  /** 离屏导出舞台用：一把算完布局，不等动画降温。 */
  instant?: boolean;
}) {
  const tabActive = useTabActive();
  const reduce = usePrefersReducedMotion();
  const instant = forceInstant || reduce;
  const theme = useThemeStore((state) => state.resolved);
  const accentSetting = useThemeStore((state) => state.accent);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const simulationRef = useRef<d3.Simulation<GNode, undefined> | null>(null);
  const viewRef = useRef({ scale: 0.9, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const imgCache = useRef(new Map<string, HTMLImageElement>());
  const didInitViewRef = useRef(false);
  const drawRafRef = useRef(0);
  const hoverRef = useRef<GNode | null>(null);
  const dragNodeRef = useRef<GNode | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(0);
  const drawRef = useRef(() => {});
  const centerViewRef = useRef(() => {});

  const [hoverNode, setHoverNode] = useState<GNode | null>(null);

  const model = useMemo(() => buildModel(report), [report]);

  function scheduleDraw() {
    if (drawRafRef.current) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = 0;
      drawRef.current();
    });
  }

  function getImage(url: string): HTMLImageElement | null {
    if (!url) return null;
    const cache = imgCache.current;
    const cached = cache.get(url);
    if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = scheduleDraw;
    img.src = url;
    cache.set(url, img);
    return null;
  }

  function centerView() {
    const { w, h } = sizeRef.current;
    const s = viewRef.current.scale;
    viewRef.current.x = (w / 2) * (1 - s);
    viewRef.current.y = (h / 2) * (1 - s);
  }
  centerViewRef.current = centerView;

  function screenToWorld(sx: number, sy: number) {
    const v = viewRef.current;
    return { x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale };
  }

  function nodeAt(sx: number, sy: number): GNode | null {
    const simulation = simulationRef.current;
    if (!simulation) return null;
    const { x, y } = screenToWorld(sx, sy);
    const nodes = simulation.nodes();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      const dx = n.x - x;
      const dy = n.y - y;
      if (dx * dx + dy * dy <= (n.radius + 3) * (n.radius + 3)) return n;
    }
    return null;
  }

  // 图变化时重建模拟：复用上一次的坐标，避免节点满屏乱飞。
  useEffect(() => {
    if (!tabActive) return;
    const { w, h } = sizeRef.current;
    const prevSim = simulationRef.current;
    if (prevSim) {
      const prev = new Map(prevSim.nodes().map((n) => [n.id, n]));
      for (const n of model.nodes) {
        const p = prev.get(n.id);
        if (p && p.x != null && p.y != null) {
          n.x = p.x;
          n.y = p.y;
          n.vx = p.vx;
          n.vy = p.vy;
        }
      }
      prevSim.stop();
    }

    const sim = d3
      .forceSimulation(model.nodes)
      .force(
        'link',
        d3
          .forceLink(model.edges)
          .id((d: GNode) => d.id)
          .distance((d: GEdge) => d.dist)
          .strength((d: GEdge) => d.strength),
      )
      .force('charge', d3.forceManyBody().strength(-190))
      .force(
        'collide',
        d3
          .forceCollide()
          .radius((d: GNode) => d.radius + 3)
          .iterations(2),
      )
      .force('center', d3.forceCenter(w / 2 || 400, h / 2 || 260)); // 离屏导出：一步到位把布局算完，别让抓帧撞上还在飘的半成品。
    if (instant) {
      sim.stop();
      for (let i = 0; i < INSTANT_TICKS; i++) sim.tick();
    } else {
      sim.on('tick', () => drawRef.current());
    }

    simulationRef.current = sim;

    return () => {
      sim.stop();
      if (drawRafRef.current) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = 0;
      }
    };
  }, [model, instant, tabActive]);

  useEffect(() => {
    if (!tabActive) return;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;

    function applySize() {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const sim = simulationRef.current;
      sim?.force('center', d3.forceCenter(rect.width / 2, rect.height / 2));
      if (instant) {
        // 尺寸定下来之后再定一次局：这样物理中心才是真正的画布中心。
        sim?.stop();
        for (let i = 0; i < INSTANT_TICKS; i++) sim?.tick();
        drawRef.current();
      } else {
        sim?.alpha(0.3).restart();
      }
      if (!didInitViewRef.current && rect.width > 0) {
        didInitViewRef.current = true;
        centerViewRef.current();
      }
    }

    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(wrap);
    return () => ro.disconnect();
    // `instant` 决定首次定完尺寸后是「直接算完」还是「让力图自己降温」，所以它变了得重挂。
  }, [instant, tabActive]);

  useEffect(() => {
    if (tabActive) drawRef.current();
  }, [theme, accentSetting, tabActive]);

  function draw() {
    const canvas = canvasRef.current;
    const simulation = simulationRef.current;
    if (!canvas || !simulation) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { w, h, dpr } = sizeRef.current;
    const v = viewRef.current;
    const styles = getComputedStyle(canvas);
    const accent = styles.getPropertyValue('--weq-accent-effective').trim();
    const labelFill = styles.getPropertyValue('--weq-fg-primary').trim();
    const labelHalo = styles.getPropertyValue('--weq-bg-surface').trim();
    const neutral = styles.getPropertyValue('--weq-border-strong').trim();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(v.x, v.y);
    ctx.scale(v.scale, v.scale);

    const nodes = simulation.nodes();
    const index = new Map(nodes.map((n) => [n.id, n]));
    const focus = hoverRef.current?.id ?? null;
    const focusNeighbours = new Set<string>();
    if (focus) {
      for (const e of model.edges) {
        const s = typeof e.source === 'object' ? e.source.id : e.source;
        const t = typeof e.target === 'object' ? e.target.id : e.target;
        if (s === focus) focusNeighbours.add(t);
        else if (t === focus) focusNeighbours.add(s);
      }
    }

    const maxEdgePull = Math.max(...model.edges.map((e) => e.pull), 1);
    for (const e of model.edges) {
      const s = typeof e.source === 'object' ? e.source : index.get(e.source);
      const t = typeof e.target === 'object' ? e.target : index.get(e.target);
      if (!s || !t) continue;
      const active = focus && (s.id === focus || t.id === focus);
      const t01 = Math.log1p(e.pull) / Math.log1p(maxEdgePull);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = active ? accent : neutral;
      ctx.globalAlpha = active ? 0.6 : 0.4;
      ctx.lineWidth = active ? 1 + t01 * 3 : 0.5 + t01 * 2.4;
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of nodes) {
      const color = communityColor(n.community, accent);
      const dim = focus && n.id !== focus && !focusNeighbours.has(n.id);
      const r = n.radius;
      ctx.globalAlpha = dim ? 0.3 : 1;

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      // 默认头像也不能是一整块高饱和的社区色 —— 那会被误读成「某人的头像」。
      // 底色压成低饱和的同色底，让人像剪影读得出来。
      ctx.fillStyle = n.avatarUrl ? color : colorMixForGlyph(color);
      ctx.fill();

      const img = n.avatarUrl ? getImage(n.avatarUrl) : null;
      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(n.x, n.y, r - 1.5, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, n.x - r, n.y - r, r * 2, r * 2);
        ctx.restore();
      } else {
        // 拿不到头像时画一枚简笔人像（与列表里的默认头像同一语义），
        // 不用昵称首字 —— 中文名取首字既认不出人，也和头像的圆形语义不符。
        drawPersonGlyph(ctx, n.x, n.y, r, labelFill);
      }

      const isFocus = n.id === focus;
      ctx.lineWidth = isFocus ? 3 : 1.5;
      ctx.strokeStyle = isFocus ? accent : color;
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.stroke();

      if (!dim && (isFocus || focusNeighbours.has(n.id) || r >= 20 || v.scale >= 1.1)) {
        ctx.globalAlpha = 1;
        const fontPx = Math.max(10, 11 / v.scale);
        ctx.font = `500 ${fontPx}px ${styles.fontFamily}`;
        const label = n.label.length > 10 ? `${n.label.slice(0, 10)}…` : n.label;
        ctx.lineWidth = 3 / v.scale;
        ctx.strokeStyle = labelHalo;
        ctx.strokeText(label, n.x, n.y + r + fontPx * 0.9);
        ctx.fillStyle = labelFill;
        ctx.fillText(label, n.x, n.y + r + fontPx * 0.9);
      }
    }
    ctx.globalAlpha = 1;
  }
  drawRef.current = draw;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const rect = wrapRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    movedRef.current = 0;
    const hit = nodeAt(sx, sy);
    if (hit) {
      dragNodeRef.current = hit;
      const world = screenToWorld(sx, sy);
      hit.fx = world.x;
      hit.fy = world.y;
      simulationRef.current?.alphaTarget(0.3).restart();
    } else {
      panRef.current = { x: e.clientX, y: e.clientY };
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const rect = wrapRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (dragNodeRef.current) {
      movedRef.current += Math.abs(e.movementX) + Math.abs(e.movementY);
      const world = screenToWorld(sx, sy);
      dragNodeRef.current.fx = world.x;
      dragNodeRef.current.fy = world.y;
      return;
    }
    if (panRef.current) {
      movedRef.current += Math.abs(e.movementX) + Math.abs(e.movementY);
      viewRef.current.x += e.clientX - panRef.current.x;
      viewRef.current.y += e.clientY - panRef.current.y;
      panRef.current = { x: e.clientX, y: e.clientY };
      draw();
      return;
    }

    const hit = nodeAt(sx, sy);
    if (hit !== hoverRef.current) {
      hoverRef.current = hit;
      setHoverNode(hit);
      draw();
    }
    if (hit && tooltipRef.current) {
      tooltipRef.current.style.left = `${sx + 14}px`;
      tooltipRef.current.style.top = `${sy + 14}px`;
    }
    if (wrapRef.current) wrapRef.current.style.cursor = hit ? 'pointer' : 'grab';
  }

  function endPointer() {
    const node = dragNodeRef.current;
    if (node) {
      node.fx = null;
      node.fy = null;
      simulationRef.current?.alphaTarget(0);
    }
    dragNodeRef.current = null;
    panRef.current = null;
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    const rect = wrapRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const v = viewRef.current;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(Math.max(v.scale * factor, 0.25), 4);
    const wx = (mx - v.x) / v.scale;
    const wy = (my - v.y) / v.scale;
    v.scale = next;
    v.x = mx - wx * next;
    v.y = my - wy * next;
    draw();
  }

  const windowMinutes = Math.max(1, Math.round(report.windowSeconds / 60));

  if (report.nodes.length === 0) {
    return (
      <p className="ga-placeholder">
        这个群还没聊出成对的对话 —— 要么消息太少，要么基本都是各说各的。
      </p>
    );
  }

  return (
    <div className="cg-wrap">
      <div
        ref={wrapRef}
        className="cg-canvas-wrap"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerLeave={() => {
          endPointer();
          hoverRef.current = null;
          setHoverNode(null);
        }}
        onWheel={onWheel}
      >
        <canvas ref={canvasRef} className="cg-canvas" />
        <div
          ref={tooltipRef}
          className="cg-tooltip"
          style={{ display: hoverNode ? 'block' : 'none' }}
        >
          {hoverNode ? (
            <>
              <strong>{hoverNode.label}</strong>
              <span>
                {formatNumber(hoverNode.messageCount)} 条发言 · 参与 {hoverNode.conversationCount}{' '}
                段对话
              </span>
              <span>拉力合计 {formatNumber(hoverNode.pull)}</span>
            </>
          ) : null}
        </div>
        <div className="cg-legend">
          <span className="cg-legend-stat">
            {model.nodes.length} 人 · {model.edges.length} 条拉力线 ·{' '}
            {Math.max(...model.nodes.map((n) => n.community)) + 1} 个小圈子
          </span>
          <span className="cg-legend-hint">拖节点 / 滚轮缩放 · 会话边界 {windowMinutes} 分钟</span>
        </div>
      </div>
    </div>
  );
}
