export default class ConfigManager {
    constructor(kv) {
        this.kv = kv;
        this.cache = null;
    }

    async load() {
        if (this.cache) return this.cache;
        
        try {
            const data = await this.kv.get('config', { type: 'json' });
            // 提供默认值，防止 null 导致报错
            this.cache = data || {
                storageMode: '', // 移除默认 'local'，留空迫使用户配置
                s3: {},
                webdav: {},
                telegram: {}
            };
        } catch (e) {
            console.error("Config Load Error:", e);
            this.cache = {}; // 降级处理
        }
        return this.cache;
    }

    async save(newConfig) {
        const current = await this.load();
        // 深度合并配置，防止覆盖
        const updated = {
            ...current,
            ...newConfig,
            // 针对嵌套对象进行合并 (s3, webdav, telegram)
            s3: { ...(current.s3 || {}), ...(newConfig.s3 || {}) },
            webdav: { ...(current.webdav || {}), ...(newConfig.webdav || {}) },
            telegram: { ...(current.telegram || {}), ...(newConfig.telegram || {}) }
        };

        // 移除 undefined 或 null 的键（可选）
        await this.kv.put('config', JSON.stringify(updated));
        this.cache = updated;
        return true;
    }
}
