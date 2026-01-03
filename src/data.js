import path from 'node:path';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from './crypto.js';

// [修复] 增加 tg_message_id 字段
const ALL_FILE_COLUMNS = `
    fileName, mimetype, file_id, thumb_file_id, tg_message_id, date, size, folder_id, user_id, storage_type, is_deleted, deleted_at
`;

const SAFE_SELECT_MESSAGE_ID = `CAST(message_id AS TEXT) AS message_id`;
const SAFE_SELECT_ID_AS_TEXT = `CAST(message_id AS TEXT) AS id`;

// =================================================================================
// 1. 辅助功能
// =================================================================================

export async function getUniqueName(db, folderId, originalName, userId, type) {
    const table = type === 'file' ? 'files' : 'folders';
    const col = type === 'file' ? 'fileName' : 'name';
    const parentCol = type === 'file' ? 'folder_id' : 'parent_id';
    
    // 基础检查
    const exists = await db.get(
        `SELECT 1 as exists_flag FROM ${table} WHERE ${col} = ? AND ${parentCol} = ? AND user_id = ? AND deleted_at IS NULL`, 
        [originalName, folderId, userId]
    );
    
    if (!exists) return originalName;

    // 生成新名字
    let name = originalName;
    let ext = '';
    if (type === 'file') {
        const lastDotIndex = originalName.lastIndexOf('.');
        if (lastDotIndex !== -1 && lastDotIndex !== 0) {
            name = originalName.substring(0, lastDotIndex);
            ext = originalName.substring(lastDotIndex);
        }
    }

    let counter = 1;
    while (true) {
        const newName = `${name} (${counter})${ext}`;
        const check = await db.get(
            `SELECT 1 as exists_flag FROM ${table} WHERE ${col} = ? AND ${parentCol} = ? AND user_id = ? AND deleted_at IS NULL`, 
            [newName, folderId, userId]
        );
        if (!check) return newName;
        counter++;
    }
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 处理因“软删除”文件导致的唯一约束冲突
async function handleTrashConflict(db, table, nameCol, parentCol, nameVal, parentVal, userId) {
    const row = await db.get(
        `SELECT id, message_id FROM ${table} WHERE ${nameCol} = ? AND ${parentCol} = ? AND user_id = ? AND deleted_at IS NOT NULL`,
        [nameVal, parentVal, userId]
    );
    
    if (row) {
        const trashName = `${nameVal}_deleted_${Date.now()}_${Math.floor(Math.random()*1000)}`;
        const idCol = table === 'files' ? 'message_id' : 'id';
        const idVal = table === 'files' ? row.message_id : row.id;
        await db.run(`UPDATE ${table} SET ${nameCol} = ? WHERE ${idCol} = ?`, [trashName, idVal]);
        return true; 
    }
    return false; 
}

// =================================================================================
// 2. 用户管理
// =================================================================================

export async function createUser(db, username, hashedPassword) {
    const sql = `INSERT INTO users (username, password, is_admin, max_storage_bytes) VALUES (?, ?, 0, 1073741824)`;
    const result = await db.run(sql, [username, hashedPassword]);
    let newId = result?.meta?.last_row_id;
    if (!newId) {
        const u = await findUserByName(db, username);
        newId = u.id;
    }
    return { id: newId, username };
}

export async function findUserByName(db, username) {
    return await db.get("SELECT * FROM users WHERE username = ?", [username]);
}

export async function findUserById(db, id) {
    return await db.get("SELECT * FROM users WHERE id = ?", [id]);
}

export async function changeUserPassword(db, userId, newHashedPassword) {
    const sql = `UPDATE users SET password = ? WHERE id = ?`;
    const result = await db.run(sql, [newHashedPassword, userId]);
    return { success: true, changes: result.meta.changes };
}

export async function listAllUsers(db) {
    const sql = `SELECT id, username FROM users ORDER BY username ASC`;
    return await db.all(sql);
}

export async function deleteUser(db, userId) {
    const sql = `DELETE FROM users WHERE id = ? AND is_admin = 0`;
    const result = await db.run(sql, [userId]);
    return { success: true, changes: result.meta.changes };
}

// =================================================================================
// 3. 配额管理
// =================================================================================

export async function getUserQuota(db, userId) {
    const user = await db.get("SELECT max_storage_bytes FROM users WHERE id = ?", [userId]);
    const usage = await db.get("SELECT SUM(size) as total_size FROM files WHERE user_id = ? AND deleted_at IS NULL", [userId]);
    
    let maxStorage = 1073741824; 
    if (user && user.max_storage_bytes !== null && user.max_storage_bytes !== undefined) {
        maxStorage = user.max_storage_bytes;
    }

    return {
        max: maxStorage,
        used: usage && usage.total_size ? usage.total_size : 0
    };
}

export async function checkQuota(db, userId, incomingSize) {
    const quota = await getUserQuota(db, userId);
    if (quota.max === 0) return true; 
    return (quota.used + incomingSize) <= quota.max;
}

export async function listAllUsersWithQuota(db) {
    const sql = `SELECT id, username, is_admin, max_storage_bytes FROM users ORDER BY is_admin DESC, username ASC`;
    const users = await db.all(sql);
    if (users.length === 0) return [];
    const userIds = users.map(u => u.id);
    const placeholders = userIds.map(() => '?').join(',');
    const usageSql = `SELECT user_id, SUM(size) as total_size FROM files WHERE user_id IN (${placeholders}) AND deleted_at IS NULL GROUP BY user_id`;
    const usageData = await db.all(usageSql, userIds);
    const usageMap = new Map(usageData.map(row => [row.user_id, row.total_size]));
    
    return users.map(user => {
        let maxBytes = 1073741824;
        if (user.max_storage_bytes !== null && user.max_storage_bytes !== undefined) {
            maxBytes = user.max_storage_bytes;
        }

        return {
            id: user.id, 
            username: user.username, 
            is_admin: user.is_admin,
            max_storage_bytes: maxBytes, 
            used_storage_bytes: usageMap.get(user.id) || 0
        };
    });
}

export async function setMaxStorageForUser(db, userId, maxBytes) {
    const sql = `UPDATE users SET max_storage_bytes = ? WHERE id = ? AND is_admin = 0`; 
    const result = await db.run(sql, [maxBytes, userId]);
    return { success: true, changes: result.meta.changes };
}

// =================================================================================
// 4. 文件操作
// =================================================================================

export async function addFile(db, fileData, folderId = 1, userId, storageType) {
    // [修复] 接收 tg_message_id
    const { message_id, fileName, mimetype, file_id, thumb_file_id, tg_message_id, date, size } = fileData;
    
    // [修复] 插入 SQL 包含 tg_message_id
    const sql = `INSERT INTO files (message_id, fileName, mimetype, file_id, thumb_file_id, tg_message_id, date, size, folder_id, user_id, storage_type, is_deleted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`;
    
    try {
        const result = await db.run(sql, [message_id, fileName, mimetype, file_id, thumb_file_id, tg_message_id || null, date, size, folderId, userId, storageType]);
        return { success: true, id: result.meta.last_row_id || 0, fileId: message_id };
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            const resolved = await handleTrashConflict(db, 'files', 'fileName', 'folder_id', fileName, folderId, userId);
            if (resolved) {
                const retryResult = await db.run(sql, [message_id, fileName, mimetype, file_id, thumb_file_id, tg_message_id || null, date, size, folderId, userId, storageType]);
                return { success: true, id: retryResult.meta.last_row_id || 0, fileId: message_id };
            }
        }
        throw err;
    }
}

