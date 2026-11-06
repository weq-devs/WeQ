/** 历史契约合成数据；不读取个人原件，也不声称验证了旧解码器。 */
import { revision } from './conformance.mjs';
import { actor, emptyNative, makeRecord, mediaHash, observation, time } from './fixtures.mjs';

export function historicalFixture() {
  const message = makeRecord('message', 'legacy-message', {
    conversation: { kind: 'unknown', id: null },
    messageId: null,
    sender: { identities: [], name: '旧昵称' },
    sentAt: { local: '2008-07-01 20:30', timezone: 'unknown', precision: 'unknown' },
    seq: null,
    content: [
      { type: 'text', text: `保留孤立码元:${String.fromCharCode(0xd800)}` },
      { type: 'media', mediaType: 'audio', resourceIds: ['legacy-audio', 'legacy-playback'] },
    ],
  });
  message.identity = { status: 'unverified', nativeNamespace: 'pcqq/msg0' };
  message.native = {
    attributes: [
      ['legacy.pcqq.header.color', 'integer', '16711680', 'verified'],
      ['legacy.pcqq.header.font_size', 'integer', '12', 'verified'],
      ['legacy.pcqq.header.font_name', 'text', '宋体', 'verified'],
      ['legacy.pcqq.header.font_family', 'integer', '0', 'verified'],
      ['legacy.pcqq.header.charset', 'integer', '134', 'verified'],
      ['legacy.pcqq.header.font_style', 'integer', '1', 'partial'],
      ['legacy.mobile.read', 'integer', '1', 'opaque'],
      ['legacy.mobile.extensionData', 'bytes', 'AP8=', 'opaque'],
      ['legacy.mobile.reservedInt1', 'integer', '0', 'opaque'],
      ['legacy.cloud.totalSeq', 'integer', '9007199254740993', 'partial'],
      ['legacy.cloud.editable', 'boolean', false, 'opaque'],
      ['legacy.cloud.msgEventInfo', 'json', { tag: 'uninterpreted' }, 'partial'],
      ['legacy.senderSnapshot.memberLevel', 'integer', '6', 'verified'],
      ['legacy.senderSnapshot.gender', 'integer', '0', 'partial'],
    ].map(([name, type, value, interpretation]) => ({
      target: '/data',
      name,
      interpretation,
      value: { type, value, ...(type === 'bytes' ? { encoding: 'base64' } : {}) },
    })),
    residuals: [],
  };
  const records = [message];
  function space(type, key, extra = {}) {
    const record = makeRecord('qzone', key, {
      type,
      owner: actor,
      author: actor,
      sourceId: key,
      createdAt: null,
      content: [{ type: 'text', format: 'html', text: `<p>${type}全文</p>` }],
      ...extra,
    });
    record.identity = { status: 'source-local', nativeNamespace: 'qzone/legacy' };
    record.native = emptyNative();
    records.push(record);
    return record;
  }
  const blog = space('blog', 'blog');
  const board = space('guestbook', 'board', {
    content: [{ type: 'text', format: 'ubb', text: '[b]留言全文[/b]' }],
  });
  space('reply', 'board-reply', { parentId: board.id, parentType: 'guestbook' });
  space('share', 'share', {
    content: [
      {
        type: 'structured',
        kind: 'link',
        value: {
          type: 'json',
          value: { url: 'https://example.invalid/original', publisher: '合成来源' },
        },
      },
    ],
  });
  space('favorite', 'favorite', { targetId: blog.id });
  space('visit', 'visit-1', { author: { identities: [], name: '访客' }, content: [] });
  space('visit', 'visit-2', { author: { identities: [], name: '访客' }, content: [] });
  const album = space('album', 'album');
  album.native.attributes = [
    ['classid', 'integer', '1'],
    ['className', 'text', '合成分类'],
    ['lastuploadtime', 'integer', '10'],
    ['modifytime', 'integer', '11'],
  ].map(([name, type, value]) => ({
    target: '/data',
    name: `legacy.qzone.${name}`,
    interpretation: 'partial',
    value: { type, value },
  }));
  const photo = space('photo', 'photo', {
    parentId: album.id,
    parentType: 'album',
    uploadedAt: time('10'),
    shotAt: { local: '2008-06-30', timezone: 'unknown', precision: 'day' },
    location: { name: '合成地点', latitude: 24.5, longitude: 118.1 },
  });
  const comment = space('comment', 'photo-comment', { parentId: photo.id, parentType: 'photo' });
  comment.native.attributes.push({
    target: '/data',
    name: 'likes',
    value: { type: 'json', value: [{ actor, likedAt: null }] },
  });
  const collection = makeRecord('collection', 'legacy-collection', {
    cid: 'legacy-cid',
    type: 'text',
    author: actor,
    createdAt: null,
    collectedAt: null,
    bodyStatus: 'complete',
    content: [{ type: 'text', text: 'QQ 收藏正文，与空间收藏分开' }],
  });
  collection.identity = { status: 'source-local', nativeNamespace: 'qq-collection/cid' };
  collection.native = {
    attributes: [
      ['bizKey', 'text', 'synthetic-biz'],
      ['qzoneUgcKey', 'text', 'synthetic-ugc'],
      ['topTime', 'integer', '0'],
    ].map(([name, type, value]) => ({
      target: '/data',
      name: `legacy.collection.${name}`,
      interpretation: 'partial',
      value: { type, value },
    })),
    residuals: [],
  };
  records.push(collection);
  for (const record of records) record.revision = revision(record);
  const observations = records.map((record, index) => {
    const item = observation(record, `legacy-${index}`, null);
    item.importedAt = time();
    item.source.kind = 'legacy-import';
    item.source.provenance = {
      file: 'synthetic/history.jsonl',
      chunk: 'synthetic-chunk',
      line: String(index + 1),
      sha256: 'a'.repeat(64),
      sourceAccount: { identities: [] },
      observerAccount: actor,
      scope: 'shokou_private',
    };
    item.legacyReferences = [
      {
        namespace: 'archive-v0/shokou_private',
        messageId: `archive-message-${index}`,
        variantId: `archive-variant-${index}`,
      },
    ];
    item.identityLinks = [
      {
        relation: 'display-alias',
        target: 'source:old-nickname',
        status: 'candidate',
        evidence: 'synthetic/name-only-not-identity',
      },
    ];
    item.mappings = record.native.attributes.map((attribute, n) => ({
      from: `/fields/${attribute.name}`,
      to: `/native/attributes/${n}/value`,
      transform: 'typed-identity-v1',
    }));
    return item;
  });
  return {
    format: 'weq-export',
    version: '1.0',
    profile: 'full',
    archiveId: 'historical-synthetic',
    scope: {
      account: { identities: [] },
      partition: 'shokou_private',
      selection: { type: 'text', value: 'synthetic-history' },
    },
    formats: ['json', 'jsonl'],
    incremental: { enabled: true, authority: 'jsonl' },
    records,
    observations,
    resources: [
      {
        id: 'legacy-audio',
        role: 'original',
        status: 'saved',
        observedAt: time(),
        path: `media/${mediaHash}`,
        sha256: mediaHash,
        size: '4',
        bindings: [
          {
            recordId: message.id,
            target: '/data/content/1',
            status: 'candidate',
            evidence: 'synthetic/filename-only',
          },
        ],
        native: emptyNative(),
        source: {
          id: 'tar-source',
          kind: 'legacy-import',
          locator: 'synthetic/old-pack',
          provenance: { container: 'tar', member: 'old/audio.silk', offset: '512', length: '4' },
        },
      },
      {
        id: 'legacy-playback',
        role: 'playback',
        status: 'missing',
        observedAt: time(),
        bindings: [
          {
            recordId: message.id,
            target: '/data/content/1',
            status: 'unresolved',
            evidence: 'synthetic/unresolved-original-binding',
          },
        ],
        derivation: {
          sourceResourceId: 'legacy-audio',
          operation: 'silk-to-wav',
          inputCodec: 'silk',
          outputCodec: 'pcm-wav',
          inputSha256: mediaHash,
          evidence: 'synthetic/old-conversion-manifest',
        },
        native: emptyNative(),
        source: {
          id: 'playback-source',
          kind: 'legacy-import',
          locator: 'synthetic/conversion-manifest',
        },
      },
    ],
  };
}
