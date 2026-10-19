import { useDialog } from '../components/Dialog';

let current: { owner: symbol; dirty: boolean; busy: boolean } | null = null;

export function registerMailDraft(
  owner: symbol,
  state: { dirty: boolean; busy: boolean },
): () => void {
  current = { owner, ...state };
  return () => {
    if (current?.owner === owner) current = null;
  };
}

export async function confirmMailAccountLeave(): Promise<boolean> {
  if (!current?.dirty && !current?.busy) return true;
  return useDialog
    .getState()
    .confirm(
      current.busy ? '邮件操作尚未结束' : '离开未保存的邮件？',
      current.busy
        ? '离开账号会中断附件传输或提交等待，发送结果可能未知。'
        : '当前有未保存的写信内容，离开账号后将被清除。',
      { okLabel: '离开账号', cancelLabel: '取消', tone: 'warning' },
    );
}
