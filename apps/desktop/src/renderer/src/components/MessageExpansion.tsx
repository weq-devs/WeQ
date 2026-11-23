import {
  Component,
  createRef,
  useContext,
  type ContextType,
  type ReactNode,
  type RefObject,
} from 'react';
import { allowsLayoutMotion, layoutMotionTiming } from '../lib/layoutMotion';
import { MessageLayoutContext } from '../lib/messageLayout';
import '../styles/message-expansion.css';

type Props = {
  anchor: RefObject<HTMLElement | null>;
  details: ReadonlyArray<readonly [selector: string, ...values: unknown[]]>;
};

/** 子组件自己的状态（例如语音转写）也需要在 DOM 提交前交给聊天时间线。 */
export class MessageLayoutChange extends Component<Props> {
  static override contextType = MessageLayoutContext;
  declare context: ContextType<typeof MessageLayoutContext>;

  override getSnapshotBeforeUpdate(previous: Props) {
    const anchor = this.props.anchor.current;
    if (anchor && this.context) {
      const changed = this.props.details
        .filter((detail, index) =>
          detail.some((value, part) => !Object.is(value, previous.details[index]?.[part])),
        )
        .map(([selector]) => selector);
      if (changed.length) this.context(anchor, changed);
    }
    return null;
  }

  override componentDidUpdate() {}

  override render() {
    return null;
  }
}

export function MessageExpansion({ children }: ExpansionProps) {
  // 转发记录等独立消息视图仍使用自身的布局过渡。
  if (!useContext(MessageLayoutContext))
    return <StandaloneExpansion>{children}</StandaloneExpansion>;
  if (!children) return null;
  return (
    <div className="weq-message-expansion">
      <div className="weq-message-expansion-content">{children}</div>
    </div>
  );
}

type ExpansionProps = { children: ReactNode };
type State = { content: ReactNode };

class StandaloneExpansion extends Component<ExpansionProps, State> {
  override state: State = { content: this.props.children };
  private readonly block = createRef<HTMLDivElement>();
  private readonly content = createRef<HTMLDivElement>();
  private animation?: Animation;

  static getDerivedStateFromProps({ children }: ExpansionProps, { content }: State): State | null {
    return children && children !== content ? { content: children } : null;
  }

  override getSnapshotBeforeUpdate(previous: ExpansionProps) {
    return previous.children !== this.props.children
      ? (this.block.current?.getBoundingClientRect().height ?? 0)
      : null;
  }

  override componentDidUpdate(_previous: ExpansionProps, _state: State, height: number | null) {
    const block = this.block.current;
    const content = this.content.current;
    if (height === null || !block || !content) return;
    this.animation?.cancel();
    this.animation = undefined;
    const open = Boolean(this.props.children);
    const target = open ? content.getBoundingClientRect().height : 0;
    const finish = () => {
      if (!this.props.children) this.setState({ content: null });
    };
    if (!block.animate || !allowsLayoutMotion(block) || Math.abs(target - height) < 1) {
      finish();
      return;
    }
    const animation = block.animate(
      [
        { height: `${height}px`, overflow: 'clip' },
        { height: `${target}px`, overflow: 'clip' },
      ],
      layoutMotionTiming,
    );
    this.animation = animation;
    animation.onfinish = () => {
      if (this.animation !== animation) return;
      this.animation = undefined;
      finish();
    };
  }

  override componentWillUnmount() {
    this.animation?.cancel();
  }

  override render() {
    if (!this.state.content) return null;
    return (
      <div className="weq-message-expansion" ref={this.block} inert={!this.props.children}>
        <div className="weq-message-expansion-content" ref={this.content}>
          {this.state.content}
        </div>
      </div>
    );
  }
}
