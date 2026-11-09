// @ts-nocheck
import { useEffect, useRef, useState } from 'react';
import type { Simulation } from 'd3';
import { Scan } from 'lucide-react';
import { usePrivacyStore } from '../../state/privacy';
import { communityColor, SELF_ID } from './graphModel';
import type { BuiltGraph, GNode } from './types';
import { createGraphSimulation, fitGraphView, type GraphView } from './graphLayout';

export function GraphCanvas({
  graph,
  selectedId,
  onSelect,
}: {
  graph: BuiltGraph;
  selectedId: string | null;
  onSelect: (node: GNode | null, anchor: { x: number; y: number }) => void;
}) {
  const privacy = usePrivacyStore((state) => state.effective);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const simulationRef = useRef<Simulation<GNode, undefined> | null>(null);

  const viewRef = useRef<GraphView>({ scale: 1, x: 0, y: 0 });
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const autoFitRef = useRef(true);
  const graphKeyRef = useRef('');
  const drawRafRef = useRef(0);

  const hoverRef = useRef<GNode | null>(null);
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;

  const dragNodeRef = useRef<GNode | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(0);

  const [hoverNode, setHoverNode] = useState<GNode | null>(null);

  // 动画与 ResizeObserver 通过 ref 使用最新渲染，不反复重建模拟。
  const drawRef = useRef<() => void>(() => {});
  const fitViewRef = useRef<() => void>(() => {});

  // Coalesce redraws into one per frame — when many avatars finish loading at
  // once we don't want a draw() per image.
  function scheduleDraw(): void {
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
    const nodes = simulation.nodes();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = n.x - x;
      const dy = n.y - y;
      if (dx * dx + dy * dy <= (n.radius + 2) * (n.radius + 2)) return n;
    }
    return null;
  }

  useEffect(() => {
    const prevSim = simulationRef.current;
    const key = graph.nodes
      .map((node) => `${node.kind}:${node.id}`)
      .sort()
      .join('|');
    if (graphKeyRef.current !== key) {
      graphKeyRef.current = key;
      autoFitRef.current = true;
    }
    prevSim?.stop();
    const sim = createGraphSimulation(graph, prevSim?.nodes());
    simulationRef.current = sim;
    let fitted = false;
    sim.on('tick', () => {
      if (!fitted && sim.alpha() < 0.18 && autoFitRef.current) {
        fitted = true;
        fitViewRef.current();
      } else drawRef.current();
    });
    sim.on('end', () => {
      if (autoFitRef.current) fitViewRef.current();
    });
    if (autoFitRef.current) fitViewRef.current();

    return () => {
      sim.stop();
      if (drawRafRef.current) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = 0;
      }
    };
  }, [graph]);

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
    const index = new Map(nodes.map((n) => [n.id, n]));
    const focus = hoverRef.current?.id ?? selectedRef.current ?? null;
    const focusNeighbours = new Set<string>();

    if (focus) {
      for (const e of graph.edges) {
        if (e.source.id === focus || e.source === focus)
          focusNeighbours.add(e.target.id || e.target);
        else if (e.target.id === focus || e.target === focus)
          focusNeighbours.add(e.source.id || e.source);
      }
    }

    for (const e of graph.edges) {
      const s = typeof e.source === 'object' ? e.source : index.get(e.source);
      const t = typeof e.target === 'object' ? e.target : index.get(e.target);
      if (!s || !t) continue;

      const active = focus && (s.id === focus || t.id === focus);
      const isSelfEdge = s.id === SELF_ID || t.id === SELF_ID;

      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = active
        ? 'rgba(0,153,255,0.55)'
        : isSelfEdge
          ? 'rgba(120,140,165,0.07)'
          : 'rgba(120,140,165,0.18)';
      ctx.lineWidth = active
        ? Math.min(1 + e.weight * 0.5, 4)
        : isSelfEdge
          ? 0.5
          : Math.min(0.6 + e.weight * 0.25, 2.4);
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of nodes) {
      const isSelfNode = n.kind === 'self';
      const color = isSelfNode ? '#0a7fd0' : communityColor(n.community);
      const dim = focus && n.id !== focus && !focusNeighbours.has(n.id);
      const r = n.radius;

      ctx.globalAlpha = dim ? 0.35 : 1;

      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      const img = !privacy && n.avatarUrl ? getImage(n.avatarUrl) : null;
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
        const label = n.label.length > 12 ? `${n.label.slice(0, 12)}…` : n.label;
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
  }, [privacy]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    autoFitRef.current = false;
    const rect = wrapRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    movedRef.current = 0;
    const hit = nodeAt(sx, sy);
    if (hit) {
      dragNodeRef.current = hit;
      const w = screenToWorld(sx, sy);
      hit.fx = w.x;
      hit.fy = w.y;
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
      const w = screenToWorld(sx, sy);
      dragNodeRef.current.fx = w.x;
      dragNodeRef.current.fy = w.y;
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

  function endPointer(e: React.PointerEvent<HTMLDivElement>, cancelled = false) {
    const node = dragNodeRef.current;
    if (node) {
      node.fx = null;
      node.fy = null;

      simulationRef.current?.alphaTarget(0);
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
    draw(); // 手动重绘
  }

  return (
    <div
      ref={wrapRef}
      className="weq-graph-canvas-wrap"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e)}
      onPointerCancel={(e) => endPointer(e, true)}
      onPointerLeave={(e) => {
        endPointer(e, true);
        hoverRef.current = null;
        setHoverNode(null);
      }}
      onWheel={onWheel}
    >
      <canvas ref={canvasRef} className="weq-graph-canvas" />
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
