export default class Database {
    constructor(d1) {
        this.d1 = d1;
    }

    async initDB() {
        // [修复] 使用 this.run() 代替 this.d1.exec() 以避免本地环境下的兼容性错误
        
        // 用户表
        await this.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                is_admin INTEGER DEFAULT 0,
                max_storage_bytes INTEGER DEFAULT 1073741824
            );
        `);

        // 文件夹表
        // 注意：增加 is_deleted 默认值，增加 share 相关字段
        await this.run(`
            CREATE TABLE IF NOT EXISTS folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                parent_id INTEGER,
                user_id INTEGER NOT NULL,
                password TEXT,
                is_deleted INTEGER DEFAULT 0,
                deleted_at INTEGER,
                share_token TEXT,
                share_expires_at INTEGER,
                share_password TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                UNIQUE(name, parent_id, user_id)
            );
        `);

        // 文件表
        // [修复] 增加 tg_message_id 字段用于 Telegram 物理删除
        await this.run(`
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL,
                fileName TEXT NOT NULL,
                mimetype TEXT,
                file_id TEXT NOT NULL,
                thumb_file_id TEXT,
                tg_message_id INTEGER,
                date INTEGER,
                size INTEGER,
                folder_id INTEGER,
                user_id INTEGER NOT NULL,
                storage_type TEXT,
                is_deleted INTEGER DEFAULT 0,
                deleted_at INTEGER,
                share_token TEXT,
                share_expires_at INTEGER,
                share_password TEXT
            );
        `);

        // 尝试自动迁移旧数据库：添加 tg_message_id 列
        // 如果列已存在，SQLite 会抛出错误，我们直接忽略该错误即可
        try {
            await this.run("ALTER TABLE files ADD COLUMN tg_message_id INTEGER");
        } catch (e) {
            // 忽略“列已存在”的错误
        }

        // 认证 Token 表
        await this.run(`
            CREATE TABLE IF NOT EXISTS auth_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token TEXT NOT NULL UNIQUE,
                expires_at INTEGER NOT NULL
            );
        `);

        console.log("数据库结构初始化完成 (已包含分享、回收站及 Telegram Message ID 字段)。");
    }

    // 封装 D1 的 prepare 和 bind
    async run(sql, params = []) {
        try {
            const stmt = this.d1.prepare(sql).bind(...params);
            return await stmt.run();
        } catch (e) {
            console.error(`SQL 执行错误: ${sql}`, e);
            throw new Error('数据库操作失败: ' + e.message);
        }
    }

    async get(sql, params = []) {
        try {
            const stmt = this.d1.prepare(sql).bind(...params);
            return await stmt.first();
        } catch (e) {
            console.error(`SQL 查询错误 (get): ${sql}`, e);
            throw e;
        }
    }

    async all(sql, params = []) {
        try {
            const stmt = this.d1.prepare(sql).bind(...params);
            const result = await stmt.all();
            return result.results || [];
        } catch (e) {
            console.error(`SQL 查询错误 (all): ${sql}`, e);
            throw e;
        }
    }

    // 批量执行 (用于事务或迁移)
    async batch(statements) {
        try {
            return await this.d1.batch(statements);
        } catch (e) {
            console.error("批量操作失败", e);
            throw e;
        }
    }
}
