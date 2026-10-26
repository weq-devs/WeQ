import { Component, type ReactNode } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import '../styles/renderer-recovery.css';

/** 放在业务 Provider 外，恢复界面不依赖已经抛错的状态或 IPC。 */
export class RendererErrorBoundary extends Component<
  { children: ReactNode; reload?: () => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="weq-renderer-recovery">
        <section role="alert">
          <TriangleAlert size={28} aria-hidden />
          <h1>界面遇到异常</h1>
          <p>后台操作可能仍在运行，请先核对结果，避免重复提交。</p>
          <p>重新加载会丢失未保存的界面内容，不会自动重发操作。</p>
          <button
            type="button"
            onClick={() => (this.props.reload ?? (() => window.location.reload()))()}
          >
            <RefreshCw size={16} aria-hidden />
            重新加载界面
          </button>
        </section>
      </main>
    );
  }
}
