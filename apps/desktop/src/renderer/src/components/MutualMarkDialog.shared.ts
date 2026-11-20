import type { ProfileExtInfo } from '../im-template/template/types';
import { profileCode } from '@weqbot/protocol/profile-values';
import '../styles/profile-cache.css';

export type CachedMark = ProfileExtInfo['interactMarks'][number];
export function usableCachedMarks(marks: readonly CachedMark[]) {
  const found = new Map<string, CachedMark>();
  for (const mark of marks) {
    const id = profileCode(mark.markId);
    const type = mark.type?.trim();
    if (id === null && !type) continue;
    const key = `${type ?? ''}:${id ?? ''}`;
    if (!found.has(key)) found.set(key, mark);
  }
  return [...found.values()];
}
