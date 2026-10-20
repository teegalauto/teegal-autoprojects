/**
 * AI 模型配置 UI 组件（简化版）
 * 
 * 架构说明：
 * - 自定义模型：用户添加一次模型，包含基本信息（名称、URL、API Key）
 * - 绑定配置：将模型绑定到不同用途点（summary、plan、code 等）
 * - 搜索源：配置搜索和爬取服务
 * - 一个模型可以绑定到多个用途点
 */

import React, { useState, useEffect } from 'react';
import { ModelManager } from '@/utils/llm/ModelManager';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Loader2, Network, Plus, Trash2, Edit2, Settings2, Link2, Search, Globe, Eye, EyeOff, Check, AlertCircle, Cpu, Sparkles, MessageSquare } from 'lucide-react';
import { CustomModelDialog, SimpleModelFormData, SimpleUserModel, ModelCategoryIcon, isMediaGenerationModel } from './CustomModelDialog';
import { SearchProviderConfig } from './SearchProviderDialog';
import { Input } from '@/components/ui/input';

import { TokenUsageStats } from './TokenUsageStats';

// 🔥 搜索已切官方 hosted 通道（登录即用，服务端聚合 zhipu/tavily/arxiv），不再向用户开放自定义搜索源配置
const SEARCH_TAB_ENABLED = false;

interface ModelSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  /** 🔥 打开时默认选中的 tab：bindings(使用视图) | custom(我的模型) | local(本地推理) | search(搜索源)。默认 bindings */
  defaultTab?: 'bindings' | 'custom' | 'local' | 'search';
}

// 🔥 组织助手合并为 agent，内部映射到 summary/plan/execution
const agentSubCategories = ['summary', 'plan', 'execution'];

