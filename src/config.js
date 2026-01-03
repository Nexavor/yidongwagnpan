// [优化] 引入全局变量作为缓存，在 Worker 实例生命周期内复用配置
// 避免每个请求都去读取 KV，节省费用并提升速度
let globalConfigCache = null;

export default class ConfigManager {
    constructor(kv) {
        this.kv = kv;
    }

    async load() {
        // 1. 优先从全局内存缓存读取
        if (globalConfigCache) return globalConfigCache;
        
        try {
            // 2. 缓存未命中，从 KV 读取
            const data = await this.kv.get('config', { type: 'json' });
            
            // 提供默认值，防止 null 导致报错
            globalConfigCache = data || {
                storageMode: '', // 移除默认 'local'，留空迫使用户配置
                s3: {},
                webdav: {},
                telegram: {}
            };
        } catch (e) {
            console.error("Config Load Error:", e);
            // 发生错误时给予空对象，避免系统崩溃，但暂存入缓存防止死循环重试
            globalConfigCache = {}; 
        }
        return globalConfigCache;
    }

    async save(newConfig) {
        // 必须先加载现有配置以进行合并
        const current = await this.load();
        
        // 深度合并配置，防止覆盖未修改的字段
        const updated = {
            ...current,
            ...newConfig,
            // 针对嵌套对象进行合并 (s3, webdav, telegram)
            s3: { ...(current.s3 || {}), ...(newConfig.s3 || {}) },
            webdav: { ...(current.webdav || {}), ...(newConfig.webdav || {}) },
            telegram: { ...(current.telegram || {}), ...(newConfig.telegram || {}) }
        };

        // 写入 KV
        await this.kv.put('config', JSON.stringify(updated));
        
        // [优化] 更新全局缓存，确保后续请求立即生效
        globalConfigCache = updated;
        return true;
    }
}
