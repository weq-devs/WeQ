export const DIAGNOSTIC_SAMPLE_REQUEST = 'diagnostics:sample-request';
export const DIAGNOSTIC_SAMPLE_RESPONSE = 'diagnostics:sample-response';
export const RESOURCE_DIAGNOSTIC_REQUEST = 'weq:resource-diagnostic-request';
export const RESOURCE_DIAGNOSTIC_ID = 'weq-resource-diagnostics';

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
