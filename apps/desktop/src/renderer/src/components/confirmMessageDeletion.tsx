import { useDialog } from './Dialog';
import '../styles/message-deletion.css';

export async function confirmMessageDeletion(count: number): Promise<boolean | null> {
  let hidden = false;
  const accepted = await useDialog.getState().confirm(
    count === 1 ? '删除这条消息？' : `删除所选的 ${count} 条消息？`,
    <label className="weq-message-delete-option">
      <input
        type="checkbox"
        onChange={(event) => {
          hidden = event.currentTarget.checked;
        }}
      />
      <span>删除后不再显示</span>
    </label>,
    { okLabel: '删除' },
  );
  return accepted ? hidden : null;
}
