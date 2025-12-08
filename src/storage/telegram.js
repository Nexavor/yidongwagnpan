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

        // 获取 file_id，优先选择最大的 file_id (虽然后端通常只返回一个 document)
        const doc = data.result.document;
        const fileId = doc.file_id;

        return {
            fileId: fileId,
            thumbId: data.result.thumb ? data.result.thumb.file_id : null
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
        // Telegram Bot API 不支持通过 file_id 删除服务器上的文件。
        // 删除 message 需要 message_id，但我们目前只存储了 file_id。
        // 因此这里仅做空操作，依靠数据库层面的删除来“软删除”文件。
        // 如果需要物理删除，需要在 files 表中额外存储 message_id。
        console.log(`[TelegramStorage] Skipping physical deletion for ${files.length} files (API limitation).`);
        return;
    }

    async list(prefix) {
        // Telegram 不支持列出 Chat 中的文件
        return [];
    }
}
