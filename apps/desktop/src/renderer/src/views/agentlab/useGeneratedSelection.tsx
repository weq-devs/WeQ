import { CheckSquare, X } from 'lucide-react';
import type { GeneratedContentIdentity } from '../../../../shared/content_selection';
import { generatedContentContainer } from '../../../../shared/content_selection';
import { useContentMultiSelect, useRequestContentExport } from '../../state/contentSelection';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import '../../styles/generated-selection.css';

/** 没有持久消息 ID 的流式回合只显示，不伪造可交接的导出身份。 */
export function useGeneratedSelection(
  target: GeneratedContentIdentity,
  messages: readonly { id?: string }[],
  available: boolean,
  controlClassName = 'weq-set-iconbtn',
) {
  const requestExport = useRequestContentExport();
  const selection = useContentMultiSelect({
    kind: target.kind === 'assistant' ? 'assistant-messages' : 'clone-messages',
    container: generatedContentContainer(target),
  });
  const multi = useMultiSelection({
    ids: messages.flatMap((message) => (message.id ? [message.id] : [])),
    selected: selection.selectedIds,
    onChange: selection.setSelectedIds,
    anchorRef: selection.anchorRef,
    enabled: selection.selectionMode,
    disabled: !available,
    onStart: () => selection.setSelectionMode(true),
    onExit: () => selection.setSelectionMode(false),
  });
  return {
    exportConversation:
      requestExport && available
        ? () =>
            requestExport({
              owner: {
                kind: target.kind === 'assistant' ? 'assistant-messages' : 'clone-messages',
                container: generatedContentContainer(target),
              },
              scope: { type: 'all' },
            })
        : undefined,
    rootProps: multi.rootProps,
    selectionMode: selection.selectionMode,
    itemProps: (id?: string) => (id ? multi.itemProps(id) : {}),
    selected: (id?: string) => Boolean(id && selection.selectedIds.has(id)),
    selectMessage: (id?: string) => {
      if (!id || !available) return;
      selection.anchorRef.current = id;
      selection.setSelectedIds(new Set([id]));
      selection.setSelectionMode(true);
    },
    control: (
      <button
        type="button"
        className={controlClassName}
        disabled={!available}
        aria-label={selection.selectionMode ? '退出消息多选' : '多选消息'}
        title={
          selection.selectionMode
            ? `退出消息多选（已选 ${selection.selectedIds.size} 条）`
            : '多选消息'
        }
        aria-pressed={selection.selectionMode}
        onClick={() => selection.setSelectionMode(!selection.selectionMode)}
      >
        {selection.selectionMode ? <X size={16} /> : <CheckSquare size={16} />}
      </button>
    ),
  };
}
