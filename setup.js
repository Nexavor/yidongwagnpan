const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 配置项目名称（用于创建资源时的名称）
const KV_NAME = 'netdrv-kv';
const DB_NAME = 'netfile-db'; // 需与 wrangler.toml 中的 database_name 保持一致
const TOML_PATH = path.join(__dirname, 'wrangler.toml');

function runCommand(command) {
    try {
        return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
        return null;
    }
}

function getOrCreateKV() {
    console.log(`🔍 正在检查 KV 命名空间: ${KV_NAME}...`);
    let listJson = runCommand('npx wrangler kv:namespace list --json');
    let list = JSON.parse(listJson || '[]');
    let target = list.find(item => item.title === KV_NAME);

    if (target) {
        console.log(`✅ 找到现有 KV (ID: ${target.id})`);
        return target.id;
    }

    console.log(`✨ 未找到，正在创建 KV: ${KV_NAME}...`);
    let createOutput = runCommand(`npx wrangler kv:namespace create "${KV_NAME}"`);
    // 创建后重新获取列表以确保拿到 ID
    listJson = runCommand('npx wrangler kv:namespace list --json');
    list = JSON.parse(listJson || '[]');
    target = list.find(item => item.title === KV_NAME);
    
    if (target) {
        console.log(`✅ 创建成功 (ID: ${target.id})`);
        return target.id;
    }
    throw new Error('无法创建 KV 命名空间，请检查 Wrangler 登录状态。');
}

function getOrCreateD1() {
    console.log(`🔍 正在检查 D1 数据库: ${DB_NAME}...`);
    let listJson = runCommand('npx wrangler d1 list --json');
    let list = JSON.parse(listJson || '[]');
    let target = list.find(item => item.name === DB_NAME);

    if (target) {
        console.log(`✅ 找到现有 D1 (ID: ${target.uuid})`);
        return target.uuid;
    }

    console.log(`✨ 未找到，正在创建 D1: ${DB_NAME}...`);
    runCommand(`npx wrangler d1 create "${DB_NAME}"`);
    // 创建后重新获取
    listJson = runCommand('npx wrangler d1 list --json');
    list = JSON.parse(listJson || '[]');
    target = list.find(item => item.name === DB_NAME);

    if (target) {
        console.log(`✅ 创建成功 (ID: ${target.uuid})`);
        return target.uuid;
    }
    throw new Error('无法创建 D1 数据库。');
}

function updateToml(kvId, d1Id) {
    console.log('📝 正在更新 wrangler.toml...');
    let content = fs.readFileSync(TOML_PATH, 'utf8');

    // 使用正则替换 ID
    // 替换 KV ID (匹配 id = "..." 在 [[kv_namespaces]] 下的情况，简单替换即可)
    // 注意：这里假设文件中只有一个 KV 和一个 D1，直接替换 ID 字符串可能不准确，
    // 最好的方式是匹配 binding 上下文，但在简单场景下，直接正则替换特定 binding 下的 id 字段。
    
    // 替换 KV
    const kvRegex = /((?:\[\[kv_namespaces\]\])[\s\S]*?binding\s*=\s*"CONFIG_KV"[\s\S]*?id\s*=\s*")([^"]+)(")/;
    if (content.match(kvRegex)) {
        content = content.replace(kvRegex, `$1${kvId}$3`);
    } else {
        // 如果找不到可能是被注释了或者格式不对，尝试直接替换占位符
        console.warn('⚠️  警告: 未能通过正则精确匹配到 CONFIG_KV 配置块，尝试全局替换 KV ID...');
    }

    // 替换 D1
    const d1Regex = /((?:\[\[d1_databases\]\])[\s\S]*?binding\s*=\s*"DB"[\s\S]*?database_id\s*=\s*")([^"]+)(")/;
    if (content.match(d1Regex)) {
        content = content.replace(d1Regex, `$1${d1Id}$3`);
    } else {
        console.warn('⚠️  警告: 未能通过正则精确匹配到 DB 配置块。');
    }

    fs.writeFileSync(TOML_PATH, content);
    console.log('🎉 wrangler.toml 更新完成！');
}

// 主流程
try {
    const kvId = getOrCreateKV();
    const d1Id = getOrCreateD1();
    updateToml(kvId, d1Id);
    console.log('\n✅ 配置就绪，您可以运行 "npm run deploy" 部署了！');
} catch (error) {
    console.error('\n❌ 发生错误:', error.message);
    process.exit(1);
}
