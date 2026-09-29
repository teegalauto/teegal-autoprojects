/**
 * Credentials API 路由
 * 🔥 纯 CRUD：存取 encrypted_value（已是密文）
 * 加密/解密由 Electron 主进程的 safeStorage 负责，后端不感知明文
 */

import express from 'express';
import { credentialDAO } from '../dao';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

/**
 * GET /api/local/credentials
 * 获取用户的所有凭据（包含 encrypted_value，由 IPC 层解密后返回给 UI）
 */
router.get('/', (req, res) => {
  try {
    const userId = req.query.user_id as string;

    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const credentials = credentialDAO.getByUserId(userId);
    res.json({ data: credentials });
  } catch (error: any) {
    console.error('❌ 获取凭据列表失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/local/credentials/:id
 * 获取单个凭据（包含 encrypted_value）
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const credential = credentialDAO.getById(id);

    if (!credential) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    res.json({ data: credential });
  } catch (error: any) {
    console.error('❌ 获取凭据失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/local/credentials/by-name/:name
 * 根据名称获取凭据（用于 userpc_shell 注入环境变量）
 * 🔥 需要 user_id 查询参数
 */
router.get('/by-name/:name', (req, res) => {
  try {
    const { name } = req.params;
    const userId = req.query.user_id as string;

    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const credential = credentialDAO.getByName(name, userId);

    if (!credential) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    res.json({ data: credential });
  } catch (error: any) {
    console.error('❌ 根据名称获取凭据失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/local/credentials
 * 创建新凭据
 * 🔥 encrypted_value 应已由 Electron 主进程加密
 */
router.post('/', (req, res) => {
  try {
    const { id, user_id, name, type, description, env_var, encrypted_value, source, provider } = req.body;

    // 🔥 param 型允许空值（如 updateSourceUrl 留空=官方源），其他类型要求 encrypted_value 非空
    // platform 型凭据 encrypted_value 恒为空串（值由租约服务运行时下发，不落库）
    if (!user_id || !name || !env_var) {
      return res.status(400).json({ error: 'user_id, name, env_var are required' });
    }
    if (type !== 'param' && !encrypted_value && source !== 'platform') {
      return res.status(400).json({ error: 'encrypted_value is required for env types' });
    }

    // 🔥 检查名称是否已存在（同一用户下名称唯一）
    const existing = credentialDAO.getByName(name, user_id);
    if (existing) {
      return res.status(409).json({ error: `凭据名称 "${name}" 已存在`, code: 'CREDENTIAL_NAME_DUPLICATE' });
    }

    const credentialData = {
      id: id || uuidv4(),
      user_id,
      name,
      type: type || 'env_var',
      description: description || '',
      env_var,
      encrypted_value: encrypted_value || '',
      source: source === 'platform' ? 'platform' : 'user',
      provider: provider || undefined,
    };

    const credential = credentialDAO.create(credentialData);

    res.status(201).json({ data: credential });
  } catch (error: any) {
    console.error('❌ 创建凭据失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/local/credentials/:id
 * 更新凭据
 * 🔥 encrypted_value（如提供）应已由 Electron 主进程加密
 */
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // 🔥 检查凭据是否存在
    const existing = credentialDAO.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    // 🔥 如果更新 name，检查名称冲突
    if (updates.name && updates.name !== existing.name) {
      const conflict = credentialDAO.getByName(updates.name, existing.user_id);
      if (conflict && conflict.id !== id) {
        return res.status(409).json({ error: `凭据名称 "${updates.name}" 已存在`, code: 'CREDENTIAL_NAME_DUPLICATE' });
      }
    }

    const success = credentialDAO.update(id, updates);

    if (!success) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    const updated = credentialDAO.getById(id);
    res.json({ data: updated });
  } catch (error: any) {
    console.error('❌ 更新凭据失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/local/credentials/:id
 * 删除凭据
 */
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;

    const existing = credentialDAO.getById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    const success = credentialDAO.delete(id);

    if (!success) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('❌ 删除凭据失败:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
