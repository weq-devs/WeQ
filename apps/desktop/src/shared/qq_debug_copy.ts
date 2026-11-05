export type QqDebugCopyAction = 'prepare' | 'verify' | 'launch' | 'remove';
export type QqDebugCopyPhase =
  | 'idle'
  | 'checking'
  | 'copying'
  | 'signing'
  | 'verifying'
  | 'launching'
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
  message: string;
}
