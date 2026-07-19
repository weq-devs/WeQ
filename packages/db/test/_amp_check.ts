// 不碰 DB：直接把源码 tipJson 常量编码成 protobuf blob 再 decode，看 & 会不会变 &amp;
import { decodeBody } from '../src/msg/util';

const PRE = `{"align":"center","items":[{"col":"3","jp":"tencent://ntqq-open?subCmd=profile&action=openMiniBuddyProfile&actionParams=%7B%22uin%22%3A%22`;
const MID = `%22%2C%22sourceType%22%3A%22QrCodeShareBuddyLink%22%7D","txt":"`;
const POST = `","type":"url"},{"txt":"撤回了一条消息","type":"nor"}]}`;
const tip = `${PRE}1707889225${MID}H3CoF6${POST}`;

console.log('=== 源码常量拼出的 tipJson（未经 SQL/DB）===');
console.log('含 &amp; ?', tip.includes('&amp;'));
console.log('含 &action ?', tip.includes('&action'));

// 手工编码成 40800 blob
const EL_HEAD = Buffer.from('c8fc15d3a5efcfc6cff0ab6ad0fc1508d8fc1511', 'hex');
const TIP_TAG = Buffer.from('fac817', 'hex');
const EL_TAIL = Buffer.from('80c9170088c917e11298c91700', 'hex');
const tipBytes = Buffer.from(tip, 'utf8');
function varint2(n: number): Buffer { return Buffer.from([(n & 127) | 128, (n >> 7) & 127]); }
const elContent = Buffer.concat([EL_HEAD, TIP_TAG, varint2(tipBytes.length), tipBytes, EL_TAIL]);
const blob = Buffer.concat([Buffer.from('82f613', 'hex'), varint2(elContent.length), elContent]);

const decoded = decodeBody(blob) as any[];
const gotTip = decoded[0]?.tipJson ?? '';
console.log('\n=== decodeBody 后的 tipJson ===');
console.log('含 &amp; ?', gotTip.includes('&amp;'));
console.log('含 &action ?', gotTip.includes('&action'));
console.log('\ntipJson 片段:', gotTip.slice(60, 130));
