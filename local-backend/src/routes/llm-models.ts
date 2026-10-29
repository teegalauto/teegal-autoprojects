/**
 * LLM 模型管理 API 路由（多用户版本）
 *
 * 所有接口都支持 userId 参数，用于区分不同用户的配置
 * 存储位置：.teegal/user-{userId}/user-models.json
 */

import express from 'express';
import { userModelRegistry, SimpleUserModel, SearchProviderConfig, getDefaultSystemModels } from '../utils/llm/UserModelRegistry';
import { modelBindingRegistry } from '../utils/llm/ModelBindingRegistry';
import { tokenUsageService } from '../utils/TokenUsageService';

const router = express.Router();

// 从请求中获取 userId（支持 query 参数或 header）
function getUserId(req: express.Request): string | undefined {
  const userId = req.query.userId as string || req.headers['x-user-id'] as string;
  // 返回 userId 或 undefined（不返回 'default'）
  return userId || undefined;
}

// ========== 用户模型管理 API ==========

// 🔥 启动身份自愈：后端重启后 currentUserId 为空，GPU/租赁转发云端全部报
//    "未登录...且 GPU_WORKER_SECRET 未配置" → 502 → 弹窗空白（聊天走渲染层配置不受
//    影响，极难关联定位）。渲染层启动必调 GET /user-models 与 /all，顺手恢复身份
function ensureCurrentUser(userId: string | undefined): void {
  if (userId && userModelRegistry.getCurrentUserId() !== userId) {
    userModelRegistry.setCurrentUser(userId);
    console.log(`[LLM-MODELS-API] 已恢复当前用户身份: ${userId}`);
  }
}

// 🔥 兼容前端调用的 /all 路由（返回所有模型，包括组织和助手模型）
router.get('/all', (req, res) => {
  try {
    const userId = getUserId(req);
    ensureCurrentUser(userId);
    console.log(`[LLM-MODELS-API] 获取所有模型, userId: ${userId}`);

    // 获取用户自定义模型
    const userModels = userModelRegistry.getAllUserModels(userId);

    // 🔥 转换为前端期望的格式（organization 和 assistant 分类）
    // 用户自定义模型作为 organization 模型
    const organizationModels = userModels.map(model => ({
      id: model.id,
      name: model.name,
      provider: model.provider || 'custom',
      modelId: model.modelId,
      description: `${model.provider || 'custom'} 模型`,
      contextWindow: 4096,
      maxTokens: 2048,
      enabled: true,
    }));

    // 🔥 使用 UserModelRegistry 中的默认系统模型作为 assistant 模型
    const defaultSystemModels = getDefaultSystemModels();
    const assistantModels = defaultSystemModels.map(model => ({
      id: model.id,
      name: model.name,
      provider: model.provider || 'dashscope',
      modelId: model.modelId,
      description: `${model.provider || 'dashscope'} 系统模型`,
      contextWindow: 4096,
      maxTokens: 2048,
      enabled: true,
    }));

    res.json({
      success: true,
      data: {
        organization: {
          majorCategory: 'organization',
          subCategories: ['custom'],
          models: organizationModels,
        },
        assistant: {
          majorCategory: 'assistant',
          subCategories: ['vision', 'speech'],
          models: assistantModels,
        },
      },
    });
  } catch (error) {
    console.error('[LLM-MODELS-API] 获取所有模型失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch all models',
    });
  }
});

router.get('/user-models', (req, res) => {
  try {
    const userId = getUserId(req);
    ensureCurrentUser(userId);
    console.log(`[LLM-MODELS-API] 获取用户模型, userId: ${userId}`);

    const models = userModelRegistry.getAllUserModels(userId);

    res.json({
      success: true,
      models: models,
    });
  } catch (error) {
    console.error('[LLM-MODELS-API] 获取用户模型失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user models',
    });
  }
});

