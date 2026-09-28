/**
 * LLM 模型管理器（前端 - 简化版，多用户支持）
 *
 * 架构说明：
 * - 自定义模型：用户添加的模型定义（名称、URL、API Key）
 * - 绑定配置：模型与用途点的绑定关系
 * - 搜索源：用户配置的搜索和爬取服务
 *
 * 存储位置：
 * - 自定义模型：通过 API 存储到后端本地文件（按 userId 分目录）
 * - 绑定配置：通过 API 存储到后端本地文件（按 userId 分目录）
 * - 搜索源：通过 API 存储到后端本地文件（按 userId 分目录）
 */

import { getBackendUrl, CLOUD_API_BASE_URL } from '@/config/api';
import { CloudAuthService } from '@/services/cloud/CloudAuthService';
import {
  UserModelConfig,
  ModelDefinition,
  ModelMajorCategory,
  AllModelsApiResponse
} from './types';
import { SimpleUserModel, SearchProviderConfig } from '@/components/profile/CustomModelDialog';

class ModelManagerClass {
  private userConfig: UserModelConfig = {};
  private organizationModels: ModelDefinition[] = [];
  private assistantModels: ModelDefinition[] = [];
  private userModels: SimpleUserModel[] = [];
  private searchProviders: SearchProviderConfig[] = [];
  private packageModels: SimpleUserModel[] = []; // 🔥 套餐模型（内存态，服务端维护，不持久化）
  private modelsLoaded: boolean = false;
  private currentUserId: string | null = null;

  // 设置当前用户 ID
  setUserId(userId: string | null) {
    if (this.currentUserId !== userId) {
      console.log(`[MODEL-MANAGER] 切换用户: ${this.currentUserId} -> ${userId}`);
      this.currentUserId = userId;
      // 清空缓存，强制重新加载
      this.modelsLoaded = false;
      this.userModels = [];
      this.searchProviders = [];
      this.userConfig = {};
    }
  }

  getUserId(): string | null {
    return this.currentUserId;
  }

  async initialize(userId?: string) {
    if (userId) {
      this.setUserId(userId);
    }

    // 🔥 等待后端启动完成
    const backendReady = await this.waitForBackend();
    if (!backendReady) {
      console.warn('[MODEL-MANAGER] 后端服务未启动，跳过初始化');
      return;
    }

    // 加载数据
    await Promise.all([
      this.loadUserConfig(),
      this.loadAvailableModels(),
      this.loadSearchProviders(),
      this.loadPackageModels(),
    ]);

    // 🔥 拉到最新套餐列表后，清理本地已下架的套餐模型（离线时 packageModels 为空会自动跳过）
    await this.syncPackageModels();
    // 🔥 agent 三键若无有效绑定（下架清空/新用户），自动回退到第一个可用套餐模型，避免进来模型为空
    await this.ensureDefaultBinding();
  }

