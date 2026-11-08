export {
  AUTHORIZATION_INTERFACE,
  AUTHORIZATION_PROTOCOL,
} from '@weq/native/authorization.mjs';

/** 长期授权不可用时给设置页 / 提示用的具体原因。 */
export type LongTermAuthorizationReason =
  | 'expired'
  | 'interface-changed'
  | 'channel-mismatch'
  | 'incompatible'
  | 'unresponsive';

export interface LongTermAuthorizationStatus {
  platform: string;
  state: 'unavailable' | 'not-installed' | 'ready' | 'needs-repair';
  message: string;
  /** `needs-repair` 时尽量给出可操作原因，而不是只显示笼统的失败。 */
  reason?: LongTermAuthorizationReason;
  build?: string;
  installedBytes?: number;
  development?: boolean;
}

export interface LongTermAuthorizationBridge {
  status(): Promise<LongTermAuthorizationStatus>;
  install(expectedDevelopment?: boolean): Promise<LongTermAuthorizationStatus>;
  remove(expectedDevelopment?: boolean): Promise<LongTermAuthorizationStatus>;
}
