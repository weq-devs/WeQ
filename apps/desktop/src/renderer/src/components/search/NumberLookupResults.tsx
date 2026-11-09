import { RotateCw, UserRound, UsersRound } from 'lucide-react';
import { useNumberLookup } from '../../hooks/useNumberLookup';

export function NumberLookupResults({ keyword }: { keyword: string }) {
  const lookup = useNumberLookup(keyword);
  return (
    <section className="weq-search-section" aria-label="QQ号/群号">
      <div className="weq-search-section-header">
        <span className="weq-search-section-name">QQ号/群号</span>
      </div>
      {!lookup.available ? (
        <div className="weq-search-empty" role="status">
          QQ 在线能力未就绪
        </div>
      ) : (
        (['user', 'group'] as const).map((kind) => {
          const result = lookup[kind];
          const label = kind === 'user' ? '用户' : '群聊';
          const Icon = kind === 'user' ? UserRound : UsersRound;
          return (
            <div
              className="weq-number-lookup-result"
              key={kind}
              aria-label={`${label}查询结果`}
              aria-busy={result.loading}
            >
              <Icon size={18} aria-hidden />
              <div className="weq-number-lookup-details">
                <span className="weq-number-lookup-kind">{label}</span>
                {result.loading ? <span role="status">搜索中…</span> : null}
                {result.error !== undefined ? (
                  <div className="weq-search-failure" role="status">
                    <span>{result.error}</span>
                    <button
                      type="button"
                      title={`重试${label}查询`}
                      aria-label={`重试${label}查询`}
                      onClick={result.retry}
                    >
                      <RotateCw size={14} />
                    </button>
                  </div>
                ) : null}
                {result.data ? (
                  <>
                    <strong>{result.data.name || (kind === 'user' ? '用户资料' : '群资料')}</strong>
                    <span>{result.data.id}</span>
                    {result.data.level !== null ? <span>QQ 等级：{result.data.level}</span> : null}
                    {result.data.category ? <span>群分类：{result.data.category}</span> : null}
                  </>
                ) : null}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
