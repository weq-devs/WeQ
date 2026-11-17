import '../../styles/composition-sort.css';
import { draftTitle, type MfDraft } from './model';

/** 供外层对话框显示默认标题。 */
export function composerDefaultTitle(draft: MfDraft): string {
  return draft.title || draftTitle(draft.nodes);
}