export async function updateFile(db, fileId, updates, userId) {
    const fields = []; const values = [];
    // [修复] 允许更新 tg_message_id
    const validKeys = ['fileName', 'mimetype', 'file_id', 'thumb_file_id', 'tg_message_id', 'size', 'date', 'message_id'];
    for (const key in updates) {
        if (Object.hasOwnProperty.call(updates, key) && validKeys.includes(key)) {
            fields.push(`${key} = ?`);
            values.push(updates[key]);
        }
    }
    fields.push('is_deleted = 0');
    fields.push('deleted_at = NULL');
    
    if (fields.length === 0) return { success: true, changes: 0 };
    values.push(fileId, userId);
    const sql = `UPDATE files SET ${fields.join(', ')} WHERE message_id = ? AND user_id = ?`;
    const result = await db.run(sql, values);
    return { success: true, changes: result.meta.changes };
}

export async function getFilesByIds(db, messageIds, userId) {
    if (!messageIds || messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(',');
    const sql = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE message_id IN (${placeholders}) AND user_id = ?`;
    return await db.all(sql, [...messageIds, userId]);
}

export async function checkFileExist(db, folderId, fileName, userId) {
    const result = await db.get(
        "SELECT 1 FROM files WHERE folder_id = ? AND fileName = ? AND user_id = ? AND deleted_at IS NULL", 
        [folderId, fileName, userId]
    );
    return !!result;
}

// =================================================================================
// 5. 文件夹操作
// =================================================================================

export async function createFolder(db, name, parentId, userId) {
    const sql = `INSERT INTO folders (name, parent_id, user_id, is_deleted) VALUES (?, ?, ?, 0)`;
    try {
        const result = await db.run(sql, [name, parentId, userId]);
        let newId = result?.meta?.last_row_id;
        if (!newId) {
            let querySql = ""; let params = [];
            if (parentId === null) { querySql = "SELECT id FROM folders WHERE name = ? AND parent_id IS NULL AND user_id = ?"; params = [name, userId]; } 
            else { querySql = "SELECT id FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?"; params = [name, parentId, userId]; }
            const row = await db.get(querySql, params);
            if (row) newId = row.id;
        }
        return { success: true, id: newId };
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            const whereClause = parentId === null ? "parent_id IS NULL" : "parent_id = ?";
            const params = parentId === null ? [name, userId] : [name, parentId, userId];
            const row = await db.get(`SELECT id, deleted_at FROM folders WHERE name = ? AND ${whereClause} AND user_id = ?`, params); 
            
            if (row) {
                if (row.deleted_at !== null) {
                    const trashName = `${name}_deleted_${Date.now()}`;
                    await db.run("UPDATE folders SET name = ? WHERE id = ?", [trashName, row.id]);
                    const retryResult = await db.run(sql, [name, parentId, userId]);
                    return { success: true, id: retryResult.meta.last_row_id };
                } else {
                    throw new Error('文件夹已存在');
                }
            } 
            throw err;
        }
        throw err;
    }
}

export async function getFolder(db, folderId, userId) {
    return await db.get("SELECT * FROM folders WHERE id = ? AND user_id = ?", [folderId, userId]);
}

export async function getFolderContents(db, folderId, userId) {
    const sqlFolders = `SELECT id, name, parent_id, 'folder' as type, password IS NOT NULL as is_locked FROM folders WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY name ASC`;
    const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type FROM files WHERE folder_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY name ASC`;
    
    const folders = await db.all(sqlFolders, [folderId, userId]);
    const files = await db.all(sqlFiles, [folderId, userId]);

    return {
        folders: folders.map(f => ({ ...f, encrypted_id: encrypt ? encrypt(f.id) : f.id })), // [修复] 防御 encrypt 为空
        files: files
    };
}

export async function getRootFolder(db, userId) {
    return await db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId]);
}

export async function getFolderPath(db, folderId, userId) {
    let pathArr = []; let currentId = folderId;
    while (currentId) {
        const folder = await db.get("SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?", [currentId, userId]);
        if (folder) {
            pathArr.unshift({ id: folder.id, name: folder.name, encrypted_id: encrypt ? encrypt(folder.id) : folder.id });
            currentId = folder.parent_id;
        } else { break; }
    }
    return pathArr;
}

