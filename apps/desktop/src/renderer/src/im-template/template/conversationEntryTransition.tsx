import { Component, type ReactNode, type RefObject } from 'react';
import { allowsLayoutMotion } from '../../lib/layoutMotion';
import { surfaceMotionTiming } from '../../lib/surfaceMotion';

type Snapshot = { layer: HTMLDivElement; frame: HTMLDivElement; scrollTop: number };
type Props = {
  scope: string;
  active: boolean;
  waiting: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
};
const timing = { duration: surfaceMotionTiming.enter, easing: 'ease-out', fill: 'both' } as const;

// 位于按会话重挂载的媒体图库之外，才能在旧正文卸载前取到画面。
export class ConversationEntryTransition extends Component<Props> {
  private previousFrame?: Snapshot;
  private entering?: Animation;
  private leaving?: Animation;

  override getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { active, scope, waiting, scrollRef, contentRef } = this.props;
    const scroll = scrollRef.current;
    if (
      !active ||
      !previous.active ||
      scope === previous.scope ||
      previous.waiting ||
      !scroll?.clientHeight ||
      (!waiting && !allowsLayoutMotion(scroll))
    )
      return null;
    const frame = scroll.cloneNode(false) as HTMLDivElement;
    frame.removeAttribute('tabindex');
    frame.style.width = `${scroll.offsetWidth}px`;
    frame.style.height = `${scroll.offsetHeight}px`;
    const bounds = scroll.getBoundingClientRect();
    const content = contentRef.current;
    for (const child of scroll.children) {
      if (child === content && content.classList.contains('is-windowed')) {
        // 保留虚拟列表的几何，但只复制视口里的实渲染行，不复制预挂载行和滚动预览。
        const timeline = content.cloneNode(false);
        for (const row of content.children) {
          if (!row.classList.contains('weq-virtual-timeline-row')) continue;
          const rect = row.getBoundingClientRect();
          if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom)
            timeline.appendChild(row.cloneNode(true));
        }
        frame.append(timeline);
      } else {
        frame.append(child.cloneNode(true));
      }
    }
    for (const node of frame.querySelectorAll('[id], [data-message-id], [autofocus]')) {
      node.removeAttribute('id');
      node.removeAttribute('data-message-id');
      node.removeAttribute('autofocus');
    }
    // 静态画面不重新加载嵌入内容，也不启动旧会话的媒体。
    for (const embed of frame.querySelectorAll('iframe, object, embed')) embed.remove();
    for (const media of frame.querySelectorAll('audio, video')) {
      media.removeAttribute('autoplay');
      media.removeAttribute('src');
      for (const source of media.querySelectorAll('source, track')) source.remove();
    }
    const layer = scroll.ownerDocument.createElement('div');
    layer.className = 'weq-conversation-snapshot';
    layer.inert = true;
    layer.setAttribute('aria-hidden', 'true');
    layer.append(frame);
    return { layer, frame, scrollTop: scroll.scrollTop };
  }

  override componentDidMount() {
    const { active, waiting, scrollRef } = this.props;
    if (active && !waiting && scrollRef.current) this.reveal(scrollRef.current);
  }

  override componentDidUpdate(previous: Props, _state: unknown, snapshot: Snapshot | null) {
    const { active, scope, waiting, scrollRef } = this.props;
    const scroll = scrollRef.current;
    if (!active || !scroll) {
      this.stop();
    } else if (previous.active && scope !== previous.scope) {
      // 在 B 还没显示时从 A → B → C，把 A 的画面带到重挂载后的消息区。
      const frame = snapshot ?? (previous.waiting ? this.previousFrame : undefined);
      this.stop();
      if (frame) {
        this.previousFrame = frame;
        scroll.after(frame.layer);
        frame.frame.scrollTop = frame.scrollTop;
      }
      if (!waiting) this.reveal(scroll);
    } else if (previous.active && previous.waiting && !waiting) {
      this.reveal(scroll);
    }
  }

  override componentWillUnmount() {
    this.stop();
  }

  override render() {
    return this.props.children;
  }

  private reveal(scroll: HTMLDivElement) {
    if (!allowsLayoutMotion(scroll) || typeof scroll.animate !== 'function') {
      this.stop();
      return;
    }
    const entering = scroll.animate([{ opacity: 0 }, { opacity: 1 }], timing);
    this.entering = entering;
    this.leaving = this.previousFrame?.layer.animate([{ opacity: 1 }, { opacity: 0 }], timing);
    const finish = () => {
      if (this.entering === entering) this.stop();
    };
    void entering.finished.then(finish, finish);
  }

  private stop() {
    this.entering?.cancel();
    this.leaving?.cancel();
    this.previousFrame?.layer.remove();
    this.entering = undefined;
    this.leaving = undefined;
    this.previousFrame = undefined;
  }
}
