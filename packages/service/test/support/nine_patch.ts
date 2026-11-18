/** 仅供几何解析用的 PNG chunk 夹具，不包含像素数据，也不校验 CRC。 */
export function ninePatch(
  width: number,
  height: number,
  x: readonly number[],
  y: readonly number[],
): Buffer {
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  const body = Buffer.alloc(32 + 4 * (x.length + y.length + 9));
  body[1] = x.length;
  body[2] = y.length;
  body[3] = 9;
  [...x, ...y].forEach((value, i) => {
    body.writeInt32BE(value, 32 + i * 4);
  });
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length);
  header.write('npTc', 4);
  const iend = Buffer.alloc(12);
  iend.write('IEND', 4);
  return Buffer.concat([signature, ihdr, header, body, Buffer.alloc(4), iend]);
}
