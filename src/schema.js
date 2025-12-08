// src/schema.js

export const initSQL = `
    -- 用户表
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        max_storage_bytes INTEGER DEFAULT 1073741824 -- 默认 1GB 配额
    );

    -- 文件夹表
    CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        parent_id INTEGER,
        user_id INTEGER NOT NULL,
        
        -- 新增字段：加密保护
        password TEXT, 
        
        -- 新增字段：回收站逻辑
        is_deleted INTEGER DEFAULT 0,
        deleted_at INTEGER,
        
        -- 新增字段：分享逻辑
        share_token TEXT,
        share_expires_at INTEGER,
        share_password TEXT,
        
        FOREIGN KEY(parent_id) REFERENCES folders(id),
        FOREIGN KEY(user_id) REFERENCES users(id),
        UNIQUE(name, parent_id, user_id)
    );

    -- 文件表
    CREATE TABLE IF NOT EXISTS files (
        message_id TEXT PRIMARY KEY, -- 业务 ID (通常是时间戳生成的 BigInt 字符串)
        fileName TEXT NOT NULL,
        mimetype TEXT,
        file_id TEXT NOT NULL,       -- 存储后端的物理 ID/路径
        thumb_file_id TEXT,
        date INTEGER,
        size INTEGER,
        folder_id INTEGER,
        user_id INTEGER NOT NULL,
        storage_type TEXT,           -- 存储类型标记 (如 imported)
        
        -- 新增字段：回收站逻辑
        is_deleted INTEGER DEFAULT 0,
        deleted_at INTEGER,
        
        -- 新增字段：分享逻辑
        share_token TEXT,
        share_expires_at INTEGER,
        share_password TEXT,
        
        FOREIGN KEY(folder_id) REFERENCES folders(id),
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    -- 会话 Token 表
    CREATE TABLE IF NOT EXISTS auth_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );
    
    -- 索引优化
    CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
    CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
    CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
    
    -- 分享查询索引
    CREATE INDEX IF NOT EXISTS idx_files_share ON files(share_token);
    CREATE INDEX IF NOT EXISTS idx_folders_share ON folders(share_token);
    
    -- 回收站查询索引
    CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(is_deleted);
    CREATE INDEX IF NOT EXISTS idx_folders_deleted ON folders(is_deleted);
`;
