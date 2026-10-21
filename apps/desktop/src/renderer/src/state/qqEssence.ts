import { create } from 'zustand';
import type { QQWriteBinding, QQWriteOutcome } from '../hooks/useQQWriteSession';

export const ESSENCE_RECEIPT_TTL = 60_000;
const MAX_RECEIPTS = 256;
export interface EssenceTarget {
  groupId: number;
  sequence: number;
  random: number;
}
export interface EssenceReceipt {
  source: string;
  groupId: number;
  sequence: number;
  random: number;
  pending?: number;
  enabled?: boolean;
  at: number;
}
export type EssenceReceipts = Record<string, EssenceReceipt>;
export function essenceRefreshInterval(
  receipts: EssenceReceipts,
  source: string,
  groupId: number,
  now = Date.now(),
): number | false {
  const ages = Object.values(receipts)
    .filter(
      (receipt) =>
        receipt.source === source && receipt.groupId === groupId && receipt.enabled !== undefined,
    )
    .map((receipt) => now - receipt.at)
    .filter((age) => age < ESSENCE_RECEIPT_TTL);
  if (!ages.length) return false;
  const age = Math.min(...ages);
  return age < 3000 ? 1000 : age < 10_000 ? 2000 : age < 30_000 ? 5000 : 10_000;
}
export function essenceSource(binding: QQWriteBinding | null): string {
  return binding
    ? JSON.stringify([binding.expectedAccountUin, binding.expectedAccountConfigId])
    : '';
}
export function essenceKey(source: string, groupId: number, sequence: number): string {
  return JSON.stringify([source, groupId, sequence]);
}
export function essenceActive(
  receipts: EssenceReceipts,
  source: string,
  groupId: number,
  sequence: number,
  initial: boolean,
  now = Date.now(),
): boolean {
  const receipt = receipts[essenceKey(source, groupId, sequence)];
  return receipt?.enabled !== undefined && now - receipt.at < ESSENCE_RECEIPT_TTL
    ? receipt.enabled
    : initial;
}
export function essenceSequences(
  receipts: EssenceReceipts,
  source: string,
  groupId: number,
  initial: readonly string[],
): string[] {
  const seqs = new Set(initial);
  for (const receipt of Object.values(receipts)) {
    if (
      receipt.source !== source ||
      receipt.groupId !== groupId ||
      receipt.enabled === undefined ||
      Date.now() - receipt.at >= ESSENCE_RECEIPT_TTL
    )
      continue;
    if (receipt.enabled) seqs.add(String(receipt.sequence));
    else seqs.delete(String(receipt.sequence));
  }
  return [...seqs];
}
let nextOperation = 0;
// 仅暂存已受理的界面回执，不写 QQ 数据；两种读取追上或超时后恢复读取结果。
export const useQQEssence = create<{
  receipts: EssenceReceipts;
  begin: (source: string, target: EssenceTarget) => number | null;
  finish: (key: string, operation: number, enable?: boolean, outcome?: QQWriteOutcome) => void;
  reconcile: (
    source: string,
    groupId: number,
    local: readonly string[],
    localAt: number,
    online: readonly string[],
    onlineAt: number,
  ) => void;
}>((set, get) => ({
  receipts: {},
  begin(source, target) {
    if (!source) return null;
    const key = essenceKey(source, target.groupId, target.sequence);
    if (get().receipts[key]?.pending) return null;
    const receipts = Object.fromEntries(
      Object.entries(get().receipts).filter(
        ([, receipt]) => receipt.pending || Date.now() - receipt.at < ESSENCE_RECEIPT_TTL,
      ),
    );
    if (!receipts[key] && Object.keys(receipts).length >= MAX_RECEIPTS) {
      const oldest = Object.entries(receipts).find(([, receipt]) => !receipt.pending);
      if (!oldest) return null;
      delete receipts[oldest[0]];
    }
    const operation = ++nextOperation;
    receipts[key] = {
      ...receipts[key],
      source,
      groupId: target.groupId,
      sequence: target.sequence,
      random: target.random,
      pending: operation,
      at: receipts[key]?.at ?? Date.now(),
    };
    set({ receipts });
    return operation;
  },
  finish(key, operation, enable, outcome) {
    const receipt = get().receipts[key];
    if (receipt?.pending !== operation) return;
    set((state) => {
      const receipts = { ...state.receipts };
      if (enable !== undefined && (outcome?.state === 'accepted' || outcome?.state === 'confirmed'))
        receipts[key] = { ...receipt, pending: undefined, enabled: enable, at: Date.now() };
      else if (receipt.enabled !== undefined) receipts[key] = { ...receipt, pending: undefined };
      else delete receipts[key];
      return { receipts };
    });
  },
  reconcile(source, groupId, local, localAt, online, onlineAt) {
    const receipts = { ...get().receipts };
    let changed = false;
    for (const [key, receipt] of Object.entries(receipts)) {
      if (receipt.pending) continue;
      const caughtUp =
        receipt.source === source &&
        receipt.groupId === groupId &&
        localAt > receipt.at &&
        onlineAt > receipt.at &&
        local.includes(String(receipt.sequence)) === receipt.enabled &&
        online.includes(String(receipt.sequence)) === receipt.enabled;
      if (caughtUp || Date.now() - receipt.at >= ESSENCE_RECEIPT_TTL) {
        delete receipts[key];
        changed = true;
      }
    }
    if (changed) set({ receipts });
  },
}));
