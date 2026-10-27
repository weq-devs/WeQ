export interface RendererRecoveryBridge {
  getNotice(): Promise<{ id: number } | null>;
  acknowledgeNotice(id: number): Promise<void>;
}
