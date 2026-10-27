import { CheckSquare, Copy, Download, X } from 'lucide-react';
import { MessageSelectionBar } from '../../components/MessageSelectionBar';
import { copyTextToClipboard } from '../../im-template/template/clipboard';
import { useToast } from '../../components/Toast';
import type { GeneratedContentIdentity } from '../../../../shared/content_selection';
import { generatedContentContainer } from '../../../../shared/content_selection';
import { useContentMultiSelect, useRequestContentExport } from '../../state/contentSelection';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import '../../styles/generated-selection.css';

/** 没有持久消息 ID 的流式回合只显示，不伪造可交接的导出身份。 */
export function useGeneratedSelection(
  target: GeneratedContentIdentity,
  messages: readonly { id?: string; text?: string }[],
  available: boolean,
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
  const selectedMessages = messages.filter(
    (message) => message.id && selection.selectedIds.has(message.id),
  );
  const blocked =
    !available ||
    !selectedMessages.length ||
    selectedMessages.length !== selection.selectedIds.size;
  return {
    toolbar: selection.selectionMode ? (
      <MessageSelectionBar count={selection.selectedIds.size}>
        {requestExport ? (
          <button
            type="button"
            className="selection-action"
            title="导出所选消息"
            aria-label="导出所选消息"
            disabled={blocked}
            onClick={() =>
              requestExport({
                owner: {
                  kind: target.kind === 'assistant' ? 'assistant-messages' : 'clone-messages',
                  container: generatedContentContainer(target),
                },
                scope: {
                  type: 'items',
                  ids: selectedMessages.flatMap((message) => (message.id ? [message.id] : [])),
                },
              })
            }
          >
            <Download size={17} />
          </button>
        ) : null}
        <button
          type="button"
          className="selection-action"
          title="复制"
          aria-label="复制"
          disabled={blocked}
          onClick={() => {
            void copyTextToClipboard(
              selectedMessages.map((message) => message.text ?? '').join('\n'),
            ).then((ok) => {
              if (!ok) useToast.getState().push({ tone: 'error', title: '复制失败' });
            });
          }}
        >
          <Copy size={17} />
        </button>
        <button
          type="button"
          className="selection-action"
          title="退出多选"
          aria-label="退出多选"
          onClick={() => selection.setSelectionMode(false)}
        >
          <X size={17} />
        </button>
      </MessageSelectionBar>
    ) : null,
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
        className="weq-set-iconbtn"
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
