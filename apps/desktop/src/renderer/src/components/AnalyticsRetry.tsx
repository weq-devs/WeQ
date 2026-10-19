import { RotateCw } from 'lucide-react';
import '../styles/analysis-tool.css';

export function AnalyticsRetry({
  error,
  onRetry,
  label = '重试分析',
}: {
  error: string;
  onRetry: () => void;
  label?: string;
}) {
  return (
    <div className="ga-error weq-analysis-error" role="alert">
      <span>{error}</span>
      <button
        type="button"
        className="icon-button"
        title={label}
        aria-label={label}
        onClick={onRetry}
      >
        <RotateCw size={16} />
      </button>
    </div>
  );
}
