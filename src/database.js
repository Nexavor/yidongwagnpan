export default class Database {
    constructor(d1) {
        this.d1 = d1;
    }

    async initDB() {
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
        // 注意：新安装用户会直接创建包含 tg_message_id 的表
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

        // Token 表
        await this.run(`
            CREATE TABLE IF NOT EXISTS auth_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token TEXT NOT NULL UNIQUE,
                expires_at INTEGER NOT NULL
            );
        `);

        // [优化] 自动迁移逻辑：尝试添加 tg_message_id 列
        // 针对旧版本升级的用户
        try {
            await this.run("ALTER TABLE files ADD COLUMN tg_message_id INTEGER");
            console.log("Migration Success: Added tg_message_id column.");
        } catch (e) {
            // 只有当错误信息明确包含 "duplicate" (列重复) 时才忽略
            // 否则抛出异常或打印错误，方便调试
            if (e.message && (e.message.includes('duplicate') || e.message.includes('exists'))) {
                // 列已存在，忽略
            } else {
                console.warn("Migration Warning (tg_message_id):", e.message);
            }
        }

        console.log("Database initialized.");
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
