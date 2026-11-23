export interface AccountInstanceInfo {
  configId: string;
  uin: string;
  displayName?: string;
  avatarUrl?: string;
  static?: boolean;
  mobile?: boolean;
  running: boolean;
}

export interface AccountInstanceBridge {
  list(): Promise<AccountInstanceInfo[]>;
  open(configId: string): Promise<void>;
  newWindow(): Promise<void>;
}
