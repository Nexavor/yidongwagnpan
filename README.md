📖 CFileManager - GitHub 集成部署指南
本教程将引导您通过连接 GitHub 仓库的方式，将项目部署到 Cloudflare Pages。

📋 核心流程概览
Fork 代码 到您的 GitHub。

创建 Pages 项目 并连接 GitHub。

配置构建命令 (关键)。

手动创建资源 (KV & D1)。

绑定资源与变量。

初始化系统。

🚀 第一步：Fork 项目到您的 GitHub
登录您的 GitHub 账号。

访问本项目仓库（例如 https://github.com/Limkon/CFileManger）。

点击右上角的 Fork 按钮，将代码复制到您自己的账号下。

☁️ 第二步：在 Cloudflare 创建项目
登录 Cloudflare Dashboard。

进入 Workers & Pages 页面。

点击 Create application -> 切换到 Pages 标签 -> 点击 Connect to Git。

选择您的 GitHub 账号，并选中刚才 Fork 的 CFileManger 仓库。

点击 Begin setup。

⚙️ 第三步：配置构建设置 (至关重要)
在 "Set up builds and deployments" 页面，请严格按照以下填写，否则后端无法启动：

Project name: 自定义项目名（如 netdrv）。

Production branch: main (或您的默认分支)。

Framework preset: 选择 None。

Build command (构建命令):

Bash

npm install && npm run build
⚠️ 注意：必须包含 npm run build，否则只会部署静态页面，没有后端功能！

Build output directory (构建输出目录):

Plaintext

public
点击 Save and Deploy。 (此时第一次部署可能会成功，但网站无法使用，因为还没绑定数据库。请继续下一步。)

💾 第四步：手动创建存储资源
由于是云端部署，我们需要在 Cloudflare 后台手动创建 KV 和 D1。

保持在 Cloudflare 后台，打开左侧菜单的 Workers & Pages。

创建 KV:

点击 KV -> Create a namespace。

名称输入：netdrv-kv -> 点击 Add。

创建 D1 数据库:

点击 D1 SQL Database -> Create。

名称输入：netfile-db -> 点击 Create。

🔗 第五步：绑定资源与环境变量 (必须操作)
回到您的 Pages 项目页面（Workers & Pages -> 点击您的项目名）。

点击顶部的 Settings (设置) 选项卡。

点击左侧的 Functions (函数)。

1. 绑定 KV 和 D1
向下滚动找到 "R2, D1, KV binding" 区域：

KV Namespace Bindings:

点击 Add binding。

Variable name: CONFIG_KV (必须完全一致)

KV Namespace: 选择刚才创建的 netdrv-kv。

D1 Database Bindings:

点击 Add binding。

Variable name: DB (必须完全一致)

Database: 选择刚才创建的 netfile-db。

2. 检查兼容性标志
在同一页面的 Compatibility Flags 区域，确保包含：

nodejs_compat

(如果没有，请手动添加并保存)

3. 设置密钥
点击左侧的 Environment variables (环境变量)：

点击 Add variable。

Variable name: SESSION_SECRET

Value: 输入一个随机的长字符串（用于加密）。

(可选) 添加 RESET_TOKEN 用于重置密码。

最后，务必点击页面底部的 Save 保存所有设置！

🔄 第六步：重新部署 (让配置生效)
修改了绑定配置后，必须重新部署一次才能生效。

在项目页面，点击 Deployments (部署) 选项卡。

点击 Create deployment (或者在最新的一次部署右侧点击三个点 -> Retry deployment)。

等待部署完成（状态变为 Success）。

📦 第七步：初始化与使用
访问初始化页面： 在浏览器打开：https://您的项目名.pages.dev/setup (注意：是 /setup，不是首页)

确认初始化： 如果配置正确，页面会显示 "✅ 初始化成功"。

登录：

访问首页 /。

默认账号：admin

默认密码：admin

❓ 常见错误排查
错误：访问 /setup 显示 404

原因：构建命令写错了，没生成 _worker.js。

解决：回到 Settings -> Build，将命令改为 npm install && npm run build，然后重新部署。

错误：访问 /setup 显示 500 (Internal Server Error)

原因：资源没绑定好，或者兼容性标志没加。

解决：检查第五步，确保 CONFIG_KV 和 DB 绑定正确，且有 nodejs_compat 标志。

错误：页面无限刷新 / 重定向

原因：代码版本过旧。

解决：确保您 Fork 的是包含最新 worker.js 修复（去除 .html 后缀逻辑）的版本。
