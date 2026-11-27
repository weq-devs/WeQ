import { useConnectionTestTasks } from '../../lib/connectionTestTask';

export function ConnectionTestStatus({ testKey }: { testKey: string }) {
  const running = useConnectionTestTasks((state) => state.running.has(testKey));
  const result = useConnectionTestTasks((state) => state.results.get(testKey));
  if (running)
    return (
      <div className="weq-autosave-status" role="status">
        正在测试连接…
      </div>
    );
  if (!result) return null;
  return (
    <div className="weq-autosave-status" role={result.failed ? 'alert' : 'status'}>
      {result.failed ? '测试失败' : '测试通过'}
      {result.detail ? <> · {result.detail}</> : null}
      {result.action ? (
        <button type="button" className="weq-set-btn weq-set-btn-sm" onClick={result.action.run}>
          {result.action.label}
        </button>
      ) : null}
    </div>
  );
}