export async function getAllFolders(db, userId) {
    const sql = "SELECT id, name, parent_id FROM folders WHERE user_id = ? AND deleted_at IS NULL ORDER BY parent_id, name ASC";
    const rows = await db.all(sql, [userId]);
    return rows.map(folder => ({ ...folder, encrypted_id: encrypt ? encrypt(folder.id) : folder.id }));
}

// =================================================================================
// 6. 搜索
// =================================================================================

export async function searchItems(db, query, userId) {
    const searchQuery = `%${query}%`;
    const baseQuery = `
        WITH RECURSIVE folder_ancestry(id, parent_id, is_locked, is_deleted) AS (
            SELECT id, parent_id, (password IS NOT NULL) as is_locked, is_deleted
            FROM folders WHERE user_id = ?
            UNION ALL
            SELECT fa.id, f.parent_id, (fa.is_locked OR (f.password IS NOT NULL)), (fa.is_deleted OR f.is_deleted)
            FROM folders f JOIN folder_ancestry fa ON f.id = fa.parent_id WHERE f.user_id = ?
        ),
        folder_status AS ( SELECT id, MAX(is_locked) as is_path_locked, MAX(is_deleted) as is_path_deleted FROM folder_ancestry GROUP BY id )
    `;
    const sqlFiles = baseQuery + `
        SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, ${SAFE_SELECT_ID_AS_TEXT}, f.fileName as name, 'file' as type
        FROM files f JOIN folder_status fs ON f.folder_id = fs.id
        WHERE f.fileName LIKE ? AND f.user_id = ? AND fs.is_path_locked = 0 
        AND f.deleted_at IS NULL
        ORDER BY f.date DESC;
    `;
    const sqlFolders = baseQuery + `
        SELECT f.id, f.name, f.parent_id, 'folder' as type, (f.password IS NOT NULL) as is_locked
        FROM folders f JOIN folder_status fs ON f.id = fs.id
        WHERE f.name LIKE ? AND f.user_id = ? AND fs.is_path_locked = 0 
        AND f.deleted_at IS NULL
        AND f.parent_id IS NOT NULL
        ORDER BY f.name ASC;
    `;
    const folders = await db.all(sqlFolders, [userId, userId, searchQuery, userId]);
    const files = await db.all(sqlFiles, [userId, userId, searchQuery, userId]);
    return { folders: folders.map(f => ({ ...f, encrypted_id: encrypt ? encrypt(f.id) : f.id })), files };
}

// =================================================================================
// 7. 回收站与删除
// =================================================================================

export async function unifiedDelete(db, storage, itemId, itemType, userId, explicitFileIds = null, explicitFolderIds = null) {
    let checkIds = [];
    if (explicitFolderIds && explicitFolderIds.length > 0) {
        checkIds = explicitFolderIds;
    } else if (itemType === 'folder' && itemId) {
        checkIds = [itemId];
    }
    
    if (checkIds.length > 0) {
        const placeholders = checkIds.map(() => '?').join(',');
        const locked = await db.all(
            `SELECT name FROM folders WHERE id IN (${placeholders}) AND password IS NOT NULL AND password != '' AND user_id = ?`,
            [...checkIds, userId]
        );
        if (locked.length > 0) {
             throw new Error(`文件夹 "${locked[0].name}" 已加密保护，无法永久删除。请先移除密码。`);
        }
    }

    let filesForStorage = []; let foldersForStorage = [];
    if (explicitFileIds || explicitFolderIds) {
        if (explicitFileIds && explicitFileIds.length > 0) filesForStorage.push(...await getFilesByIds(db, explicitFileIds, userId));
        if (explicitFolderIds && explicitFolderIds.length > 0) {
             for(const fid of explicitFolderIds) {
                 const deletionData = await getFolderDeletionData(db, fid, userId);
                 filesForStorage.push(...deletionData.files);
                 foldersForStorage.push(...deletionData.folders);
             }
        }
    } else {
        if (itemType === 'folder') {
            const deletionData = await getFolderDeletionData(db, itemId, userId);
            filesForStorage.push(...deletionData.files);
            foldersForStorage.push(...deletionData.folders);
        } else {
            filesForStorage.push(...await getFilesByIds(db, [itemId], userId));
        }
    }
    if (storage && storage.remove) {
        try { await storage.remove(filesForStorage, foldersForStorage, userId); } catch (err) { console.error("实体删除失败:", err); }
    }
    
    const fileIdsToDelete = filesForStorage.map(f => f.message_id);
    let folderIdsToDelete = foldersForStorage.map(f => f.id);
    if (explicitFolderIds) folderIdsToDelete = [...new Set([...folderIdsToDelete, ...explicitFolderIds])];
    else if (itemType === 'folder') folderIdsToDelete.push(itemId);
    await executeDeletion(db, fileIdsToDelete, folderIdsToDelete, userId);
}

export async function getFolderDeletionData(db, folderId, userId) {
    let filesToDelete = []; let foldersToDeleteIds = [folderId];
    async function findContentsRecursive(currentFolderId) {
        const sqlFiles = `SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS} FROM files WHERE folder_id = ? AND user_id = ?`;
        const files = await db.all(sqlFiles, [currentFolderId, userId]);
        filesToDelete.push(...files);
        const sqlFolders = `SELECT id FROM folders WHERE parent_id = ? AND user_id = ?`;
        const subFolders = await db.all(sqlFolders, [currentFolderId, userId]);
        for (const subFolder of subFolders) {
            foldersToDeleteIds.push(subFolder.id);
            await findContentsRecursive(subFolder.id);
        }
    }
    await findContentsRecursive(folderId);
    const foldersToDelete = foldersToDeleteIds.map(id => ({ id }));
    return { files: filesToDelete, folders: foldersToDelete };
}

