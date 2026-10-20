/**
 * 🔥 BOM 自愈检查（打包链第一步）
 *
 * 背景：历史版本 Teegal 的 app-code:save 曾给所有保存的文件写 UTF-8 BOM，
 * package.json 一旦带 BOM，vite/tsc/PostCSS 读取时 JSON.parse 全部炸掉
 * （"Unexpected token '﻿'"）。本脚本扫描 git 跟踪的所有 .json，发现 BOM 直接剥离。
 *
 * 用法：node scripts/check-json-bom.js （剥离成功 exit 0；只报告不阻断打包）
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 收集 git 跟踪的 json + 根目录关键 json（git 未跟踪但打包必读的兜底） */
function collectJsonFiles() {
  const files = new Set();
  try {
    const tracked = execSync('git ls-files "*.json"', { cwd: ROOT, encoding: 'utf8' });
    for (const f of tracked.split(/\r?\n/)) {
      if (f.trim()) files.add(path.join(ROOT, f.trim()));
    }
  } catch {
    // git 不可用时至少扫根目录
  }
  for (const f of ['package.json', 'tsconfig.json']) {
    files.add(path.join(ROOT, f));
  }
  return [...files].filter(f => fs.existsSync(f));
}

function hasBom(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(3);
  const bytes = fs.readSync(fd, buf, 0, 3, 0);
  fs.closeSync(fd);
  return bytes === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

function stripBom(file) {
  // 用原始字节去头（保留文件其余内容零改动，避免任何编码转换风险）
  const raw = fs.readFileSync(file);
  fs.writeFileSync(file, raw.subarray(3));
}

const dirty = collectJsonFiles().filter(hasBom);
if (dirty.length === 0) {
  console.log('✅ [BOM-CHECK] 所有 json 无 BOM');
} else {
  console.warn(`⚠️ [BOM-CHECK] 发现 ${dirty.length} 个带 BOM 的 json，已自动剥离：`);
  for (const f of dirty) {
    stripBom(f);
    console.warn(`   🧹 ${path.relative(ROOT, f)}`);
  }
  console.warn('   （来源：历史版本 app-code:save 写 BOM；主进程已改为标准 UTF-8，不会再新增）');
}
