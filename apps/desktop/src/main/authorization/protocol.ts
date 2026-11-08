import type { CaptureWorkerRequest } from '../capture_protocol';
export const MAX_AUTHORIZATION_REPLY = 16 * 1024 * 1024;
export interface AuthorizationRequest extends Omit<CaptureWorkerRequest, 'op'> {
  op: CaptureWorkerRequest['op'] | 'status' | 'attach' | 'key-scan';
  databaseSample?: string;
}
export interface AuthorizationHelperInfo {
  protocol: number;
  /** 权限助手接口版本，见 `AUTHORIZATION_INTERFACE`。 */
  interface?: number;
  build: string;
  validity?: 'valid' | 'expired';
  development?: boolean;
  capabilities: string[];
}
