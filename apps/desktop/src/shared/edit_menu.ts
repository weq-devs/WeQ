export interface EditMenuState {
  undo: 'text' | 'mark-read' | 'mark-unread' | null;
  redo: 'text' | null;
}

export interface EditUndoBridge {
  onUndo(handler: () => boolean): () => void;
  onRefresh(handler: () => void): () => void;
  update(state: EditMenuState): void;
}

export const EMPTY_EDIT_MENU: EditMenuState = { undo: null, redo: null };

export function editMenuLabels(locale: string, state: EditMenuState) {
  const zh = /^zh(?:-|_|$)/i.test(locale);
  const undo = {
    text: zh ? '撤销文本编辑' : 'Undo Text Edit',
    'mark-read': zh ? '撤销标为已读' : 'Undo Mark as Read',
    'mark-unread': zh ? '撤销标为未读' : 'Undo Mark as Unread',
  };
  return {
    undo: state.undo ? undo[state.undo] : zh ? '撤销' : 'Undo',
    redo: state.redo ? (zh ? '重做文本编辑' : 'Redo Text Edit') : zh ? '重做' : 'Redo',
  };
}
