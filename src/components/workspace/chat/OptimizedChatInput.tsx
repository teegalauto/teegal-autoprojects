import React, { useRef, useEffect, useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ArrowUp, X, StopCircle, Paperclip, Loader2, ChevronDown, Plus, Settings, AtSign, Key, Check } from "lucide-react";
import { FileAttachment } from "../types/ChatTypes";
import FilePreviewList from "./FilePreviewList";
import { logger } from "@/utils/logger";
import { useTranslation } from "react-i18next";
import TextareaAutosize from 'react-textarea-autosize';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { ModelManager } from "@/utils/llm/ModelManager";
import { syncModelKeyCredentials } from "@/components/workspace/auth/modelKeySync";
import { SimpleUserModel, isMediaGenerationModel, ModelCategoryIcon, getMediaGenerationKind } from "@/components/profile/CustomModelDialog";
import { CodeBlockPreview, extractCodeBlockMarkers, CodeBlockData } from "./CodeBlockPreview";

/**
 * 🔥 资源引用：用户点名要使用的媒体模型 / 凭据
 * 发送时拼接进消息尾部，提示 LLM 优先使用这些资源
 */
export interface ResourceRef {
  type: 'model' | 'credential';
  key: string;           // 唯一键：model.id 或凭据 env_var
  name: string;          // 显示名
  modelId?: string;      // 模型专用：真实 modelId
  url?: string;          // 模型专用：API 端点（LLM 未开 webshell 时直接写代码调用用）
  kind?: 'video' | 'image' | 'image-edit'; // 媒体类型
  description?: string;  // 凭据描述
}

/** 凭据元信息（listCredentialsMeta 返回，不含明文值） */
interface CredentialMeta {
  env_var: string;
  description?: string;
}

/**
 * 🔥 合并模型列表：服务端最新套餐 + 已持久化模型（saved 里只保留已下架的套餐避免重复）
 * 模块级函数：loadModels 与 handleModelChange 绑定失败刷新共用
 */
const buildModelList = (): SimpleUserModel[] => {
  const saved = ModelManager.getUserModels();
  const packages = ModelManager.getPackageModels();
  const packageIds = new Set(packages.map(p => p.id));
  return [
    ...packages,
    ...saved.filter(m => !m.isPackage || !packageIds.has(m.id)),
  ];
};

interface OptimizedChatInputProps {
  input: string;
  files: FileAttachment[];
  isProcessing: boolean;
  conversationId?: string;
  userId?: string;

  // 事件处理
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onRemoveFile: (id: string) => void;
  onClickUpload: () => void;
  onSendMessage: () => void;
  onCancel: () => void;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFileAction?: (file: FileAttachment, action: string) => void;
  // 🔥 新增：打开模型设置弹窗
  onOpenModelSettings?: () => void;
  // 🔥 资源引用（模型/凭据）：状态由 Panel 持有，发送时拼接进消息
  selectedResources?: ResourceRef[];
  onResourcesChange?: (resources: ResourceRef[]) => void;
}