  // 🔥 等待后端启动完成（指数退避：前几次快速重试，后面逐渐放慢）
  private async waitForBackend(): Promise<boolean> {
    const maxAttempts = 60; // 最多重试 60 次
    const delays = [200, 200, 300, 300, 500, 500, 500, 1000, 1000, 1000]; // 前10次用渐进间隔
    const defaultDelay = 1000; // 10 次后固定 1 秒

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const backendUrl = getBackendUrl();
        const response = await fetch(`${backendUrl}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(2000),
        });

        if (response.ok) {
          console.log(`[MODEL-MANAGER] 后端服务已就绪（第 ${i + 1} 次尝试）`);
          return true;
        }
      } catch (error) {
        // 忽略错误，继续等待
      }

      const delay = i < delays.length ? delays[i] : defaultDelay;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    return false;
  }

  // 构建带 userId 的 API URL
  private buildApiUrl(endpoint: string): string {
    const backendUrl = getBackendUrl();
    // 未登录时不传递 userId，让后端处理
    const userId = this.currentUserId;
    if (!userId) {
      return `${backendUrl}/api/llm-models${endpoint}`;
    }
    return `${backendUrl}/api/llm-models${endpoint}?userId=${encodeURIComponent(userId)}`;
  }

  private async loadAvailableModels() {
    if (this.modelsLoaded) {
      return;
    }

    try {
      const apiUrl = this.buildApiUrl('/all');
      console.log('[MODEL-MANAGER] 正在加载模型列表:', apiUrl);

      const response = await fetch(apiUrl);

      if (!response.ok) {
        console.error('[MODEL-MANAGER] HTTP 错误:', response.status);
        return;
      }

      const data: AllModelsApiResponse = await response.json();

      if (data.success && data.data) {
        this.organizationModels = data.data.organization.models;
        this.assistantModels = data.data.assistant.models;
        this.modelsLoaded = true;
        console.log('[MODEL-MANAGER] 模型列表加载成功:', {
          organizationCount: this.organizationModels.length,
          assistantCount: this.assistantModels.length
        });
      } else {
        console.error('[MODEL-MANAGER] 加载模型列表失败:', data.error);
      }
    } catch (error) {
      console.error('[MODEL-MANAGER] 加载模型列表异常:', error);
    }
  }

  private async loadUserConfig() {
    try {
      const apiUrl = this.buildApiUrl('/bindings');
      const response = await fetch(apiUrl);

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.bindings) {
          this.userConfig = data.bindings;
          console.log('[MODEL-MANAGER] 绑定配置加载成功:', this.userConfig);
        }
      }

      await this.loadUserModels();
    } catch (error) {
      console.error('[MODEL-MANAGER] 加载配置异常:', error);
      this.userConfig = {};
    }
  }

  private async loadUserModels() {
    try {
      const apiUrl = this.buildApiUrl('/user-models');
      const response = await fetch(apiUrl);

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.models) {
          this.userModels = data.models;
          console.log('[MODEL-MANAGER] 用户自定义模型加载成功:', this.userModels.length);
        }
      }
    } catch (error) {
      console.error('[MODEL-MANAGER] 加载用户模型异常:', error);
    }
  }

  // ========== 套餐模型管理 ==========
  // 套餐模型走 home-web 代理（服务端注入官方 apikey 并计费），
  // 客户端侧等价于一条 user model：url 指向代理端点、apiKey 为用户 JWT

  private async loadPackageModels(): Promise<void> {
    try {
      const response = await fetch(`${CLOUD_API_BASE_URL}/llm-proxy/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;

      const data = await response.json();
      if (data.success && Array.isArray(data.models)) {
        this.packageModels = data.models.map((m: { modelId: string; displayName: string; supportsVision?: boolean; inputRate?: number; outputRate?: number }) => ({
          id: `package-${m.modelId}`,
          name: m.displayName,
          modelId: m.modelId,
          url: `${CLOUD_API_BASE_URL}/llm-proxy/chat/completions`,
          apiKey: CloudAuthService.getAccessToken() || '',
          provider: 'package',
          supportsVision: m.supportsVision || false,
          isPackage: true,
          inputRate: m.inputRate,
          outputRate: m.outputRate,
        }));
        console.log('[MODEL-MANAGER] 套餐模型加载成功:', this.packageModels.length);
      }
    } catch (error) {
      console.warn('[MODEL-MANAGER] 套餐模型加载失败（离线或服务不可用）:', error);
    }
  }

  getPackageModels(): SimpleUserModel[] {
    return [...this.packageModels];
  }

