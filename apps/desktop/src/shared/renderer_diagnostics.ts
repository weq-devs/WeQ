export const DIAGNOSTIC_SAMPLE_REQUEST = 'diagnostics:sample-request';
export const DIAGNOSTIC_SAMPLE_RESPONSE = 'diagnostics:sample-response';
export const RESOURCE_DIAGNOSTIC_REQUEST = 'weq:resource-diagnostic-request';
export const RESOURCE_DIAGNOSTIC_ID = 'weq-resource-diagnostics';
export const DEVELOPMENT_DIAGNOSTIC_INTERVAL_MS = 10_000;
export const DEVELOPMENT_DIAGNOSTIC_VERSION = 2;
export const DEVELOPMENT_MAIN_VIEWS = [
  'home',
  'messages',
  'contacts',
  'collections',
  'guild-direct',
  'export',
  'agentlab',
  'cache',
  'tools',
  'qzone',
  'mail',
  'channel',
  'annual',
] as const;
export const DEVELOPMENT_SURFACES = [
  'bootstrap',
  'chat',
  'export',
  'exportViewer',
  'collections',
  'qzone',
  'mail',
  'annual',
  'settings',
  'dressup',
  'cache',
  'agentlab',
  'other',
] as const;
export const DEVELOPMENT_COMPONENTS = [
  'messageRows',
  'forwardRows',
  'exportCards',
  'exportLogs',
  'collectionItems',
  'qzonePosts',
  'shimmers',
  'widgets',
  'retainedPanels',
  'workspacePages',
] as const;
export const DEVELOPMENT_ANIMATION_KINDS = [
  'bubbleFrames',
  'widgetFrames',
  'fontFrames',
  'shimmer',
  'spinner',
  'other',
] as const;

function diagnosticFields<const Fields extends readonly string[]>(value: unknown, fields: Fields) {
  const data = diagnosticObject(value);
  return Object.fromEntries(fields.map((field) => [field, diagnosticNumber(data[field])])) as {
    [Field in Fields[number]]: number | null;
  };
}

/** 固定页面与类别名称；原始类名、动画名、属性和资源地址均不接受。 */
export function normalizeDevelopmentDetails(value: unknown) {
  const data = diagnosticObject(value);
  const surfaces = diagnosticObject(data.surfaces);
  const components = diagnosticObject(data.components);
  const animations = diagnosticObject(data.animationDetails);
  const byKind = diagnosticObject(animations.byKind);
  const bySurface = diagnosticObject(animations.bySurface);
  return {
    schemaVersion: diagnosticNumber(data.schemaVersion),
    mainView: DEVELOPMENT_MAIN_VIEWS.find((view) => view === data.mainView) ?? null,
    sampleDurationMs: diagnosticNumber(data.sampleDurationMs),
    surfaces: Object.fromEntries(
      DEVELOPMENT_SURFACES.map((key) => [
        key,
        diagnosticFields(surfaces[key], [
          'mounted',
          'sampled',
          'rendered',
          'descendantElements',
          'omitted',
        ]),
      ]),
    ),
    components: Object.fromEntries(
      DEVELOPMENT_COMPONENTS.map((key) => [
        key,
        diagnosticFields(components[key], ['count', 'sampled', 'hiddenByAttribute', 'omitted']),
      ]),
    ),
    media: diagnosticFields(data.media, [
      'images',
      'sampledImages',
      'omittedImages',
      'completeImages',
      'pendingImages',
      'emptyCompleteImages',
      'naturalPixels',
      'maxNaturalPixels',
      'videos',
      'sampledVideos',
      'playingVideos',
      'omittedVideos',
      'canvases',
      'sampledCanvases',
      'canvasPixels',
      'omittedCanvases',
      'frames',
    ]),
    animationDetails: {
      ...diagnosticFields(animations, [
        'sampled',
        'omitted',
        'hiddenTargets',
        'detachedTargets',
        'unknownTargets',
        'pseudoTargets',
      ]),
      states: diagnosticFields(animations.states, [
        'running',
        'paused',
        'finished',
        'idle',
        'other',
      ]),
      byKind: Object.fromEntries(
        DEVELOPMENT_ANIMATION_KINDS.map((key) => [
          key,
          diagnosticFields(byKind[key], ['count', 'running']),
        ]),
      ),
      bySurface: Object.fromEntries(
        DEVELOPMENT_SURFACES.map((key) => [
          key,
          diagnosticFields(bySurface[key], ['count', 'running']),
        ]),
      ),
    },
  };
}

const CACHE_CATEGORIES = [
  'images',
  'scripts',
  'cssStyleSheets',
  'xslStyleSheets',
  'fonts',
  'other',
] as const;

/** Chromium 缓存只投影计数与字节数，不透传资源名称。 */
export function normalizeDevelopmentSample(value: unknown) {
  const data = diagnosticObject(value);
  const caches = diagnosticObject(data.caches);
  return {
    caches: Object.fromEntries(
      CACHE_CATEGORIES.map((category) => {
        const cache = diagnosticObject(caches[category]);
        return [
          category,
          {
            count: diagnosticNumber(cache.count),
            sizeBytes: diagnosticNumber(cache.size),
            liveSizeBytes: diagnosticNumber(cache.liveSize),
          },
        ];
      }),
    ),
    animations: diagnosticNumber(data.animations),
    runningAnimations: diagnosticNumber(data.runningAnimations),
    documentVisible: typeof data.documentVisible === 'boolean' ? data.documentVisible : null,
    ...normalizeDevelopmentDetails(data),
  };
}

function diagnosticObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

const RESOURCE_FIELDS = [
  'retainedImages',
  'retainedBytes',
  'pinnedImages',
  'reservedBytes',
  'activeDecodes',
  'pendingImages',
  'totalPendingImages',
  'cancelledJobs',
  'managedFonts',
  'loadingFonts',
  'documentFonts',
  'decorationStyles',
  'decorationRules',
  'omittedStyles',
] as const;
export function normalizeResourceSample(value: unknown) {
  const data =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(RESOURCE_FIELDS.map((field) => [field, diagnosticNumber(data[field])]));
}

export function diagnosticNumber(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

/** IPC 只投影数值白名单，未知指标不冒充零。 */
export function normalizeRendererSample(value: unknown) {
  const data =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    jsHeapUsedBytes: diagnosticNumber(data.jsHeapUsedBytes),
    jsHeapTotalBytes: diagnosticNumber(data.jsHeapTotalBytes),
    externalBytes: diagnosticNumber(data.externalBytes),
    arrayBuffersBytes: diagnosticNumber(data.arrayBuffersBytes),
    blinkAllocatedKB: diagnosticNumber(data.blinkAllocatedKB),
    blinkTotalKB: diagnosticNumber(data.blinkTotalKB),
    domNodes: diagnosticNumber(data.domNodes),
    resources: normalizeResourceSample(data.resources),
    eventListeners: null,
  };
}
