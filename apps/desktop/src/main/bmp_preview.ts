export function decodeBmpPreview(input: Buffer, maxPixels: number) {
  if (input.length < 54) throw new Error('incomplete BMP header');

  const pixelOffset = input.readUInt32LE(10);
  const headerSize = input.readUInt32LE(14);
  const width = input.readInt32LE(18);
  const signedHeight = input.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const planes = input.readUInt16LE(26);
  const bitsPerPixel = input.readUInt16LE(28);
  const compression = input.readUInt32LE(30);

  // Windows BMP 的 BI_RGB 像素按 BGR/BGRX 保存，每行对齐到 4 字节。
  if (headerSize < 40 || planes !== 1 || compression !== 0 || ![24, 32].includes(bitsPerPixel))
    throw new Error('unsupported BMP format');
  if (width <= 0 || height === 0 || width * height > maxPixels) throw new Error('BMP pixel limit');

  const pixelBytes = bitsPerPixel / 8;
  const rowBytes = Math.ceil((width * pixelBytes) / 4) * 4;
  if (pixelOffset < 14 + headerSize || rowBytes * height > input.length - pixelOffset)
    throw new Error('incomplete BMP pixels');

  const channels: 3 = 3;
  const pixels = Buffer.alloc(width * height * channels);
  let dest = 0;
  for (let row = 0; row < height; row++) {
    const sourceRow = signedHeight < 0 ? row : height - 1 - row;
    let source = pixelOffset + sourceRow * rowBytes;
    for (let column = 0; column < width; column++) {
      pixels[dest++] = input[source + 2]!;
      pixels[dest++] = input[source + 1]!;
      pixels[dest++] = input[source]!;
      source += pixelBytes;
    }
  }
  return { pixels, raw: { width, height, channels } };
}