export async function executeDeletion(db, fileIds, folderIds, userId) {
    if (fileIds.length === 0 && folderIds.length === 0) return { success: true };
    if (fileIds.length > 0) {
        const place = fileIds.map(() => '?').join(',');
        await db.run(`DELETE FROM files WHERE message_id IN (${place}) AND user_id = ?`, [...fileIds, userId]);
    }
    if (folderIds.length > 0) {
        const place = Array.from(new Set(folderIds)).map(() => '?').join(',');
        await db.run(`DELETE FROM folders WHERE id IN (${place}) AND user_id = ?`, [...new Set(folderIds), userId]);
    }
    return { success: true };
}

export async function softDeleteItems(db, fileIds = [], folderIds = [], userId) {
    if (folderIds && folderIds.length > 0) {
        const placeholders = folderIds.map(() => '?').join(',');
        const locked = await db.all(
            `SELECT name FROM folders WHERE id IN (${placeholders}) AND password IS NOT NULL AND password != '' AND user_id = ?`,
            [...folderIds, userId]
        );
        if (locked.length > 0) {
            throw new Error(`文件夹 "${locked[0].name}" 已加密保护，无法删除。请先移除密码（解密）。`);
        }
    }

    const now = Date.now();
    let targetFileIds = new Set(fileIds || []);
    let targetFolderIds = new Set(folderIds || []);

    if (folderIds && folderIds.length > 0) {
        for (const folderId of folderIds) {
            const data = await getFolderDeletionData(db, folderId, userId);
            data.files.forEach(f => targetFileIds.add(f.message_id));
            data.folders.forEach(f => targetFolderIds.add(f.id));
        }
    }

    const finalFileIds = Array.from(targetFileIds);
    const finalFolderIds = Array.from(targetFolderIds);

    if (finalFileIds.length > 0) {
        const place = finalFileIds.map(() => '?').join(',');
        await db.run(`UPDATE files SET is_deleted = 1, deleted_at = ? WHERE message_id IN (${place}) AND user_id = ?`, [now, ...finalFileIds, userId]);
    }
    if (finalFolderIds.length > 0) {
        const place = finalFolderIds.map(() => '?').join(',');
        await db.run(`UPDATE folders SET is_deleted = 1, deleted_at = ? WHERE id IN (${place}) AND user_id = ?`, [now, ...finalFolderIds, userId]);
    }
    return { success: true };
}

// ---------------------------------------------------------------------------------
// [核心修复] 递归合并函数 (Internal Helper)
// ---------------------------------------------------------------------------------
async function mergeFolders(db, sourceId, targetId, userId, conflictMode) {
    // 1. 合并文件
    const files = await db.all(`SELECT ${SAFE_SELECT_MESSAGE_ID}, fileName FROM files WHERE folder_id = ? AND user_id = ? AND deleted_at IS NULL`, [sourceId, userId]);
    
    for (const file of files) {
        const existing = await db.get(`SELECT ${SAFE_SELECT_MESSAGE_ID} FROM files WHERE folder_id = ? AND fileName = ? AND user_id = ? AND deleted_at IS NULL`, [targetId, file.fileName, userId]);
        
        if (existing) {
            if (conflictMode === 'overwrite') {
                // 覆盖：将目标文件软删除（重命名），然后移动源文件
                const trashName = `${file.fileName}_overwritten_${Date.now()}`;
                await db.run(`UPDATE files SET is_deleted = 1, deleted_at = ?, fileName = ? WHERE message_id = ? AND user_id = ?`, 
                    [Date.now(), trashName, existing.message_id, userId]);
                // 移动源文件
                await db.run(`UPDATE files SET folder_id = ? WHERE message_id = ? AND user_id = ?`, [targetId, file.message_id, userId]);
            } else if (conflictMode === 'rename') {
                // 重命名：源文件改名后移动
                const newName = await getUniqueName(db, targetId, file.fileName, userId, 'file');
                await db.run(`UPDATE files SET fileName = ?, folder_id = ? WHERE message_id = ? AND user_id = ?`, 
                    [newName, targetId, file.message_id, userId]);
            }
            // skip: 跳过，不移动
        } else {
             // 无冲突，直接移动
             try {
                await db.run(`UPDATE files SET folder_id = ? WHERE message_id = ? AND user_id = ?`, [targetId, file.message_id, userId]);
            } catch (e) {
                if (e.message && e.message.includes('UNIQUE')) {
                    await handleTrashConflict(db, 'files', 'fileName', 'folder_id', file.fileName, targetId, userId);
                    await db.run(`UPDATE files SET folder_id = ? WHERE message_id = ? AND user_id = ?`, [targetId, file.message_id, userId]);
                } else throw e;
            }
        }
    }

    // 2. 合并子文件夹
    const folders = await db.all(`SELECT id, name FROM folders WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL`, [sourceId, userId]);
    
    for (const folder of folders) {
        const existing = await db.get(`SELECT id FROM folders WHERE parent_id = ? AND name = ? AND user_id = ? AND deleted_at IS NULL`, [targetId, folder.name, userId]);
        
        if (existing) {
            if (conflictMode === 'overwrite') {
                // [递归关键点] 目标存在同名文件夹，递归合并
                await mergeFolders(db, folder.id, existing.id, userId, conflictMode);
                
                // 递归合并完成后，检查源子文件夹是否为空，空则删除
                const remainingFiles = await db.get(`SELECT 1 FROM files WHERE folder_id = ? AND deleted_at IS NULL LIMIT 1`, [folder.id]);
                const remainingFolders = await db.get(`SELECT 1 FROM folders WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1`, [folder.id]);
                
                if (!remainingFiles && !remainingFolders) {
                    await db.run(`DELETE FROM folders WHERE id = ?`, [folder.id]);
                }
            } else if (conflictMode === 'rename') {
                const newName = await getUniqueName(db, targetId, folder.name, userId, 'folder');
                await db.run(`UPDATE folders SET name = ?, parent_id = ? WHERE id = ? AND user_id = ?`, [newName, targetId, folder.id, userId]);
            }
            // skip: 跳过
        } else {
             // 无冲突，直接移动整个文件夹
             try {
                await db.run(`UPDATE folders SET parent_id = ? WHERE id = ? AND user_id = ?`, [targetId, folder.id, userId]);
            } catch (e) {
                if (e.message && e.message.includes('UNIQUE')) {
                    await handleTrashConflict(db, 'folders', 'name', 'parent_id', folder.name, targetId, userId);
                    await db.run(`UPDATE folders SET parent_id = ? WHERE id = ? AND user_id = ?`, [targetId, folder.id, userId]);
                } else throw e;
            }
        }
    }
}

