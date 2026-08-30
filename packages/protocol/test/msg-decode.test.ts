import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeMessage, encode, ELEM, FACE_COMMON_PB, FACE_ELEM, FILE_TRANS_TOP, INLINE_KEYBOARD_PB, MARKDOWN_COMMON_PB, MSG_CONTENT, PIC_COMMON_PB, PTT_COMMON_PB, PUSH_MSG_BODY, REPLY_PB_RESERVE, TEXT_PB_RESERVE, VIDEO_COMMON_PB } from '../src/index';


/** Hex 字符串 → bytes（测试辅助）。 */
function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
describe('decodeMessage 简化消息解码', () => {
  it('把 PushMsgBody 映射成 head/sender/session/elements/dress', () => {
    const bytes = encode(PUSH_MSG_BODY, {
      responseHead: { fromUin: 12345, fromUid: 'u_abc', grp: { groupUin: 67890 } },
      contentHead: { msgType: 82, c2cCmd: 1, msgId: 111, sequence: 7, timestamp: 1700000000 },
      body: {
        richText: {
          elems: [
            { generalFlags: { widgetId: 156358, font: { fontId1: 22004, fontId2: 290024 } } },
            { bubble: { id: 2144536 } },
            { extraInfo: { groupCard: '2-estkim', level: 1 } },
            { text: { str: 'hi' } },
          ],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.head).toEqual({
      msgType: 82,
      subType: 0,
      c2cCmd: 1,
      msgId: 111,
      sequence: 7,
      timestamp: 1700000000,
    });
    expect(msg.sender).toEqual({ uin: 12345, uid: 'u_abc' });
    expect(msg.session).toEqual({ uin: 67890, uid: '' });
    // 装扮 elem（generalFlags / bubble）和 extraInfo 被剔除，只剩 text。
    expect(msg.elements).toHaveLength(1);
    expect(msg.elements[0]).toEqual({ kind: 'text', textContent: 'hi' });
    expect(msg.dress).toEqual({ bubble: 2144536, font: 22004, widget: 156358 });
  });

  it('无装扮时 dress 全 0', () => {
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: { richText: { elems: [{ text: { str: 'x' } }] } },
    });
    const msg = decodeMessage(bytes);
    expect(msg.dress).toEqual({ bubble: 0, font: 0, widget: 0 });
  });

  it('font 优先 font1，回退 font2 字节交换转换', () => {
    const font2Stored = 0x1234; // 4660，字节交换后 = 0x3412 = 13330
    const bytes = encode(PUSH_MSG_BODY, {
      body: {
        richText: {
          elems: [{ generalFlags: { font: { fontId1: 0, fontId2: font2Stored } } }],
        },
      },
    });
    const fallback = decodeMessage(bytes);
    expect(fallback.dress).toEqual({ bubble: 0, font: 13330, widget: 0 });

    const bytes2 = encode(PUSH_MSG_BODY, {
      body: {
        richText: {
          elems: [{ generalFlags: { font: { fontId1: 22004, fontId2: font2Stored } } }],
        },
      },
    });
    const preferred = decodeMessage(bytes2);
    expect(preferred.dress).toEqual({ bubble: 0, font: 22004, widget: 0 });
  });

  it('c2c 会话取 toUin/toUid', () => {
    const bytes = encode(PUSH_MSG_BODY, {
      responseHead: { fromUin: 1, fromUid: 'u_me', toUin: 2, toUid: 'u_friend' },
    });
    const msg = decodeMessage(bytes);
    expect(msg.session).toEqual({ uin: 2, uid: 'u_friend' });
  });

  it('把 @ 消息拆成独立的 at 元素，字段命名与 codec 一致', () => {
    const pbReserve = encode(TEXT_PB_RESERVE, {
      subType: 2,
      fromUin: 1707889225,
      atTargetUid: 'u_mGIBTBW7gF4Wocw8zapc6w',
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [
            { text: { str: ' 123' } },
            { text: { str: '@1-H3CoF6', attr6Buf: new Uint8Array([0, 1]), pbReserve } },
          ],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      { kind: 'text', textContent: ' 123' },
      { kind: 'at', textContent: '@1-H3CoF6', atTargetUid: 'u_mGIBTBW7gF4Wocw8zapc6w' },
    ]);
  });

  it('只有 uid 没有 uin 的 @ 元素直接丢弃（避免重复）', () => {
    const pbReserve = encode(TEXT_PB_RESERVE, {
      subType: 2,
      atTargetUid: 'u_mGIBTBW7gF4Wocw8zapc6w',
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [
            { text: { str: ' 123' } },
            { text: { str: '@1-H3CoF6', attr6Buf: new Uint8Array([0, 1]), pbReserve } },
          ],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([{ kind: 'text', textContent: ' 123' }]);
  });

  it('把 commonElem(serviceType=37) 里的 face 解析成 codec 风格（骰子/超级表情）', () => {
    const pbElem = encode(FACE_ELEM, {
      AniStickerId: '33',
      faceId: 358,
      superEmojiFlag1: 1,
      innerId: '4',
      faceText: '/骰子',
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 37, pbElem, businessType: 2 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      { kind: 'face', faceId: 358, faceText: '/骰子', AniStickerId: '33', innerId: '4', superEmojiFlag1: 1, subType: 3 },
    ]);
  });

  it('把 commonElem(serviceType=48) 里的 pic 解析成 codec 风格', () => {
    const pbElem = encode(PIC_COMMON_PB, {
      file: {
        body: {
          info: {
            fileName: '94CB55BB1442E8105F0D1CD8A1754C24.jpg',
            imgType: { imgType: 1000 },
            imgWidth: 1440,
            imgHeight: 1920,
          },
          fileToken: 'EhSvnu9IsaXDXYs0o5A7QyLJKlHM-Bin8BAg_wooxZXMuJe6lgMyBHByb2RQgL2jAVoQHxWlE-PjsO9N6fPiDydU-XoCgziCAQJneg',
        },
        url: { originalUrl: '/download?appid=1407&fileid=EhSvnu9IsaXDXYs0o5A7QyLJKlHM-Bin8BAg_wooxZXMuJe6lgMyBHByb2RQgL2jAVoQHxWlE-PjsO9N6fPiDydU-XoCgziCAQJneg' },
      },
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 48, pbElem, businessType: 20 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'pic',
        fileName: '94CB55BB1442E8105F0D1CD8A1754C24.jpg',
        fileToken: 'EhSvnu9IsaXDXYs0o5A7QyLJKlHM-Bin8BAg_wooxZXMuJe6lgMyBHByb2RQgL2jAVoQHxWlE-PjsO9N6fPiDydU-XoCgziCAQJneg',
        originalUrl: '/download?appid=1407&fileid=EhSvnu9IsaXDXYs0o5A7QyLJKlHM-Bin8BAg_wooxZXMuJe6lgMyBHByb2RQgL2jAVoQHxWlE-PjsO9N6fPiDydU-XoCgziCAQJneg',
        imgWidth: 1440,
        imgHeight: 1920,
        imgType: 1000,
      },
    ]);
  });

  it('把 commonElem(serviceType=48) 的完整 pic（含媒体索引字段）解析成 codec 风格', () => {
    const pbElem = encode(PIC_COMMON_PB, {
      file: {
        body: {
          info: {
            fileSize: 138475,
            md5Bytes: '94cb55bb1442e8105f0d1cd8a1754c24',
            contentHash: 'c1f08e001a49949fbb1560ca963d1c7355c56765',
            fileName: '94CB55BB1442E8105F0D1CD8A1754C24.jpg',
            imgType: { imgType: 1000 },
            imgWidth: 1440,
            imgHeight: 1920,
            original: 1,
          },
          fileToken: 'EhSvnu9IsaXDXYs0o5A7QyLJKlHM-Bin8BAg_wooxZXMuJe6lgMyBHByb2RQgL2jAVoQHxWlE-PjsO9N6fPiDydU-XoCgziCAQJneg',
          storeId: 1,
          uploadTime: 1787775592,
          ttl: 604800,
          subType: 0,
        },
        url: { originalUrl: '/download?appid=1407&fileid=EhSvnu9IsaXDXYs0o5A7QyLJKlHM-Bin8BAg_wooxZXMuJe6lgMyBHByb2RQgL2jAVoQHxWlE-PjsO9N6fPiDydU-XoCgziCAQJneg' },
      },
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 48, pbElem, businessType: 20 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'pic',
        fileName: '94CB55BB1442E8105F0D1CD8A1754C24.jpg',
        fileToken: 'EhSvnu9IsaXDXYs0o5A7QyLJKlHM-Bin8BAg_wooxZXMuJe6lgMyBHByb2RQgL2jAVoQHxWlE-PjsO9N6fPiDydU-XoCgziCAQJneg',
        fileSize: 138475,
        md5Bytes: hexBytes('94cb55bb1442e8105f0d1cd8a1754c24'),
        contentHash: hexBytes('c1f08e001a49949fbb1560ca963d1c7355c56765'),
        originalUrl: '/download?appid=1407&fileid=EhSvnu9IsaXDXYs0o5A7QyLJKlHM-Bin8BAg_wooxZXMuJe6lgMyBHByb2RQgL2jAVoQHxWlE-PjsO9N6fPiDydU-XoCgziCAQJneg',
        imgWidth: 1440,
        imgHeight: 1920,
        imgType: 1000,
        isOriginal: true,
        storeId: 1,
        uploadTime: 1787775592,
        fileTTL: 604800,
        subType: 0,
      },
    ]);
  });

  it('把 commonElem(serviceType=48, businessType=21) 里的 video 解析成 codec 风格', () => {
    const pbElem = encode(VIDEO_COMMON_PB, {
      files: [
        {
          body: {
            info: {
              fileName: '0680b7b40443500c8a7dd065b1dfc8ab.mp4',
              videoWidth: 640,
              videoHeight: 1138,
              videoDuration: 20,
            },
            fileToken: 'EhSGwX-axufRV1Z0IFs6KEb8ox47Fhjsvt0CIIcLKLCH95yZupYDMgRwcm9kUID1JFoQshjBLZVL6xYtp8UMe14rhHoCQQmCAQJneg',
          },
        },
        {
          body: {
            fileToken: 'EhQ5_bMiFVTvOn7qn2F-XNg2fT3A4hjchgcgiAso0tn7nJm6lgMyBHByb2RQgPUkWhBH7cfvdszCgZjYK-W56WSjegKkeIIBAmd6',
          },
        },
      ],
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 48, pbElem, businessType: 21 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'video',
        fileName: '0680b7b40443500c8a7dd065b1dfc8ab.mp4',
        fileToken: 'EhSGwX-axufRV1Z0IFs6KEb8ox47Fhjsvt0CIIcLKLCH95yZupYDMgRwcm9kUID1JFoQshjBLZVL6xYtp8UMe14rhHoCQQmCAQJneg',
        videoToken: 'EhQ5_bMiFVTvOn7qn2F-XNg2fT3A4hjchgcgiAso0tn7nJm6lgMyBHByb2RQgPUkWhBH7cfvdszCgZjYK-W56WSjegKkeIIBAmd6',
        videoWidth: 640,
        videoHeight: 1138,
        videoDuration: 20,
      },
    ]);
  });

  it('把 commonElem(serviceType=48, businessType=21) 的完整 video（含 videoExt/storeId）解析成 codec 风格', () => {
    const pbElem = encode(VIDEO_COMMON_PB, {
      files: [
        {
          body: {
            info: {
              fileSize: 4627820,
              md5Bytes: '85736dbff95c16855316709df9f9e6bb',
              contentHash: 'f661aa75b2fa9f4b84b48db01417517046998007',
              fileName: '85736dbff95c16855316709df9f9e6bb.mp4',
              videoWidth: 640,
              videoHeight: 1138,
              videoDuration: 12,
              original: 0,
            },
            fileToken: 'EhT2Yap1svqfS4S0jbAUF1FwRpmABxjsupoCIIcLKKad54iPv5YDMgRwcm9kUID1JFoQ6_QiNoSQQMIjeQzItOxLeHoCsSqCAQJneg',
            storeId: 1,
            uploadTime: 1787775592,
            ttl: 604800,
            subType: 0,
          },
        },
        {
          body: {
            info: {
              fileSize: 96376,
              md5Bytes: 'f600dc290b9fff77f3597e56c0f218a9',
              contentHash: 'c1f08e001a49949fbb1560ca963d1c7355c56765',
              fileName: '85736dbff95c16855316709df9f9e6bb_0.png',
            },
            fileToken: 'EhTB8I4AGkmUn7sVYMqWPRxzVcVnZRj48AUgiAsomI7qiI-_lgMyBHByb2RQgPUkWhDALx4bAWbyaTWHNALk_r7degJNUoIBAmd6',
            storeId: 1,
            uploadTime: 1787775592,
            ttl: 604800,
            subType: 100,
          },
        },
      ],
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 48, pbElem, businessType: 21 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'video',
        fileName: '85736dbff95c16855316709df9f9e6bb.mp4',
        fileToken: 'EhT2Yap1svqfS4S0jbAUF1FwRpmABxjsupoCIIcLKKad54iPv5YDMgRwcm9kUID1JFoQ6_QiNoSQQMIjeQzItOxLeHoCsSqCAQJneg',
        fileSize: 4627820,
        md5Bytes: hexBytes('85736dbff95c16855316709df9f9e6bb'),
        contentHash: hexBytes('f661aa75b2fa9f4b84b48db01417517046998007'),
        videoWidth: 640,
        videoHeight: 1138,
        videoDuration: 12,
        isOriginal: false,
        storeId: 1,
        uploadTime: 1787775592,
        fileTTL: 604800,
        subType: 0,
        videoToken: 'EhTB8I4AGkmUn7sVYMqWPRxzVcVnZRj48AUgiAsomI7qiI-_lgMyBHByb2RQgPUkWhDALx4bAWbyaTWHNALk_r7degJNUoIBAmd6',
        channelParams: hexBytes('f600dc290b9fff77f3597e56c0f218a9'),
        videoFlag45421: hexBytes('c1f08e001a49949fbb1560ca963d1c7355c56765'),
      },
    ]);
  });

  it('把 MsgBody.msgContent 里的 notOnlineFile 解析成 codec 风格 file（私聊文件）', () => {
    const msgContent = encode(MSG_CONTENT, {
      notOnlineFile: {
        fileType: 0,
        fileUuid: '4952cc65f95b09df4de35ea1c783c368_1b2da186-a18c-11f1-a59d-c946be0004f7',
        fileMd5: hexBytes('d26ceb7d661d55541aa9579e32b00bc0'),
        fileName: 'bg.py',
        fileSize: 1504,
        subcmd: 1,
        dangerEvel: 0,
        expireTime: 1788984854,
        fileHash: 'D6EATj32CMmksa4GEhRVdVzQUvfiaUHTd6ciaZ8TOePibF04BjgCyChHyjulr3UBjC5uibgDOImQgsgEQANIAQY',
      },
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: { richText: {}, msgContent },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'file',
        fileName: 'bg.py',
        fileSize: 1504,
        fileToken: '4952cc65f95b09df4de35ea1c783c368_1b2da186-a18c-11f1-a59d-c946be0004f7',
        md5Bytes2: hexBytes('d26ceb7d661d55541aa9579e32b00bc0'),
        transferFlag45504: 'D6EATj32CMmksa4GEhRVdVzQUvfiaUHTd6ciaZ8TOePibF04BjgCyChHyjulr3UBjC5uibgDOImQgsgEQANIAQY',
        uploadTime: 1788984854,
        subType: 0,
      },
    ]);
  });
  it('把 transElem(elemType=24) 的 file 解析成 codec 风格（跳过 3 字节前缀）', () => {
    const prefix = new Uint8Array([0x01, 0x00, 0x93]);
    const body = encode(FILE_TRANS_TOP, {
      field1: 6,
      field2: 'misc.db',
      field3: '603136Byte',
      file: {
        info: {
          field1: 102,
          fileToken: '/20a1c950-88ad-4011-82d3-81f302be4145',
          fileSize: 603136,
          fileName: 'misc.db',
        },
      },
    });
    const elemValue = new Uint8Array(prefix.length + body.length);
    elemValue.set(prefix, 0);
    elemValue.set(body, prefix.length);
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ transElem: { elemType: 24, elemValue } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'file',
        fileName: 'misc.db',
        fileSize: 603136,
        fileToken: '/20a1c950-88ad-4011-82d3-81f302be4145',
        busId: 102,
      },
    ]);
  });

  it('transElem(elemType=24) 无前缀的干净 protobuf 也正常解析', () => {
    const body = encode(FILE_TRANS_TOP, {
      field1: 6,
      field2: 'misc.db',
      field3: '603136Byte',
      file: {
        info: {
          field1: 102,
          fileToken: '/20a1c950-88ad-4011-82d3-81f302be4145',
          fileSize: 603136,
          fileName: 'misc.db',
        },
      },
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ transElem: { elemType: 24, elemValue: body } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'file',
        fileName: 'misc.db',
        fileSize: 603136,
        fileToken: '/20a1c950-88ad-4011-82d3-81f302be4145',
        busId: 102,
      },
    ]);
  });

  it('把 marketFace 解析成 codec 风格 mface，只保留 5 个字段', () => {
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [
            {
              marketFace: {
                faceName: 'drop-me',
                itemType: 3,
                faceInfo: 2,
                marketEmoticonId: new Uint8Array([1, 2, 3, 4]),
                emojiPackId: 5,
                subType: 0,
                encryptKey: 'key123',
                param: new Uint8Array([9]),
                mediaType: 1,
                previewWidth: 100,
                previewHeight: 200,
                mobileParam: new Uint8Array([1]),
                pbReserve: new Uint8Array([2]),
              },
            },
          ],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'mface',
        marketEmoticonId: new Uint8Array([1, 2, 3, 4]),
        emojiPackId: 5,
        encryptKey: 'key123',
        previewWidth: 100,
        previewHeight: 200,
      },
    ]);
  });

  it('把 commonElem(serviceType=45) 里的 markdown 解析成 codec 风格，fileSetId 可选', () => {
    const pbElem = encode(MARKDOWN_COMMON_PB, {
      markdownContent: '[闪传](mqqapi://markdown/node)',
      markdownTextSummary: '[QQ闪传] QQ20260824-141626.png',
      flashTransferInfo: { fileSetId: '866cbaa1-a092-408d-a8d4-52706d764138' },
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 45, pbElem, businessType: 3 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'markdown',
        markdownContent: '[闪传](mqqapi://markdown/node)',
        markdownTextSummary: '[QQ闪传] QQ20260824-141626.png',
        flashTransferInfo: { fileSetId: '866cbaa1-a092-408d-a8d4-52706d764138' },
      },
    ]);

    const pbElemNoFlash = encode(MARKDOWN_COMMON_PB, {
      markdownContent: 'plain',
      markdownTextSummary: 'summary',
    });
    const bytes2 = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 45, pbElem: pbElemNoFlash, businessType: 3 } }],
        },
      },
    });
    const msg2 = decodeMessage(bytes2);
    expect(msg2.elements).toEqual([
      { kind: 'markdown', markdownContent: 'plain', markdownTextSummary: 'summary' },
    ]);
  });

  it('把 commonElem(serviceType=46) 内联键盘解析成 codec 风格 inlineKeyboard', () => {
    const pbElem = encode(INLINE_KEYBOARD_PB, {
      group: {
        buttons: {
          buttons: [
            {
              buttonId: 'broadcast_platform',
              labelInfo: { label: '前往夏令营平台', visitedLabel: '前往夏令营平台', style: 1 },
              actionInfo: { actionType: { actionType: 2 }, action: 'https://summer.yulinsec.cn' },
            },
            {
              buttonId: 'broadcast_rank',
              labelInfo: { label: '发送#rank', visitedLabel: '发送#rank', style: 1 },
              actionInfo: { actionType: { actionType: 2 }, action: '#rank' },
            },
          ],
        },
        keyboardBotAppId: 1905356414,
      },
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 46, pbElem, businessType: 1 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'inlineKeyboard',
        keyboardRows: [
          {
            buttons: [
              {
                buttonId: 'broadcast_platform',
                label: '前往夏令营平台',
                visitedLabel: '前往夏令营平台',
                style: 1,
                action: 'https://summer.yulinsec.cn',
                actionType: 2,
              },
              {
                buttonId: 'broadcast_rank',
                label: '发送#rank',
                visitedLabel: '发送#rank',
                style: 1,
                action: '#rank',
                actionType: 2,
              },
            ],
          },
        ],
        keyboardBotAppId: 1905356414,
      },
    ]);
  });

  it('把 commonElem(serviceType=33) 普通表情解析成 codec 风格 face', () => {
    const pbElem = encode(FACE_COMMON_PB, { faceId: 324, faceText: '/吃糖' });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 33, pbElem, businessType: 1 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([{ kind: 'face', faceId: 324, faceText: '/吃糖', subType: 1 }]);
  });

  it('把老 wire 直出的 elem.face 解析成 codec 风格 face（index→faceId，old 丢弃）', () => {
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ face: { index: 178, old: new Uint8Array([0x14, 0xf3]) } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([{ kind: 'face', faceId: 178, subType: 1 }]);
  });

  it('未知元素类型直接丢弃，不再原样输出', () => {
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [
            { groupFile: { filename: 'x.zip', fileSize: 100 } },
            { text: { str: 'hi' } },
          ],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([{ kind: 'text', textContent: 'hi' }]);
  });

  it('把 wallet 红包解析成 codec 风格 wallet，专属红包带 walletDesignatedUin', () => {
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [
            {
              wallet: {
                body: {
                  detail: {
                    redbagTitle: '恭喜发财',
                    openPrompt: '赶紧点击拆开吧',
                    subTitle: 'QQ红包',
                    skin: { skinId: 2309 },
                  },
                  walletDesignatedUin: 2863253201,
                },
              },
            },
          ],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'wallet',
        walletDetail: {
          redbagTitle: '恭喜发财',
          openPrompt: '赶紧点击拆开吧',
          subTitle: 'QQ红包',
          receiptList: { skinId: 2309 },
        },
        walletDesignatedUin: 2863253201,
      },
    ]);
  });

  it('把 lightApp 的 ark 卡片解析成 codec 风格 ark，解压出 arkData JSON', () => {
    const json = '{"app":"com.tencent.tuwen.lua","config":{"ctime":1787292147,"forward":1,"token":"1df62b88487339f857cefe5c82de6831","type":"normal"}}';
    const data = new Uint8Array([0x01, ...deflateSync(Buffer.from(json, 'utf8'))]);
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ lightApp: { data } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([{ kind: 'ark', arkData: json }]);
  });

  it('把 richMsg(serviceId=35) 合并转发解析成 codec 风格 multiMsg，解压出 xmlContent', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><msg serviceID="35" templateID="1" action="viewMultiMsg" brief="[聊天记录]" tSum="4" flag="3"><item layout="1"><title>群聊的聊天记录</title></item></msg>';
    const payload = new Uint8Array([0x01, ...deflateSync(Buffer.from(xml, 'utf8'))]);
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ richMsg: { template1: payload, serviceId: 35 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([{ kind: 'multiMsg', xmlContent: xml }]);
  });

  it('把带 m_resid 的合并转发解析出 resId（供 SsoRecvLongMsg 重新拉取）', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><msg serviceID="35" templateID="1" action="viewMultiMsg" brief="[聊天记录]" m_resid="f26265be-d9d4-11f1-8db2-93b16d2d5c42" tSum="4" flag="3"><item layout="1"><title>群聊的聊天记录</title></item></msg>';
    const payload = new Uint8Array([0x01, ...deflateSync(Buffer.from(xml, 'utf8'))]);
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ richMsg: { template1: payload, serviceId: 35 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'multiMsg',
        xmlContent: xml,
        resId: 'f26265be-d9d4-11f1-8db2-93b16d2d5c42',
      },
    ]);
  });

  it('把 srcMsg 解析成 codec 风格 reply，origElements 嵌套解析', () => {
    const quotedText = encode(ELEM, { text: { str: '[在做了]' } });
    const pbReserve = encode(REPLY_PB_RESERVE, { origSenderUid: 'u_mGIBTBW7gF4Wocw8zapc6w' });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [
            {
              replyElement: {
                origMsgSeq: [1553],
                origSenderUin: 1707889225,
                origMsgTime: 1787607889,
                origElementsRaw: [quotedText],
                pbReserve,
              },
            },
            { text: { str: ' ' } },
          ],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'reply',
        origMsgSeq: 1553,
        origMsgIndex: 1553,
        origSenderUin: 1707889225,
        origMsgTime: 1787607889,
        origSenderUid: 'u_mGIBTBW7gF4Wocw8zapc6w',
        origElements: [{ kind: 'text', textContent: '[在做了]' }],
      },
      { kind: 'text', textContent: ' ' },
    ]);
  });

  it('把 commonElem(serviceType=48, businessType=22) 里的 ptt 解析成 codec 风格', () => {
    const waveform = new Uint8Array(
      '440175aca4c8a6afb4acbba1a5b9b599c5a7acbfb09cb0a9bfa7b3a8c6bbadc7a8a294bf9dc2a4d6b8b7a200'
        .match(/../g)!
        .map((hex) => Number.parseInt(hex, 16)),
    );
    const pbElem = encode(PTT_COMMON_PB, {
      file: {
        body: {
          info: { fileName: '06854585bfdbfcf2e6549e343d84b288.amr', pttDuration: 4 },
          fileToken: 'EhRzCKeU1416OieJeT0cy5L1zHRupRjwNyD7Cij6qvjgnLqWAzIEcHJvZFCA9SRaEOy9a8N_VG_60e1iZMx1dOh6AlEuggECZ3o',
        },
      },
      extra: {
        meta: { wave: { waveform } },
      },
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 48, pbElem, businessType: 22 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'ptt',
        fileName: '06854585bfdbfcf2e6549e343d84b288.amr',
        fileToken: 'EhRzCKeU1416OieJeT0cy5L1zHRupRjwNyD7Cij6qvjgnLqWAzIEcHJvZFCA9SRaEOy9a8N_VG_60e1iZMx1dOh6AlEuggECZ3o',
        pttDuration: 4,
        waveform,
      },
    ]);
  });

  it('把 commonElem(serviceType=48, businessType=22) 的完整 ptt（含媒体索引字段）解析成 codec 风格', () => {
    const waveform = new Uint8Array(
      '440175aca4c8a6afb4acbba1a5b9b599c5a7acbfb09cb0a9bfa7b3a8c6bbadc7a8a294bf9dc2a4d6b8b7a200'
        .match(/../g)!
        .map((hex) => Number.parseInt(hex, 16)),
    );
    const pbElem = encode(PTT_COMMON_PB, {
      file: {
        body: {
          info: {
            fileSize: 21248,
            md5Bytes: '06854585bfdbfcf2e6549e343d84b288',
            contentHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
            fileName: '06854585bfdbfcf2e6549e343d84b288.amr',
            pttDuration: 4,
            original: 1,
          },
          fileToken: 'EhRzCKeU1416OieJeT0cy5L1zHRupRjwNyD7Cij6qvjgnLqWAzIEcHJvZFCA9SRaEOy9a8N_VG_60e1iZMx1dOh6AlEuggECZ3o',
          storeId: 1,
          uploadTime: 1787775592,
          ttl: 604800,
          subType: 0,
        },
      },
      extra: {
        meta: { wave: { waveform } },
      },
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: {
        richText: {
          elems: [{ commonElem: { serviceType: 48, pbElem, businessType: 22 } }],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.elements).toEqual([
      {
        kind: 'ptt',
        fileName: '06854585bfdbfcf2e6549e343d84b288.amr',
        fileToken: 'EhRzCKeU1416OieJeT0cy5L1zHRupRjwNyD7Cij6qvjgnLqWAzIEcHJvZFCA9SRaEOy9a8N_VG_60e1iZMx1dOh6AlEuggECZ3o',
        fileSize: 21248,
        md5Bytes: hexBytes('06854585bfdbfcf2e6549e343d84b288'),
        contentHash: hexBytes('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'),
        pttDuration: 4,
        isOriginal: true,
        storeId: 1,
        uploadTime: 1787775592,
        fileTTL: 604800,
        subType: 0,
        waveform,
      },
    ]);
  });
});
