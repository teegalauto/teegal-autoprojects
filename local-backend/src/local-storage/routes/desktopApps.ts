/**
 * Desktop Apps API 路由
 */

import express from 'express';
import { desktopAppDAO } from '../dao';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

/**
 * GET /api/local/desktop-apps
 * 获取用户的所有桌面应用
 */
router.get('/', (req, res) => {
  try {
    const userId = req.query.user_id as string;
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    // 🔥 可选类型过滤（UI 筛选）：normal=普通项目，system_base=基础项目
    const appType = req.query.app_type as 'normal' | 'system_base' | undefined;
    // 🔥 base_first=1：基础项目置顶（仅供 LLM 的 list_projects，防项目太多被淹没）
    const baseFirst = req.query.base_first === '1' || req.query.base_first === 'true';

    if (!userId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const apps = desktopAppDAO.getByUserId(userId, limit, offset, appType, baseFirst);
    res.json({ data: apps });
  } catch (error: any) {
    console.error('❌ 获取桌面应用列表失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/local/desktop-apps/project-memory?user_id=&project_id=&query=&limit=
 * 🔥 查询项目记忆：无 query 时间倒序翻档案；有 query 打分×时间衰减定向查
 * （必须在 GET /:id 之前注册，否则被动态路由捕获）
 */
router.get('/project-memory', (req, res) => {
  try {
    const { user_id, project_id, query, limit } = req.query as any;
    if (!user_id || !project_id) {
      return res.status(400).json({ error: 'user_id 与 project_id 必填' });
    }
    const memories = desktopAppDAO.queryProjectMemory({
      userId: user_id,
      projectId: project_id,
      query,
      limit: limit ? parseInt(limit, 10) : 5,
    });
    res.json({ data: memories });
  } catch (error: any) {
    console.error('❌ 查询项目记忆失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/local/desktop-apps/:id
 * 获取单个桌面应用
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const app = desktopAppDAO.getById(id);

    if (!app) {
      return res.status(404).json({ error: 'Desktop app not found' });
    }

    res.json({ data: app });
  } catch (error: any) {
    console.error('❌ 获取桌面应用失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/local/desktop-apps
 * 创建新桌面应用
 */
router.post('/', (req, res) => {
  try {
    const {
      id, name, description, code, config, preview, user_id,
      env_vars, current_code, previous_code,
      definition, interface_spec, market_status, market_app_id,
      project_type
    } = req.body;

    if (!name || !user_id) {
      return res.status(400).json({ error: 'name and user_id are required' });
    }

    // 🔥 不再设置默认代码，代码由文件树管理
    const appData = {
      id: id || uuidv4(),
      name,
      description: description || null,
      code: code || '',
      config: config || {},
      preview: preview || null,
      user_id,
      current_code: current_code || '',
      previous_code: previous_code || null,
      env_vars: env_vars || {},
      // 🔥 App 市场相关字段
      definition: definition || null,
      interface_spec: interface_spec || null,
      market_status: market_status || 'local',
      market_app_id: market_app_id || null,
      // 🔥 模型可视化数据
      model_visualization: null,
      // 🔥 导入项目路径（默认 null，使用 userDataPath/apps/{appId}）
      code_path: null,
      // 🔥 项目类型（普通创建走 normal，基础项目由 ensure 接口单独创建）
      app_type: 'normal' as const,
      // 🔥 项目场景类型（LLM 创建时选择）
      project_type: project_type || null,
    };

    const app = desktopAppDAO.create(appData);

    res.status(201).json({ data: app });
  } catch (error: any) {
    console.error('创建桌面应用失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/local/desktop-apps/:id
 * 更新桌面应用
 * 🔥 出门摆摊(outworking)状态的应用禁止修改（但允许修改 market_status 进行下班操作）
 */
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // 🔥 检查应用是否存在
    const existingApp = desktopAppDAO.getById(id);
    if (!existingApp) {
      return res.status(404).json({ error: 'Desktop app not found' });
    }

    // 🔥 检查是否处于出门工作状态
    // 允许修改 market_status（下班操作），但禁止修改其他字段
    if (existingApp.market_status === 'outworking') {
      const allowedFields = ['market_status'];
      const updateKeys = Object.keys(updates);
      const hasDisallowedFields = updateKeys.some(key => !allowedFields.includes(key));
      
      if (hasDisallowedFields) {
        return res.status(403).json({
          error: '🏪 该应用已出门工作，禁止修改。如需修改，请先下架应用。',
          code: 'APP_OUTWORKING_LOCKED',
          market_status: 'outworking',
        });
      }
    }

    const app = desktopAppDAO.update(id, updates);

    if (!app) {
      return res.status(404).json({ error: 'Desktop app not found' });
    }

    res.json({ data: app });
  } catch (error: any) {
    console.error('❌ 更新桌面应用失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/local/desktop-apps/:id
 * 删除桌面应用
 * 🔥 出门摆摊(outgoing)状态的应用禁止删除
 */
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;

    // 🔥 检查应用是否存在
    const existingApp = desktopAppDAO.getById(id);
    if (!existingApp) {
      return res.status(404).json({ error: 'Desktop app not found' });
    }

    // 🔥 检查是否处于出门工作状态
    if (existingApp.market_status === 'outworking') {
      return res.status(403).json({
        error: '🏪 该应用已出门工作，禁止删除。如需删除，请先下架应用。',
        code: 'APP_OUTWORKING_LOCKED',
        market_status: 'outworking',
      });
    }

    // 🔥 基础项目不可删除
    if (existingApp.app_type === 'system_base') {
      return res.status(403).json({
        error: '基础项目不可删除，只能修改其中的工具文件。',
        code: 'BASE_PROJECT_LOCKED',
      });
    }

    const success = desktopAppDAO.delete(id);

    if (!success) {
      return res.status(404).json({ error: 'Desktop app not found' });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('❌ 删除桌面应用失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/local/desktop-apps/base-project/ensure
 * 🔥 确保用户拥有基础项目（不存在则创建），返回基础项目记录
 */
router.post('/base-project/ensure', (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }
    // 🔥 标记本次是否新建：前端据此广播 app_created，让已打开的项目面板实时补上基础项目卡片
    //（面板首次拉取早于基础项目创建，之后 userId 不变不会自动重拉）
    const existed = !!desktopAppDAO.findUserBaseProject(user_id);
    const app = desktopAppDAO.ensureBaseProject(user_id);
    res.json({ data: app, created: !existed });
  } catch (error: any) {
    console.error('❌ 确保基础项目失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/local/desktop-apps/boot-project/ensure
 * 🔥 确保 BootCode 项目（开源源码，base-bootcode）存在，返回项目记录
 */
router.post('/boot-project/ensure', (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }
    const existed = !!desktopAppDAO.findUserBootProject(user_id);
    const app = desktopAppDAO.ensureBootProject(user_id);
    res.json({ data: app, created: !existed });
  } catch (error: any) {
    console.error('❌ 确保 BootCode 项目失败:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/local/desktop-apps/project-memory/save
 * 🔥 保存项目记忆（ReAct 任务完成收尾时由客户端触发；多项目任务每个归属项目存一条）
 */
router.post('/project-memory/save', (req, res) => {
  try {
    const { user_id, project_ids, user_query, write_note, conversation_id } = req.body;
    if (!user_id || !Array.isArray(project_ids) || project_ids.length === 0) {
      return res.status(400).json({ error: 'user_id 与 project_ids 必填' });
    }
    for (const pid of project_ids) {
      desktopAppDAO.saveProjectMemory({
        projectId: pid,
        userId: user_id,
        userQuery: user_query,
        writeNote: write_note,
        conversationId: conversation_id,
      });
    }
    res.json({ success: true, saved: project_ids.length });
  } catch (error: any) {
    console.error('❌ 保存项目记忆失败:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
