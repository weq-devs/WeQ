import { Component, type ReactNode } from 'react';

type Props = {
  children?: ReactNode;
  fallback: ReactNode | ((retry: () => void) => ReactNode);
  resetKey?: string;
};

type State = { failed: boolean; resetKey?: string };

export class ContentErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps({ resetKey }: Props, state: State): State | null {
    return resetKey === state.resetKey ? null : { failed: false, resetKey };
  }

  static getDerivedStateFromError(): Pick<State, 'failed'> {
    return { failed: true };
  }

  private retry = () => this.setState({ failed: false });

  override render(): ReactNode {
    const { children, fallback } = this.props;
    if (!this.state.failed) return children;
    return typeof fallback === 'function' ? fallback(this.retry) : fallback;
  }
}
