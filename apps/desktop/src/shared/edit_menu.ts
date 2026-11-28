export type ReadStateUndoAction = 'mark-read' | 'mark-unread';

export interface EditUndoBridge {
  onUndo(handler: () => boolean): () => void;
  update(action: ReadStateUndoAction | null): void;
}
