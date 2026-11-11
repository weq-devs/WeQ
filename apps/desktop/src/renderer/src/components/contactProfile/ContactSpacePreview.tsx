import { useQuery } from '@tanstack/react-query';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { useQzoneRequests } from '../../hooks/useQzoneRequests';
import { PROFILE_QUERY_OPTIONS, type ProfilePerson } from '../../hooks/useContactCard';
import { client } from '../../trpc/client';
import { QzoneMediaGrid } from '../../views/qzoneShared';
import '../../styles/qzone.css';

export default function SpacePreview({ person }: { person: ProfilePerson }) {
  const session = useQQWriteSession(`contact-space:${person.id}`, true);
  const requests = useQzoneRequests();
  const query = useQuery({
    queryKey: ['contact-space', session.binding, person.identityValue],
    queryFn: () =>
      requests.run((requestId) =>
        client.account.qzone.posts.query({
          selfUin: session.binding!.expectedAccountUin,
          hostUin: person.identityValue,
          requestId,
          offset: 0,
        }),
      ),
    enabled: Boolean(session.binding),
    ...PROFILE_QUERY_OPTIONS,
  });
  return (
    <section className="weq-contact-space-preview" aria-label="空间预览">
      <h3>最近说说</h3>
      {query.isFetching && !query.data ? <p role="status">正在读取…</p> : null}
      {query.error ? (
        <p role="alert">
          空间读取失败
          <button type="button" onClick={() => void query.refetch()}>
            重试
          </button>
        </p>
      ) : null}
      {query.data?.list.length === 0 ? <p>暂无说说</p> : null}
      {query.data?.list.map((post) => (
        <article key={post.tid}>
          <time>
            {new Date(post.time * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
          </time>
          <p>{post.content}</p>
          <QzoneMediaGrid images={post.images} videos={post.videos} />
          {post.repost ? (
            <blockquote>
              <p>
                {post.repost.nickname}：{post.repost.content}
              </p>
              <QzoneMediaGrid images={post.repost.images} videos={post.repost.videos} />
            </blockquote>
          ) : null}
        </article>
      ))}
    </section>
  );
}
