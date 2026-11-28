import { useLayoutEffect, type RefObject } from 'react';
import { useRenderDocument } from '../../lib/renderDocument';
import { createSearchHighlighter } from './SearchResultCard.shared';

const recordSelector = '[data-weq-record-match]';
const highlightName = 'weq-record-keyword';

/** Highlight rendered text across inline elements without changing card or Markdown markup. */
export function useRecordMatchHighlight(ref: RefObject<HTMLElement | null>, keyword: string) {
  const document = useRenderDocument();
  const view = document.defaultView;
  const registry = view?.CSS?.highlights;
  useLayoutEffect(() => {
    const root = ref.current;
    if (!keyword || !root || !registry || !view?.Highlight) return;

    const highlight = registry.get(highlightName) ?? new view.Highlight();
    registry.set(highlightName, highlight);
    const byRow = new Map<Element, Range[]>();
    const { findRanges } = createSearchHighlighter(keyword);

    function refresh(row: Element) {
      for (const range of byRow.get(row) ?? []) highlight.delete(range);
      byRow.delete(row);
      if (!root?.contains(row)) return;

      const ranges: Range[] = [];
      for (const body of row.querySelectorAll('.message-content, .weq-system-message-row')) {
        const walker = document.createTreeWalker(body, view!.NodeFilter.SHOW_TEXT);
        const nodes: { node: Node; start: number; end: number }[] = [];
        let content = '';
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const value = node.textContent;
          if (
            !value ||
            node.parentElement?.closest('.sr-only, [aria-hidden=true], .weq-message-provenance')
          )
            continue;
          const start = content.length;
          content += value;
          nodes.push({ node, start, end: content.length });
        }
        let index = 0;
        for (const [start, end] of findRanges(content)) {
          while (nodes[index] && nodes[index]!.end <= start) index++;
          const first = nodes[index]!;
          while (nodes[index] && nodes[index]!.end < end) index++;
          const last = nodes[index]!;
          const range = document.createRange();
          range.setStart(first.node, start - first.start);
          range.setEnd(last.node, end - last.start);
          ranges.push(range);
          highlight.add(range);
        }
      }
      if (ranges.length) byRow.set(row, ranges);
    }

    root.querySelectorAll(recordSelector).forEach(refresh);
    const observer = new view.MutationObserver((changes) => {
      const changed = new Set<Element>();
      for (const change of changes) {
        const element =
          change.target instanceof view.Element ? change.target : change.target.parentElement;
        const row = element?.closest(recordSelector);
        if (row) {
          changed.add(row);
          continue;
        }
        for (const list of [change.addedNodes, change.removedNodes]) {
          for (const node of list) {
            if (!(node instanceof view.Element)) continue;
            if (node.matches(recordSelector)) changed.add(node);
            for (const item of node.querySelectorAll(recordSelector)) changed.add(item);
          }
        }
      }
      changed.forEach(refresh);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      for (const ranges of byRow.values()) for (const range of ranges) highlight.delete(range);
      if (!highlight.size) registry.delete(highlightName);
    };
  }, [ref, keyword, document, view, registry]);
  return Boolean(registry && view?.Highlight);
}
