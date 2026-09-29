/**
 * 用户自定义模型注册表（多用户版本）
 *
 * 每个用户有独立的配置目录：
 * .teegal/user-{hash(userId)}/user-models.json
 *
 * 使用哈希值作为目录名，避免特殊字符问题，同时保护用户隐私
 *
 * 用户只需添加一次模型，然后通过绑定关系分配到不同用途点
 */

import { ModelDefinition, ModelProvider } from './types';
import { resolveAppDataDir } from '../appDataDir';
import { encryptSecret, decryptSecret } from '../secretBox';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const USER_MODELS_FILENAME = 'user-models.json';

// 用户 ID 到哈希的映射缓存（内存中）
const userIdToHashMap: Map<string, string> = new Map();
const hashToUserIdMap: Map<string, string> = new Map();

// 注意：系统默认模型和搜索源配置现在通过 user-models.json 维护
// 不再在代码中硬编码

export interface SimpleUserModel {
  id: string;
  name: string;
  modelId: string;
  url: string;
  apiKey: string;
  /** 🔥 套餐模型专用：云端 refreshToken（30 天），401 自愈刷新用（CloudTokenRefresher） */
  refreshToken?: string;
  provider: string;
  requestFormat?: 'openai' | 'dashscope' | 'responses';
  /** 🔥 用户声明的视觉能力（优先于前缀表推断，用于新模型无需改代码） */
  supportsVision?: boolean;
}

export interface RequestTemplate {
  method: 'GET' | 'POST';
  authType: 'header' | 'query' | 'body' | 'none';
  authHeaderName?: string;
  authQueryParam?: string;
  queryTemplate?: string;
  bodyTemplate?: string;
}

export interface ResponseTemplate {
  resultsPath: string;
  titlePath: string;
  urlPath: string;
  snippetPath: string;
}

export interface SearchProviderConfig {
  id: string;
  name: string;
  type: 'search' | 'fetch';
  providerType: string;
  url: string;
  apiKey: string;
  apiKeyRequired?: boolean;
  requestTemplate?: RequestTemplate;
  responseTemplate?: ResponseTemplate;
  keywords?: string[];
  description?: string;
  isGeneral?: boolean;
}

export interface UserModelConfig {
  version: string;
  lastUpdated: string;
  models: SimpleUserModel[];
  searchProviders?: SearchProviderConfig[];
}

// 计算用户 ID 的哈希值（用于目录名）
function getUserIdHash(userId: string): string {
  // 确保 userId 是字符串
  const userIdStr = String(userId);
  
  // 检查缓存
  if (userIdToHashMap.has(userIdStr)) {
    return userIdToHashMap.get(userIdStr)!;
  }

  // 计算 SHA-256 哈希，取前 16 位
  const hash = crypto.createHash('sha256').update(userIdStr).digest('hex').substring(0, 16);

  // 保存映射关系
  userIdToHashMap.set(userIdStr, hash);
  hashToUserIdMap.set(hash, userIdStr);

  return hash;
}

// 获取用户数据目录
function getUserDataDir(userId: string): string {
  if (!userId) {
    throw new Error('[USER-MODEL-REGISTRY] userId 不能为空');
  }
  const baseDir = resolveAppDataDir();
  const userHash = getUserIdHash(userId);
  return path.join(baseDir, `user-${userHash}`);
}

// 获取用户模型配置文件路径
function getUserModelsFilePath(userId: string): string {
  if (!userId) {
    throw new Error('[USER-MODEL-REGISTRY] userId 不能为空');
  }
  return path.join(getUserDataDir(userId), USER_MODELS_FILENAME);
}

