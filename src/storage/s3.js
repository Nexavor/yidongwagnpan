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
        const keysToDelete = files.map(f => f.file_id);
        const dirsToCheck = new Set(); // [新增] 記錄父目錄

        if (this.isR2Binding) {
            for (const key of keysToDelete) {
                await this.bucket.delete(key);
                // 提取父目錄
                const lastSlash = key.lastIndexOf('/');
                if (lastSlash !== -1) dirsToCheck.add(key.substring(0, lastSlash));
            }
        } else {
            for (const key of keysToDelete) {
                const url = `${this.endpoint}/${this.bucketName}/${encodeURIComponent(key)}`;
                await this.client.fetch(url, { method: 'DELETE' });
                
                const lastSlash = key.lastIndexOf('/');
                if (lastSlash !== -1) dirsToCheck.add(key.substring(0, lastSlash));
            }
        }

        // [新增] 檢查並清理空目錄
        for (const dir of dirsToCheck) {
            await this.cleanupEmptyDir(dir);
        }
    }

    // [新增] 檢查並刪除 S3 目錄標記 (如果存在)
    async cleanupEmptyDir(dir) {
        try {
            // 檢查該前綴下是否還有文件
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
