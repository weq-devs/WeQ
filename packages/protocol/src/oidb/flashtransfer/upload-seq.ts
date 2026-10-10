// 0x12a9 (sub=100 prepare / sub=103 apply) 的 head.sub.seq 是 QQ 内核里一条
// **共享**的单调计数器：实机抓包同一进程内 prepare/apply 依次取 3,4,5,6,7,…，
// 不区分缩略图与主文件。服务端不校验具体值，但保持递增以与实机一致。

let uploadSeq = 1;

/** 取下一条 0x12a9 head.sub.seq。 */
export function nextUploadSeq(): number {
  return uploadSeq++;
}
