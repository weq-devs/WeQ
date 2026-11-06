/** 人工构造的领域语义夹具；不是从现有渲染输出或 schema 反射生成。 */
import { canonical, hash, revision } from './conformance.mjs';

export const actor = {
  identities: [{ namespace: 'local', value: 'fixture-sender' }],
  name: '合成发送者',
};
export const time = (unixSeconds = '1793856000') => ({ unixSeconds, precision: 'second' });
export const objectId = (kind, ...parts) =>
  `${kind}:${hash(canonical(['fixture-account', kind, ...parts]))}`;
export const coverage = () => ({ acquisition: 'complete-for-selection', parsing: 'complete' });
export const mediaHash = 'edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb';
export const emptyNative = () => ({ attributes: [], residuals: [] });

export function makeRecord(kind, sourceId, data, partial = false) {
  const record = {
    id: objectId(kind, sourceId),
    kind,
    revision: '',
    state: 'present',
    coverage: coverage(),
    data,
  };
  if (partial)
    record.coverage = {
      acquisition: 'partial',
      parsing: 'opaque',
      issues: ['synthetic-unparsed-content'],
    };
  record.revision = revision(record);
  return record;
}

export function observation(record, index, observedAt = time()) {
  return {
    id: `observation-${index}`,
    recordId: record.id,
    revision: record.revision,
    observedAt,
    source: {
      id: `source-${index}`,
      kind: record.kind === 'generated' ? 'local-generated' : 'cache',
      locator: `synthetic/${record.kind}/${index}`,
      modifiedAt: null,
    },
  };
}

