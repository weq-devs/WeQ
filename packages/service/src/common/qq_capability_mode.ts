export const QQ_CAPABILITY_MODES = ['read-only', 'local', 'online', 'complete'] as const;
export type QqCapabilityMode = (typeof QQ_CAPABILITY_MODES)[number];

export const QQ_CAPABILITY_MODE_LABELS: Record<QqCapabilityMode, string> = {
  'read-only': '只读模式',
  local: '本地模式',
  online: '在线模式',
  complete: '完整模式',
};

export function isQqCapabilityMode(value: unknown): value is QqCapabilityMode {
  return QQ_CAPABILITY_MODES.some((mode) => mode === value);
}

export function qqCapabilityAllowsOnline(mode: QqCapabilityMode): boolean {
  return mode === 'online' || mode === 'complete';
}

export function legacyQqCapabilityMode(online: boolean, proxy: boolean): QqCapabilityMode {
  return online ? (proxy ? 'complete' : 'online') : 'local';
}