  /**
   * 🔥 确保 agent 三键（summary/plan/execution）有有效绑定，无效则回退到第一个可用套餐模型
   * 触发场景：下架清理清空绑定、新用户首次使用
   */
  private async ensureDefaultBinding(): Promise<void> {
    const agentKeys = ['organization.summary', 'organization.plan', 'organization.execution'];
    const hasValidBinding = agentKeys.some(key => {
      const value = this.userConfig[key];
      if (!value) return false;
      // 绑定指向的模型必须在本地真实存在（套餐模型或自定义模型）
      return this.packageModels.some(m => m.id === value) || this.userModels.some(m => m.id === value);
    });
    if (hasValidBinding) return;

    const fallback = this.packageModels[0];
    if (!fallback) return; // 离线/未登录等拿不到套餐列表，保持现状

    console.warn('[MODEL-MANAGER] 无有效模型绑定，自动回退到默认套餐模型:', fallback.id);
    const ok = await this.bindPackageModel(fallback.modelId);
    if (ok) {
      // bindPackageModel 成功后 userConfig 已更新（updateMultipleModels），无需手动同步
      console.log('[MODEL-MANAGER] 默认套餐模型绑定完成');
    }
  }

  /**
   * 🔥 清除所有指向指定模型 id 的绑定（模型被删除/下架时调用）
   */
  private async clearBindingsFor(modelId: string): Promise<void> {
    const nextConfig: Record<string, string> = {};
    let changed = false;
    for (const [key, value] of Object.entries(this.userConfig)) {
      if (value === modelId) {
        changed = true;
        continue;
      }
      nextConfig[key] = value;
    }
    if (changed) {
      await this.saveUserConfig(nextConfig);
      console.warn('[MODEL-MANAGER] 已清除指向该模型的绑定:', modelId);
    }
  }

  /**
   * 🔥 套餐模型同步清理：服务端已下架/改名的套餐模型，从本地持久化数据中移除
   * 场景：home-web 调整 PACKAGE_MODELS 后，用户选中过的 package-* 记录还留在
   * local-backend 的 user-models.json 里，绑定也还指向它——后台链路（summary/plan/execution）
   * 用已下架模型请求代理会 400「非套餐模型」。
   * ⚠️ 只有 packageModels 拉取成功（非空）才执行：离线时列表为空，绝不能清理，否则误删全部套餐模型。
   */
  private async syncPackageModels(): Promise<void> {
    if (this.packageModels.length === 0) return;

    const latestIds = new Set(this.packageModels.map(m => m.id));
    const stale = this.userModels.filter(m => (m as any).isPackage && !latestIds.has(m.id));
    if (stale.length === 0) return;

    for (const model of stale) {
      console.warn('[MODEL-MANAGER] 套餐模型已下架，从本地移除:', model.id);
      await this.deleteUserModel(model.id);
      await this.clearBindingsFor(model.id);
    }
  }

  /**
   * 🔥 刷新已保存套餐模型的 JWT 快照
   * 套餐模型以 JWT 为 apiKey 持久化在 local-backend（user-models.json），
   * JWT 7 天过期——后台链路（summary/plan/execution 等 local-backend 直读）拿不到新 token，
   * 不刷新就会出现"聊天正常、后台总结 401 令牌无效"的分裂症状。
   * 登录后/启动时调用：把所有 isPackage 模型的 apiKey 更新为当前 token（幂等）。
   */
  async refreshPackageModelTokens(): Promise<void> {
    const token = CloudAuthService.getAccessToken();
    if (!token) return;
    // 🔥 用户模型可能尚未加载完（启动 3s 定时器早于 loadUserModels 完成，后端冷启动尤甚）：
    //    空列表会让下面的循环静默空转，旧快照永远补不上 refreshToken（401 自愈失去凭据）
    if (this.userModels.length === 0) {
      await this.loadUserModels();
    }
    // 🔥 同步存 refreshToken（30天）：local-backend 后台链路 401 时靠它自动续期（CloudTokenRefresher）
    const refreshToken = localStorage.getItem('cloud_refresh_token') || undefined;

    for (const model of this.userModels.filter(m => (m as any).isPackage)) {
      const needsUpdate = !model.apiKey
        || model.apiKey !== token
        || (!!refreshToken && model.refreshToken !== refreshToken);
      if (needsUpdate) {
        try {
          await this.saveUserModel({ ...model, apiKey: token, refreshToken: refreshToken || model.refreshToken });
        } catch (error) {
          console.warn('[MODEL-MANAGER] 刷新套餐模型 JWT 失败:', model.id, error);
        }
      }
    }
  }