router.post('/user-models', (req, res) => {
  try {
    const userId = getUserId(req);
    const model: SimpleUserModel = req.body;

    if (!model.id || !model.name || !model.modelId || !model.url) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: id, name, modelId, url',
      });
    }

    console.log(`[LLM-MODELS-API] 保存用户模型, userId: ${userId}, modelId: ${model.id}`);
    const success = userModelRegistry.addOrUpdateModel(model, userId);

    if (success) {
      res.json({
        success: true,
        model: model,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to save user model',
      });
    }
  } catch (error) {
    console.error('[LLM-MODELS-API] 保存用户模型失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save user model',
    });
  }
});

router.delete('/user-models/:id', (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    console.log(`[LLM-MODELS-API] 删除用户模型, userId: ${userId}, modelId: ${id}`);
    const success = userModelRegistry.deleteModel(id, userId);

    if (success) {
      res.json({
        success: true,
      });
    } else {
      res.status(404).json({
        success: false,
        error: `Model not found: ${id}`,
      });
    }
  } catch (error) {
    console.error('[LLM-MODELS-API] 删除用户模型失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete user model',
    });
  }
});

// ========== 绑定配置管理 API ==========

router.get('/bindings', (req, res) => {
  try {
    const userId = getUserId(req);
    console.log(`[LLM-MODELS-API] 获取绑定配置, userId: ${userId}`);

    const bindings = modelBindingRegistry.getAllBindings(userId);

    res.json({
      success: true,
      bindings: bindings,
    });
  } catch (error) {
    console.error('[LLM-MODELS-API] 获取绑定配置失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch bindings',
    });
  }
});

router.post('/bindings', (req, res) => {
  try {
    const userId = getUserId(req);
    const { bindings } = req.body;

    if (!bindings || typeof bindings !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: bindings',
      });
    }

    console.log(`[LLM-MODELS-API] 保存绑定配置, userId: ${userId}`);
    const success = modelBindingRegistry.setMultipleBindings(bindings, userId);

    if (success) {
      res.json({
        success: true,
        bindings: modelBindingRegistry.getAllBindings(userId),
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to save bindings',
      });
    }
  } catch (error) {
    console.error('[LLM-MODELS-API] 保存绑定配置失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save bindings',
    });
  }
});

// ========== 搜索源管理 API ==========

router.get('/search-providers', (req, res) => {
  try {
    const userId = getUserId(req);
    console.log(`[LLM-MODELS-API] 获取搜索源, userId: ${userId}`);

    const providers = userModelRegistry.getAllSearchProviders(userId);

    res.json({
      success: true,
      providers: providers,
    });
  } catch (error) {
    console.error('[LLM-MODELS-API] 获取搜索源失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch search providers',
    });
  }
});

router.post('/search-providers', (req, res) => {
  try {
    const userId = getUserId(req);
    const provider: SearchProviderConfig = req.body;

    console.log(`[LLM-MODELS-API] 收到搜索源保存请求:`, {
      userId,
      queryUserId: req.query.userId,
      headerUserId: req.headers['x-user-id'],
      providerId: provider?.id,
      providerName: provider?.name,
      providerType: provider?.type,
      providerUrl: provider?.url
    });

    if (!userId) {
      console.error('[LLM-MODELS-API] 保存搜索源失败: userId 为空');
      return res.status(400).json({
        success: false,
        error: 'userId is required (query parameter or x-user-id header)',
      });
    }

    if (!provider.id || !provider.name || !provider.type || !provider.url) {
      console.error('[LLM-MODELS-API] 保存搜索源失败: 缺少必要字段', {
        hasId: !!provider.id,
        hasName: !!provider.name,
        hasType: !!provider.type,
        hasUrl: !!provider.url
      });
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: id, name, type, url',
      });
    }

    console.log(`[LLM-MODELS-API] 保存搜索源, userId: ${userId}, providerId: ${provider.id}`);
    const success = userModelRegistry.addOrUpdateSearchProvider(provider, userId);

    console.log(`[LLM-MODELS-API] 保存结果: ${success}`);

    if (success) {
      res.json({
        success: true,
        provider: provider,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to save search provider',
      });
    }
  } catch (error) {
    console.error('[LLM-MODELS-API] 保存搜索源失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save search provider',
    });
  }
});

