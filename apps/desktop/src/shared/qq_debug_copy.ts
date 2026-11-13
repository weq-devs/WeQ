export const QQ_DEBUG_COPY_ACTIONS = [
  'prepare',
  'verify',
  'launch',
  'activate',
  'open',
  'switch',
  'remove',
] as const;
export type QqDebugCopyAction = (typeof QQ_DEBUG_COPY_ACTIONS)[number];
export const QQ_DEBUG_COPY_PERMISSION_ACTIONS = [
  'screenCapture',
  'microphone',
  'camera',
  'reveal',
] as const;
export type QqDebugCopyPermissionAction = (typeof QQ_DEBUG_COPY_PERMISSION_ACTIONS)[number];
export type QqDebugCopyPhase =
  | 'idle'
  | 'checking'
  | 'copying'
  | 'signing'
  | 'verifying'
  | 'launching'
  | 'quitting'
  | 'removing';

export interface QqDebugCopyStatus {
  supported: boolean;
  phase: QqDebugCopyPhase;
  state: 'missing' | 'ready' | 'outdated' | 'invalid' | 'unmanaged';
  sourcePath: string | null;
  sourceVersion: string | null;
  path: string;
  version: string | null;
  readerReady: boolean;
  runningPids: number[];
  sourceRunningPids: number[];
  message: string;
}