  /**
   * 选中套餐模型时调用：以当前 JWT 为 apiKey 保存/更新该套餐模型记录并建立绑定
   * 🔥 与自定义模型切换一致：同时更新 summary/plan/execution 三个绑定
   */
  async bindPackageModel(modelId: string): Promise<boolean> {
    const pkg = this.packageModels.find(m => m.modelId === modelId);
    if (!pkg) {
      console.error('[MODEL-MANAGER] 未找到套餐模型:', modelId);
      // 🔥 运行时自愈：本地残留的已下架套餐模型 → 删除记录并解除绑定
      // （启动时 syncPackageModels 已兜底；这里是用户手动点到旧条目时的兜底）
      const staleLocal = this.userModels.find(m => (m as any).isPackage && m.modelId === modelId);
      if (staleLocal) {
        console.warn('[MODEL-MANAGER] 检测到已下架套餐模型的本地残留，自动清理:', staleLocal.id);
        await this.deleteUserModel(staleLocal.id);
        await this.clearBindingsFor(staleLocal.id);
      }
      return false;
    }

    // JWT 可能比上次保存时更新，每次绑定都刷新 apiKey
    const token = CloudAuthService.getAccessToken();
    if (!token) {
      console.error('[MODEL-MANAGER] 未登录，无法使用套餐模型');
      return false;
    }

    try {
      // 🔥 快照同时携带 refreshToken：后台链路 401 自愈的凭据来源（CloudTokenRefresher）
      const refreshToken = localStorage.getItem('cloud_refresh_token') || undefined;
      await this.saveUserModel({ ...pkg, apiKey: token, refreshToken });
    } catch (error) {
      console.error('[MODEL-MANAGER] 保存套餐模型失败:', error);
      return false;
    }

    return this.updateMultipleModels({
      'organization.summary': pkg.id,
      'organization.plan': pkg.id,
      'organization.execution': pkg.id,
    });
  }

