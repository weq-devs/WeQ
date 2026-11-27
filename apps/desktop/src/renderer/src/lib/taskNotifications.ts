import { useWorkspaceMenu } from '../state/workspaceMenu';
import { accountBinding } from './clientPreferences';

const recentStarts = new Map<string, number>();
const START_LIMIT = 128;
const START_TTL = 60_000;

/** 受理与首份任务快照可能交错，完成提醒仍取自真实结果。 */
export function rememberTaskCreated(id: string) {
  const binding = accountBinding();
  const scope = binding
    ? JSON.stringify([binding.expectedAccountUin, binding.expectedAccountConfigId])
    : useWorkspaceMenu.getState().taskScope;
  if (!scope) return;
  recentStarts.set(JSON.stringify([scope, `export:${id}`]), Date.now());
  if (recentStarts.size > START_LIMIT) recentStarts.delete(recentStarts.keys().next().value!);
}

export function takeTaskStarts(scope: string, ids: readonly string[]) {
  const started = new Set<string>();
  const now = Date.now();
  for (const id of ids) {
    const key = JSON.stringify([scope, id]);
    const at = recentStarts.get(key);
    if (at === undefined) continue;
    recentStarts.delete(key);
    if (now - at < START_TTL) started.add(id);
  }
  return started;
}
