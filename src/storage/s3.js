import { AwsClient } from 'aws4fetch';

export class S3Storage {
    constructor(config) {
        this.config = config;
        this.isR2Binding = config.isR2Binding;
        
        if (this.isR2Binding) {
            this.bucket = config.bucket;
        } else {
            this.client = new AwsClient({
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
                service: 's3',
                region: config.region || 'auto',
            });
            this.endpoint = config.endpoint;
            this.bucketName = config.bucketName;
            this.publicUrl = config.publicUrl;
        }
    }

    async upload(file, fileName, contentType, userId, folderId) {
        const key = `${userId}/${folderId}/${fileName}`;
        
        if (this.isR2Binding) {
            await this.bucket.put(key, file, {
                httpMetadata: { contentType: contentType }
            });
        } else {
            const url = `${this.endpoint}/${this.bucketName}/${encodeURIComponent(key)}`;
            await this.client.fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': contentType },
                body: file
            });
        }

        return {
            fileId: key,
            thumbId: null
        };
    }

    async download(fileId, userId) {
        if (this.isR2Binding) {
            const object = await this.bucket.get(fileId);
            if (!object) throw new Error('File not found in R2');
            
            return {
                stream: object.body,
                contentType: object.httpMetadata?.contentType || 'application/octet-stream',
                headers: {
                    'Content-Length': object.size,
                    'ETag': object.etag
                }
            };
        } else {
            const url = `${this.endpoint}/${this.bucketName}/${encodeURIComponent(fileId)}`;
            const res = await this.client.fetch(url, { method: 'GET' });
            if (!res.ok) throw new Error(`S3 Download Error: ${res.status}`);
            
            return {
                stream: res.body,
                contentType: res.headers.get('Content-Type'),
                headers: {
                    'Content-Length': res.headers.get('Content-Length'),
                    'ETag': res.headers.get('ETag')
                }
            };
        }
    }

    async remove(files, folders, userId) {
        if (!files || files.length === 0) return;

        const keysToDelete = files.map(f => f.file_id);
        const dirsToCheck = new Set(); // 记录父目录以便后续清理

        // 预处理：收集所有涉及的父目录
        for (const key of keysToDelete) {
            const lastSlash = key.lastIndexOf('/');
            if (lastSlash !== -1) dirsToCheck.add(key.substring(0, lastSlash));
        }

        // [优化] 分批并发处理，防止触发 Worker 子请求数量限制
        // 建议并发数控制在 10-20 左右
        const CONCURRENT_LIMIT = 10;

        if (this.isR2Binding) {
            for (let i = 0; i < keysToDelete.length; i += CONCURRENT_LIMIT) {
                const chunk = keysToDelete.slice(i, i + CONCURRENT_LIMIT);
                // R2 Binding 并发删除
                await Promise.all(chunk.map(key => this.bucket.delete(key)));
            }
        } else {
            for (let i = 0; i < keysToDelete.length; i += CONCURRENT_LIMIT) {
                const chunk = keysToDelete.slice(i, i + CONCURRENT_LIMIT);
                // S3 API 并发删除
                await Promise.all(chunk.map(key => {
                    const url = `${this.endpoint}/${this.bucketName}/${encodeURIComponent(key)}`;
                    return this.client.fetch(url, { method: 'DELETE' });
                }));
            }
        }

        // [优化] 并发检查并清理空目录
        const dirsArray = Array.from(dirsToCheck);
        for (let i = 0; i < dirsArray.length; i += CONCURRENT_LIMIT) {
            const chunk = dirsArray.slice(i, i + CONCURRENT_LIMIT);
            await Promise.all(chunk.map(dir => this.cleanupEmptyDir(dir)));
        }
    }

    // 检查并删除 S3 目录标记 (如果存在)
    async cleanupEmptyDir(dir) {
        try {
            // 检查该前綴下是否还有文件
            const contents = await this.list(dir + '/');
            if (contents.length === 0) {
                // 如果為空，嘗試刪除目錄對象本身 (通常是 key 以 / 結尾的 0字節對象)
                const dirKey = dir + '/';
                if (this.isR2Binding) {
                    await this.bucket.delete(dirKey);
                } else {
                    const url = `${this.endpoint}/${this.bucketName}/${encodeURIComponent(dirKey)}`;
                    await this.client.fetch(url, { method: 'DELETE' });
                }
            }
        } catch(e) {
            // 忽略 S3 清理錯誤 (因為 S3 本身不強制要求目錄對象)
        }
    }

    async list(prefix) {
        let files = [];
        
        if (this.isR2Binding) {
            let cursor = undefined;
            do {
                const listed = await this.bucket.list({ prefix: prefix, cursor: cursor });
                files.push(...listed.objects.map(obj => ({
                    fileId: obj.key,
                    size: obj.size,
                    updatedAt: obj.uploaded.getTime()
                })));
                cursor = listed.truncated ? listed.cursor : undefined;
            } while (cursor);
        } 
        else {
            const url = `${this.endpoint}/${this.bucketName}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
            const res = await this.client.fetch(url, { method: 'GET' });
            
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`S3 List Error: ${res.status} - ${errText}`);
            }

            const text = await res.text();
            
            const contentsRegex = /<Contents>(.*?)<\/Contents>/gs;
            const keyRegex = /<Key>(.*?)<\/Key>/;
            const sizeRegex = /<Size>(\d+)<\/Size>/;
            const dateRegex = /<LastModified>(.*?)<\/LastModified>/;

            const matches = text.match(contentsRegex);
            if (matches) {
                files = matches.map(itemStr => {
                    const keyMatch = itemStr.match(keyRegex);
                    const sizeMatch = itemStr.match(sizeRegex);
                    const dateMatch = itemStr.match(dateRegex);

                    if (keyMatch) {
                        return {
                            fileId: keyMatch[1],
                            size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
                            updatedAt: dateMatch ? new Date(dateMatch[1]).getTime() : Date.now()
                        };
                    }
                    return null;
                }).filter(f => f !== null);
            }
        }
        return files;
    }
}
