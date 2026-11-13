import { RotateCw, UserRound, UsersRound } from 'lucide-react';
import { useNumberLookup, type NumberLookupProfile } from '../../hooks/useNumberLookup';
import { SearchAvatar, c2cAvatarSrc, groupAvatarSrc } from './SearchResultCard';
import '../../styles/identity-links.css';

export type OpenNumberProfile = (profile: NumberLookupProfile, anchor: HTMLElement) => void;

export function NumberLookupResults({
  keyword,
  onOpenProfile,
  kinds = ['user', 'group'],
}: {
  keyword: string;
  onOpenProfile?: OpenNumberProfile;
  kinds?: readonly ('user' | 'group')[];
}) {
  const lookup = useNumberLookup(keyword, kinds);
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
        kinds.map((kind) => {
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
              {result.data ? (
                <button
                  type="button"
                  className="weq-number-lookup-identity"
                  title={`查看${label}名片`}
                  aria-label={`查看${label}名片`}
                  disabled={!onOpenProfile}
                  onClick={(event) => onOpenProfile?.(result.data!, event.currentTarget)}
                >
                  <SearchAvatar
                    url={
                      kind === 'user'
                        ? c2cAvatarSrc(result.data.id)
                        : groupAvatarSrc(result.data.id)
                    }
                    fallbackText={(result.data.name || label).slice(0, 1)}
                  />
                  <span className="weq-number-lookup-name">
                    {result.data.name || (kind === 'user' ? '用户资料' : '群资料')}
                  </span>
                </button>
              ) : (
                <span className="weq-number-lookup-placeholder">
                  <Icon size={18} aria-hidden />
                </span>
              )}
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
