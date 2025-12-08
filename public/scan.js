document.addEventListener('DOMContentLoaded', () => {
    const userSelect = document.getElementById('user-select');
    const scanS3Btn = document.getElementById('scan-s3-btn');
    const scanWebdavBtn = document.getElementById('scan-webdav-btn');
    const scanLog = document.getElementById('scan-log');

    // 1. 加载用户列表 (使用 axios，因为是一次性请求)
    async function loadUsers() {
        try {
            // 注意：这里复用了 admin API，请确保 worker.js 中已包含此接口
            const response = await axios.get('/api/admin/users');
            
            userSelect.innerHTML = '<option value="" disabled selected>-- 请选择目标用户 --</option>';
            
            if (Array.isArray(response.data)) {
                response.data.forEach(user => {
                    const option = document.createElement('option');
                    option.value = user.id;
                    option.textContent = user.username;
                    userSelect.appendChild(option);
                });
            } else {
                throw new Error('返回的用户数据格式不正确');
            }
        } catch (error) {
            logMessage('无法加载用户列表: ' + (error.response?.data?.message || error.message), 'error');
        }
    }

    // 2. 日志显示辅助函数
    function logMessage(message, type = 'info') {
        // 特殊指令：清空日志
        if (message === '__CLEAR__') {
            scanLog.innerHTML = '';
            return;
        }

        const line = document.createElement('div');
        
        // 简单的日志级别判断逻辑
        if (message.includes('Error') || message.includes('失败') || message.includes('Failed')) {
            type = 'error';
        } else if (message.includes('导入') || message.includes('完成') || message.includes('Success')) {
            type = 'success';
        } else if (message.includes('跳过')) {
            type = 'warn';
        }
        
        line.className = `log-${type}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        
        scanLog.appendChild(line);
        // 自动滚动到底部
        scanLog.scrollTop = scanLog.scrollHeight;
    }

    function disableControls(disabled) {
        if (scanS3Btn) scanS3Btn.disabled = disabled;
        if (scanWebdavBtn) scanWebdavBtn.disabled = disabled;
        userSelect.disabled = disabled;
        
        // 更新按钮状态文字
        if (disabled) {
            if (scanS3Btn) scanS3Btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 扫描中...';
            if (scanWebdavBtn) scanWebdavBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 扫描中...';
        } else {
            if (scanS3Btn) scanS3Btn.innerHTML = '<i class="fas fa-cloud"></i> 扫描 S3 / R2';
            if (scanWebdavBtn) scanWebdavBtn.innerHTML = '<i class="fas fa-server"></i> 扫描 WebDAV';
        }
    }

    // 3. 核心扫描逻辑 (使用 Fetch API 处理流式响应)
    async function startScan(storageType) {
        const userId = userSelect.value;
        if (!userId) {
            alert('请先选择一个要导入的用户！');
            return;
        }

        const confirmMsg = storageType === 's3' 
            ? "确定要扫描 S3/R2 存储吗？\n这可能需要一些时间，请勿关闭页面。" 
            : "确定要扫描 WebDAV 存储吗？\n请确保 WebDAV 服务响应正常。";
            
        if (!confirm(confirmMsg)) return;
        
        logMessage('__CLEAR__');
        logMessage(`正在初始化 ${storageType.toUpperCase()} 扫描进程...`, 'info');
        disableControls(true);

        try {
            const response = await fetch('/api/admin/scan', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                // 关键：传递 storageType 给后端
                body: JSON.stringify({ 
                    userId: userId, 
                    storageType: storageType 
                })
            });

            // 处理 HTTP 错误状态
            if (!response.ok) {
                let errMsg = response.statusText;
                try {
                    const errJson = await response.json();
                    errMsg = errJson.message || errMsg;
                } catch(e) {}
                throw new Error(`服务器返回错误 (${response.status}): ${errMsg}`);
            }

            // 处理流式响应 (Streams API)
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                // 解码二进制流
                const chunk = decoder.decode(value, { stream: true });
                // 按换行符分割日志
                const lines = chunk.split('\n');
                
                lines.forEach(line => {
                    if (line.trim()) {
                        logMessage(line);
                    }
                });
            }
            
            logMessage('扫描会话结束。', 'success');

        } catch (error) {
            logMessage('发生严重错误: ' + error.message, 'error');
            console.error(error);
        } finally {
            disableControls(false);
        }
    }

    // 4. 事件绑定
    if (scanS3Btn) {
        scanS3Btn.addEventListener('click', () => startScan('s3'));
    }
    
    if (scanWebdavBtn) {
        scanWebdavBtn.addEventListener('click', () => startScan('webdav'));
    }

    // 初始化加载
    loadUsers();
});