// =================================================================================
// 10. 移動與重命名 (Exports)
// =================================================================================

export async function moveItems(db, storage, fileIds = [], folderIds = [], targetFolderId, userId, conflictMode = 'rename') {
    // 1. 处理文件移动
    for (const fileId of fileIds) {
        const file = await db.get("SELECT fileName, folder_id FROM files WHERE message_id = ? AND user_id = ?", [fileId, userId]);
        if (!file || file.folder_id == targetFolderId) continue;

        let finalName = file.fileName;
        const existing = await db.get(
            "SELECT message_id, fileName FROM files WHERE folder_id = ? AND fileName = ? AND user_id = ? AND deleted_at IS NULL", 
            [targetFolderId, file.fileName, userId]
        );

        if (existing) {
            if (conflictMode === 'overwrite') {
                const trashName = `${existing.fileName}_overwritten_${Date.now()}`;
                await db.run("UPDATE files SET is_deleted = 1, deleted_at = ?, fileName = ? WHERE message_id = ? AND user_id = ?", 
                    [Date.now(), trashName, existing.message_id, userId]);
            } else if (conflictMode === 'skip') {
                continue; 
            } else {
                finalName = await getUniqueName(db, targetFolderId, file.fileName, userId, 'file');
            }
        }
        
        try {
            await db.run("UPDATE files SET folder_id = ?, fileName = ? WHERE message_id = ? AND user_id = ?", [targetFolderId, finalName, fileId, userId]);
        } catch (err) {
            if (err.message && err.message.includes('UNIQUE')) {
                 const resolved = await handleTrashConflict(db, 'files', 'fileName', 'folder_id', finalName, targetFolderId, userId);
                 if (resolved) await db.run("UPDATE files SET folder_id = ?, fileName = ? WHERE message_id = ? AND user_id = ?", [targetFolderId, finalName, fileId, userId]);
                 else throw err;
            } else throw err;
        }
    }

    // 2. 处理文件夹移动
    for (const folderId of folderIds) {
        if (folderId === targetFolderId) continue; 
        const folder = await db.get("SELECT name, id FROM folders WHERE id = ? AND user_id = ?", [folderId, userId]);
        if (!folder) continue;

        const existingFolder = await db.get(
            "SELECT id, name FROM folders WHERE parent_id = ? AND name = ? AND user_id = ? AND deleted_at IS NULL",
            [targetFolderId, folder.name, userId]
        );

        if (existingFolder) {
            if (conflictMode === 'overwrite') {
                // [入口] 调用递归合并
                await mergeFolders(db, folderId, existingFolder.id, userId, conflictMode);
                
                // 检查源文件夹是否为空
                const remainingFiles = await db.get(`SELECT 1 FROM files WHERE folder_id = ? AND deleted_at IS NULL LIMIT 1`, [folderId]);
                const remainingFolders = await db.get(`SELECT 1 FROM folders WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1`, [folderId]);
                if (!remainingFiles && !remainingFolders) {
                    await db.run(`DELETE FROM folders WHERE id = ?`, [folderId]);
                }
            } else if (conflictMode === 'skip') {
                continue; 
            } else {
                const finalName = await getUniqueName(db, targetFolderId, folder.name, userId, 'folder');
                await db.run("UPDATE folders SET parent_id = ?, name = ? WHERE id = ? AND user_id = ?", [targetFolderId, finalName, folderId, userId]);
            }
        } else {
            // 无冲突，直接移动
             try {
                await db.run("UPDATE folders SET parent_id = ? WHERE id = ? AND user_id = ?", [targetFolderId, folderId, userId]);
            } catch (err) {
                if (err.message && err.message.includes('UNIQUE')) {
                    const resolved = await handleTrashConflict(db, 'folders', 'name', 'parent_id', folder.name, targetFolderId, userId);
                    if (resolved) await db.run("UPDATE folders SET parent_id = ? WHERE id = ? AND user_id = ?", [targetFolderId, folderId, userId]);
                    else throw err;
                } else throw err;
            }
        }
    }
    return { success: true };
}

