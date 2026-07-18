import type { ProtolabApi } from './index';

declare global {
  interface Window {
    protolab: ProtolabApi;
  }
}
