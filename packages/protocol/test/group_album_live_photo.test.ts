import { expect, it } from 'vitest';
import { decode, encode, message } from '../src/protobuf';
import { GET_MEDIA_LIST_RESPONSE } from '../src/oidb/media-schemas';

const fixtureShape = message([
  {
    name: 'data',
    tag: 4,
    type: message([
      {
        name: 'items',
        tag: 3,
        repeated: true,
        type: message([
          { name: 'type', tag: 1, type: 'uint32' },
          { name: 'live', tag: 18, type: 'bool', force: true },
        ]),
      },
    ]),
  },
]);
it('群相册媒体类型与显式实况位分离，缺失不补 false', () => {
  const decoded = decode(
    GET_MEDIA_LIST_RESPONSE,
    encode(fixtureShape, {
      data: { items: [{ type: 1, live: true }, { type: 1, live: false }, { type: 1 }] },
    }),
  );
  expect(decoded.data).toMatchObject({
    mediaList: [{ type: 1, isLivePhoto: true }, { type: 1, isLivePhoto: false }, { type: 1 }],
  });
  expect((decoded.data as { mediaList: object[] }).mediaList[2]).not.toHaveProperty('isLivePhoto');
});
it('同 tag 的非布尔 wire 不作为实况标记', () => {
  const wrongWire = message([
    {
      name: 'data',
      tag: 4,
      type: message([
        {
          name: 'items',
          tag: 3,
          repeated: true,
          type: message([{ name: 'unknown', tag: 18, type: 'string' }]),
        },
      ]),
    },
  ]);
  const decoded = decode(
    GET_MEDIA_LIST_RESPONSE,
    encode(wrongWire, { data: { items: [{ unknown: 'not a flag' }] } }),
  );
  expect((decoded.data as { mediaList: object[] }).mediaList[0]).not.toHaveProperty('isLivePhoto');
});