// 获取默认搜索源配置（用于初始化时写入 JSON）
function getDefaultSearchProviders(): SearchProviderConfig[] {
  return [
    {
      id: 'search-tavily',
      name: 'Tavily Search',
      type: 'search',
      providerType: 'tavily',
      url: 'https://api.tavily.com/search',
      apiKey: ''
    },
    {
      id: 'search-serpapi',
      name: 'SerpAPI (Google)',
      type: 'search',
      providerType: 'serpapi',
      url: 'https://serpapi.com/search',
      apiKey: ''
    },
    {
      id: 'search-bing',
      name: 'Bing Search',
      type: 'search',
      providerType: 'bing',
      url: 'https://api.bing.microsoft.com/v7.0/search',
      apiKey: ''
    },
    {
      id: 'search-qwen',
      name: 'Qwen Search',
      type: 'search',
      providerType: 'qwen',
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      apiKey: ''
    },
    {
      id: 'fetch-firecrawl',
      name: 'Firecrawl',
      type: 'fetch',
      providerType: 'firecrawl',
      url: 'https://api.firecrawl.dev/v0/scrape',
      apiKey: ''
    },
    {
      id: 'fetch-jina',
      name: 'Jina AI Reader',
      type: 'fetch',
      providerType: 'jina',
      url: 'https://r.jina.ai',
      apiKey: ''
    },
    {
      id: 'search-huggingface',
      name: 'HuggingFace 模型搜索',
      type: 'search',
      providerType: 'huggingface',
      url: 'https://huggingface.co/api/models',
      apiKey: '',
      apiKeyRequired: false
    },
    {
      id: 'search-arxiv',
      name: 'arXiv 学术论文',
      type: 'search',
      providerType: 'arxiv',
      url: 'http://export.arxiv.org/api/query',
      apiKey: '',
      apiKeyRequired: false
    }
  ];
}

// 获取默认系统模型配置
// 🔥 已移除 vision/speech 等助手类型，不再需要默认系统模型
function getDefaultSystemModels(): SimpleUserModel[] {
  return [];
}

// 用户数据缓存
interface UserData {
  userModels: Map<string, SimpleUserModel>;
  searchProviders: Map<string, SearchProviderConfig>;
  configPath: string;
  initialized: boolean;
  lastModified?: number;  // 文件最后修改时间
}

export class UserModelRegistry {
  private static instance: UserModelRegistry;
  private userDataMap: Map<string, UserData> = new Map();
  private currentUserId: string | null = null;

  static getInstance(): UserModelRegistry {
    if (!UserModelRegistry.instance) {
      UserModelRegistry.instance = new UserModelRegistry();
    }
    return UserModelRegistry.instance;
  }

  // 获取或创建用户数据
  private getUserData(userId: string): UserData {
    if (!this.userDataMap.has(userId)) {
      this.userDataMap.set(userId, {
        userModels: new Map(),
        searchProviders: new Map(),
        configPath: getUserModelsFilePath(userId),
        initialized: false,
        lastModified: 0,
      });
    }
    return this.userDataMap.get(userId)!;
  }

  /**
   * 🔥 检查文件是否被修改，如果被修改则重新加载
   */
  private checkAndReloadIfNeeded(userId: string): void {
    const userData = this.getUserData(userId);
    if (!fs.existsSync(userData.configPath)) {
      return;
    }

    const stats = fs.statSync(userData.configPath);
    const currentModified = stats.mtimeMs;

    // 如果文件被修改过，重新加载
    if (userData.lastModified && currentModified > userData.lastModified) {
      console.log(`[USER-MODEL-REGISTRY] 检测到配置文件已修改，重新加载: ${userData.configPath}`);
      userData.initialized = false;
      userData.userModels.clear();
      userData.searchProviders.clear();
      this.initialize(userId);
    }
  }

