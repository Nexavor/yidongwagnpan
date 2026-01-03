export class TelegramStorage {
    constructor(config) {
        this.botToken = config.botToken;
        this.chatId = config.chatId;
        this.apiUrl = 'https://api.telegram.org/bot' + this.botToken;
        this.fileUrl = 'https://api.telegram.org/file/bot' + this.botToken;
    }

    async upload(file, fileName, contentType, userId, folderId) {
        const formData = new FormData();
        formData.append('chat_id', this.chatId);
        // 为了方便管理，可以在 caption 中添加元数据
        formData.append('caption', `User: ${userId}\nPath: ${folderId}/${fileName}`);
        formData.append('document', file, fileName);

        const res = await fetch(`${this.apiUrl}/sendDocument`, {
            method: 'POST',
            body: formData
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Telegram Upload Error: ${res.status} - ${errText}`);
        }

        const data = await res.json();
        if (!data.ok) {
            throw new Error(`Telegram API Error: ${data.description}`);
        }

        // 获取 file_id
        const doc = data.result.document;
        const fileId = doc.file_id;
        // [修复] 获取 message_id 用于后续删除
        const messageId = data.result.message_id;

        return {
            fileId: fileId,
            thumbId: data.result.thumb ? data.result.thumb.file_id : null,
            tgMessageId: messageId // 返回给 worker 保存到数据库
        };
    }

    async download(fileId, userId) {
        // 1. 获取 File Path
        const res = await fetch(`${this.apiUrl}/getFile?file_id=${fileId}`);
        const data = await res.json();
        
        if (!data.ok) throw new Error(`Telegram GetFile Error: ${data.description}`);
        
        const filePath = data.result.file_path;
        const downloadUrl = `${this.fileUrl}/${filePath}`;

        // 2. 获取文件流
        const fileRes = await fetch(downloadUrl);
        if (!fileRes.ok) throw new Error(`Telegram Download Error: ${fileRes.status}`);

        return {
            stream: fileRes.body,
            contentType: fileRes.headers.get('Content-Type') || 'application/octet-stream',
            headers: {
                'Content-Length': fileRes.headers.get('Content-Length'),
                // Telegram 不一定返回 ETag，这里留空或生成一个伪 ETag
                'ETag': `tg-${fileId.substring(0, 10)}` 
            }
        };
    }

    async remove(files, folders, userId) {
        // [修复] 实现 Telegram 消息批量删除
        if (!files || files.length === 0) return;

        // 从文件记录中提取 tg_message_id
        // 过滤掉没有 message_id 的旧文件记录
        const messageIds = files
            .map(f => f.tg_message_id)
            .filter(id => id !== null && id !== undefined);

        if (messageIds.length === 0) return;

        // Telegram deleteMessages API 限制每次最多删除 100 条消息
        const chunkSize = 100;
        for (let i = 0; i < messageIds.length; i += chunkSize) {
            const chunk = messageIds.slice(i, i + chunkSize);
            try {
                const res = await fetch(`${this.apiUrl}/deleteMessages`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        chat_id: this.chatId,
                        message_ids: chunk
                    })
                });

                if (!res.ok) {
                    const errText = await res.text();
                    console.error(`Telegram Delete Error (Batch ${i}): ${res.status} - ${errText}`);
                } else {
                    const data = await res.json();
                    if (!data.ok) {
                        console.error(`Telegram Delete API Error (Batch ${i}): ${data.description}`);
                    }
                }
            } catch (e) {
                console.error(`Telegram Delete Exception (Batch ${i}):`, e);
            }
        }
    }

    async list(prefix) {
        // Telegram 不支持列出 Chat 中的文件
        return [];
    }
}
