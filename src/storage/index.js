import { S3Storage } from './s3.js';
import { WebDAVStorage } from './webdav.js';
import { TelegramStorage } from './telegram.js';

/**
 * 存储后端工厂函数
 * 根据配置初始化对应的存储实例
 * @param {Object} config - 全局配置对象 (包含了 s3, webdav, telegram, storageMode 等配置)
 * @param {Object} env - Cloudflare Worker 环境变量
 */
export function initStorage(config, env) {
    // 移除 R2 Binding (local) 的支持逻辑

    // 根据 storageMode 选择后端
    switch (config.storageMode) {
        case 's3':
            if (!config.s3) throw new Error("S3 存储模式已启用，但未找到 S3 配置。");
            return new S3Storage(config.s3);
        
        case 'webdav':
            if (!config.webdav) throw new Error("WebDAV 存储模式已启用，但未找到 WebDAV 配置。");
            return new WebDAVStorage(config.webdav);
        
        case 'telegram':
            // Telegram 配置通常来自环境变量，但也可能通过 config 传递
            const tgConfig = config.telegram || {
                botToken: env.TG_BOT_TOKEN,
                chatId: env.TG_CHAT_ID
            };
            if (!tgConfig.botToken || !tgConfig.chatId) {
                throw new Error("Telegram 存储模式已启用，但未找到 Bot Token 或 Chat ID (请检查环境变量 TG_BOT_TOKEN 和 TG_CHAT_ID)。");
            }
            return new TelegramStorage(tgConfig);

        default:
            // 如果未配置或配置了已移除的 local 模式，抛出明确错误
            throw new Error(`未配置有效的存储模式 (当前: ${config.storageMode || '无'})。请进入管理后台配置 S3、WebDAV 或 Telegram 存储后端。`);
    }
}
