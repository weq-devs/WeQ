import {
  DEVELOPMENT_ANIMATION_KINDS,
  DEVELOPMENT_COMPONENTS,
  DEVELOPMENT_DIAGNOSTIC_VERSION,
  DEVELOPMENT_MAIN_VIEWS,
  DEVELOPMENT_SURFACES,
  diagnosticNumber,
} from '../shared/renderer_diagnostics';

export const DEVELOPMENT_SCAN_LIMITS = {
  roots: 64,
  components: 512,
  media: 512,
  animations: 1024,
  styles: 128,
} as const;

// Node 类型检查不依赖 DOM lib；同时避免跨隔离世界的 instanceof 判定。
export interface DiagnosticElement {
  isConnected: boolean;
  matches(selector: string): boolean;
  closest(selector: string): DiagnosticElement | null;
  getAttribute(name: string): string | null;
  getClientRects(): { length: number };
  getElementsByTagName(name: string): { length: number };
  naturalWidth?: number;
  naturalHeight?: number;
  complete?: boolean;
  paused?: boolean;
  ended?: boolean;
  width?: number;
  height?: number;
  videoWidth?: number;
  videoHeight?: number;
  readyState?: number;
  getVideoPlaybackQuality?(): { totalVideoFrames: number; droppedVideoFrames: number };
}
export interface DiagnosticAnimation {
  playState: string;
  animationName?: string;
  effect?: { target?: unknown; pseudoElement?: string | null } | null;
}
export interface DevelopmentDiagnosticDocument {
  querySelectorAll(selector: string): ArrayLike<DiagnosticElement>;
  styleSheets?: ArrayLike<{ cssRules: { length: number } }>;
}

const SURFACES = {
  bootstrap: '.weq-home-shell',
  home: '.weq-chathome',
  chat: '.message-scroll',
  export: '.weq-export-tool',
  exportViewer: '.weq-export-viewer',
  collections: '.weq-collection-dialog',
  qzone: '.weq-qzn',
  mail: '.weq-mail-workspace',
  annual: '.weq-report-root',
  settings: '.weq-settings-dialog',
  dressup: '.weq-dress-dialog',
  cache: '.weq-cache',
  agentlab: '.weq-agentlab-workspace',
  other: '',
} satisfies Record<(typeof DEVELOPMENT_SURFACES)[number], string>;
const COMPONENTS = {
  messageRows: '.message-line',
  forwardRows: '.weq-forward-row',
  exportCards: '.weq-exp-card',
  exportLogs: '.weq-exp-log-line',
  collectionItems: '.weq-col-card',
  qzonePosts: '.weq-qzn-post',
  shimmers: '.weq-shimmer-block, .weq-exp-skel, .weq-exp-card-skeleton',
  widgets: '.weq-avatar-pendant-img',
  retainedPanels: '[data-retained-panel]',
  workspacePages: '.weq-workspace-page',
  homeBackdrops: '.weq-chathome-backdrop-media',
  homeWidgets: '.weq-orb-widget',
  homeFlakes: '.weq-flake',
  homeTags: '.weq-tag',
} satisfies Record<(typeof DEVELOPMENT_COMPONENTS)[number], string>;
const SURFACE_SELECTOR = Object.values(SURFACES).filter(Boolean).join(', ');

function animationKind(name: string | undefined): (typeof DEVELOPMENT_ANIMATION_KINDS)[number] {
  if (/^weq-flake-fall(?:-alt)?$/.test(name ?? '')) return 'homeFlake';
  if (/^weq-tag-(?:appear|float)$/.test(name ?? '')) return 'homeTag';
  if (/^weq-orb-(?:enter|breathe)$/.test(name ?? '')) return 'homeOrb';
  if (name === 'weq-chathome-caret-blink') return 'homeCaret';
  if (/^weq-bubbleframe-\d+$/.test(name ?? '')) return 'bubbleFrames';
  if (/^weq-widgetframe-\d+$/.test(name ?? '')) return 'widgetFrames';
  if (/^weq-fontfx-\d+-\d+$/.test(name ?? '')) return 'fontFrames';
  if (/^(weq-|rp-|reaction-likers-).*(shimmer|skeleton)/.test(name ?? '')) return 'shimmer';
  if (/^(weq-|rp-|qq-media-|ark-|voice-).*spin$/.test(name ?? '') || name === 'spin')
    return 'spinner';
  return 'other';
}