const OptimizedChatInput: React.FC<OptimizedChatInputProps> = ({
  input,
  files,
  isProcessing,
  conversationId,
  userId,
  // 事件处理
  onInputChange,
  onKeyDown,
  onRemoveFile,
  onClickUpload,
  onSendMessage,
  onCancel,
  onFileChange,
  onFileAction = () => {},
  onOpenModelSettings,
  selectedResources = [],
  onResourcesChange = () => {},

}) => {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [executionStartTime, setExecutionStartTime] = useState<number | null>(null);

  // 🔥 新增状态：模型选择相关
  const [customModels, setCustomModels] = useState<SimpleUserModel[]>([]);
  const [agentModelId, setAgentModelId] = useState<string>('');
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);

  // 🔥 资源引用相关：Popover 开关 + 凭据列表
  const [isResourcePopoverOpen, setIsResourcePopoverOpen] = useState(false);
  const [credentials, setCredentials] = useState<CredentialMeta[]>([]);
  const [credentialsLoading, setCredentialsLoading] = useState(false);

  // 🔥 跟踪执行开始时间
  useEffect(() => {
    if (isProcessing && !executionStartTime) {
      setExecutionStartTime(Date.now());
    } else if (!isProcessing && executionStartTime) {
      setExecutionStartTime(null);
    }
  }, [isProcessing, executionStartTime]);

  // 🔥 新增：加载模型数据
  // 🔥 用户身份变更（切换账号/登出）时同步刷新：登出清空模型列表与绑定选择，
  //    切换用户时 ModelManager.initialize(新userId) 会清缓存重载
  useEffect(() => {
    if (!userId) {
      // 登出：清空模型列表与绑定选择，避免残留上一用户数据
      setCustomModels([]);
      setAgentModelId('');
      return;
    }

    const loadModels = async () => {
      try {
        await ModelManager.initialize(userId);
        setCustomModels(buildModelList());

        // 获取 agent 绑定的模型（取 summary/plan/execution 的第一个有效值）
        const config = ModelManager.getUserConfig();
        const agentSubCategories = ['summary', 'plan', 'execution'];
        for (const subCategory of agentSubCategories) {
          const key = `organization.${subCategory}`;
          if (config[key]) {
            setAgentModelId(config[key]);
            break;
          }
        }
      } catch (error) {
        logger.error('[CHAT-INPUT] 加载模型失败:', error);
      }
    };
    
    loadModels();
    
    // 🔥 监听模型更新事件
    const handleModelsUpdated = () => {
      logger.info('[CHAT-INPUT] 收到模型更新事件，重新加载模型');
      loadModels();
    };
    
    window.addEventListener('models-updated', handleModelsUpdated);

    return () => {
      window.removeEventListener('models-updated', handleModelsUpdated);
    };
  }, [userId]);

  // 🔥 媒体生成模型（视频/图片生成、图片编辑）：供资源引用 Popover 展示
  const mediaModels = useMemo(
    () => customModels.filter(m => isMediaGenerationModel(m.modelId)),
    [customModels]
  );

  // 🔥 加载凭据元信息（仅名称/描述，不含明文值）：Popover 打开时刷新
  // 🔥 先跑模型 Key 镜像同步（幂等）：「模型/搜索源 API Key（自动同步）」凭据只在
  //    凭据管理页打开时才入库——用户从不打开凭据管理时，@ 列表会一直是空的
  useEffect(() => {
    if (!isResourcePopoverOpen || !userId) return;
    const loadCredentials = async () => {
      setCredentialsLoading(true);
      try {
        // 同步失败不阻塞列表加载（还能看到手工创建的凭据）
        await syncModelKeyCredentials(userId).catch(e => logger.error('[CHAT-INPUT] 模型 Key 同步失败:', e));
        const electron = (window as any).electron;
        if (!electron?.localStorage?.listCredentialsMeta) return;
        const creds = await electron.localStorage.listCredentialsMeta(userId);
        setCredentials(creds || []);
      } catch (error) {
        logger.error('[CHAT-INPUT] 加载凭据失败:', error);
      } finally {
        setCredentialsLoading(false);
      }
    };
    loadCredentials();
  }, [isResourcePopoverOpen, userId]);

  // 🔥 勾选/取消资源引用
  const toggleResource = (ref: ResourceRef) => {
    const exists = selectedResources.some(r => r.key === ref.key);
    if (exists) {
      onResourcesChange(selectedResources.filter(r => r.key !== ref.key));
    } else {
      onResourcesChange([...selectedResources, ref]);
    }
  };

  // 🔥 移除单个已选资源（chips 上的 X）
  const removeResource = (key: string) => {
    onResourcesChange(selectedResources.filter(r => r.key !== key));
  };

  // 🔥 新增：处理模型切换
  const handleModelChange = async (modelId: string) => {
    try {
      // 🔥 套餐模型：先以当前 JWT 保存/刷新记录，再建立绑定
      const target = customModels.find(m => m.id === modelId);
      if (target?.isPackage) {
        const ok = await ModelManager.bindPackageModel(target.modelId);
        if (ok) {
          setAgentModelId(modelId);
        } else {
          logger.error('[CHAT-INPUT] 套餐模型绑定失败（未登录、服务不可用或模型已下架）');
          // 🔥 绑定失败时刷新列表：若因模型下架失败，本地残留已被自愈清理，下拉立即与实际一致
          setCustomModels(buildModelList());
        }
        return;
      }

      // 同时更新 summary/plan/execution
      const newBindings = {
        'organization.summary': modelId,
        'organization.plan': modelId,
        'organization.execution': modelId,
      };

      const success = await ModelManager.updateMultipleModels(newBindings);
      if (success) {
        setAgentModelId(modelId);
      }
    } catch (error) {
      logger.error('[CHAT-INPUT] 切换模型失败:', error);
    }
  };

  // 🔥 新增：获取当前选中的模型名称
  const getCurrentModelName = () => {
    const model = customModels.find(m => m.id === agentModelId);
    return model?.name || '选择模型';
  };

  // 🔥 新增：触发文件输入
  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  // 🔥 新增：处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    onKeyDown(e);
  };

  // 🔥 新增：获取占位符文本（根据 isProcessing 状态动态变化）
  const placeholder = isProcessing
    ? "运行过程中可以按 Enter 发送消息进行上下文补充"
    : t('workspace.chatInput.placeholder');

  // 🔥 新增：禁用状态（仅禁用文件上传按钮，不禁用文本输入）
  const disabled = false; // 允许在 isProcessing 时继续输入

  // 🔥 新增：监听app引用插入事件
  useEffect(() => {
    const handleInsertAppReference = (event: CustomEvent) => {
      // 🔥 支持 projectId 和 appId 两种参数名
      const projectId = event.detail.projectId || event.detail.appId;
      if (projectId) {
        const textarea = textareaRef.current;
        const projectReference = `@projectid:${projectId}`;
        let newInput: string;
        
        // 🔥 检查输入是否以 @ 结尾，如果是则替换 @ 符号
        if (input.endsWith('@')) {
          newInput = input.slice(0, -1) + projectReference + ' ';
        } else {
          // 尝试获取光标位置，如果有效则插入到光标位置，否则追加到末尾
          if (textarea && textarea.selectionStart > 0) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const currentValue = textarea.value;
            
            if (start !== end) {
              // 替换选中的文本
              newInput = currentValue.substring(0, start) + projectReference + ' ' + currentValue.substring(end);
            } else {
              // 插入到光标位置
              newInput = currentValue.substring(0, start) + projectReference + ' ' + currentValue.substring(start);
            }
            
            // 插入后聚焦并设置光标位置
            setTimeout(() => {
              if (textarea) {
                textarea.focus();
                const newPos = start + projectReference.length + 1;
                textarea.setSelectionRange(newPos, newPos);
              }
            }, 0);
          } else {
            // 无法获取光标位置，追加到末尾
            newInput = input + ' ' + projectReference + ' ';
          }
        }
        
        // 创建一个模拟的事件对象来更新输入
        const simulatedEvent = {
          target: {
            value: newInput
          }
        } as React.ChangeEvent<HTMLTextAreaElement>;
        
        onInputChange(simulatedEvent);
      }
    };

    window.addEventListener('insertAppReference', handleInsertAppReference as EventListener);
    
    return () => {
      window.removeEventListener('insertAppReference', handleInsertAppReference as EventListener);
    };
  }, [input, onInputChange]);

  // 🔥 新增：监听数据库表引用插入事件
  useEffect(() => {
    const handleInsertTableReference = (event: CustomEvent) => {
      const { tableName } = event.detail;
      if (tableName) {
        const textarea = textareaRef.current;
        const tableReference = `@table:${tableName}`;
        let newInput: string;
        
        // 🔥 检查输入是否以 @ 结尾，如果是则替换 @ 符号
        if (input.endsWith('@')) {
          newInput = input.slice(0, -1) + tableReference + ' ';
        } else {
          // 尝试获取光标位置，如果有效则插入到光标位置，否则追加到末尾
          if (textarea && textarea.selectionStart > 0) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const currentValue = textarea.value;
            
            if (start !== end) {
              // 替换选中的文本
              newInput = currentValue.substring(0, start) + tableReference + ' ' + currentValue.substring(end);
            } else {
              // 插入到光标位置
              newInput = currentValue.substring(0, start) + tableReference + ' ' + currentValue.substring(start);
            }
            
            // 插入后聚焦并设置光标位置
            setTimeout(() => {
              if (textarea) {
                textarea.focus();
                const newPos = start + tableReference.length + 1;
                textarea.setSelectionRange(newPos, newPos);
              }
            }, 0);
          } else {
            // 无法获取光标位置，追加到末尾
            newInput = input + ' ' + tableReference + ' ';
          }
        }
        
        // 创建一个模拟的事件对象来更新输入
        const simulatedEvent = {
          target: {
            value: newInput
          }
        } as React.ChangeEvent<HTMLTextAreaElement>;
        
        onInputChange(simulatedEvent);
      }
    };

    window.addEventListener('insertTableReference', handleInsertTableReference as EventListener);

    return () => {
      window.removeEventListener('insertTableReference', handleInsertTableReference as EventListener);
    };
  }, [input, onInputChange]);

  // 🔥 新增：监听 DSE 面板"添加到对话"事件——以 @ 引用形式在光标处插入数据集，并附默认训练指令
  useEffect(() => {
    const handleInsertDatasetReference = (event: CustomEvent) => {
      const { fileName, ossUrl } = event.detail || {};
      if (!fileName || !ossUrl) return;
      const ref = `@${fileName} (${ossUrl}) ${t('workspace.chatInput.datasetRefPrompt')}`;
      const textarea = textareaRef.current;
      // 光标处内联插入；无光标信息则追加到末尾
      const start = textarea?.selectionStart ?? input.length;
      const end = textarea?.selectionEnd ?? input.length;
      const newInput = input.slice(0, start) + ref + input.slice(end);
      const simulatedEvent = {
        target: { value: newInput },
      } as React.ChangeEvent<HTMLTextAreaElement>;
      onInputChange(simulatedEvent);
      // 聚焦并把光标移到引用之后
      const pos = start + ref.length;
      setTimeout(() => {
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(pos, pos);
        }
      }, 0);
    };

    window.addEventListener('insertDatasetReference', handleInsertDatasetReference as EventListener);

    return () => {
      window.removeEventListener('insertDatasetReference', handleInsertDatasetReference as EventListener);
    };
  }, [input, onInputChange, t]);

  // 🔥 新增：监听标注消息插入事件
  useEffect(() => {
    const handleInsertAnnotationMessage = (event: CustomEvent) => {
      const { message } = event.detail;
      if (message) {
        const textarea = textareaRef.current;

        if (textarea) {
          const start = textarea.selectionStart;
          const end = textarea.selectionEnd;
          const currentValue = textarea.value;

          let newValue: string;
          let newCursorPos: number;

          if (start !== end) {
            // 有选中文本，替换选中的内容
            newValue = currentValue.substring(0, start) + message + currentValue.substring(end);
            newCursorPos = start + message.length;
          } else if (currentValue.length === 0) {
            // 输入框为空，直接插入
            newValue = message;
            newCursorPos = message.length;
          } else {
            // 在光标位置插入，如果光标不在开头则先加换行
            const prefix = start > 0 ? currentValue.substring(0, start) + '\n\n' : currentValue.substring(0, start);
            newValue = prefix + message + currentValue.substring(start);
            newCursorPos = prefix.length + message.length;
          }

          const simulatedEvent = {
            target: {
              value: newValue
            }
          } as React.ChangeEvent<HTMLTextAreaElement>;

          onInputChange(simulatedEvent);

          // 聚焦并设置光标位置
          setTimeout(() => {
            if (textarea) {
              textarea.focus();
              textarea.setSelectionRange(newCursorPos, newCursorPos);
            }
          }, 0);
        } else {
          // 无法获取文本框，追加到现有内容
          const newValue = input ? input + '\n\n' + message : message;
          const simulatedEvent = {
            target: {
              value: newValue
            }
          } as React.ChangeEvent<HTMLTextAreaElement>;
          onInputChange(simulatedEvent);
        }
      }
    };

    window.addEventListener('insertAnnotationMessage', handleInsertAnnotationMessage as EventListener);

    return () => {
      window.removeEventListener('insertAnnotationMessage', handleInsertAnnotationMessage as EventListener);
    };
  }, [input, onInputChange]);

  // 🔥 提取代码块标记（仅用于视觉预览）
  const { markers, displayText } = useMemo(() => {
    return extractCodeBlockMarkers(input);
  }, [input]);
  
  // 🔥 移除代码块
  const handleRemoveCodeBlock = (markerId: string) => {
    // 找到对应的标记
    const marker = markers.find(m => m.id === markerId);
    if (!marker) return;
    
    // 从 input 中移除
    const newInput = input.slice(0, marker.startIndex) + input.slice(marker.endIndex).trim();
    
    const simulatedEvent = {
      target: { value: newInput }
    } as React.ChangeEvent<HTMLTextAreaElement>;
    
    onInputChange(simulatedEvent);
  };
  
  // 🔥 处理 textarea 输入（保留代码块标记）
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newUserText = e.target.value;
    
    // 如果有代码块标记，需要合并
    if (markers.length > 0) {
      // 重建完整文本：标记 + 用户文本
      const markerTexts = markers.map(m => {
        const data = m.data;
        return `[[CODE_BLOCK:${btoa(encodeURIComponent(JSON.stringify(data)))}]]`;
      }).join('');
      
      const fullInput = markerTexts + ' ' + newUserText;
      
      const simulatedEvent = {
        target: { value: fullInput }
      } as React.ChangeEvent<HTMLTextAreaElement>;
      
      onInputChange(simulatedEvent);
    } else {
      onInputChange(e);
    }
  };

  // 🔥 新增：监听来自PreviewViewer的错误处理事件
  useEffect(() => {
    const handleSendToChatInput = (event: CustomEvent) => {
      const message = event.detail;
      if (message) {
        const newInput = input + ' ' + message + ' ';
        
        // 创建一个模拟的事件对象来更新输入
        const simulatedEvent = {
          target: {
            value: newInput
          }
        } as React.ChangeEvent<HTMLTextAreaElement>;
        
        onInputChange(simulatedEvent);
      }
    };

    window.addEventListener('sendToChatInput', handleSendToChatInput as EventListener);

    // 🔥 跨窗口通道：独立 viewer 窗口里"添加到对话"经 localStorage storage 事件传来
    const handleStorageSignal = (e: StorageEvent) => {
      if (e.key === 'sendToChatInputSignal' && e.newValue) {
        try {
          const { message } = JSON.parse(e.newValue);
          if (message) {
            const newInput = input + ' ' + message + ' ';
            const simulatedEvent = {
              target: { value: newInput }
            } as React.ChangeEvent<HTMLTextAreaElement>;
            onInputChange(simulatedEvent);
          }
        } catch { /* 忽略坏信号 */ }
      }
    };
    window.addEventListener('storage', handleStorageSignal);

    return () => {
      window.removeEventListener('sendToChatInput', handleSendToChatInput as EventListener);
      window.removeEventListener('storage', handleStorageSignal);
    };
  }, [input, onInputChange]);

  // 移除重复的日志，仅在调试时启用
  // logger.debug("[OPTIMIZED-INPUT] AgentForm状态", { pendingAgent: pendingAgent?.name, agentFormVisible });

  return (
    <div className="pt-2 relative">
      {/* 文件预览区域 - 紧跟在输入框上方，增加左边距 */}
      {files.length > 0 && (
        <div className="mb-3 pl-2">
          <FilePreviewList
            files={files}
            onRemoveFile={onRemoveFile}
          />
        </div>
      )}

      {/* 🔥 新增：代码块预览区域 */}
      {markers.length > 0 && (
        <div className="mb-3 pl-2 pr-2">
          {markers.map((marker) => (
            <CodeBlockPreview
              key={marker.id}
              data={marker.data}
              onRemove={() => handleRemoveCodeBlock(marker.id)}
            />
          ))}
        </div>
      )}

      {/* 🔥 资源引用标签（媒体模型/凭据）：发送时拼接进消息提示 LLM */}
      {selectedResources.length > 0 && (
        <div className="mb-3 pl-2 pr-2 flex flex-wrap gap-1.5">
          {selectedResources.map((res) => (
            <span
              key={res.key}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-50 border border-purple-200 text-[11px] text-purple-700 max-w-full"
            >
              {res.type === 'model' ? (
                <ModelCategoryIcon modelId={res.modelId || res.name} className="h-3 w-3 shrink-0" />
              ) : (
                <Key className="h-3 w-3 shrink-0 text-amber-500" />
              )}
              <span className="truncate max-w-[160px]">{res.name}</span>
              <button
                type="button"
                onClick={() => removeResource(res.key)}
                className="shrink-0 text-purple-400 hover:text-purple-700"
                aria-label={`移除 ${res.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 输入容器 - 简洁高级的白色卡片样式 */}
      <div
        className="mt-2 mb-4 mx-2 cursor-text bg-white rounded-2xl border border-gray-200 shadow-md hover:shadow-xl hover:border-gray-300 transition-all duration-200"
        onClick={(e) => {
          // 🔥 点击容器时聚焦到 textarea，除非点击的是按钮区域
          const target = e.target as HTMLElement;
          if (!target.closest('button')) {
            textareaRef.current?.focus();
          }
        }}
      >
        {/* 输入框区域 */}
        <div className="relative px-2 pt-3">
          <TextareaAutosize
            ref={textareaRef}
            value={displayText}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            className="w-full resize-none border-0 bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-0 max-h-64 break-words overflow-wrap-anywhere placeholder:text-gray-400"
            minRows={1}
            maxRows={15}
            style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
          />
        </div>

        {/* 按钮区域 */}
        <div className="flex items-center justify-between px-3 py-2 pb-3">
          <div className="flex items-center space-x-2">
            {/* 文件上传按钮 - 移除边框样式 */}
            <Button
              variant="ghost"
              size="icon"
              onClick={triggerFileInput}
              disabled={disabled}
              className="h-8 w-8 p-0 text-gray-500 hover:text-gray-700 hover:bg-gray-100"
            >
              <Paperclip size={16} />
            </Button>

            {/* 🔥 资源引用按钮：点名媒体模型/凭据，发送时提示 LLM 优先使用 */}
            <Popover open={isResourcePopoverOpen} onOpenChange={setIsResourcePopoverOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={isProcessing}
                  title="引用媒体模型/凭据"
                  className={`h-8 w-8 p-0 hover:bg-gray-100 ${selectedResources.length > 0 ? 'text-purple-600 bg-purple-50 hover:bg-purple-100' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  <AtSign size={16} />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-0">
                <div className="max-h-[320px] overflow-y-auto py-1">
                  {/* 媒体模型组 */}
                  <div className="px-3 py-1.5 text-[11px] font-medium text-gray-400">媒体模型（视频/图片生成）</div>
                  {mediaModels.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-gray-400">暂无媒体模型，请先在「我的模型」中添加</div>
                  ) : (
                    mediaModels.map(model => {
                      const kind = getMediaGenerationKind(model.modelId);
                      const resKey = `model:${model.id}`;
                      const checked = selectedResources.some(r => r.key === resKey);
                      return (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => toggleResource({
                            type: 'model',
                            key: resKey,
                            name: model.name,
                            modelId: model.modelId,
                            url: model.url,
                            kind: kind || undefined,
                          })}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                            checked ? 'bg-purple-50 text-purple-700' : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          <ModelCategoryIcon modelId={model.modelId} className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate flex-1">{model.name}</span>
                          <span className="text-[10px] text-gray-400 shrink-0">
                            {kind === 'video' ? '视频' : kind === 'image-edit' ? '图编' : '图片'}
                          </span>
                          {checked && <Check className="h-3.5 w-3.5 shrink-0 text-purple-600" />}
                        </button>
                      );
                    })
                  )}

                  <div className="my-1 border-t border-gray-100" />

                  {/* 凭据组 */}
                  <div className="px-3 py-1.5 text-[11px] font-medium text-gray-400">凭据（API Key 等）</div>
                  {credentialsLoading ? (
                    <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-gray-400">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      加载中…
                    </div>
                  ) : credentials.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-gray-400">暂无凭据，请先在「凭据管理」中添加</div>
                  ) : (
                    credentials.map(cred => {
                      const resKey = `cred:${cred.env_var}`;
                      const checked = selectedResources.some(r => r.key === resKey);
                      return (
                        <button
                          key={cred.env_var}
                          type="button"
                          onClick={() => toggleResource({
                            type: 'credential',
                            key: resKey,
                            name: cred.env_var,
                            description: cred.description,
                          })}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                            checked ? 'bg-purple-50 text-purple-700' : 'text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          <Key className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                          <span className="truncate flex-1">{cred.env_var}</span>
                          {checked && <Check className="h-3.5 w-3.5 shrink-0 text-purple-600" />}
                        </button>
                      );
                    })
                  )}
                </div>
                {selectedResources.length > 0 && (
                  <div className="border-t border-gray-100 px-3 py-1.5 text-[11px] text-gray-400">
                    已选 {selectedResources.length} 项，发送时将提示 AI 优先使用
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>

          {/* 🔥 模型选择下拉 + 发送按钮 */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* 🔥 模型选择下拉菜单 - 始终显示，processing 时禁用 */}
            <DropdownMenu open={isModelMenuOpen} onOpenChange={setIsModelMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isProcessing}
                  className="h-8 px-2 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 flex items-center gap-1"
                >
                  <span className="max-w-[140px] truncate">{getCurrentModelName()}</span>
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72 max-h-[300px] overflow-y-auto">
                {/* 🔥 拦截媒体生成模型：视频/图片生成走专用工具，不能当对话主模型；当前已绑定的仍显示 */}
                {(() => {
                  const chatModels = customModels.filter(m => !isMediaGenerationModel(m.modelId) || m.id === agentModelId);
                  const packageModels = chatModels.filter(m => m.isPackage);
                  const ownModels = chatModels.filter(m => !m.isPackage);

                  const renderItem = (model: SimpleUserModel) => (
                    <DropdownMenuItem
                      key={model.id}
                      onClick={() => handleModelChange(model.id)}
                      className="flex items-center justify-between cursor-pointer"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className="truncate">{model.name}</span>
                        {model.isPackage && model.outputRate !== undefined && (
                          <Badge variant="secondary" className="text-[10px] text-blue-600 shrink-0">{(model.outputRate / 50).toFixed(2).replace(/\.?0+$/, '')}x</Badge>
                        )}
                        <ModelCategoryIcon modelId={model.modelId} supportsVision={model.supportsVision} />
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {agentModelId === model.id && (
                          <Check className="h-3.5 w-3.5 text-green-600 shrink-0" />
                        )}
                        {!model.isPackage && !model.apiKey && (
                          <Badge variant="destructive" className="text-[10px]">未配置</Badge>
                        )}
                      </div>
                    </DropdownMenuItem>
                  );

                  if (chatModels.length === 0) {
                    return (
                      <div className="px-3 py-2 text-sm text-gray-500">
                        暂无可用对话模型
                      </div>
                    );
                  }

                  return (
                    <>
                      {packageModels.length > 0 && (
                        <>
                          <div className="px-3 py-1 text-[10px] text-gray-400">内置模型</div>
                          {packageModels.map(renderItem)}
                          <DropdownMenuSeparator />
                          <div className="px-3 py-1 text-[10px] text-gray-400">自定义模型</div>
                        </>
                      )}
                      {ownModels.map(renderItem)}
                    </>
                  );
                })()}
                
                <DropdownMenuSeparator />
                
                {/* 添加模型链接 */}
                <DropdownMenuItem
                  onClick={onOpenModelSettings}
                  className="flex items-center gap-2 cursor-pointer text-blue-600"
                >
                  <Plus className="h-4 w-4" />
                  <span>添加模型</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            
            {/* 发送/取消按钮 */}
            {isProcessing ? (
              <Button
                variant="default"
                size="sm"
                onClick={onCancel}
                className="h-8 w-8 p-0 bg-red-600 hover:bg-red-700"
                title="取消执行"
              >
                <StopCircle className="h-4 w-4" />
              </Button>
            ) : (
              <button
                onClick={onSendMessage}
                disabled={!input.trim() && files.length === 0}
                className="h-8 w-8 p-0 bg-black hover:bg-gray-800 border-0 text-white disabled:bg-black disabled:opacity-100 rounded-md flex items-center justify-center transition-colors"
                title="发送"
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 隐藏的文件输入 */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFileChange} accept="*/*" />
    </div>
  );
};

export default OptimizedChatInput;