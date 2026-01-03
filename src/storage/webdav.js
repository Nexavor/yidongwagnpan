export class WebDAVStorage {
    constructor(config) {
        // 安全檢查：防止 config 為空導致崩潰
        if (!config) {
            throw new Error("WebDAV 配置對象為空");
        }
        if (!config.endpoint) {
            throw new Error("WebDAV Endpoint 未填寫，請進入後台設置");
        }

        // 去除 endpoint 末尾的斜杠
        this.endpoint = config.endpoint.endsWith('/') ? config.endpoint.slice(0, -1) : config.endpoint;
        this.username = config.username || '';
        this.password = config.password || '';
        
        // 只有當有用戶名密碼時才生成 Auth Header
        if (this.username || this.password) {
            this.authHeader = 'Basic ' + btoa(`${this.username}:${this.password}`);
        } else {
            this.authHeader = null;
        }
    }

    async ensureDir(path) {
        const parts = path.split('/').filter(p => p);
        let currentUrl = this.endpoint;
        
        for (const part of parts) {
            currentUrl += '/' + encodeURIComponent(part); 
            
            const headers = { 'Depth': '0' };
            if (this.authHeader) headers['Authorization'] = this.authHeader;

            // 檢查目錄是否存在
            const check = await fetch(currentUrl, {
                method: 'PROPFIND',
                headers: headers
            });
            
            // 如果不存在，創建它
            if (check.status === 404) {
                const mkHeaders = {};
                if (this.authHeader) mkHeaders['Authorization'] = this.authHeader;
                
                await fetch(currentUrl, {
                    method: 'MKCOL',
                    headers: mkHeaders
                });
            }
        }
    }

    async upload(file, fileName, contentType, userId, folderId) {
        const dirPath = `${userId}/${folderId}`;
        await this.ensureDir(dirPath);
        
        const key = `${dirPath}/${fileName}`;
        const url = `${this.endpoint}/${userId}/${folderId}/${encodeURIComponent(fileName)}`;
        
        const headers = { 'Content-Type': contentType };
        if (this.authHeader) headers['Authorization'] = this.authHeader;

        const res = await fetch(url, {
            method: 'PUT',
            headers: headers,
            body: file
        });

        if (!res.ok) {
            throw new Error(`WebDAV Upload Failed: ${res.status} ${res.statusText}`);
        }

        return {
            fileId: key, 
            thumbId: null
        };
    }

    async download(fileId, userId) {
        const encodedPath = fileId.split('/').map(encodeURIComponent).join('/');
        const url = `${this.endpoint}/${encodedPath}`;

        const headers = {};
        if (this.authHeader) headers['Authorization'] = this.authHeader;

        const res = await fetch(url, {
            method: 'GET',
            headers: headers
        });

        if (!res.ok) throw new Error(`WebDAV Download Failed: ${res.status}`);

        return {
            stream: res.body,
            contentType: res.headers.get('Content-Type') || 'application/octet-stream',
            headers: {
                'Content-Length': res.headers.get('Content-Length'),
                'ETag': res.headers.get('ETag')
            }
        };
    }

    async remove(files, folders, userId) {
        const targets = files.map(f => f.file_id);
        const dirsToCheck = new Set(); // [新增] 用於記錄需要檢查的父目錄

        // 1. 收集所有需要檢查的父目錄 (保持原邏輯)
        for (const path of targets) {
            const lastSlash = path.lastIndexOf('/');
            if (lastSlash !== -1) {
                dirsToCheck.add(path.substring(0, lastSlash));
            }
        }

        // 2. [优化] 並發刪除文件 (替代原本的串行循環)
        // 限制並發數為 5，避免觸發 WebDAV 服務器的頻率限制
        const CONCURRENT_LIMIT = 5;
        
        for (let i = 0; i < targets.length; i += CONCURRENT_LIMIT) {
            const chunk = targets.slice(i, i + CONCURRENT_LIMIT);
            
            // 使用 Promise.all 等待這一批刪除完成
            await Promise.all(chunk.map(async (path) => {
                const encodedPath = path.split('/').map(encodeURIComponent).join('/');
                const url = `${this.endpoint}/${encodedPath}`;
                
                const headers = {};
                if (this.authHeader) headers['Authorization'] = this.authHeader;

                try {
                    await fetch(url, {
                        method: 'DELETE',
                        headers: headers
                    });
                } catch (e) {
                    // 記錄錯誤但不中斷整個流程
                    console.error(`WebDAV Delete Error (${path}):`, e);
                }
            }));
        }

        // 3. [保持原邏輯] 檢查並清理空目錄 (保持串行以確保穩定性)
        for (const dir of dirsToCheck) {
            await this.deleteDirIfEmpty(dir);
        }
    }

    // [新增] 輔助方法：如果目錄為空則刪除
    async deleteDirIfEmpty(dirPath) {
        try {
            const encodedPath = dirPath.split('/').map(encodeURIComponent).join('/');
            const url = `${this.endpoint}/${encodedPath}`;
            
            const headers = { 'Depth': '1' }; // 只檢查下一級
            if (this.authHeader) headers['Authorization'] = this.authHeader;

            // 1. 檢查目錄內容
            const res = await fetch(url, { method: 'PROPFIND', headers: headers });
            if (!res.ok) return; // 目錄可能已經不存在

            const text = await res.text();
            
            // 2. 計算 <D:response> 的數量
            // 如果數量 <= 1，說明只有目錄自己，沒有子文件，可以刪除
            const responseCount = (text.match(/<[Dd]:response/g) || []).length;

            if (responseCount <= 1) {
                await fetch(url, {
                    method: 'DELETE',
                    headers: this.authHeader ? { 'Authorization': this.authHeader } : {}
                });
            }
        } catch (e) {
            // 忽略清理過程中的錯誤，避免影響主流程
            console.warn(`清理空目錄失敗 ${dirPath}:`, e);
        }
    }

    async list(prefix) {
        const url = `${this.endpoint}/${prefix}`;
        
        const res = await fetch(url, {
            method: 'PROPFIND',
            headers: {
                'Authorization': this.authHeader || '',
                'Depth': 'infinity'
            }
        });

        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`WebDAV PROPFIND failed: ${res.status}`);

        const text = await res.text();
        const files = [];
        
        const responses = text.split(/<D:response|<d:response/i);
        
        for (const resp of responses) {
            if (!resp.trim()) continue;

            let hrefMatch = resp.match(/<[Dd]:href>(.*?)<\/[Dd]:href>/);
            let href = hrefMatch ? hrefMatch[1] : '';
            href = decodeURIComponent(href);
            
            if (/<\/[Dd]:collection>|<[Dd]:collection\s*\/>/.test(resp)) {
                continue;
            }

            const sizeMatch = resp.match(/<[Dd]:getcontentlength>(\d+)<\/[Dd]:getcontentlength>/);
            const size = sizeMatch ? parseInt(sizeMatch[1]) : 0;
            
            const dateMatch = resp.match(/<[Dd]:getlastmodified>(.*?)<\/[Dd]:getlastmodified>/);
            const dateStr = dateMatch ? dateMatch[1] : '';
            const updatedAt = dateStr ? new Date(dateStr).getTime() : Date.now();
            
            let fileId = href;
            try {
                const endpointPath = new URL(this.endpoint).pathname;
                if (endpointPath && endpointPath !== '/' && fileId.includes(endpointPath)) {
                    fileId = fileId.substring(fileId.indexOf(endpointPath) + endpointPath.length);
                }
            } catch (e) {}
            
            if (fileId.startsWith('/')) fileId = fileId.substring(1);

            if (prefix && !fileId.startsWith(prefix) && !fileId.startsWith(decodeURIComponent(prefix))) {
                continue;
            }

            if (fileId) {
                files.push({
                    fileId: fileId,
                    size: size,
                    updatedAt: updatedAt
                });
            }
        }
        return files;
    }
}