export function basicFixture() {
  const records = [];
  const text = (value) => ({ type: 'text', text: value });
  const message = (kind, id) => ({
    conversation: { kind, id: `conversation-${kind}` },
    messageId: id,
    sender: actor,
    sentAt: time(),
    seq: '9007199254740993',
    content: [
      text('原正文\n第二行'),
      { type: 'media', mediaType: 'file', resourceIds: ['asset-original'] },
      {
        type: 'forward',
        status: 'complete',
        title: '嵌套转发',
        records: [
          {
            id: 'embedded-1',
            sender: actor,
            sentAt: null,
            seq: null,
            content: [
              {
                type: 'forward',
                status: 'complete',
                records: [
                  {
                    id: 'embedded-2',
                    sender: actor,
                    sentAt: time(),
                    seq: '2',
                    content: [
                      text('内部消息'),
                      { type: 'media', mediaType: 'image', resourceIds: ['asset-inline'] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { type: 'reference', target: 'embedded-2', status: 'resolved' },
    ],
  });
  for (const kind of ['c2c', 'group', 'service', 'official', 'data-line', 'guild-direct'])
    records.push(makeRecord('message', kind, message(kind, `msg-${kind}`)));
  records[0].coverage.parsing = 'partial';
  records[0].revision = revision(records[0]);
  const postId = objectId('qzone', 'post');
  const commentId = objectId('qzone', 'comment');
  const albumId = objectId('qzone', 'album');
  for (const type of ['post', 'comment', 'reply', 'album', 'photo', 'video', 'repost']) {
    const data = {
      type,
      owner: actor,
      sourceId: `qzone-${type}`,
      author: actor,
      createdAt: time(),
      content: [text(`${type}正文`)],
    };
    if (['comment', 'reply'].includes(type)) data.parentId = type === 'reply' ? commentId : postId;
    if (['photo', 'video'].includes(type)) {
      data.parentId = albumId;
      data.content.push({
        type: 'media',
        mediaType: type === 'photo' ? 'image' : 'video',
        resourceIds: [type === 'photo' ? 'asset-inline' : 'asset-video'],
      });
    }
    if (type === 'repost') data.repostId = postId;
    if (type === 'post') data.counts = { comments: '2', likes: null, reposts: '0' };
    records.push(makeRecord('qzone', type, data));
  }
  for (const type of [
    'text',
    'link',
    'gallery',
    'audio',
    'video',
    'file',
    'location',
    'richMedia',
    'unknown',
  ]) {
    let content = [text('收藏全文')];
    if (type === 'link')
      content = [
        {
          type: 'structured',
          kind: 'link',
          value: {
            type: 'json',
            value: {
              url: 'https://example.invalid/article',
              publisher: '合成来源',
              brief: '独立摘要',
            },
          },
        },
      ];
    if (type === 'location')
      content = [
        {
          type: 'structured',
          kind: 'location',
          value: { type: 'json', value: { latitude: 24.5, longitude: 118.1, address: '合成地址' } },
        },
      ];
    if (['gallery', 'audio', 'video', 'file'].includes(type))
      content = [
        {
          type: 'media',
          mediaType: type === 'gallery' ? 'image' : type,
          resourceIds: [type === 'video' ? 'asset-video' : 'asset-original'],
        },
      ];
    if (type === 'richMedia')
      content = [
        { type: 'text', format: 'html', text: '<p>收藏全文<img src="cid:inline-1"></p>' },
        { type: 'media', mediaType: 'image', resourceIds: ['asset-inline'] },
      ];
    if (type === 'unknown')
      content = [{ type: 'unknown', sourceType: '999', reason: '合成未识别类型' }];
    records.push(
      makeRecord(
        'collection',
        type,
        {
          cid: `cid-${type}`,
          type,
          author: actor,
          createdAt: time(),
          collectedAt: time('1793856100'),
          bodyStatus: type === 'unknown' ? 'opaque' : 'complete',
          content,
        },
        type === 'unknown',
      ),
    );
  }
  records.push(
    makeRecord('mail', 'mail-1', {
      mailId: 'opaque-mail-1',
      messageId: '<synthetic@example.invalid>',
      sender: { identities: [{ namespace: 'email', value: 'sender@example.invalid' }] },
      to: [actor],
      cc: [],
      bcc: [],
      replyTo: null,
      sentAt: time(),
      subject: '合成邮件',
      threadId: 'thread-1',
      inReplyTo: null,
      content: [{ type: 'text', format: 'html', text: '<p>原始正文<img src="cid:inline-1"></p>' }],
      attachments: ['asset-original'],
      inlineResources: [{ cid: 'inline-1', resourceId: 'asset-inline' }],
    }),
  );
  for (const type of ['contact', 'group', 'member', 'category']) {
    const data = { type, subject: actor, name: `合成${type}`, remark: '' };
    if (type === 'member') data.parentId = objectId('directory', 'group');
    if (type === 'contact') data.categoryIds = [objectId('directory', 'category')];
    records.push(makeRecord('directory', type, data));
  }
  for (const targetKind of ['persona', 'group', 'assistant'])
    records.push(
      makeRecord('generated', targetKind, {
        origin: 'local-generated',
        targetKind,
        ownerId: targetKind,
        sessionId: targetKind === 'persona' ? null : 'session-1',
        messageId: 'generated-1',
        sender: actor,
        role: 'assistant',
        sentAt: { unixSeconds: '1793856000.125', precision: 'millisecond' },
        content: [
          text('生成正文'),
          { type: 'media', mediaType: 'file', resourceIds: ['asset-original'] },
        ],
        process: [
          {
            type: 'json',
            value: {
              kind: 'tool',
              name: 'synthetic-tool',
              input: { query: '合成输入' },
              result: '合成输出',
            },
          },
        ],
      }),
    );
  for (const type of [
    'folder',
    'file',
    'album',
    'photo',
    'video',
    'emoji-pack',
    'emoji',
    'bubble',
    'font',
    'widget',
    'artifact',
    'report',
    'bot-package',
  ])
    records.push(
      makeRecord('resource-directory', type, {
        type,
        sourceId: `resource-${type}`,
        owner: actor,
        name: `合成${type}`,
        ...(type === 'file' ? { parentId: objectId('resource-directory', 'folder') } : {}),
        resourceIds: ['asset-original'],
      }),
    );
  return {
    format: 'weq-export',
    version: '1.0',
    profile: 'basic',
    archiveId: 'synthetic-archive',
    scope: {
      account: { identities: [{ namespace: 'local', value: 'fixture-account' }] },
      selection: { type: 'json', value: { mode: 'synthetic-selected-objects' } },
    },
    formats: ['json', 'jsonl'],
    incremental: { enabled: true, authority: 'jsonl' },
    records,
    observations: records.map((record, index) => observation(record, index)),
    resources: [
      {
        id: 'asset-original',
        role: 'original',
        status: 'saved',
        observedAt: time(),
        name: 'synthetic.txt',
        mime: 'text/plain',
        size: '4',
        path: `media/${mediaHash}`,
        sha256: mediaHash,
      },
      {
        id: 'asset-inline',
        role: 'original',
        status: 'not-requested',
        observedAt: time(),
        name: 'inline.png',
        url: 'https://example.invalid/inline.png',
      },
      {
        id: 'asset-video',
        role: 'original',
        status: 'unavailable',
        observedAt: time(),
        name: 'video.mp4',
        error: '合成不可访问视频',
      },
    ],
  };
}

export function fullFixture() {
  const archive = basicFixture();
  archive.profile = 'full';
  archive.archiveId = 'synthetic-archive-full';
  const attributes = {
    message: ['clientSeq', { type: 'integer', value: '9223372036854775807' }],
    qzone: ['likes', { type: 'json', value: [{ actor, likedAt: null }] }],
    collection: ['sequence', { type: 'integer', value: '9007199254740995' }],
    mail: ['unread', { type: 'boolean', value: false }],
    directory: ['signature', { type: 'text', value: '合成签名' }],
    generated: ['model', { type: 'text', value: 'synthetic-model' }],
    'resource-directory': ['available', { type: 'boolean', value: true }],
  };
  archive.records.forEach((record, index) => {
    const [name, value] = attributes[record.kind];
    record.native = { attributes: [{ target: '/data', name, value }], residuals: [] };
    if (record.kind === 'message' && index === 0) {
      record.coverage.parsing = 'partial';
      record.native.residuals.push(
        {
          source: `source-${index}`,
          path: '/40800/45001/0/99999/0',
          reason: 'unknown-field',
          wireType: 2,
          occurrence: 0,
          value: { type: 'bytes', encoding: 'base64', value: 'AAEC' },
          offset: '20',
          length: '3',
        },
        {
          source: `source-${index}`,
          path: '/40800/tail',
          reason: 'unconsumed-tail',
          value: { type: 'bytes', encoding: 'base64', value: '/wA=' },
          offset: '23',
          length: '2',
        },
      );
    }
    if (record.data.type === 'unknown')
      record.native.residuals.push({
        source: `source-${index}`,
        path: '/180015/99999/0',
        reason: 'decode-failed',
        value: { type: 'bytes', encoding: 'base64', value: 'AP8=' },
      });
    record.revision = revision(record);
    archive.observations[index].revision = record.revision;
    archive.observations[index].mappings = [
      { from: '/known-extra', to: '/native/attributes/0/value', transform: 'identity-v1' },
    ];
  });
  archive.resources.forEach((resource, index) => {
    resource.native = emptyNative();
    resource.source = {
      id: `resource-source-${index}`,
      kind: 'cache',
      locator: `synthetic/resource/${index}`,
    };
  });
  return archive;
}
