import { Component, createRef, type ReactNode } from 'react';
import { allowsLayoutMotion, layoutMotionTiming } from '../lib/layoutMotion';
import '../styles/message-expansion.css';

type Props = { children: ReactNode };
type State = { content: ReactNode };

/** 让附加内容和它下面的消息共享同一段高度过渡。 */
export class MessageExpansion extends Component<Props, State> {
  override state: State = { content: this.props.children };
  private readonly block = createRef<HTMLDivElement>();
  private readonly content = createRef<HTMLDivElement>();
  private animation?: Animation;

  static getDerivedStateFromProps({ children }: Props, { content }: State): State | null {
    return children && children !== content ? { content: children } : null;
  }

  override getSnapshotBeforeUpdate(previous: Props) {
    return previous.children !== this.props.children
      ? (this.block.current?.getBoundingClientRect().height ?? 0)
      : null;
  }

  override componentDidUpdate(_previous: Props, _state: State, height: number | null) {
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