// 递归还原并合并 (Restore & Merge Helper)
async function restoreAndMergeFolder(db, sourceId, targetId, userId, conflictMode) {
    const files = await db.all(`SELECT ${SAFE_SELECT_MESSAGE_ID}, fileName FROM files WHERE folder_id = ? AND user_id = ?`, [sourceId, userId]); 
    
    for (const file of files) {
        const existing = await db.get(`SELECT ${SAFE_SELECT_MESSAGE_ID} FROM files WHERE folder_id = ? AND fileName = ? AND user_id = ? AND deleted_at IS NULL`, [targetId, file.fileName, userId]);
        
        if (existing) {
             if (conflictMode === 'overwrite') {
                const trashName = `${file.fileName}_overwritten_${Date.now()}`;
                await db.run(`UPDATE files SET is_deleted = 1, deleted_at = ?, fileName = ? WHERE message_id = ? AND user_id = ?`, 
                    [Date.now(), trashName, existing.message_id, userId]);
                await db.run(`UPDATE files SET is_deleted = 0, deleted_at = NULL, folder_id = ? WHERE message_id = ? AND user_id = ?`, [targetId, file.message_id, userId]);
             } else if (conflictMode === 'rename') {
                const newName = await getUniqueName(db, targetId, file.fileName, userId, 'file');
                await db.run(`UPDATE files SET is_deleted = 0, deleted_at = NULL, fileName = ?, folder_id = ? WHERE message_id = ? AND user_id = ?`, 
                    [newName, targetId, file.message_id, userId]);
             }
        } else {
             await db.run(`UPDATE files SET is_deleted = 0, deleted_at = NULL, folder_id = ? WHERE message_id = ? AND user_id = ?`, [targetId, file.message_id, userId]);
        }
    }

    const folders = await db.all(`SELECT id, name FROM folders WHERE parent_id = ? AND user_id = ?`, [sourceId, userId]);
    
    for (const folder of folders) {
        const existing = await db.get(`SELECT id FROM folders WHERE parent_id = ? AND name = ? AND user_id = ? AND deleted_at IS NULL`, [targetId, folder.name, userId]);
        
        if (existing) {
             if (conflictMode === 'overwrite') {
                 await restoreAndMergeFolder(db, folder.id, existing.id, userId, conflictMode);
                 await db.run(`DELETE FROM folders WHERE id = ?`, [folder.id]);
             } else if (conflictMode === 'rename') {
                 const newName = await getUniqueName(db, targetId, folder.name, userId, 'folder');
                 await db.run(`UPDATE folders SET is_deleted = 0, deleted_at = NULL, name = ?, parent_id = ? WHERE id = ? AND user_id = ?`, 
                     [newName, targetId, folder.id, userId]);
                 await cascadeRestore(db, folder.id, userId);
             }
        } else {
             await db.run(`UPDATE folders SET is_deleted = 0, deleted_at = NULL, parent_id = ? WHERE id = ? AND user_id = ?`, [targetId, folder.id, userId]);
             await cascadeRestore(db, folder.id, userId);
        }
    }
}

async function cascadeRestore(db, folderId, userId) {
    await db.run(`UPDATE files SET is_deleted = 0, deleted_at = NULL WHERE folder_id = ? AND user_id = ?`, [folderId, userId]);
    const subs = await db.all(`SELECT id FROM folders WHERE parent_id = ? AND user_id = ?`, [folderId, userId]);
    for(const sub of subs) {
        await db.run(`UPDATE folders SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND user_id = ?`, [sub.id, userId]);
        await cascadeRestore(db, sub.id, userId);
    }
}

export async function restoreItems(db, storage, fileIds = [], folderIds = [], userId, conflictMode = 'rename') {
    for (const id of (folderIds || [])) {
        const folder = await db.get("SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?", [id, userId]);
        if (!folder) continue;

        let targetParentId = folder.parent_id;
        if (targetParentId) {
             const parent = await db.get("SELECT is_deleted FROM folders WHERE id = ?", [targetParentId]);
             if (!parent || parent.is_deleted) {
                 const root = await getRootFolder(db, userId);
                 targetParentId = root.id;
             }
        }

        const existingFolder = await db.get(
            "SELECT id, name FROM folders WHERE parent_id = ? AND name = ? AND user_id = ? AND deleted_at IS NULL", 
            [targetParentId, folder.name, userId]
        );

        if (existingFolder) {
            if (conflictMode === 'overwrite') {
                await restoreAndMergeFolder(db, id, existingFolder.id, userId, conflictMode);
                await db.run(`DELETE FROM folders WHERE id = ?`, [id]);
            } else if (conflictMode === 'skip') {
                continue; 
            } else {
                const newName = await getUniqueName(db, targetParentId, folder.name, userId, 'folder');
                await db.run("UPDATE folders SET name = ?, parent_id = ?, is_deleted = 0, deleted_at = NULL WHERE id = ? AND user_id = ?", 
                    [newName, targetParentId, id, userId]);
                await cascadeRestore(db, id, userId);
            }
        } else {
            try {
                await db.run("UPDATE folders SET parent_id = ?, is_deleted = 0, deleted_at = NULL WHERE id = ? AND user_id = ?", 
                    [targetParentId, id, userId]);
            } catch(e) {
                if (e.message && e.message.includes('UNIQUE')) {
                    await handleTrashConflict(db, 'folders', 'name', 'parent_id', folder.name, targetParentId, userId);
                    await db.run("UPDATE folders SET parent_id = ?, is_deleted = 0, deleted_at = NULL WHERE id = ? AND user_id = ?", 
                        [targetParentId, id, userId]);
                } else throw e;
            }
            await cascadeRestore(db, id, userId);
        }
    }

    for (const id of (fileIds || [])) {
        const file = await db.get("SELECT message_id, fileName, folder_id FROM files WHERE message_id = ? AND user_id = ?", [id, userId]);
        if (!file) continue;

        let targetFolderId = file.folder_id;
        if (targetFolderId) {
             const parent = await db.get("SELECT is_deleted FROM folders WHERE id = ?", [targetFolderId]);
             if (!parent || parent.is_deleted) {
                 const root = await getRootFolder(db, userId);
                 targetFolderId = root.id;
             }
        }

        const existingFile = await db.get(
            "SELECT message_id, fileName FROM files WHERE folder_id = ? AND fileName = ? AND user_id = ? AND deleted_at IS NULL", 
            [targetFolderId, file.fileName, userId]
        );

        if (existingFile) {
            if (conflictMode === 'overwrite') {
                const trashName = `${existingFile.fileName}_overwritten_${Date.now()}`;
                await db.run("UPDATE files SET is_deleted = 1, deleted_at = ?, fileName = ? WHERE message_id = ?", 
                    [Date.now(), trashName, existingFile.message_id]);
                await db.run("UPDATE files SET is_deleted = 0, deleted_at = NULL, folder_id = ? WHERE message_id = ?", 
                    [targetFolderId, id]);
            } else if (conflictMode === 'skip') {
                continue; 
            } else {
                const newName = await getUniqueName(db, targetFolderId, file.fileName, userId, 'file');
                await db.run("UPDATE files SET fileName = ?, folder_id = ?, is_deleted = 0, deleted_at = NULL WHERE message_id = ?", 
                    [newName, targetFolderId, id]);
            }
        } else {
             try {
                await db.run("UPDATE files SET folder_id = ?, is_deleted = 0, deleted_at = NULL WHERE message_id = ?", 
                    [targetFolderId, id]);
             } catch(e) {
                 if (e.message && e.message.includes('UNIQUE')) {
                     await handleTrashConflict(db, 'files', 'fileName', 'folder_id', file.fileName, targetFolderId, userId);
                     await db.run("UPDATE files SET folder_id = ?, is_deleted = 0, deleted_at = NULL WHERE message_id = ?", 
                        [targetFolderId, id]);
                 } else throw e;
             }
        }
    }

    return { success: true };
}