export const ModelSettings: React.FC<ModelSettingsProps> = ({
  open,
  onOpenChange,
  userId,
  defaultTab = 'custom',
}) => {
  const { t } = useTranslation();

  const subCategoryLabels: Record<string, string> = {
    'agent': t('profile.modelSettings.agent'),
    'summary': t('profile.modelSettings.summary'),
    'plan': t('profile.modelSettings.plan'),
    'execution': t('profile.modelSettings.execution'),
  };
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [customModels, setCustomModels] = useState<SimpleUserModel[]>([]);
  const [searchProviders, setSearchProviders] = useState<SearchProviderConfig[]>([]);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [editingCustomModel, setEditingCustomModel] = useState<SimpleUserModel | null>(null);
  
  const [editingApiKey, setEditingApiKey] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [savingApiKey, setSavingApiKey] = useState(false);

  useEffect(() => {
    if (open && userId) {
      loadData();
    }
  }, [open, userId]);

  useEffect(() => {
    const handleModelsUpdated = () => {
      if (userId) {
        loadData();
      }
    };
    window.addEventListener('models-updated', handleModelsUpdated);
    return () => window.removeEventListener('models-updated', handleModelsUpdated);
  }, [userId]);

  const loadData = async () => {
    setLoading(true);
    try {
      // 使用 userId 初始化 ModelManager
      await ModelManager.initialize(userId);

      const config = ModelManager.getUserConfig();
      setBindings(config);
      console.log('[MODEL-SETTINGS] 绑定配置:', config);

      const userModels = ModelManager.getUserModels();
      console.log('[MODEL-SETTINGS] 获取到的用户模型:', userModels);
      console.log('[MODEL-SETTINGS] 用户模型数量:', userModels.length);
      console.log('[MODEL-SETTINGS] 用户模型 IDs:', userModels.map(m => m.id));
      setCustomModels([...userModels]); // 强制创建新数组触发 React 更新

      const providers = ModelManager.getSearchProviders();
      setSearchProviders([...providers]); // 强制创建新数组触发 React 更新
      console.log('[MODEL-SETTINGS] 搜索源:', providers.length);
      console.log('[MODEL-SETTINGS] 搜索源详情:', providers);
    } catch (error) {
      console.error('[MODEL-SETTINGS] 加载配置失败:', error);
      toast.error(t('profile.modelSettings.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  // 🔥 未登录提示
  const checkLogin = (): boolean => {
    if (!userId) {
      toast.error(t('profile.modelSettings.loginFirst'));
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!checkLogin()) return;
    setSaving(true);
    try {
      const success = await ModelManager.updateMultipleModels(bindings);
      if (success) {
        toast.success(t('profile.modelSettings.saved'));
        // 🔥 通知其他组件模型配置已更新
        window.dispatchEvent(new CustomEvent('models-updated'));
        onOpenChange(false);
      } else {
        toast.error(t('profile.modelSettings.saveFailedRetry'));
      }
    } catch (error) {
      console.error('[MODEL-SETTINGS] 保存配置失败:', error);
      toast.error(t('profile.modelSettings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleAddCustomModel = () => {
    setEditingCustomModel(null);
    setCustomDialogOpen(true);
  };

  const handleEditCustomModel = (model: SimpleUserModel) => {
    setEditingCustomModel(model);
    setCustomDialogOpen(true);
  };

  const handleDeleteCustomModel = async (modelId: string) => {
    if (!checkLogin()) return;
    try {
      await ModelManager.deleteUserModel(modelId);
      setCustomModels(prev => prev.filter(m => m.id !== modelId));

      const newBindings = { ...bindings };
      Object.keys(newBindings).forEach(key => {
        if (newBindings[key] === modelId) {
          delete newBindings[key];
        }
      });
      setBindings(newBindings);

      window.dispatchEvent(new CustomEvent('models-updated'));

      toast.success(t('profile.modelSettings.modelDeleted'));
    } catch (error) {
      console.error('[MODEL-SETTINGS] 删除模型失败:', error);
      toast.error(t('profile.modelSettings.deleteFailed'));
    }
  };

  const handleDeleteSearchProvider = async (providerId: string) => {
    if (!checkLogin()) return;
    try {
      await ModelManager.deleteSearchProvider(providerId);
      setSearchProviders(prev => prev.filter(p => p.id !== providerId));
      toast.success(t('profile.modelSettings.providerDeleted'));
    } catch (error) {
      console.error('[MODEL-SETTINGS] 删除搜索源失败:', error);
      toast.error(t('profile.modelSettings.deleteFailed'));
    }
  };

  const handleSaveCustomModel = async (data: SimpleModelFormData) => {
    if (!checkLogin()) return;
    try {
      const modelId = data.id || `custom-${Date.now()}`;
      const newModel: SimpleUserModel = {
        id: modelId,
        name: data.modelId,
        modelId: data.modelId,
        url: data.url,
        apiKey: data.apiKey,
        provider: 'custom',
        supportsVision: data.supportsVision,
      };

      // 🔥 检查返回值：saveUserModel 现在 throw on failure
      const success = await ModelManager.saveUserModel(newModel);
      if (!success) {
        throw new Error(t('profile.modelSettings.saveFailedRetry'));
      }

      setCustomModels(prev => {
        const exists = prev.find(m => m.id === modelId);
        if (exists) {
          return prev.map(m => m.id === modelId ? newModel : m);
        } else {
          return [...prev, newModel];
        }
      });

      // 🔥 通知其他组件模型配置已更新
      window.dispatchEvent(new CustomEvent('models-updated'));

      setCustomDialogOpen(false);
    } catch (error) {
      console.error('[MODEL-SETTINGS] 保存自定义模型失败:', error);
      throw error;
    }
  };

  // ========== 搜索源 API Key 管理 ==========

  // 提取 URL 主体（域名）
  const extractUrlHost = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.toLowerCase();
    } catch {
      return '';
    }
  };

  // 从所有配置中查找相同 URL 主体的 API Key
  const findExistingApiKeyForUrl = (url: string): { apiKey: string; source: string } | null => {
    const targetHost = extractUrlHost(url);
    if (!targetHost) return null;

    // 从自定义模型中查找
    for (const model of customModels) {
      if (model.apiKey && extractUrlHost(model.url) === targetHost) {
        return { apiKey: model.apiKey, source: model.name };
      }
    }

    // 从搜索源中查找
    for (const provider of searchProviders) {
      if (provider.apiKey && extractUrlHost(provider.url) === targetHost) {
        return { apiKey: provider.apiKey, source: provider.name };
      }
    }

    return null;
  };

  const handleStartEditApiKey = (provider: SearchProviderConfig) => {
    setEditingApiKey(provider.id);
    setApiKeyInput(provider.apiKey || '');
    setShowApiKey(false);
  };

  const handleAutoFillApiKey = (apiKey: string) => {
    setApiKeyInput(apiKey);
  };

  const handleCancelEditApiKey = () => {
    setEditingApiKey(null);
    setApiKeyInput('');
    setShowApiKey(false);
  };

  const handleSaveApiKey = async (provider: SearchProviderConfig) => {
    if (!apiKeyInput.trim()) {
      toast.error(t('profile.modelSettings.inputApiKey'));
      return;
    }
    if (!checkLogin()) return;

    setSavingApiKey(true);
    try {
      const updatedProvider: SearchProviderConfig = {
        ...provider,
        apiKey: apiKeyInput.trim(),
      };

      await ModelManager.saveSearchProvider(updatedProvider);

      setSearchProviders(prev =>
        prev.map(p => (p.id === provider.id ? updatedProvider : p))
      );

      toast.success(t('profile.modelSettings.apiKeySaved'));
      setEditingApiKey(null);
      setApiKeyInput('');
    } catch (error) {
      console.error('[MODEL-SETTINGS] 保存 API Key 失败:', error);
      toast.error(t('profile.modelSettings.saveFailed'));
    } finally {
      setSavingApiKey(false);
    }
  };

  const renderBindingSelector = (subCategory: string, category: 'organization' | 'assistant') => {
    const bindingKey = `${category}.${subCategory}`;
    const selectedModelId = bindings[bindingKey];

    const handleBindingChange = (modelId: string) => {
      setBindings(prev => ({
        ...prev,
        [bindingKey]: modelId,
      }));
    };

    return (
      <div key={subCategory} className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg">
        <div className="flex-1">
          <Label className="text-sm font-medium">
            {subCategoryLabels[subCategory] || subCategory}
          </Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {subCategory}
          </p>
        </div>
        <Select value={selectedModelId || ''} onValueChange={handleBindingChange}>
          <SelectTrigger className="w-[280px]">
            <SelectValue placeholder={t('profile.modelSettings.selectModel')} />
          </SelectTrigger>
          <SelectContent>
            {customModels.length === 0 ? (
              <div className="px-2 py-2 text-sm text-gray-500">
                {t('profile.modelSettings.noModels')}
              </div>
            ) : (
              customModels.map(model => (
                <SelectItem key={model.id} value={model.id}>
                  <div className="flex items-center gap-2">
                    <span>{model.name}</span>
                    <ModelCategoryIcon modelId={model.modelId} supportsVision={model.supportsVision} />
                    {!model.apiKey && (
                      <Badge variant="destructive" className="text-[10px] px-1 py-0">
                        {t('profile.modelSettings.noApiKey')}
                      </Badge>
                    )}
                  </div>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
    );
  };

  const renderBindingConfig = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    }

    // 🔥 获取 agent 当前绑定的模型（取 summary/plan/execution 的第一个有效值）
    const getAgentModelId = () => {
      for (const subCategory of agentSubCategories) {
        const key = `organization.${subCategory}`;
        if (bindings[key]) return bindings[key];
      }
      return '';
    };

    // 🔥 处理 agent 模型变更，同时更新 summary/plan/execution
    const handleAgentBindingChange = (modelId: string) => {
      setBindings(prev => ({
        ...prev,
        'organization.summary': modelId,
        'organization.plan': modelId,
        'organization.execution': modelId,
      }));
    };

    const agentModelId = getAgentModelId();

    return (
      <div className="space-y-6">
        {/* 🔥 云端代理 - 合并 summary/plan/execution */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <MessageSquare className="h-4 w-4" />
                {t('profile.modelSettings.chatModel')}
              </div>
              <Select value={agentModelId} onValueChange={handleAgentBindingChange}>
                <SelectTrigger className="w-[280px]">
                  <SelectValue placeholder={t('profile.modelSettings.selectModel')} />
                </SelectTrigger>
                <SelectContent>
                  {/* 🔥 拦截媒体生成模型（视频/图片生成走专用工具，不能当对话主模型）；当前已绑定的仍显示，避免显示空白 */}
                  {customModels.filter(m => !isMediaGenerationModel(m.modelId) || m.id === agentModelId).length === 0 ? (
                    <div className="px-2 py-2 text-sm text-gray-500">
                      {t('profile.modelSettings.noChatModels')}
                    </div>
                  ) : (
                    customModels.filter(m => !isMediaGenerationModel(m.modelId) || m.id === agentModelId).map(model => (
                      <SelectItem key={model.id} value={model.id}>
                        <div className="flex items-center gap-2">
                          <span>{model.name}</span>
                          <ModelCategoryIcon modelId={model.modelId} supportsVision={model.supportsVision} />
                          {!model.apiKey && (
                            <Badge variant="destructive" className="text-[10px] px-1 py-0">
                              {t('profile.modelSettings.noApiKey')}
                            </Badge>
                          )}
                        </div>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <TokenUsageStats userId={userId} />
      </div>
    );
  };

  const renderCustomModelsList = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="space-y-2">
          {customModels.map(model => (
            <div
              key={model.id}
              className="flex items-center justify-between p-3 bg-muted/50 rounded-lg hover:bg-muted transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{model.name}</span>
                  <ModelCategoryIcon modelId={model.modelId} supportsVision={model.supportsVision} />
                  {!model.apiKey && (
                    <Badge variant="destructive" className="text-[10px]">
                      {t('profile.modelSettings.noApiKey')}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {model.url}
                </p>
              </div>
              <div className="flex items-center gap-1 ml-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => handleEditCustomModel(model)}
                >
                  <Edit2 className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => handleDeleteCustomModel(model.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
          {/* 🔥 列表末尾的添加按钮 */}
          <div
            onClick={handleAddCustomModel}
            className="flex items-center justify-center p-2 border border-dashed border-muted-foreground/30 rounded-lg bg-muted/20 hover:bg-muted/50 cursor-pointer transition-colors text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
          </div>
        </div>
      </div>
    );
  };

  const renderSearchProviderItem = (provider: SearchProviderConfig) => {
    const isEditing = editingApiKey === provider.id;
    const hasApiKey = !!provider.apiKey;

    if (isEditing) {
      // 检测是否有相同 URL 主体的现有 API Key
      const existingKeyInfo = !apiKeyInput ? findExistingApiKeyForUrl(provider.url) : null;

      return (
        <div
          key={provider.id}
          className="flex items-start gap-3 p-3 bg-primary/5 border border-primary/20 rounded-lg"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              {provider.type === 'search' ? (
                <Search className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Globe className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="font-medium">{provider.name}</span>
              <Badge variant="secondary" className="text-[10px]">
                {provider.providerType}
              </Badge>
            </div>
            <div className="flex flex-col gap-2">
              <div className="relative flex-1">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKeyInput}
                  onChange={e => setApiKeyInput(e.target.value)}
                  placeholder={t('profile.modelSettings.inputApiKey')}
                  className="pr-10"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {existingKeyInfo && (
                <button
                  type="button"
                  onClick={() => handleAutoFillApiKey(existingKeyInfo.apiKey)}
                  className="text-left text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-2 py-1.5 rounded transition-colors"
                >
                  <span className="font-medium">{t('profile.modelSettings.reuseApiKey', { source: existingKeyInfo.source })}</span>
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive"
              onClick={handleCancelEditApiKey}
              disabled={savingApiKey}
            >
              <AlertCircle className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-green-600"
              onClick={() => handleSaveApiKey(provider)}
              disabled={savingApiKey || !apiKeyInput.trim()}
            >
              {savingApiKey ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div
        key={provider.id}
        className={`flex items-center justify-between p-3 rounded-lg transition-colors ${
          hasApiKey ? 'bg-muted/50' : 'bg-yellow-50/50 border border-yellow-200'
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {provider.type === 'search' ? (
              <Search className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Globe className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="font-medium truncate">{provider.name}</span>
            <Badge variant="secondary" className="text-[10px]">
              {provider.providerType}
            </Badge>
            {!hasApiKey && provider.apiKeyRequired !== false && (
              <Badge variant="destructive" className="text-[10px]">
                {t('profile.modelSettings.noApiKey')}
              </Badge>
            )}
            {provider.apiKeyRequired === false && (
              <Badge variant="outline" className="text-[10px] text-green-600 border-green-200 bg-green-50">
                {t('profile.modelSettings.noConfigNeeded')}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{provider.url}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={() => handleStartEditApiKey(provider)}
        >
          <Edit2 className="h-4 w-4 mr-1" />
          {hasApiKey ? t('profile.modelSettings.edit') : t('profile.modelSettings.configure')}
        </Button>
      </div>
    );
  };

  const renderSearchProvidersList = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    }

    const searchProvidersList = searchProviders.filter(p => p.type === 'search' && p.providerType !== 'generic');
    const fetchProvidersList = searchProviders.filter(p => p.type === 'fetch' && p.providerType !== 'generic');
    const llmProviders = searchProviders.filter(p => p.providerType === 'generic');
    const configuredCount = searchProviders.filter(p => p.apiKey).length;

    return (
      <div className="space-y-6">
        {/* 状态概览 */}
        <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('profile.modelSettings.configured')}</span>
            <span className="text-lg font-semibold text-green-600">{configuredCount}</span>
            <span className="text-sm text-muted-foreground">{t('profile.modelSettings.searchProvidersCount', { count: searchProviders.length })}</span>
          </div>
          {configuredCount === 0 && (
            <Badge variant="destructive">{t('profile.modelSettings.needOneProvider')}</Badge>
          )}
        </div>

        {/* 搜索引擎 */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4" />
            <h3 className="text-sm font-medium">{t('profile.modelSettings.searchEngines')}</h3>
          </div>

          <div className="space-y-2">
            {searchProvidersList.map(provider => renderSearchProviderItem(provider))}
          </div>
        </div>

        {/* 网页爬取 */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4" />
            <h3 className="text-sm font-medium">{t('profile.modelSettings.webFetch')}</h3>
          </div>

          <div className="space-y-2">
            {fetchProvidersList.map(provider => renderSearchProviderItem(provider))}
          </div>
        </div>

        {/* LLM 安装的搜索源 */}
        {llmProviders.length === 0 ? null : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              <h3 className="text-sm font-medium">{t('profile.modelSettings.llmInstalled')}</h3>
              <span className="text-xs text-muted-foreground">({llmProviders.length})</span>
            </div>

            <div className="space-y-2">
              {llmProviders.map(provider => (
                <div
                  key={provider.id}
                  className="flex items-center justify-between p-3 rounded-lg border bg-card"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Sparkles className="h-4 w-4 text-purple-500" />
                    <div className="min-w-0">
                      <div className="font-medium text-sm truncate">{provider.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {provider.type} · {provider.providerType} · {provider.url}
                      </div>
                    </div>
                    {provider.apiKeyRequired === false || provider.requestTemplate?.authType === 'none' ? (
                      <Badge variant="secondary" className="bg-green-100 text-green-700 text-xs">
                        {t('profile.modelSettings.noConfigNeeded')}
                      </Badge>
                    ) : provider.apiKey ? (
                      <Badge variant="default" className="bg-green-100 text-green-700 text-xs">
                        {t('profile.modelSettings.configured')}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">
                        {t('profile.modelSettings.notConfigured')}
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteSearchProvider(provider.id)}
                    className="text-red-500 hover:text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 提示信息 */}
        <div className="text-xs text-muted-foreground bg-muted/50 p-3 rounded-lg space-y-1">
          <p>{t('profile.modelSettings.usageTitle')}</p>
          <ul className="list-disc list-inside space-y-1">
            <li>{t('profile.modelSettings.usageTip1')}</li>
            <li>{t('profile.modelSettings.usageTip2')}</li>
            <li>{t('profile.modelSettings.usageTip3')}</li>
          </ul>
        </div>
      </div>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('profile.modelSettings.title')}
          </DialogTitle>
        </DialogHeader>

          <Tabs defaultValue={defaultTab} className="flex-1 overflow-hidden flex flex-col">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="custom" className="flex items-center gap-2 data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:font-semibold">
                <Settings2 className="h-4 w-4" />
                {t('profile.modelSettings.tabMyModels')}
              </TabsTrigger>
              <TabsTrigger value="bindings" className="flex items-center gap-2 data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:font-semibold">
                <Link2 className="h-4 w-4" />
                {t('profile.modelSettings.tabBindings')}
              </TabsTrigger>
              {SEARCH_TAB_ENABLED && (
                <TabsTrigger value="search" className="flex items-center gap-2 data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:font-semibold">
                  <Search className="h-4 w-4" />
                  {t('profile.modelSettings.tabSearch')}
                </TabsTrigger>
              )}
            </TabsList>

            <div className="flex-1 overflow-y-auto mt-4 pr-2">
              <TabsContent value="bindings" className="space-y-4 m-0">
                {renderBindingConfig()}
              </TabsContent>

              <TabsContent value="custom" className="space-y-4 m-0">
                {renderCustomModelsList()}
              </TabsContent>

              {SEARCH_TAB_ENABLED && (
                <TabsContent value="search" className="space-y-4 m-0">
                  {renderSearchProvidersList()}
                </TabsContent>
              )}
            </div>
          </Tabs>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              {t('profile.modelSettings.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('profile.modelSettings.saving')}
                </>
              ) : (
                t('profile.modelSettings.save')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CustomModelDialog
        open={customDialogOpen}
        onOpenChange={setCustomDialogOpen}
        editingModel={editingCustomModel}
        existingModels={customModels}
        onSave={handleSaveCustomModel}
        isSystemModel={editingCustomModel?.id.startsWith('system-') ?? false}
      />


    </>
  );
};

export default ModelSettings;
