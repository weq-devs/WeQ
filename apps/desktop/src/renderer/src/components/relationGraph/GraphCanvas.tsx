// @ts-nocheck
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Scan } from 'lucide-react';
import { usePrivacyStore } from '../../state/privacy';
import { communityColor, graphNodeLabel } from './graphModel';
import type { BuiltGraph, GNode } from './types';
import { fitGraphView, type GraphView } from './graphLayout';
import { createGraphSimulationClient } from './graphSimulationClient';
import { indexGraphHit, indexGraphRender, type RenderEdge } from './graphRender';

export function GraphCanvas({
  graph,
  selectedId,
  onSelect,
  showRemarks = false,
}: {
  graph: BuiltGraph;
  selectedId: string | null;
  onSelect: (node: GNode | null, anchor: { x: number; y: number }) => void;
  showRemarks?: boolean;
}) {
  const privacy = usePrivacyStore((state) => state.effective);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const simulationRef = useRef<ReturnType<typeof createGraphSimulationClient> | null>(null);

  const viewRef = useRef<GraphView>({ scale: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const autoFitRef = useRef(true);
  const drawRafRef = useRef(0);
  const renderIndexRef = useRef<ReturnType<typeof indexGraphRender> | null>(null);
  const hitIndexRef = useRef<ReturnType<typeof indexGraphHit> | null>(null);

  const hoverRef = useRef<GNode | null>(null);
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;

  const dragNodeRef = useRef<GNode | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(0);

  const [hoverNode, setHoverNode] = useState<GNode | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // 动画与 ResizeObserver 通过 ref 使用最新渲染，不反复重建模拟。
  const drawRef = useRef<() => void>(() => {});
  const fitViewRef = useRef<() => void>(() => {});

  // Coalesce redraws into one per frame — when many avatars finish loading at
  // once we don't want a draw() per image.
  const scheduleDraw = useCallback((): void => {
    if (drawRafRef.current) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = 0;
      drawRef.current();
    });
  }, []);

  function getImage(url: string): HTMLImageElement | null {
    if (!url) return null;
    const cache = imgCache.current;
    const cached = cache.get(url);
    if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    // The sim stops ticking once it settles; repaint when a late avatar lands
    // so it actually shows up without needing a hover/drag to force a draw.
    img.onload = scheduleDraw;
    img.src = url;
    cache.set(url, img);
    return null;
  }

  function fitView(): void {
    const { w, h } = sizeRef.current;
    const wrap = wrapRef.current;
    const overlay = wrap?.parentElement?.querySelector('.weq-graph-overlay');
    const top =
      overlay && wrap
        ? overlay.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top + 12
        : 96;
    viewRef.current = fitGraphView(simulationRef.current?.nodes() ?? [], w, h, top);
    drawRef.current();
  }
  fitViewRef.current = fitView;

  function screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const v = viewRef.current;
    return { x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale };
  }

  function nodeAt(sx: number, sy: number): GNode | null {
    const simulation = simulationRef.current;
    if (!simulation) return null;
    const { x, y } = screenToWorld(sx, sy);
    hitIndexRef.current ??= indexGraphHit(simulation.nodes());
    return hitIndexRef.current(x, y);
  }

  useEffect(() => {
    const prevSim = simulationRef.current;
    const previous = prevSim?.nodes().map(({ id, x, y, vx, vy }) => ({ id, x, y, vx, vy })) ?? [];
    prevSim?.stop();
    dragNodeRef.current = null;
    panRef.current = null;
    hoverRef.current = null;
    setHoverNode(null);
    setSimulationError(null);
    renderIndexRef.current = indexGraphRender(graph);
    hitIndexRef.current = null;
    const sim = createGraphSimulationClient(
      graph,
      previous,
      () => {
        hitIndexRef.current = null;
        if (autoFitRef.current) fitViewRef.current();
        else scheduleDraw();
      },
      setSimulationError,
    );
    simulationRef.current = sim;

    return () => {
      sim.stop();
      if (drawRafRef.current) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = 0;
      }
    };
  }, [graph, attempt, scheduleDraw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;

    function applySize() {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (rect.width <= 0 || rect.height <= 0) return;
      const previous = sizeRef.current;
      if (previous.w === rect.width && previous.h === rect.height && previous.dpr === dpr) return;
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;

      if (autoFitRef.current) fitViewRef.current();
      else {
        viewRef.current.x += (rect.width - previous.w) / 2;
        viewRef.current.y += (rect.height - previous.h) / 2;
        drawRef.current();
      }
    }

    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  function draw() {
    const canvas = canvasRef.current;
    const simulation = simulationRef.current;
    if (!canvas || !simulation) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { w, h, dpr } = sizeRef.current;
    const v = viewRef.current;
    // Node labels must flip with the theme — dark text + white halo is
    // unreadable on the dark canvas, so swap to light text + dark halo.
    const dark = document.documentElement.dataset.theme === 'dark';
    const labelFill = dark ? '#c8d0da' : '#33455a';
    const labelHalo = dark ? 'rgba(8,10,13,0.85)' : 'rgba(255,255,255,0.85)';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(v.x, v.y);
    ctx.scale(v.scale, v.scale);

    const nodes = simulation.nodes();
    const topology = renderIndexRef.current;
    if (!topology) return;
    const focus = hoverRef.current?.id ?? selectedRef.current ?? null;
    const focusNeighbours = topology.adjacent.get(focus) ?? new Set<string>();
    const left = -v.x / v.scale;
    const right = (w - v.x) / v.scale;
    const top = -v.y / v.scale;
    const bottom = (h - v.y) / v.scale;

    function strokeEdges(edges: RenderEdge[], excludeFocus = false) {
      ctx.beginPath();
      let count = 0;
      for (const { source: s, target: t } of edges) {
        if (excludeFocus && (s.id === focus || t.id === focus)) continue;
        // 两端在视口同侧的线段不可能可见；保留穿过画布的线段。
        if (
          Math.max(s.x, t.x) < left - 4 ||
          Math.min(s.x, t.x) > right + 4 ||
          Math.max(s.y, t.y) < top - 4 ||
          Math.min(s.y, t.y) > bottom + 4
        )
          continue;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        // 限制单条路径的大小，避免超密图在浏览器内构建巨型路径。
        if (++count % 2048 === 0) {
          ctx.stroke();
          ctx.beginPath();
        }
      }
      if (count % 2048) ctx.stroke();
    }
    for (const batch of topology.batches) {
      ctx.strokeStyle = batch.self ? 'rgba(120,140,165,0.07)' : 'rgba(120,140,165,0.18)';
      ctx.lineWidth = batch.width;
      strokeEdges(batch.edges, Boolean(focus));
    }
    if (focus) {
      const active = new Map<number, RenderEdge[]>();
      for (const edge of topology.incident.get(focus) ?? []) {
        const width = Math.min(1 + edge.weight * 0.5, 4);
        const batch = active.get(width) ?? [];
        batch.push(edge);
        active.set(width, batch);
      }
      ctx.strokeStyle = 'rgba(0,153,255,0.55)';
      for (const [width, edges] of active) {
        ctx.lineWidth = width;
        strokeEdges(edges);
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of nodes) {
      const margin = n.radius + 80 / Math.min(v.scale, 1);
      if (
        n.x + margin < left ||
        n.x - margin > right ||
        n.y + margin < top ||
        n.y - margin > bottom
      )
        continue;
      const isSelfNode = n.kind === 'self';
      const color = isSelfNode ? '#0a7fd0' : communityColor(n.community);
      const dim = focus && n.id !== focus && !focusNeighbours.has(n.id);
      const r = n.radius;

      ctx.globalAlpha = dim ? 0.35 : 1;

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      const avatarVisible =
        n.x + r >= left && n.x - r <= right && n.y + r >= top && n.y - r <= bottom;
      const img = !privacy && avatarVisible && n.avatarUrl ? getImage(n.avatarUrl) : null;
      if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(n.x, n.y, r - 1.5, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, n.x - r, n.y - r, r * 2, r * 2);
        ctx.restore();
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.font = `600 ${Math.round(r)}px var(--font-sans, sans-serif)`;
        ctx.fillText(privacy ? '•' : (n.label || '?').slice(0, 1), n.x, n.y + 1);
      }

      const isFocus = n.id === focus;
      ctx.lineWidth = isFocus || isSelfNode ? 3 : 1.5;
      ctx.strokeStyle = isFocus ? '#0099ff' : isSelfNode ? '#0a7fd0' : color;
      ctx.globalAlpha = dim ? 0.4 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.stroke();

      if (
        !privacy &&
        !dim &&
        (isSelfNode || isFocus || focusNeighbours.has(n.id) || r >= 22 || v.scale >= 1.1)
      ) {
        ctx.globalAlpha = 1;
        const fontPx = Math.max(10, 11 / v.scale);
        ctx.font = `500 ${fontPx}px var(--font-sans, sans-serif)`;
        const name = graphNodeLabel(n, showRemarks);
        const label = name.length > 12 ? `${name.slice(0, 12)}…` : name;
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

  useEffect(() => {
    drawRef.current();
  }, [privacy, selectedId, showRemarks]);

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
      simulationRef.current?.pin(hit.id, world.x, world.y);
      hitIndexRef.current = null;
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
      if (movedRef.current < 4) return;
      autoFitRef.current = false;
      const w = screenToWorld(sx, sy);
      simulationRef.current?.pin(dragNodeRef.current.id, w.x, w.y);
      hitIndexRef.current = null;
      scheduleDraw();
      return;
    }
    if (panRef.current) {
      movedRef.current += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (movedRef.current < 4) return;
      autoFitRef.current = false;
      viewRef.current.x += e.clientX - panRef.current.x;
      viewRef.current.y += e.clientY - panRef.current.y;
      panRef.current = { x: e.clientX, y: e.clientY };
      scheduleDraw();
      return;
    }

    const hit = nodeAt(sx, sy);
    if (hit !== hoverRef.current) {
      hoverRef.current = hit;
      setHoverNode(hit);
      scheduleDraw();
    }
    if (hit && tooltipRef.current) {
      tooltipRef.current.style.left = `${sx + 14}px`;
      tooltipRef.current.style.top = `${sy + 14}px`;
    }
    if (wrapRef.current) wrapRef.current.style.cursor = hit ? 'pointer' : 'grab';
  }

  function endPointer(e: React.PointerEvent<HTMLDivElement>, cancelled = false) {
    const node = dragNodeRef.current;
    if (node) {
      simulationRef.current?.release(node.id);
    }
    const clicked = !cancelled && movedRef.current < 4 && (node || panRef.current);
    dragNodeRef.current = null;
    panRef.current = null;
    if (clicked) {
      hoverRef.current = null;
      setHoverNode(null);
      onSelect(node, { x: e.clientX, y: e.clientY });
      scheduleDraw();
    }
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    autoFitRef.current = false;
    const rect = wrapRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const v = viewRef.current;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(Math.max(v.scale * factor, 0.02), 4);
    const wx = (mx - v.x) / v.scale;
    const wy = (my - v.y) / v.scale;
    v.scale = next;
    v.x = mx - wx * next;
    v.y = my - wy * next;
    scheduleDraw();
  }

  return (
    <div
      ref={wrapRef}
      className="weq-graph-canvas-wrap"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e)}
      onPointerCancel={(e) => endPointer(e, true)}
      onLostPointerCapture={(e) => endPointer(e, true)}
      onPointerLeave={(e) => {
        endPointer(e, true);
        hoverRef.current = null;
        setHoverNode(null);
      }}
      onWheel={onWheel}
    >
      <canvas ref={canvasRef} className="weq-graph-canvas" />
      {simulationError ? (
        <div className="weq-graph-state" role="alert">
          <span>图谱布局失败：{simulationError}</span>
          <button
            className="weq-graph-icon-btn"
            type="button"
            title="重试图谱布局"
            aria-label="重试图谱布局"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw size={18} />
          </button>
        </div>
      ) : null}
      <button
        className="weq-graph-fit"
        type="button"
        title="适应全部"
        aria-label="适应全部"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onClick={() => {
          autoFitRef.current = true;
          fitView();
        }}
      >
        <Scan size={18} />
      </button>
      <div
        ref={tooltipRef}
        className="weq-graph-tooltip"
        style={{ display: hoverNode ? 'block' : 'none' }}
      >
        {hoverNode ? (
          <>
            <strong data-privacy-sensitive>{hoverNode.label}</strong>
            {hoverNode.kind === 'person' ? (
              <span>
                {hoverNode.isFriend ? '好友' : '群友'} · 共 {hoverNode.groupCount} 群
                {hoverNode.intimacy ? ` · 亲密度 ${hoverNode.intimacy}` : ''}
              </span>
            ) : (
              <span>
                {hoverNode.memberCount} 人 · 命中 {hoverNode.sharedCount} 位
                {hoverNode.myLevel ? ` · 我的等级 ${hoverNode.myLevel}` : ''}
              </span>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
