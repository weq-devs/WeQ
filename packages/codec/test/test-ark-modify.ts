/**
 * 验证脚本:读取指定 ARK 元素,修改昵称,写回数据库
 *
 * 用法: pnpm tsx packages/codec/scripts/test-ark-modify.ts
 */

import { ProtoMsg } from '../src/core';
import { MsgBody } from '../src/proto/msg/common/body';
import { decodeElement, encodeElement } from '../src/element';
import type { ArkElement } from '../src/element';
import { loadNative } from '../../native/src/index';
import { QqDb } from '../../db/src/qq_db';

const DB_PATH = 'D:\\estkim\\T\\Tencent Files\\1707889225\\nt_qq\\nt_db\\nt_msg.db';
const DB_KEY = '^;<kXZ;RI[@]yTD<';
const TABLE = 'c2c_msg_table';
const ROWID = '7650288743672057123';

const bodyCodec = new ProtoMsg(MsgBody);

async function main() {
  const nt = loadNative().ntHelper;
  const db = new QqDb(nt, { dbPath: DB_PATH, key: DB_KEY });


  const checkRows = await db.query(`SELECT rowid, "40001", "40800" FROM ${TABLE} WHERE rowid = ?`, [BigInt(ROWID)]);

  const blob = checkRows[0]![2] as Uint8Array;

  const decoded = bodyCodec.decode(blob);
  const elements = (decoded.elements ?? []).map(decodeElement);

  const arkEl = elements.find(e => e.kind === 'ark') as ArkElement | undefined;
  if (!arkEl) {
    throw new Error('未找到 ARK 元素');
  }

  const writeData = {
    "app":"com.tencent.tuwen.lua",
    "bizsrc":"qqconnect.sdkshare",
    "config":{
      "ctime":1781221652,
      "forward":1,
      "token":"97d6df59b8c962a2d5cda8cf8b01ba28",
      "type":"normal"
    },
    "extra":{
      "app_type":1,
      "appid":100446242,
      "uin":1707889225
    },
    "meta":{
      "news":{
        "app_type":1,
        "appid":100446242,
        "ctime":1781221652,
        "desc":"💖💖💖💖💖",
        "jumpUrl":"mqqapi://markdown/node?nodeType=richui&json=%7B%22busId%22%3A%22FlashTransfer%22%2C%22templateId%22%3A%22flash%22%2C%22version%22%3A2%2C%22layout%22%3A%7B%22viewId%22%3A%22flash_file%22%2C%22width%22%3A-2%2C%22height%22%3A-2%2C%22direction%22%3A%22horizontal%22%2C%22layout%22%3A%5B%7B%22viewId%22%3A%22progressLeft%22%2C%22viewType%22%3A%22circularProgress%22%2C%22height%22%3A28%2C%22width%22%3A28%2C%22marginRight%22%3A8%2C%22gravity%22%3A%22centerVertical%22%7D%2C%7B%22viewId%22%3A%22file%22%2C%22direction%22%3A%22vertical%22%2C%22height%22%3A-2%2C%22width%22%3A263%2C%22layout%22%3A%5B%7B%22viewId%22%3A%22image%22%2C%22viewType%22%3A%22image%22%2C%22width%22%3A-1%2C%22height%22%3A180%7D%2C%7B%22viewId%22%3A%22title%22%2C%22viewType%22%3A%22text%22%2C%22width%22%3A-1%2C%22height%22%3A-2%2C%22marginTop%22%3A12%2C%22marginLeft%22%3A12%2C%22marginRight%22%3A12%7D%2C%7B%22viewId%22%3A%22desc%22%2C%22viewType%22%3A%22text%22%2C%22width%22%3A-1%2C%22height%22%3A-2%2C%22marginLeft%22%3A12%2C%22marginTop%22%3A4%2C%22marginRight%22%3A12%7D%2C%7B%22viewId%22%3A%22divider%22%2C%22width%22%3A-1%2C%22height%22%3A0.5%2C%22marginTop%22%3A13%7D%2C%7B%22viewId%22%3A%22tail%22%2C%22direction%22%3A%22horizontal%22%2C%22width%22%3A-1%2C%22height%22%3A22%2C%22marginLeft%22%3A12%2C%22layout%22%3A%5B%7B%22viewId%22%3A%22tailIcon%22%2C%22viewType%22%3A%22image%22%2C%22width%22%3A12%2C%22height%22%3A12%2C%22gravity%22%3A%22centerVertical%22%7D%2C%7B%22viewId%22%3A%22tailText%22%2C%22viewType%22%3A%22text%22%2C%22width%22%3A-2%2C%22height%22%3A-2%2C%22gravity%22%3A%22centerVertical%22%2C%22marginLeft%22%3A4%7D%5D%7D%5D%7D%2C%7B%22viewId%22%3A%22progressRight%22%2C%22viewType%22%3A%22circularProgress%22%2C%22height%22%3A28%2C%22width%22%3A28%2C%22marginLeft%22%3A8%2C%22gravity%22%3A%22centerVertical%22%7D%5D%7D%2C%22attributes%22%3A%7B%22viewId%22%3A%22flash_file%22%2C%22attributes%22%3A%5B%7B%22viewId%22%3A%22progressLeft%22%2C%22progress%22%3A0%2C%22state%22%3A%22none%22%2C%22event%22%3A%7B%22init%22%3A%7B%22visibleCtr%22%3A%7B%22visible%22%3A%22%24%24leftProgressVisible%22%2C%22visibleBehave%22%3A%22gone%22%2C%22src%22%3A%221%22%7D%7D%7D%7D%2C%7B%22viewId%22%3A%22file%22%2C%22radius%22%3A10%2C%22schema%22%3A%22mqqrouter%3A%2F%2Fflash_transfer%2Fopen_fileset%3Ffileset_id%3Dd371bef9-f52d-4b13-913c-be61d21fe1e9%5Cu0026version%3D1%5Cu0026channel_id%3D1%5Cu0026src_type%3Dinternal%5Cu0026scene_type%3D1%22%2C%22backgroundColor%22%3A%22bubble_guest%22%2C%22event%22%3A%7B%22init%22%3A%7B%22resetWidth%22%3A%7B%22width%22%3A%22%24%24width%22%7D%7D%7D%2C%22attributes%22%3A%5B%7B%22viewId%22%3A%22image%22%2C%22src%22%3A%22https%3A%2F%2Fmultimedia.qfile.qq.com%2Fdownload%3Fappid%3D14903%5Cu0026fileid%3DEhRRbeP5jy9iFZuafZu9VlLBXCMh-hjJ9w4gt3Qo6b2qwrWAlQMyBHByb2RQgM7aA1oQjWleIzPMWPkXFymqdeV5tHoDcw7_ggECZ3o%5Cu0026rkey%3DCAQSOA0IIHcaPypiA8bz32qPIHBjw4zhp1oOqfiyvV9tFU8XmtTyFFjwyF3pmDiK3zmHy-CH-U4y0xa-%22%2C%22backgroundColor%22%3A%22%2333707999%22%2C%22contentMode%22%3A2%2C%22failedSrc%22%3A%22https%3A%2F%2Fdownv6.qq.com%2Fqqface%2Fdefault_cover.png%22%7D%2C%7B%22viewId%22%3A%22title%22%2C%22text%22%3A%22xzk.png%22%2C%22textSize%22%3A17%2C%22textColor%22%3A%22bubble_guest_text_primary%22%2C%22maxLine%22%3A2%2C%22ellipsize%22%3A%22middle%22%7D%2C%7B%22viewId%22%3A%22desc%22%2C%22text%22%3A%22%22%2C%22textColor%22%3A%22bubble_guest_text_secondary%22%2C%22textSize%22%3A12%2C%22maxLine%22%3A1%2C%22lineHeightRatio%22%3A1.14%7D%2C%7B%22viewId%22%3A%22divider%22%2C%22backgroundColor%22%3A%22border_standard%22%7D%2C%7B%22viewId%22%3A%22tail%22%2C%22attributes%22%3A%5B%7B%22viewId%22%3A%22tailIcon%22%2C%22src%22%3A%22https%3A%2F%2Fstatic-res.qq.com%2Fstatic-res%2Faio%2Fflash_transfer%2Fflash_transfer_msg_tail.png%22%2C%22contentMode%22%3A2%2C%22radius%22%3A2%7D%2C%7B%22viewId%22%3A%22tailText%22%2C%22text%22%3A%22QQ%E9%97%AA%E4%BC%A0%22%2C%22textSize%22%3A12%2C%22textColor%22%3A%22%23909094%22%7D%5D%7D%5D%7D%2C%7B%22viewId%22%3A%22progressRight%22%2C%22progress%22%3A0%2C%22state%22%3A%22none%22%2C%22event%22%3A%7B%22init%22%3A%7B%22visibleCtr%22%3A%7B%22visible%22%3A%22%24%24rightProgressVisible%22%2C%22visibleBehave%22%3A%22gone%22%2C%22src%22%3A%221%22%7D%7D%7D%7D%5D%7D%7D",
        "preview":"https://s1.aigei.com/src/img/png/bf/bf326ca500714c689920087e1cbf80be.png?imageMogr2/auto-orient/thumbnail/!282x282r/gravity/Center/crop/282x282/quality/85/%7CimageView2/2/w/282&e=2051020800&token=P7S2Xpzfz11vAkASLTkfHN7Fw-oOZBecqeJaxypL:lPjNYUze3UL4dQ1Ycm1bPqx8fsg=",
        "tag":"这是小南娘",
        "tagIcon":"http://thirdqq.qlogo.cn/g?b=oidb&k=x3VfxDVA1R0ZDxUSqJ3obw&kti=aitKWRHhVOA&s=140",
        "title":"你是小南娘",
        "uin":1707889225
      }
      },
    "prompt":"[分享] wechat-decrypt-rs/src/lib.rs at master · H3CoF6/wechat-decrypt-rs",
    "ver":"0.0.0.1",
    "view":"news"
  }

  arkEl.arkData = JSON.stringify(writeData);

  const newBodyBytes = bodyCodec.encode({ elements: elements.map(encodeElement) });


  await db.write(`UPDATE ${TABLE} SET "40800" = ? WHERE rowid = ?`, [newBodyBytes, BigInt(ROWID)]);

  console.log('修改完成');


  db.close();
}

main().catch(console.error);
