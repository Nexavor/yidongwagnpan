import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

// 1. 初始化一个默认密钥 (硬编码保底)，防止 SECRET_KEY 为空导致系统崩溃
// 使用 SHA-256 将字符串转为 32 字节的 Buffer
let SECRET_KEY = crypto.createHash('sha256').update('default-fallback-key-2024-secure').digest();
const IV_LENGTH = 16; 

export function initCrypto(secret) {
    try {
        if (secret) {
            // 如果提供了环境变量，则更新密钥
            const secretStr = String(secret);
            SECRET_KEY = crypto.createHash('sha256').update(secretStr).digest();
        }
    } catch (e) {
        console.error("Crypto Init Warning:", e);
        // 出错时不抛出异常，继续使用默认密钥
    }
}

export function encrypt(text) {
    // 过滤无效输入
    if (text === null || text === undefined) return null;

    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-cbc', SECRET_KEY, iv);
        
        // 关键修复：显式转换为 String 再转为 Buffer，不传递 encoding 参数
        // 这能避免 "inputEncoding is undefined" 的错误
        const inputBuffer = Buffer.from(String(text));
        
        let encrypted = cipher.update(inputBuffer);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    } catch (e) {
        console.error("Encrypt error:", e);
        return null;
    }
}

export function decrypt(text) {
    if (!text) return null;

    try {
        const textParts = text.split(':');
        if (textParts.length !== 2) return null;
        
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        
        const decipher = crypto.createDecipheriv('aes-256-cbc', SECRET_KEY, iv);
        
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        
        return decrypted.toString();
    } catch (e) {
        // 解密失败返回 null，不抛出异常
        return null;
    }
}
