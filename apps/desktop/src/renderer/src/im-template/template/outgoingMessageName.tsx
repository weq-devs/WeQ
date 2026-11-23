import { Component, createRef, type ReactNode } from 'react';
import { messageSequence, ShowMessageSeqContext } from '../../components/MessageProvenance.shared';
import { outgoingMetadataTiming } from '../../hooks/useOutgoingMetadataMotion';
import { allowsLayoutMotion } from '../../lib/layoutMotion';

type Props = { sequence?: string; children: ReactNode };
type Position = { x: number; y: number };

export class OutgoingMessageName extends Component<Props> {
  static override contextType = ShowMessageSeqContext;
  declare context: boolean;
  private readonly name = createRef<HTMLSpanElement>();
  private motion?: Animation;

  private position(element: HTMLSpanElement): Position | null {
    const heading = element.parentElement?.getBoundingClientRect();
    if (!heading?.height) return null;
    const name = element.getBoundingClientRect();
    // 以抬头的右下角为基准，换行时也能过渡，并与时间线的纵向位移叠加。
    return { x: name.right - heading.right, y: name.bottom - heading.bottom };
  }

  override getSnapshotBeforeUpdate(previous: Props) {
    const element = this.name.current;
    if (
      !this.context ||
      previous.sequence === this.props.sequence ||
      messageSequence(previous.sequence) === messageSequence(this.props.sequence) ||
      !element?.animate ||
      !allowsLayoutMotion(element)
    )
      return null;
    return this.position(element);
  }

  override componentDidUpdate(_previous: Props, _state: unknown, before: Position | null) {
    const element = this.name.current;
    if (!before || !element) return;
    this.motion?.cancel();
    const after = this.position(element);
    if (!after) return;
    const x = before.x - after.x;
    const y = before.y - after.y;
    if (Math.abs(x) < 1 && Math.abs(y) < 1) return;
    this.motion = element.animate(
      [{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }],
      outgoingMetadataTiming,
    );
  }

  override componentWillUnmount() {
    this.motion?.cancel();
  }

  override render() {
    return (
      <span className="message-name" ref={this.name}>
        {this.props.children}
      </span>
    );
  }
}
