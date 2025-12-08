// public/shares.js

document.addEventListener('DOMContentLoaded', () => {
    const sharesTable = document.getElementById('sharesTable');
    const sharesTableBody = document.getElementById('sharesTableBody');
    const loadingMessage = document.getElementById('loading-message');

    // 初始化加载
    loadShares();

    async function loadShares() {
        try {
            // 注意：需要在 worker.js 中补充 GET /api/shares 路由
            const res = await axios.get('/api/shares');
            const shares = res.data;

            if (shares.length === 0) {
                loadingMessage.textContent = '当前没有活跃的分享链接。';
                sharesTable.style.display = 'none';
                return;
            }

            loadingMessage.style.display = 'none';
            sharesTable.style.display = 'table';
            sharesTableBody.innerHTML = '';

            shares.forEach(item => {
                const tr = document.createElement('tr');
                
                // 构造完整的分享链接
                const shareLink = `${window.location.origin}/share/view/${item.type}/${item.share_token}`;
                
                // 格式化过期时间
                let expiresText = '永久有效';
                if (item.share_expires_at) {
                    const expiresDate = new Date(item.share_expires_at);
                    if (expiresDate < new Date()) {
                        expiresText = '<span style="color:red;">已过期</span>';
                    } else {
                        expiresText = expiresDate.toLocaleString();
                    }
                }

                const icon = item.type === 'folder' ? '<i class="fas fa-folder" style="color:#fbc02d;"></i>' : '<i class="fas fa-file" style="color:#007bff;"></i>';
                
                // 定位按钮
                const locationBtn = item.encrypted_parent_id 
                    ? `<a href="/view/${item.encrypted_parent_id}" class="locate-btn upload-link-btn" style="background-color: #17a2b8; color: white; padding: 5px 10px; font-size: 12px; text-decoration: none; margin-right: 5px; margin-top: 0;"><i class="fas fa-folder-open"></i> 定位</a>`
                    : '<span style="color:#ccc;">根目录</span>';

                tr.innerHTML = `
                    <td>
                        <div style="display:flex; align-items:center;">
                            ${icon} <span style="margin-left:8px;">${escapeHtml(item.name)}</span>
                        </div>
                    </td>
                    <td>
                        <div class="link-container">
                            <input type="text" value="${shareLink}" readonly onclick="this.select()" style="width: 200px; padding: 4px;">
                            <button class="copy-btn upload-link-btn" data-link="${shareLink}" style="padding: 4px 8px; font-size: 12px; margin-top: 0;">复制</button>
                        </div>
                    </td>
                    <td>${expiresText}</td>
                    <td>${locationBtn}</td>
                    <td>
                        <button class="cancel-share-btn upload-link-btn" data-id="${item.id || item.message_id}" data-type="${item.type}" style="background-color: #dc3545; color: white; padding: 5px 10px; font-size: 12px; margin-top: 0;">
                            <i class="fas fa-times"></i> 取消分享
                        </button>
                    </td>
                `;
                sharesTableBody.appendChild(tr);
            });

        } catch (error) {
            loadingMessage.textContent = '加载失败: ' + (error.response?.data?.message || error.message);
            loadingMessage.style.color = 'red';
        }
    }

    // 事件委托处理按钮点击
    sharesTableBody.addEventListener('click', async (e) => {
        const target = e.target.closest('button');
        if (!target) return;

        // 复制链接
        if (target.classList.contains('copy-btn')) {
            const link = target.dataset.link;
            try {
                await navigator.clipboard.writeText(link);
                const originalText = target.textContent;
                target.textContent = '已复制';
                target.style.backgroundColor = '#28a745';
                setTimeout(() => {
                    target.textContent = originalText;
                    target.style.backgroundColor = '';
                }, 2000);
            } catch (err) {
                alert('复制失败，请手动复制');
            }
        }

        // 取消分享
        if (target.classList.contains('cancel-share-btn')) {
            if (!confirm('确定要取消此分享吗？链接将立即失效。')) return;

            const id = target.dataset.id;
            const type = target.dataset.type;

            try {
                // 注意：需要在 worker.js 中补充 POST /api/share/cancel 路由
                await axios.post('/api/share/cancel', { itemId: id, itemType: type });
                loadShares(); // 重新加载列表
            } catch (error) {
                alert('操作失败: ' + (error.response?.data?.message || error.message));
            }
        }
    });

    function escapeHtml(text) {
        if (!text) return '';
        return text.replace(/[&<>"']/g, m => ({ 
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' 
        })[m]);
    }
});