  // 设置当前用户（切换用户时调用）
  setCurrentUser(userId: string): void {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 拒绝切换到空用户');
      return;
    }
    this.currentUserId = userId;
    // 初始化新用户的配置
    this.initialize(this.currentUserId);
  }

  // 获取当前用户ID
  getCurrentUserId(): string | null {
    return this.currentUserId;
  }

  initialize(userId: string = this.currentUserId || ''): void {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 初始化失败: userId 为空');
      return;
    }
    const userData = this.getUserData(userId);

    if (userData.initialized) {
      return;
    }

    try {
      const dir = path.dirname(userData.configPath);
      if (!fs.existsSync(dir)) {
        console.log(`[USER-MODEL-REGISTRY] 创建目录: ${dir}`);
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(userData.configPath)) {
        const content = fs.readFileSync(userData.configPath, 'utf-8');
        console.log(`[USER-MODEL-REGISTRY] 文件内容长度: ${content.length}`);
        const config: UserModelConfig = JSON.parse(content);

        if (config.version === '1.0') {
          // 加载模型（apiKey/refreshToken 落盘为密文，读入解密到内存；旧明文原样兼容）
          config.models.forEach(model => {
            userData.userModels.set(model.id, {
              ...model,
              apiKey: decryptSecret(model.apiKey) || '',
              refreshToken: decryptSecret(model.refreshToken),
            });
          });
          console.log(`[USER-MODEL-REGISTRY] 用户 ${userId}: 已加载 ${config.models.length} 个用户自定义模型`);
          // 🔥 不再自动添加系统默认模型，所有模型必须由用户自己配置

          // 加载搜索源（如果配置文件中有）
          if (config.searchProviders && config.searchProviders.length > 0) {
            config.searchProviders.forEach(provider => {
              userData.searchProviders.set(provider.id, {
                ...provider,
                apiKey: decryptSecret(provider.apiKey) || '',
              });
            });
            console.log(`[USER-MODEL-REGISTRY] 用户 ${userId}: 已加载 ${config.searchProviders.length} 个搜索源`);
            // 🔥 不再自动添加默认搜索源，所有搜索源必须由用户自己配置
          }
          // 🔥 配置文件中没有搜索源时也不再自动添加
        } else {
          console.warn(`[USER-MODEL-REGISTRY] 用户 ${userId}: 配置文件版本不兼容: ${config.version}`);
        }
      } else {
        console.log(`[USER-MODEL-REGISTRY] 用户 ${userId}: 配置文件不存在，创建空配置`);
        // 🔥 不再创建默认配置，所有配置必须由用户自己添加
        const emptyConfig: UserModelConfig = {
          version: '1.0',
          lastUpdated: new Date().toISOString(),
          models: [],
          searchProviders: []
        };
        fs.writeFileSync(userData.configPath, JSON.stringify(emptyConfig, null, 2), 'utf-8');
        console.log(`[USER-MODEL-REGISTRY] 用户 ${userId}: 已创建空配置`);
      }

      userData.initialized = true;
      // 记录文件修改时间
      if (fs.existsSync(userData.configPath)) {
        userData.lastModified = fs.statSync(userData.configPath).mtimeMs;
      }
    } catch (error) {
      console.error(`[USER-MODEL-REGISTRY] 用户 ${userId}: 初始化失败:`, error);
      userData.initialized = true;
    }
  }

  // ========== 模型管理 ==========
  getAllUserModels(userId: string = this.currentUserId || ''): SimpleUserModel[] {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 获取所有模型失败: userId 为空');
      return getDefaultSystemModels();
    }
    this.checkAndReloadIfNeeded(userId);  // 🔥 检查文件是否被修改
    this.initialize(userId);
    const userData = this.getUserData(userId);
    const userModels = Array.from(userData.userModels.values());
    
    // 🔥 合并用户模型和系统默认模型
    // 系统模型：vision 和 speech，用户需要配置 API key
    const defaultModels = getDefaultSystemModels();
    const mergedModels = [...defaultModels];
    
    // 用用户配置的模型覆盖默认模型（如果用户修改了 API key）
    for (const userModel of userModels) {
      const index = mergedModels.findIndex(m => m.id === userModel.id);
      if (index >= 0) {
        mergedModels[index] = userModel;
      } else {
        mergedModels.push(userModel);
      }
    }
    
    return mergedModels;
  }

  getUserModelById(modelId: string, userId: string = this.currentUserId || ''): SimpleUserModel | undefined {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 获取模型失败: userId 为空');
      return undefined;
    }
    this.checkAndReloadIfNeeded(userId);  // 🔥 检查文件是否被修改
    this.initialize(userId);
    const userData = this.getUserData(userId);
    return userData.userModels.get(modelId);
  }

  addOrUpdateModel(model: SimpleUserModel, userId: string = this.currentUserId || ''): boolean {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 添加/更新模型失败: userId 为空');
      return false;
    }
    this.initialize(userId);
    const userData = this.getUserData(userId);
    userData.userModels.set(model.id, model);
    return this.saveToFile(userId);
  }

  deleteModel(modelId: string, userId: string = this.currentUserId || ''): boolean {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 删除模型失败: userId 为空');
      return false;
    }
    this.initialize(userId);
    const userData = this.getUserData(userId);
    const deleted = userData.userModels.delete(modelId);
    if (deleted) {
      this.saveToFile(userId);
    }
    return deleted;
  }

  // ========== 搜索源管理 ==========
  getAllSearchProviders(userId: string = this.currentUserId || ''): SearchProviderConfig[] {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 获取所有搜索源失败: userId 为空');
      return getDefaultSearchProviders();
    }
    this.checkAndReloadIfNeeded(userId);
    this.initialize(userId);
    const userData = this.getUserData(userId);
    const userProviders = Array.from(userData.searchProviders.values());
    
    const defaultProviders = getDefaultSearchProviders();
    
    const mergedProviders: SearchProviderConfig[] = [];
    
    for (const defaultProvider of defaultProviders) {
      const userProvider = userData.searchProviders.get(defaultProvider.id);
      if (userProvider) {
        mergedProviders.push({ ...defaultProvider, ...userProvider });
      } else {
        mergedProviders.push(defaultProvider);
      }
    }
    
    for (const userProvider of userProviders) {
      const isDefaultProvider = defaultProviders.some(dp => dp.id === userProvider.id);
      if (!isDefaultProvider) {
        mergedProviders.push(userProvider);
      }
    }
    
    console.log(`[USER-MODEL-REGISTRY] 用户 ${userId}: 返回 ${mergedProviders.length} 个搜索源（默认 ${defaultProviders.length}，用户自定义 ${userProviders.length - defaultProviders.length}）`);
    return mergedProviders;
  }

  getSearchProviderById(providerId: string, userId: string = this.currentUserId || ''): SearchProviderConfig | undefined {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 获取搜索源失败: userId 为空');
      return undefined;
    }
    this.initialize(userId);
    const userData = this.getUserData(userId);
    return userData.searchProviders.get(providerId);
  }

  addOrUpdateSearchProvider(provider: SearchProviderConfig, userId: string = this.currentUserId || ''): boolean {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 添加/更新搜索源失败: userId 为空');
      return false;
    }
    this.initialize(userId);
    const userData = this.getUserData(userId);
    userData.searchProviders.set(provider.id, provider);
    return this.saveToFile(userId);
  }

  deleteSearchProvider(providerId: string, userId: string = this.currentUserId || ''): boolean {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 删除搜索源失败: userId 为空');
      return false;
    }
    this.initialize(userId);
    const userData = this.getUserData(userId);
    const deleted = userData.searchProviders.delete(providerId);
    if (deleted) {
      this.saveToFile(userId);
    }
    return deleted;
  }

  /**
   * 🔥 获取 Fetch Provider 配置（用于 URL Reader）
   * @param providerType - 'firecrawl' | 'jina' | 'native'
   * @param userId - 用户ID
   * @returns SearchProviderConfig | undefined
   */
  getFetchProviderConfig(providerType: 'firecrawl' | 'jina' | 'native', userId: string = this.currentUserId || ''): SearchProviderConfig | undefined {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 获取 Fetch Provider 失败: userId 为空');
      return undefined;
    }
    this.initialize(userId);
    const userData = this.getUserData(userId);

    // 查找匹配的 fetch provider
    for (const provider of userData.searchProviders.values()) {
      if (provider.type === 'fetch' && provider.providerType === providerType) {
        return provider;
      }
    }

    // 如果没有找到，返回默认配置（不带 API key）
    const defaultProviders = getDefaultSearchProviders();
    return defaultProviders.find(p => p.type === 'fetch' && p.providerType === providerType);
  }

  // ========== 文件操作 ==========
  private saveToFile(userId: string = this.currentUserId || ''): boolean {
    if (!userId) {
      console.warn('[USER-MODEL-REGISTRY] 保存文件失败: userId 为空');
      return false;
    }
    try {
      const userData = this.getUserData(userId);
      // 🔥 敏感字段落盘加密（apiKey/refreshToken）；内存持有明文，消费方零改动
      const config: UserModelConfig = {
        version: '1.0',
        lastUpdated: new Date().toISOString(),
        models: Array.from(userData.userModels.values()).map(m => ({
          ...m,
          apiKey: encryptSecret(m.apiKey) || '',
          refreshToken: encryptSecret(m.refreshToken),
        })),
        searchProviders: Array.from(userData.searchProviders.values()).map(p => ({
          ...p,
          apiKey: encryptSecret(p.apiKey) || '',
        })),
      };
      fs.writeFileSync(userData.configPath, JSON.stringify(config, null, 2), 'utf-8');
      console.log(`[USER-MODEL-REGISTRY] 用户 ${userId}: 配置已保存到文件`);
      return true;
    } catch (error) {
      console.error(`[USER-MODEL-REGISTRY] 用户 ${userId}: 保存配置失败:`, error);
      return false;
    }
  }
}

// 导出单例实例
export const userModelRegistry = UserModelRegistry.getInstance();

// 🔥 导出默认系统模型获取函数，供路由使用
export { getDefaultSystemModels };