// =================================================================================
// 8. 回收站內容
// =================================================================================

export async function getTrashContents(db, userId) {
    const sqlFolders = `
        SELECT f.id, f.name, f.deleted_at, 'folder' as type 
        FROM folders f
        LEFT JOIN folders p ON f.parent_id = p.id
        WHERE f.user_id = ? 
          AND f.is_deleted = 1
          AND (f.parent_id IS NULL OR p.is_deleted = 0 OR p.is_deleted IS NULL)
        ORDER BY f.deleted_at DESC
    `;
    const sqlFiles = `
        SELECT CAST(f.message_id AS TEXT) AS message_id, CAST(f.message_id AS TEXT) AS id, 
               f.fileName as name, f.size, f.deleted_at, 'file' as type 
        FROM files f
        LEFT JOIN folders p ON f.folder_id = p.id
        WHERE f.user_id = ? 
          AND f.is_deleted = 1
          AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
        ORDER BY f.deleted_at DESC
    `;
    const folders = await db.all(sqlFolders, [userId]);
    const files = await db.all(sqlFiles, [userId]);
    // [修复] 增加对 encrypt 的存在性检查，防止 (void 0) is not a function 错误
    return { 
        folders: folders.map(f => ({ ...f, encrypted_id: encrypt ? encrypt(f.id) : f.id })), 
        files 
    };
}

export async function emptyTrash(db, storage, userId) {
    const files = await db.all(`SELECT ${SAFE_SELECT_MESSAGE_ID}, file_id FROM files WHERE is_deleted = 1 AND user_id = ?`, [userId]);
    const folders = await db.all(`SELECT id FROM folders WHERE is_deleted = 1 AND user_id = ?`, [userId]);
    const fileIds = files.map(f => f.message_id);
    const folderIds = folders.map(f => f.id);
    if (fileIds.length === 0 && folderIds.length === 0) return { success: true };
    await unifiedDelete(db, storage, null, null, userId, fileIds, folderIds);
    return { success: true };
}

// =================================================================================
// 9. 分享與加密
// =================================================================================

export async function createShareLink(db, itemId, itemType, expiresIn, userId, password = null, customExpiresAt = null) {
    const tokenArray = new Uint8Array(8); crypto.getRandomValues(tokenArray);
    const token = Array.from(tokenArray).map(b => b.toString(16).padStart(2, '0')).join('');
    let expiresAt = null;
    if (expiresIn !== '0') {
        const now = Date.now();
        if (expiresIn === 'custom' && customExpiresAt) expiresAt = parseInt(customExpiresAt, 10);
        else {
            const hour = 3600000; const day = 24 * hour;
            if (expiresIn === '1h') expiresAt = now + hour;
            else if (expiresIn === '24h') expiresAt = now + day;
            else if (expiresIn === '7d') expiresAt = now + 7 * day;
            else expiresAt = now + day;
        }
    }
    const table = itemType === 'folder' ? 'folders' : 'files';
    const idColumn = itemType === 'folder' ? 'id' : 'message_id';
    let hashedPassword = null;
    if (password && password.length > 0) { const salt = await bcrypt.genSalt(10); hashedPassword = await bcrypt.hash(password, salt); }
    const sql = `UPDATE ${table} SET share_token = ?, share_expires_at = ?, share_password = ? WHERE ${idColumn} = ? AND user_id = ?`;
    const result = await db.run(sql, [token, expiresAt, hashedPassword, itemId, userId]);
    if (result.meta.changes === 0) return { success: false, message: '項目未找到。' };
    return { success: true, token };
}

export async function getFileByShareToken(db, token) {
    const row = await db.get(`SELECT ${SAFE_SELECT_MESSAGE_ID}, ${ALL_FILE_COLUMNS}, share_password, share_expires_at FROM files WHERE share_token = ?`, [token]);
    if (!row) return null;
    if (row.share_expires_at && Date.now() > row.share_expires_at) return null;
    return row;
}

export async function getFolderByShareToken(db, token) {
    const row = await db.get("SELECT * FROM folders WHERE share_token = ?", [token]);
    if (!row) return null;
    if (row.share_expires_at && Date.now() > row.share_expires_at) return null;
    return row;
}

export async function cancelShare(db, itemId, itemType, userId) {
    const table = itemType === 'folder' ? 'folders' : 'files';
    const idColumn = itemType === 'folder' ? 'id' : 'message_id';
    await db.run(`UPDATE ${table} SET share_token = NULL, share_expires_at = NULL, share_password = NULL WHERE ${idColumn} = ? AND user_id = ?`, [itemId, userId]);
    return { success: true };
}

