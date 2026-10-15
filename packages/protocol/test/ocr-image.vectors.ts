/**
 * OcrImage (0xe07_0) 的黄金向量 —— 2026-10-16 抓包，Linux QQ 借本机会话物料重放成功。
 *
 *   上行： `OcrImage.encodeRequest(...)` 必须逐字节复现 `OCR_REQ_INNER_HEX`。
 *   下行： `OcrImage.decodeResponse(...)` 解 `OCR_RESP_INNER_HEX`（服务端原始回包）。
 *
 * 两条都是**内层 body**（信封 `08 <cmd> 10 <sub> 18 00 22 <len> …` 由 native 补）。
 */

/** 上行用到的图片地址。路径里的 UUID 本地无源，可直接当常量复用。 */
export const OCR_REQUEST_URL =
  'https://qqpicocr-70827.njc.vod.tencent-cloud.com/3d295613-c320-4ab3-a2a9-09c6ff2cad22' +
  '?file_md5=34e29e19f0b38c51e04b10b77258d68a';

/** 上行 inner body（218 字节）：`1`=任务类型、`2`/`3` 恒 0、`10`=图片（url + md5×2 + 字节数/宽/高）。 */
export const OCR_REQ_INNER_HEX =
  '08011000180052d1010a7f68747470733a2f2f71717069636f63722d37303832372e6e6a632e766f642e' +
  '74656e63656e742d636c6f75642e636f6d2f33643239353631332d633332302d346162332d613261392d' +
  '3039633666663263616432323f66696c655f6d64353d33346532396531396630623338633531653034' +
  '6231306237373235386436386152203334653239653139663062333863353165303462313062373732' +
  '3538643638615a20333465323965313966306233386335316530346231306237373235386436386160' +
  '8ea20768e70870f10a7800';

/** 下行 inner body（386 字节）。 */
export const OCR_RESP_INNER_HEX =
  '12047375636352f9020a4f0a0357655110631a200a0608e8021083010a0608ed031083010a0608ed0310' +
  'b9010a0608e80210b90122177b225061726167223a7b2250617261674e6f223a317d7d2a0b08e80210' +
  '830118850120360a560a0a3a39373537393033303610611a200a0608e80210d3010a0608b80510d301' +
  '0a0608b80510fe010a0608e80210fe0122177b225061726167223a7b2250617261674e6f223a327d7d' +
  '2a0b08e80210d30118d002202b1202656e1a2437636530653035382d613331302d346262382d386561' +
  '332d656263366163316465366663aa06027a68aa0602656eaa06026a70aa06026b72b206027a68ba06' +
  '0c0a026b721206e99fa9e8afadba06120a026573120ce8a5bfe78fade78999e8afadba060c0a026672' +
  '1206e6b395e8afadba060c0a0264651206e5beb7e8afadba06130a03554e4b120ce69caae79fa5e8af' +
  'ade7a78dba060c0a027a681206e4b8ade69687ba060c0a02656e1206e88bb1e8afadba060c0a026a70' +
  '1206e697a5e8afadf806e7088007f10a';

/** 回包里被识别出来的两段文字，以及它们在原图上的位置。 */
export const OCR_EXPECTED_BLOCKS = [
  {
    text: 'WeQ',
    parag: '{"Parag":{"ParagNo":1}}',
    rect: { x: 360, y: 131, width: 133, height: 54 },
    quad: [
      { x: 360, y: 131 },
      { x: 493, y: 131 },
      { x: 493, y: 185 },
      { x: 360, y: 185 },
    ],
  },
  {
    text: ':975790306',
    parag: '{"Parag":{"ParagNo":2}}',
    rect: { x: 360, y: 211, width: 336, height: 43 },
    quad: [
      { x: 360, y: 211 },
      { x: 696, y: 211 },
      { x: 696, y: 254 },
      { x: 360, y: 254 },
    ],
  },
] as const;

/** 图片尺寸 —— 上行送进去的尺寸，也是回包坐标系的基准。 */
export const OCR_REQUEST_SIZE = { width: 1127, height: 1393 };

/** 被测图片文件的 md5。 */
export const OCR_REQUEST_MD5 = '34e29e19f0b38c51e04b10b77258d68a';

/** 被测图片的字节数（库里 `40800.45405` = 请求 `4.10.12`）。 */
export const OCR_REQUEST_FILE_SIZE = 119054;

/** 回包里的 sessionId（每次请求都不同，这里只用于断言解码路径走通）。 */
export const OCR_RESP_SESSION_ID = '7ce0e058-a310-4bb8-8ea3-ebc6ac1de6fc';

/**
 * 下行**失败帧**（63 字节，实测：把一条已过期的 CDN 直链发给 0xe07_0）：
 *   `1` = 200、`2` = `FailedOperation.DownLoadError`、`3` = `服务忙,请稍后重试`、`10` = 空。
 */
export const OCR_RESP_EXPIRED_HEX =
  '08c801121d4661696c65644f7065726174696f6e2e446f776e4c6f61644572726f721a19e69c8de58aa1' +
  'e5bf992ce8afb7e7a88de5908ee9878de8af955200';