  // ========== 搜索源管理 ==========
  private async loadSearchProviders() {
    try {
      const apiUrl = this.buildApiUrl('/search-providers');
      const response = await fetch(apiUrl);

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.providers) {
          this.searchProviders = data.providers;
          console.log('[MODEL-MANAGER] 搜索源加载成功:', this.searchProviders.length);
        }
      }
    } catch (error) {
      console.error('[MODEL-MANAGER] 加载搜索源异常:', error);
    }
  }

  getSearchProviders(): SearchProviderConfig[] {
    return [...this.searchProviders];
  }

  getSearchProvidersByType(type: 'search' | 'fetch'): SearchProviderConfig[] {
    return this.searchProviders.filter(p => p.type === type);
  }

  async saveSearchProvider(provider: SearchProviderConfig): Promise<boolean> {
    try {
      const apiUrl = this.buildApiUrl('/search-providers');
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(provider),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          const exists = this.searchProviders.find(p => p.id === provider.id);
          if (exists) {
            this.searchProviders = this.searchProviders.map(p => p.id === provider.id ? provider : p);
          } else {
            this.searchProviders.push(provider);
          }
          console.log('[MODEL-MANAGER] 搜索源保存成功:', provider.id);
          return true;
        }
      }

      console.error('[MODEL-MANAGER] 保存搜索源失败');
      return false;
    } catch (error) {
      console.error('[MODEL-MANAGER] 保存搜索源异常:', error);
      return false;
    }
  }

  async deleteSearchProvider(providerId: string): Promise<boolean> {
    try {
      const apiUrl = this.buildApiUrl(`/search-providers/${providerId}`);
      const response = await fetch(apiUrl, { method: 'DELETE' });

      if (response.ok) {
        this.searchProviders = this.searchProviders.filter(p => p.id !== providerId);
        console.log('[MODEL-MANAGER] 搜索源删除成功:', providerId);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[MODEL-MANAGER] 删除搜索源异常:', error);
      return false;
    }
  }

  // ========== 模型管理 ==========
  async saveUserModel(model: SimpleUserModel): Promise<boolean> {
    const apiUrl = this.buildApiUrl('/user-models');
    let response: Response;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model),
      });
    } catch (fetchError) {
      console.error('[MODEL-MANAGER] 网络请求失败，后端可能未启动:', fetchError);
      throw new Error('无法连接到本地服务，请重启应用后重试');
    }

    if (!response.ok) {
      throw new Error(`保存失败：后端返回 ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.message || '保存失败：后端处理出错');
    }

    const exists = this.userModels.find(m => m.id === model.id);
    if (exists) {
      this.userModels = this.userModels.map(m => m.id === model.id ? model : m);
    } else {
      this.userModels.push(model);
    }
    console.log('[MODEL-MANAGER] 用户模型保存成功:', model.id);
    return true;
  }

  async deleteUserModel(modelId: string): Promise<boolean> {
    try {
      const apiUrl = this.buildApiUrl(`/user-models/${modelId}`);
      const response = await fetch(apiUrl, { method: 'DELETE' });

      if (response.ok) {
        this.userModels = this.userModels.filter(m => m.id !== modelId);
        console.log('[MODEL-MANAGER] 用户模型删除成功:', modelId);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[MODEL-MANAGER] 删除用户模型异常:', error);
      return false;
    }
  }

  getUserModels(): SimpleUserModel[] {
    return [...this.userModels];
  }

  async saveUserConfig(config: UserModelConfig) {
    try {
      const apiUrl = this.buildApiUrl('/bindings');
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindings: config }),
      });

      if (!response.ok) {
        console.error('[MODEL-MANAGER] 保存绑定配置到后端失败');
        return false;
      }

      this.userConfig = config;
      console.log('[MODEL-MANAGER] 绑定配置保存成功:', config);
      return true;
    } catch (error) {
      console.error('[MODEL-MANAGER] 保存配置异常:', error);
      return false;
    }
  }

  getUserConfig(): UserModelConfig {
    return { ...this.userConfig };
  }

  getOrganizationModels(): ModelDefinition[] {
    return this.organizationModels;
  }

  getAssistantModels(): ModelDefinition[] {
    return this.assistantModels;
  }

  getModelsByCategory(majorCategory: ModelMajorCategory, subCategory: string): ModelDefinition[] {
    const models = majorCategory === ModelMajorCategory.ORGANIZATION
      ? this.organizationModels
      : this.assistantModels;

    return models.filter(m => m.subCategory === subCategory);
  }

  getModelId(majorCategory: ModelMajorCategory, subCategory: string): string {
    const key = `${majorCategory}.${subCategory}`;
    const configuredModelId = this.userConfig[key];

    if (configuredModelId) {
      const userModel = this.userModels.find(m => m.id === configuredModelId);
      if (userModel) {
        return userModel.modelId;
      }

      const models = this.getModelsByCategory(majorCategory, subCategory);
      const model = models.find(m => m.id === configuredModelId);
      if (model) {
        return model.modelId;
      }
    }

    const models = this.getModelsByCategory(majorCategory, subCategory);
    const defaultModel = models.find(m => m.isDefault) || models[0];

    if (!defaultModel) {
      console.warn(`[MODEL-MANAGER] 未找到模型: ${key}`);
      return 'gpt-4-turbo-preview';
    }

    return defaultModel.modelId;
  }

  async setModelForCategory(
    majorCategory: ModelMajorCategory,
    subCategory: string,
    modelId: string
  ): Promise<boolean> {
    const key = `${majorCategory}.${subCategory}`;
    const newConfig = { ...this.userConfig, [key]: modelId };
    return await this.saveUserConfig(newConfig);
  }

  async updateMultipleModels(updates: Record<string, string>): Promise<boolean> {
    const newConfig = { ...this.userConfig, ...updates };
    return await this.saveUserConfig(newConfig);
  }

  async resetToDefaults(): Promise<boolean> {
    return await this.saveUserConfig({});
  }
}

export const ModelManager = new ModelManagerClass();