export async function getActiveShares(db, userId) {
    const now = Date.now();
    const files = await db.all(
        `SELECT ${SAFE_SELECT_ID_AS_TEXT}, fileName as name, 'file' as type, share_token, share_expires_at, folder_id as parent_id 
         FROM files 
         WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ?`, 
         [now, userId]
    );
    const folders = await db.all(
        `SELECT id, name, 'folder' as type, share_token, share_expires_at, parent_id 
         FROM folders 
         WHERE share_token IS NOT NULL AND (share_expires_at IS NULL OR share_expires_at > ?) AND user_id = ?`, 
         [now, userId]
    );
    
    const results = [...files, ...folders];
    return results.map(item => {
        let pid = item.parent_id;
        return {
            ...item,
            encrypted_parent_id: encrypt && pid ? encrypt(pid) : null // [修复] 防御 encrypt 为空
        };
    });
}

export async function setFolderPassword(db, folderId, password, userId) {
    const finalPassword = (password && password.length > 0) ? password : null;
    const result = await db.run(`UPDATE folders SET password = ? WHERE id = ? AND user_id = ?`, [finalPassword, folderId, userId]);
    if (result.meta.changes === 0) throw new Error('文件夹未找到或无权操作');
    return { success: true };
}

export async function renameFile(db, storage, messageId, newFileName, userId) {
    const file = await db.get("SELECT folder_id FROM files WHERE message_id = ? AND user_id = ?", [messageId, userId]);
    if (!file) throw new Error('File not found');
    try {
        await db.run(`UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?`, [newFileName, messageId, userId]);
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
             const resolved = await handleTrashConflict(db, 'files', 'fileName', 'folder_id', newFileName, file.folder_id, userId);
             if (resolved) await db.run(`UPDATE files SET fileName = ? WHERE message_id = ? AND user_id = ?`, [newFileName, messageId, userId]);
             else throw err;
        } else throw err;
    }
    return { success: true };
}

export async function renameFolder(db, storage, folderId, newFolderName, userId) {
    const folder = await db.get("SELECT parent_id FROM folders WHERE id = ? AND user_id = ?", [folderId, userId]);
    if (!folder) throw new Error('Folder not found');
    try {
        await db.run(`UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`, [newFolderName, folderId, userId]);
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            const resolved = await handleTrashConflict(db, 'folders', 'name', 'parent_id', newFolderName, folder.parent_id, userId);
            if (resolved) await db.run(`UPDATE folders SET name = ? WHERE id = ? AND user_id = ?`, [newFolderName, folderId, userId]);
            else throw err;
        } else throw err;
    }
    return { success: true };
}

// =================================================================================
// 11. 認證 Token
// =================================================================================

export async function createAuthToken(db, userId, token, expiresAt) {
    await db.run(`INSERT INTO auth_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`, [userId, token, expiresAt]);
}

export async function findAuthToken(db, token) {
    return await db.get(`SELECT t.id, t.user_id, t.expires_at, u.username, u.is_admin FROM auth_tokens t JOIN users u ON t.user_id = u.id WHERE t.token = ?`, [token]);
}

export async function deleteAuthToken(db, token) {
    await db.run(`DELETE FROM auth_tokens WHERE token = ?`, [token]);
}

// =================================================================================
// 12. 掃描與導入
// =================================================================================

export async function scanStorageAndImport(db, storage, userId, storageType, log) {
    await log(`正在连接 ${storageType} 存储...`);
    try {
        const prefix = `${userId}/`; 
        const remoteFiles = await storage.list(prefix);
        await log(`远程存储中发现 ${remoteFiles.length} 个文件。开始比对数据库...`);
        const rootFolder = await getRootFolder(db, userId);
        if (!rootFolder) throw new Error(`用户根目录不存在，请先登录该用户以初始化目录结构。`);
        let importCount = 0;
        let skipCount = 0;
        for (const remote of remoteFiles) {
            const existing = await db.get("SELECT 1 FROM files WHERE file_id = ? AND user_id = ? AND deleted_at IS NULL", [remote.fileId, userId]);
            if (existing) { skipCount++; continue; }
            const fileName = path.basename(remote.fileId);
            if (!fileName || fileName.startsWith('.')) continue;
            const uniqueName = await getUniqueName(db, rootFolder.id, fileName, userId, 'file');
            const messageId = (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
            await addFile(db, {
                message_id: messageId, fileName: uniqueName, mimetype: 'application/octet-stream', 
                file_id: remote.fileId, thumb_file_id: null, date: remote.updatedAt || Date.now(), size: remote.size
            }, rootFolder.id, userId, 'imported'); 
            await log(`[导入] ${uniqueName} (${formatSize(remote.size)})`);
            importCount++;
        }
        await log(`扫描完成！新增: ${importCount}, 跳过: ${skipCount}`);
    } catch (e) { await log(`扫描失败: ${e.message}`); throw e; }
}

export async function getShareFolderAllFiles(db, folderId, userId) {
    const filesList = [];
    async function recurse(currentId, currentPath) {
        const sqlFiles = `SELECT CAST(message_id AS TEXT) AS message_id, fileName, size, file_id, storage_type, thumb_file_id FROM files WHERE folder_id = ? AND user_id = ? AND deleted_at IS NULL`;
        const files = await db.all(sqlFiles, [currentId, userId]);
        for (const f of files) {
            filesList.push({
                ...f,
                zipPath: currentPath ? `${currentPath}/${f.fileName}` : f.fileName
            });
        }
        const sqlFolders = `SELECT id, name FROM folders WHERE parent_id = ? AND user_id = ? AND deleted_at IS NULL`;
        const folders = await db.all(sqlFolders, [currentId, userId]);
        for (const f of folders) {
            const nextPath = currentPath ? `${currentPath}/${f.name}` : f.name;
            await recurse(f.id, nextPath);
        }
    }
    await recurse(folderId, "");
    return filesList;
}
