/**
 * 个性装扮的可复用渲染部件 —— 首页（{@link ../views/ChatHome}）与他人的个性主页
 * （{@link ./PersonalityHomeDialog}）共用同一套视觉。
 *
 * 四层自下而上：名片背景 → 浮屏雨 → 头像+挂件 → 个性标签环。尺寸全部由宿主容器上的
 * `--weq-orb-size` 驱动，所以同一组件既能铺满首页、也能缩进一张竖屏卡片。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import * as d3 from 'd3';

// 挂件是直接拼 CDN 地址、不做探测的,常年会有下架/过期 404。加载失败就把 <img> 藏起来,
// 别让浏览器画裂图占位 —— 头像本体照常显示,只是没有这个装饰角标。
function hideBrokenImg(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.style.display = 'none';
}

/** 头像 + 挂件（挂件素材是 APNG，浏览器自己会动）。 */
export function AvatarOrb({
  avatarUrl,
  nickname,
  widgetUrl,
}: {
  avatarUrl: string | null;
  nickname: string;
  widgetUrl: string;
}) {
  return (
    <span className={`weq-orb${widgetUrl ? ' has-widget' : ''}`}>
      {avatarUrl ? (
        <img src={avatarUrl} alt={nickname} className="weq-orb-img is-round" draggable={false} />
      ) : (
        <span className="weq-orb-img is-round weq-orb-fallback">
          {(nickname || '?').slice(0, 1)}
        </span>
      )}
      {widgetUrl && (
        <img
          className="weq-orb-widget"
          src={widgetUrl}
          alt=""
          aria-hidden
          draggable={false}
          onError={hideBrokenImg}
        />
      )}
    </span>
  );
}

interface Flake {
  id: number;
  style: CSSProperties;
}

/**
 * 浮屏雨：方形小图从上方随机位置出现、边旋转边下落。
 *
 * 同一时刻要「2–4 个」，故不是固定 N 个一起落——而是让每枚有各自的时长与负延迟，
 * 错峰进入。全部交给 CSS animation（GPU 合成），零 setState。
 */
export function ScreenRain({ src, count = 9 }: { src: string; count?: number }) {
  // 挂载时定一次即可：随机值进 useMemo，避免每次重渲染都换位置。
  const flakes = useMemo<Flake[]>(() => {
    return Array.from({ length: count }, (_, i) => {
      const duration = 6 + Math.random() * 7;
      const size = 34 + Math.random() * 30;
      return {
        id: i,
        style: {
          left: `${Math.random() * 96}%`,
          width: `${size}px`,
          height: `${size}px`,
          animationDuration: `${duration.toFixed(2)}s`,
          // 负延迟 = 一挂载就处于动画中途，不必等第一轮落完才有画面
          animationDelay: `${(-Math.random() * duration).toFixed(2)}s`,
          // 奇偶反向旋转，看起来更自然
          animationName: i % 2 === 0 ? 'weq-flake-fall' : 'weq-flake-fall-alt',
          opacity: 0.55 + Math.random() * 0.35,
        } as CSSProperties,
      };
    });
  }, [count]);

  return (
    <div className="weq-flakes" aria-hidden>
      {flakes.map((f) => (
        <img key={f.id} className="weq-flake" src={src} alt="" style={f.style} draggable={false} />
      ))}
    </div>
  );
}

/**
 * 个性标签环。
 *
 * 位置交给 d3-force（与联系人页关系图同一套 simulation）：forceRadial 把标签拉到头像外
 * 的圆环上、forceCollide 让它们互不重叠、forceManyBody 给一点相斥。所有片起始都堆在
 * 头像中心，radial 把它们推开——展开动画即是力导演化本身，不再需要 CSS keyframes 算位置。
 *
 * 分工：JS 只写 `translate`（位移），CSS 只写 `transform`（缩放/浮动），两个属性互不覆盖。
 * 拖拽照抄 GraphCanvas 的做法：按下钉住 fx/fy + alphaTarget 注入活性，松手清空。
 */
interface TagNode extends d3.SimulationNodeDatum {
  label: string;
  r: number;
}

