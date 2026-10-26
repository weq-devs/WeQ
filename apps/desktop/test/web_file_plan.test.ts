import { expect, it } from 'vitest';
import { buildComposerSendPlan } from '../src/renderer/src/im-template/template/composerSend';
import { elementToToken } from '../src/renderer/src/im-template/template/draftElements';

it('浏览器选中的普通文件没有电脑路径时，仍可用原始字节建立发送计划', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const plan = buildComposerSendPlan({
    body: elementToToken({ kind: 'file', fileName: 'fixture.txt', fileSize: 3 }),
    locals: [{ key: 'fixture.txt:3', name: 'fixture.txt', bytes }],
    superStickers: new Map(),
  });
  expect(plan).toEqual({ kind: 'file', bytes, fileName: 'fixture.txt' });
});

it('桌面文件仍优先使用本地路径，不重复上传字节', () => {
  expect(
    buildComposerSendPlan({
      body: elementToToken({ kind: 'file', fileName: 'fixture.txt', fileSize: 3 }),
      locals: [
        {
          key: 'fixture.txt:3',
          name: 'fixture.txt',
          path: '/fixture.txt',
          bytes: new Uint8Array([1]),
        },
      ],
      superStickers: new Map(),
    }),
  ).toEqual({ kind: 'file', path: '/fixture.txt', fileName: 'fixture.txt' });
});
