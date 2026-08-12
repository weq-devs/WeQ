const crypto = require('crypto');
const fs = require('fs');

/**
 * GPro (QQ Channel) 数据库纯算法解密脚本 (Node.js)
 *
 * 加密原语:
 * - KDF: PBKDF2-HMAC-SHA512 (4000 iterations)
 * - Cipher: AES-256-CBC
 * - HMAC: HMAC-SHA512 (SQLCipher 4 默认保留空间通常为 48 或 80)
 * - Page Size: 4096
 */

const CONFIG = {
    inputPath: process.argv[2] || 'gpro_v1-6.db',
    outputPath: process.argv[3] || 'gpro_decrypted.db',
    keyStr: process.argv[4] || '2a4e04f77fd4ab2f4a42717e3e69e3d3',
    headerSize: 1024,
    pageSize: 4096,
    kdfIter: 4000,
    // GPro 数据库使用 HMAC-SHA512，预留空间为 80 字节 (16字节 IV + 64字节 HMAC)
    reservedSize: 80
};

if (process.argv.length < 5 && !process.argv[2]) {
    console.log("用法: node decrypt_gpro.js <输入数据库> <输出明文数据库> <32位密钥>");
    process.exit(1);
}

function decrypt() {
    console.log(`[*] 开始处理: ${CONFIG.inputPath}`);
    const fileBuffer = fs.readFileSync(CONFIG.inputPath);

    // 1. 跳过 1024 字节自定义头
    const dbData = fileBuffer.slice(CONFIG.headerSize);
    console.log(`[*] 已剥离头部，有效数据大小: ${dbData.length} 字节`);

    // 2. 获取第一页的 Salt (前 16 字节)
    const salt = dbData.slice(0, 16);
    console.log(`[*] 提取 Salt: ${salt.toString('hex')}`);

    // 3. 派生密钥 (PBKDF2-HMAC-SHA512)
    // SQLCipher 使用原始密钥字符串作为输入
    console.log(`[*] 正在派生密钥 (Iterations: ${CONFIG.kdfIter})...`);
    const derivedKey = crypto.pbkdf2Sync(
        CONFIG.keyStr,
        salt,
        CONFIG.kdfIter,
        64, // 512 bits = 64 bytes
        'sha512'
    );
    // SQLCipher 实际上只取前 32 字节作为 AES 密钥，后 32 字节作为 HMAC 密钥
    const aesKey = derivedKey.slice(0, 32);
    const hmacKey = derivedKey.slice(32, 64);

    const totalPages = Math.floor(dbData.length / CONFIG.pageSize);
    console.log(`[*] 总计页面: ${totalPages}`);

    const outStream = fs.createWriteStream(CONFIG.outputPath);

    for (let i = 0; i < totalPages; i++) {
        const pageStart = i * CONFIG.pageSize;
        const pageData = dbData.slice(pageStart, pageStart + CONFIG.pageSize);

        let usableData;
        let iv;

        if (i === 0) {
            // 第一页特殊处理：前 16 字节是 Salt，不是加密数据
            // 剩下的数据中，最后 reservedSize 字节是 IV 和 HMAC
            usableData = pageData.slice(16, CONFIG.pageSize - CONFIG.reservedSize);
            iv = pageData.slice(CONFIG.pageSize - CONFIG.reservedSize, CONFIG.pageSize - CONFIG.reservedSize + 16);
        } else {
            usableData = pageData.slice(0, CONFIG.pageSize - CONFIG.reservedSize);
            iv = pageData.slice(CONFIG.pageSize - CONFIG.reservedSize, CONFIG.pageSize - CONFIG.reservedSize + 16);
        }

        // 解密
        const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
        decipher.setAutoPadding(false);

        let decrypted = Buffer.concat([decipher.update(usableData), decipher.final()]);

        if (i === 0) {
            // 第一页解密后，前 16 字节应该是 "SQLite format 3\0"
            const sqliteHeader = Buffer.from("SQLite format 3\0");
            const resultPage = Buffer.alloc(CONFIG.pageSize);
            sqliteHeader.copy(resultPage, 0);
            decrypted.copy(resultPage, 16);
            outStream.write(resultPage);
        } else {
            // 后续页面，解密后的数据直接补齐到 pageSize
            const resultPage = Buffer.alloc(CONFIG.pageSize);
            decrypted.copy(resultPage, 0);
            outStream.write(resultPage);
        }
    }

    outStream.end();
    console.log(`[+] 解密完成！明文数据库已保存至: ${CONFIG.outputPath}`);
}

try {
    decrypt();
} catch (err) {
    console.error(`[-] 发生错误: ${err.message}`);
}