function animationTarget(value: unknown): DiagnosticElement | null {
  return value !== null &&
    typeof value === 'object' &&
    'closest' in value &&
    typeof value.closest === 'function' &&
    'matches' in value &&
    typeof value.matches === 'function'
    ? (value as DiagnosticElement)
    : null;
}

function surfaceFor(target: DiagnosticElement): (typeof DEVELOPMENT_SURFACES)[number] {
  const root = target.closest(SURFACE_SELECTOR);
  return root
    ? (DEVELOPMENT_SURFACES.find((key) => SURFACES[key] && root.matches(SURFACES[key])) ?? 'other')
    : 'other';
}

function pixels(width: number | undefined, height: number | undefined): number {
  const value = (diagnosticNumber(width) ?? 0) * (diagnosticNumber(height) ?? 0);
  return diagnosticNumber(value) ?? 0;
}

/** 每次请求独立聚合，不保留节点/动画；缺失或异常分类单独记为未知。 */
export function collectDevelopmentDetails(
  document: DevelopmentDiagnosticDocument | undefined,
  animations: readonly DiagnosticAnimation[] | undefined,
) {
  let mainView: string | null = null;
  const surfaces: Record<string, object | null> = {};
  const components: Record<string, object | null> = {};
  let media: object | null = null;
  let styles: object | null = null;
  if (document) {
    try {
      const view = document
        .querySelectorAll('[data-weq-diagnostic-view]')[0]
        ?.getAttribute('data-weq-diagnostic-view');
      mainView = DEVELOPMENT_MAIN_VIEWS.find((candidate) => candidate === view) ?? null;
    } catch {
      /* 导航期间保留未知页面。 */
    }
    for (const key of DEVELOPMENT_SURFACES) {
      if (!SURFACES[key]) continue;
      try {
        const roots = document.querySelectorAll(SURFACES[key]);
        const sampled = Math.min(roots.length, DEVELOPMENT_SCAN_LIMITS.roots);
        let rendered = 0;
        let descendantElements = 0;
        for (let i = 0; i < sampled; i++) {
          const root = roots[i]!;
          if (!root.closest('[hidden]') && root.getClientRects().length > 0) rendered++;
          descendantElements += root.getElementsByTagName('*').length;
        }
        surfaces[key] = {
          mounted: roots.length,
          sampled,
          rendered,
          descendantElements,
          omitted: roots.length - sampled,
        };
      } catch {
        surfaces[key] = null;
      }
    }
    for (const key of DEVELOPMENT_COMPONENTS) {
      try {
        const nodes = document.querySelectorAll(COMPONENTS[key]);
        const sampled = Math.min(nodes.length, DEVELOPMENT_SCAN_LIMITS.components);
        let hiddenByAttribute = 0;
        for (let i = 0; i < sampled; i++) if (nodes[i]!.closest('[hidden]')) hiddenByAttribute++;
        components[key] = {
          count: nodes.length,
          sampled,
          hiddenByAttribute,
          omitted: nodes.length - sampled,
        };
      } catch {
        components[key] = null;
      }
    }
    try {
      const images = document.querySelectorAll('img');
      const videos = document.querySelectorAll('video');
      const canvases = document.querySelectorAll('canvas');
      const sampledImages = Math.min(images.length, DEVELOPMENT_SCAN_LIMITS.media);
      const sampledVideos = Math.min(videos.length, DEVELOPMENT_SCAN_LIMITS.media);
      const sampledCanvases = Math.min(canvases.length, DEVELOPMENT_SCAN_LIMITS.media);
      let completeImages = 0,
        pendingImages = 0,
        emptyCompleteImages = 0,
        naturalPixels = 0,
        maxNaturalPixels = 0;
      let playingVideos = 0,
        canvasPixels = 0,
        videoPixels = 0,
        videoFrames = 0,
        droppedVideoFrames = 0,
        sampledVideoQuality = 0,
        readyVideos = 0;
      for (let i = 0; i < sampledImages; i++) {
        const image = images[i]!;
        const area = pixels(image.naturalWidth, image.naturalHeight);
        if (!image.complete) pendingImages++;
        else if (area > 0) completeImages++;
        else emptyCompleteImages++;
        naturalPixels += area;
        maxNaturalPixels = Math.max(maxNaturalPixels, area);
      }
      for (let i = 0; i < sampledVideos; i++) {
        const video = videos[i]!;
        if (!video.paused && !video.ended) playingVideos++;
        if ((video.readyState ?? 0) >= 2) readyVideos++;
        videoPixels += pixels(video.videoWidth, video.videoHeight);
        try {
          const quality = video.getVideoPlaybackQuality?.();
          if (
            quality &&
            diagnosticNumber(quality.totalVideoFrames) !== null &&
            diagnosticNumber(quality.droppedVideoFrames) !== null
          ) {
            videoFrames += quality.totalVideoFrames;
            droppedVideoFrames += quality.droppedVideoFrames;
            sampledVideoQuality++;
          }
        } catch {
          // 单个播放器缺测不丢失其它视频的统计。
        }
      }
      for (let i = 0; i < sampledCanvases; i++)
        canvasPixels += pixels(canvases[i]!.width, canvases[i]!.height);
      media = {
        images: images.length,
        sampledImages,
        omittedImages: images.length - sampledImages,
        completeImages,
        pendingImages,
        emptyCompleteImages,
        naturalPixels,
        maxNaturalPixels,
        videos: videos.length,
        sampledVideos,
        playingVideos,
        omittedVideos: videos.length - sampledVideos,
        canvases: canvases.length,
        sampledCanvases,
        canvasPixels,
        omittedCanvases: canvases.length - sampledCanvases,
        frames: document.querySelectorAll('iframe, webview').length,
        videoPixels,
        videoFrames: sampledVideoQuality > 0 || sampledVideos === 0 ? videoFrames : null,
        droppedVideoFrames:
          sampledVideoQuality > 0 || sampledVideos === 0 ? droppedVideoFrames : null,
        sampledVideoQuality,
        readyVideos,
      };
    } catch {
      /* 媒体节点不可读时不阻断其它分类。 */
    }
    try {
      const sheets = document.styleSheets;
      if (sheets) {
        const sampledSheets = Math.min(sheets.length, DEVELOPMENT_SCAN_LIMITS.styles);
        let rules = 0,
          inaccessibleSheets = 0;
        for (let i = 0; i < sampledSheets; i++) {
          try {
            rules += sheets[i]!.cssRules.length;
          } catch {
            inaccessibleSheets++;
          }
        }
        styles = {
          sheets: sheets.length,
          sampledSheets,
          rules,
          inaccessibleSheets,
          omittedSheets: sheets.length - sampledSheets,
          styleElements: document.querySelectorAll('style').length,
        };
      }
    } catch {
      // 跨域样式表不可读时保留未知，不读取其正文或来源。
    }
  }
  let animationDetails: object | null = null;
  if (animations) {
    const sampled = Math.min(animations.length, DEVELOPMENT_SCAN_LIMITS.animations);
    const states: Record<string, number> = {
      running: 0,
      paused: 0,
      finished: 0,
      idle: 0,
      other: 0,
    };
    const byKind = Object.fromEntries(
      DEVELOPMENT_ANIMATION_KINDS.map((key) => [key, { count: 0, running: 0 }]),
    );
    const bySurface = Object.fromEntries(
      DEVELOPMENT_SURFACES.map((key) => [key, { count: 0, running: 0 }]),
    );
    let hiddenTargets = 0,
      detachedTargets = 0,
      unknownTargets = 0,
      pseudoTargets = 0;
    for (let i = 0; i < sampled; i++) {
      const animation = animations[i]!;
      const running = animation.playState === 'running';
      const state = Object.hasOwn(states, animation.playState) ? animation.playState : 'other';
      states[state] = (states[state] ?? 0) + 1;
      const kind = byKind[animationKind(animation.animationName)]!;
      kind.count++;
      if (running) kind.running++;
      let surface: (typeof DEVELOPMENT_SURFACES)[number] = 'other';
      try {
        const target = animationTarget(animation.effect?.target);
        if (!target) unknownTargets++;
        else {
          if (!target.isConnected) detachedTargets++;
          if (target.closest('[hidden]')) hiddenTargets++;
          surface = surfaceFor(target);
        }
        if (animation.effect?.pseudoElement) pseudoTargets++;
      } catch {
        unknownTargets++;
      }
      bySurface[surface]!.count++;
      if (running) bySurface[surface]!.running++;
    }
    animationDetails = {
      sampled,
      omitted: animations.length - sampled,
      hiddenTargets,
      detachedTargets,
      unknownTargets,
      pseudoTargets,
      states,
      byKind,
      bySurface,
    };
  }
  return {
    schemaVersion: DEVELOPMENT_DIAGNOSTIC_VERSION,
    mainView,
    surfaces,
    components,
    media,
    styles,
    animationDetails,
  };
}
