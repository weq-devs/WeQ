import type { FavoriteEmojiImportPreview } from '@weq/service';
import { backgroundTasks } from './background_tasks';

export function updateFavoriteImportTask(id: string, view: FavoriteEmojiImportPreview) {
  const items = view.result?.items ?? [];
  const processed = items.filter((item) => item.state !== 'not-run').length;
  const confirmed = items.filter(
    (item) => item.state === 'confirmed' || item.state === 'exists',
  ).length;
  const patch = {
    progress: items.length ? (processed / items.length) * 100 : undefined,
    note: `已处理 ${processed} / ${items.length} · 已确认 ${confirmed}`,
    details: items.map(
      (item, index) =>
        `第 ${index + 1} 项：${
          {
            'not-run': '未执行',
            exists: '已存在，跳过',
            failed: '发送前失败',
            accepted: '已添加，元数据未完成',
            unconfirmed: '结果未确认',
            'metadata-failed': '元数据需核对',
            confirmed: '已确认',
          }[item.state]
        }${item.issue ? ` · ${item.issue}` : ''}`,
    ),
  };
  if (view.phase !== 'finished') {
    backgroundTasks.update(id, {
      ...patch,
      statusLabel: view.cancelling ? '停止收尾中' : undefined,
    });
    return;
  }
  backgroundTasks.setActions(id, []);
  const error = view.error || view.result?.stopped;
  if (view.cancelling)
    backgroundTasks.finish(id, 'cancelled', { ...patch, note: error || patch.note });
  else if (error) backgroundTasks.finish(id, 'failed', { ...patch, note: error });
  else if (confirmed !== items.length || !items.length)
    backgroundTasks.finish(id, 'paused', { ...patch, statusLabel: '部分结果待核对' });
  else backgroundTasks.finish(id, 'completed', patch);
}