router.delete('/search-providers/:id', (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    console.log(`[LLM-MODELS-API] 删除搜索源, userId: ${userId}, providerId: ${id}`);
    const success = userModelRegistry.deleteSearchProvider(id, userId);

    if (success) {
      res.json({
        success: true,
      });
    } else {
      res.status(404).json({
        success: false,
        error: `Search provider not found: ${id}`,
      });
    }
  } catch (error) {
    console.error('[LLM-MODELS-API] 删除搜索源失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete search provider',
    });
  }
});

// ========== Token 使用量统计 API ==========

router.get('/token-usage/recent', (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    console.log(`[LLM-MODELS-API] 获取最近 ${days} 天的 token 使用量`);

    const recentUsage = tokenUsageService.getRecentDays(days);

    res.json({
      success: true,
      data: recentUsage,
    });
  } catch (error) {
    console.error('[LLM-MODELS-API] 获取 token 使用量失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch token usage',
    });
  }
});

router.get('/token-usage/stats', (req, res) => {
  try {
    console.log(`[LLM-MODELS-API] 获取 token 使用量总统计`);

    const stats = tokenUsageService.getTotalStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('[LLM-MODELS-API] 获取 token 统计失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch token stats',
    });
  }
});

router.get('/token-usage/today', (req, res) => {
  try {
    console.log(`[LLM-MODELS-API] 获取今日 token 使用量`);

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const todayUsage = tokenUsageService.getDailyUsage(dateStr);

    res.json({
      success: true,
      data: todayUsage || {
        date: dateStr,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        callCount: 0,
        records: []
      },
    });
  } catch (error) {
    console.error('[LLM-MODELS-API] 获取今日 token 使用量失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch today token usage',
    });
  }
});

// 🔥 任务级聚合：按 sessionId 输出每任务的轮数/token/缓存命中率
router.get('/token-usage/session-aggregates', (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    console.log(`[LLM-MODELS-API] 获取最近 ${days} 天的 sessionId 任务级聚合`);

    const aggregates = tokenUsageService.getSessionAggregates(days);

    res.json({
      success: true,
      data: aggregates,
    });
  } catch (error) {
    console.error('[LLM-MODELS-API] 获取任务级聚合失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch session aggregates',
    });
  }
});

// 🔥 回合级 summary token：summarizer（thinking/最终报告）记录键是 conversationId，
// 前端按回合发时间窗，返回与窗口顺序一一对应的 token 总数（配合 session-aggregates 拼回合总消耗）
router.post('/token-usage/summary-windows', (req, res) => {
  try {
    const { conversationId, windows } = req.body || {};
    if (!conversationId || !Array.isArray(windows)) {
      return res.status(400).json({ success: false, error: 'conversationId and windows[] are required' });
    }
    const totals = tokenUsageService.getSummaryTokensInWindows(
      String(conversationId),
      windows.slice(0, 100).map((w: any) => ({ startTs: Number(w.startTs) || 0, endTs: Number(w.endTs) || Date.now() }))
    );
    res.json({ success: true, data: totals });
  } catch (error) {
    console.error('[LLM-MODELS-API] summary-windows 聚合失败:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch summary windows' });
  }
});

// ========== 通用路由（必须放在最后） ==========

router.get('/:id', (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    console.log(`[LLM-MODELS-API] 获取模型详情, userId: ${userId}, modelId: ${id}`);
    const model = userModelRegistry.getUserModelById(id, userId);

    if (!model) {
      return res.status(404).json({
        success: false,
        error: `Model not found: ${id}`,
      });
    }

    res.json({
      success: true,
      data: model,
    });
  } catch (error) {
    console.error('[LLM-MODELS-API] 获取模型详情失败:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch model',
    });
  }
});

export default router;
