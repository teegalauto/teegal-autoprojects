/**
 * 本地敏感字段加密盒（AES-256-GCM）
 *
 * 🔥 背景：user-models.json 等本地配置文件含明文 apiKey/refreshToken，
 * LLM 通过 shell/文件工具可翻读用户数据目录 → 明文 key 直接进上下文泄露。
 *
 * 设计：
 * - 密钥 = 本机首次随机生成（randomBytes(32)），存 {appDataDir}/data/.sk（0600）
 *   不内置源码常量（源码可被 LLM 读 app.asar.unpacked 看到）
 * - 密文格式 enc1:{iv}.{tag}.{ct}（base64），带前缀便于识别与版本演进
 * - decryptSecret 对非 enc1: 前缀原样返回 → 旧明文文件无缝兼容，
 *   下次 saveToFile 自动升级为密文（无迁移脚本）
 * - 防护边界：挡"无意识翻读泄露"（主要实际威胁：key 进对话记录/云端）；
 *   同机蓄意提取（LLM 主动读 .sk + 写解密代码）不在本层防线内，属平台行为约束层
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { resolveAppDataDir } from './appDataDir';

const SECRET_KEY_FILENAME = '.sk';
const ENC_PREFIX = 'enc1:';

let cachedKey: Buffer | null = null;

/** 获取（或首次生成）本机加密密钥 */
function getSecretKey(): Buffer {
  if (cachedKey) return cachedKey;

  const dir = path.join(resolveAppDataDir(), 'data');
  const keyPath = path.join(dir, SECRET_KEY_FILENAME);

  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, 'utf-8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      cachedKey = Buffer.from(hex, 'hex');
      return cachedKey;
    }
    console.warn('[SECRET-BOX] 密钥文件格式异常，重新生成（已加密数据将不可解）');
  }

  fs.mkdirSync(dir, { recursive: true });
  cachedKey = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyPath, cachedKey.toString('hex'), { mode: 0o600 });
    if (process.platform === 'win32') {
      try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows 忽略 chmod 失败 */ }
    }
  } catch (e: any) {
    console.error('[SECRET-BOX] 密钥文件写入失败:', e.message);
  }
  return cachedKey;
}

/** 加密敏感值（空值原样返回；结果带 enc1: 前缀） */
export function encryptSecret(plain: string | undefined): string | undefined {
  if (!plain) return plain;
  if (plain.startsWith(ENC_PREFIX)) return plain; // 已加密，防双重加密
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getSecretKey(), iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${ENC_PREFIX}${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
  } catch (e: any) {
    console.error('[SECRET-BOX] 加密失败（保留明文，不影响功能）:', e.message);
    return plain;
  }
}

/** 解密敏感值（空值/非 enc1: 前缀 → 原样返回，兼容旧明文） */
export function decryptSecret(value: string | undefined): string | undefined {
  if (!value || !value.startsWith(ENC_PREFIX)) return value;
  try {
    const [ivB64, tagB64, ctB64] = value.slice(ENC_PREFIX.length).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getSecretKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (e: any) {
    console.error('[SECRET-BOX] 解密失败（密钥可能已更换）:', e.message);
    return ''; // 解不开的密文按空值处理，调用方走"未配置"分支
  }
}
