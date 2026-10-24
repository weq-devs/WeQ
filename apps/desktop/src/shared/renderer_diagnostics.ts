export const DIAGNOSTIC_SAMPLE_REQUEST = 'diagnostics:sample-request';
export const DIAGNOSTIC_SAMPLE_RESPONSE = 'diagnostics:sample-response';
export const RESOURCE_DIAGNOSTIC_REQUEST = 'weq:resource-diagnostic-request';
export const RESOURCE_DIAGNOSTIC_ID = 'weq-resource-diagnostics';
export const DEVELOPMENT_DIAGNOSTIC_INTERVAL_MS = 10_000;

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
