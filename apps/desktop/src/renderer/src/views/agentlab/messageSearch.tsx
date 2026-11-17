import '../../styles/generated-search.css';

export function GeneratedSearchNotice({ missing, error }: { missing: boolean; error: boolean }) {
  return missing || error ? (
    <div className="weq-generated-search-notice" role="status">
      {error ? '记录加载失败' : '该条记录已不在当前会话中'}
    </div>
  ) : null;
}
