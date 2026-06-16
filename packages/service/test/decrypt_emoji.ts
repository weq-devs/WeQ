import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';

function decrypt(input: Buffer): Buffer {
  const output = Buffer.allocUnsafe(input.length);
  for (let i = 0; i < input.length; i += 50) {
    const chunkSize = Math.min(50, input.length - i);
    const encryptedPartSize = Math.min(20, chunkSize);

    // XOR first 20 bytes with 0xFF
    for (let j = 0; j < encryptedPartSize; j++) {
      output[i + j] = (input[i + j] as number) ^ 0xff;
    }

    // Copy remaining bytes (up to 30)
    if (chunkSize > 20) {
      input.copy(output, i + 20, i + 20, i + chunkSize);
    }
  }
  return output;
}

const inputPath = "D:\\estkim\\T\\Tencent Files\\1707889225\\nt_qq\\nt_data\\Emoji\\marketface\\237036\\747a234be30321f68e7424568fb12bfa";
const outputPath = "decrypted_emoji.gif";

if (existsSync(inputPath)) {
  console.log(`Reading: ${inputPath}`);
  const encrypted = readFileSync(inputPath);
  const decrypted = decrypt(encrypted);
  writeFileSync(outputPath, decrypted);
  console.log(`Successfully decrypted to: ${outputPath}`);
} else {
  console.error(`File not found: ${inputPath}`);
}