export function TagRing({
  tags,
  max = 10,
  /** 环半径的常数项（px）。与 CSS 的 `--weq-tag-radius` 公式必须同值。 */
  radiusPad = 78,
}: {
  tags: string[];
  max?: number;
  radiusPad?: number;
}) {
  const items = useMemo(() => tags.slice(0, max), [tags, max]);
  const key = items.join(' ');
  const hostRef = useRef<HTMLDivElement>(null);
  const elsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const nodesRef = useRef<TagNode[]>([]);
  const simRef = useRef<d3.Simulation<TagNode, undefined> | null>(null);
  const centerRef = useRef({ x: 0, y: 0 });

  // biome-ignore lint/correctness/useExhaustiveDependencies: items 由 key 代表内容身份
  useEffect(() => {
    const host = hostRef.current;
    if (!host || items.length === 0) return undefined;

    // 起始全部堆在中心（带一点角度抖动，否则同点重合力方向退化），由 radial 推开成环。
    const nodes: TagNode[] = items.map((label, i) => {
      const a = (i / items.length) * Math.PI * 2;
      return { label, r: 37, x: Math.cos(a) * 0.5, y: Math.sin(a) * 0.5 };
    });
    nodesRef.current = nodes;

    function render(): void {
      for (let i = 0; i < nodes.length; i += 1) {
        const el = elsRef.current[i];
        const n = nodes[i];
        if (el && n) el.style.translate = `${(n.x ?? 0).toFixed(1)}px ${(n.y ?? 0).toFixed(1)}px`;
      }
    }

    const sim = d3
      .forceSimulation(nodes)
      .force('collide', d3.forceCollide<TagNode>((d) => d.r + 4).iterations(2))
      .force('charge', d3.forceManyBody().strength(-24))
      .alphaDecay(0.018)
      .on('tick', render);
    simRef.current = sim;

    function layout(): void {
      const box = host!.getBoundingClientRect();
      // 舞台是正方形，边长即 --weq-orb-size；环半径沿用 CSS 里 --weq-tag-radius 的公式。
      const ringRadius = box.width * 0.52 + radiusPad;
      const half = (elsRef.current[0]?.offsetWidth ?? 74) / 2;
      for (const n of nodes) n.r = half;
      // 坐标系原点取容器中心（CSS 已把每片的中心对到中心），故 radial 圆心是 (0, 0)。
      centerRef.current = { x: box.width / 2, y: box.height / 2 };
      sim
        .force('radial', d3.forceRadial<TagNode>(ringRadius, 0, 0).strength(0.09))
        .force('collide', d3.forceCollide<TagNode>((d) => d.r + 4).iterations(2))
        .alpha(0.9)
        .restart();
    }

    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(host);

    return () => {
      ro.disconnect();
      sim.stop();
      simRef.current = null;
    };
  }, [key, items.length, radiusPad]);

  function startDrag(index: number, event: ReactPointerEvent<HTMLSpanElement>): void {
    const node = nodesRef.current[index];
    if (!node) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('is-dragging');
    node.fx = node.x;
    node.fy = node.y;
    simRef.current?.alphaTarget(0.3).restart();
  }

  function moveDrag(index: number, event: ReactPointerEvent<HTMLSpanElement>): void {
    const node = nodesRef.current[index];
    if (!node || node.fx == null) return;
    const box = hostRef.current?.getBoundingClientRect();
    if (!box) return;
    node.fx = event.clientX - box.left - centerRef.current.x;
    node.fy = event.clientY - box.top - centerRef.current.y;
  }

  function endDrag(index: number, event: ReactPointerEvent<HTMLSpanElement>): void {
    const node = nodesRef.current[index];
    event.currentTarget.classList.remove('is-dragging');
    if (!node) return;
    node.fx = null;
    node.fy = null;
    simRef.current?.alphaTarget(0);
  }

  if (items.length === 0) return null;

  return (
    <div className="weq-tagring" ref={hostRef}>
      {items.map((tag, i) => (
        <span
          className="weq-tag"
          key={tag}
          ref={(el) => {
            elsRef.current[i] = el;
          }}
          style={
            {
              '--weq-tag-delay': `${(0.12 + i * 0.06).toFixed(2)}s`,
              '--weq-tag-float-dur': `${(4.4 + ((i * 7) % 5) * 0.62).toFixed(2)}s`,
            } as CSSProperties
          }
          onPointerDown={(e) => startDrag(i, e)}
          onPointerMove={(e) => moveDrag(i, e)}
          onPointerUp={(e) => endDrag(i, e)}
          onPointerCancel={(e) => endDrag(i, e)}
        >
          <span className="weq-tag-body">{tag}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * 名片背景层。视频优先（QQ 的沉浸式名片本体就是那段 mp4），无视频用静图。
 * 两者皆无则返回 null —— 整层不渲染，透出宿主自己的底色。
 */
export function CardBackdrop({ imageUrl, videoUrl }: { imageUrl: string; videoUrl: string }) {
  const [videoFailed, setVideoFailed] = useState(false);

  const useVideo = Boolean(videoUrl) && !videoFailed;
  if (!useVideo && !imageUrl) return null;

  return (
    <div className="weq-chathome-backdrop" aria-hidden>
      {useVideo ? (
        <video
          className="weq-chathome-backdrop-media"
          src={videoUrl}
          autoPlay
          loop
          muted
          playsInline
          onError={() => setVideoFailed(true)}
        />
      ) : (
        <img className="weq-chathome-backdrop-media" src={imageUrl} alt="" draggable={false} />
      )}
      {/* 压暗一层，保证文字在任何名片上都读得清 */}
      <div className="weq-chathome-backdrop-scrim" />
    </div>
  );
}
