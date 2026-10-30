import React, { useEffect, useCallback, useState } from 'react';
import { Message, FileAttachment } from '../types/ChatTypes';
import { useChatInput } from '@/hooks/workspace/useChatInput';
import ChatHeader from './ChatHeader';
import ChatMessages from './ChatMessages';
import OptimizedChatInput, { ResourceRef } from './OptimizedChatInput';
import { logger } from '@/utils/logger';
import { useAuth } from '@/context/AuthContext';
import { ModelSettings } from '@/components/profile/ModelSettings';
import { expandAllCodeBlocks } from './CodeBlockPreview';

import i18n from '@/i18n/index';
import { toast } from 'sonner';

export type { Message } from '../types/ChatTypes';

// 语言偏好检测：只要出现中文字符或中文标点，即认定为中文，否则英文
const CHINESE_CHAR_REGEX = /[\u4E00-\u9FFF]/;
const CHINESE_PUNCT_REGEX = /[，。！？；：、“”‘’（）《》]/;
const detectPreferredLanguageFromText = (text: string): 'zh' | 'en' => {
  if (!text || !text.trim()) return 'en';
  return (CHINESE_CHAR_REGEX.test(text) || CHINESE_PUNCT_REGEX.test(text)) ? 'zh' : 'en';
};

// 简化的 Agent 类型
interface Agent {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
}

interface OptimizedChatPanelProps {
  messages: Message[];
  onSendMessage: (content: string, files: FileAttachment[], selectedAgent?: Agent, parameters?: Record<string, any>) => void;
  isProcessing: boolean;
  onCancel: () => void;
  currentConversationId?: string | null;
  // 消息分页加载
  onLoadMoreMessages?: () => Promise<boolean>;
  // 打开/关闭 Desktop面板
  onOpenDesktop?: () => void;
  isDesktopOpen?: boolean;
  // 🔥 打开/关闭 数据环境面板
  onOpenDSE?: () => void;
  isDSEOpen?: boolean;
}

/**
 * 优化聊天面板
 */
const OptimizedChatPanel: React.FC<OptimizedChatPanelProps> = React.memo(({
  messages,
  onSendMessage,
  isProcessing,
  onCancel,
  currentConversationId,
  onLoadMoreMessages,
  onOpenDesktop,
  isDesktopOpen,
  onOpenDSE,
  isDSEOpen
}) => {


  const { user, isAuthenticated } = useAuth();
  
  // 🔥 新增：模型设置弹窗状态
  const [isModelSettingsOpen, setIsModelSettingsOpen] = useState(false);

  // 🔥 资源引用（媒体模型/凭据）：发送时拼接进消息，提示 LLM 优先使用
  const [selectedResources, setSelectedResources] = useState<ResourceRef[]>([]);

  const {
    input,
    setInput,
    files,
    textareaRef,
    fileInputRef,
    handleFileChange,
    removeFile,
    clearInput,
    checkFilesUploadStatus,
    insertFileReference
  } = useChatInput(currentConversationId);

  // 🔥 新增：监听文件引用插入事件
  useEffect(() => {
    const handleInsertFileReference = (event: CustomEvent) => {
      const { file } = event.detail;
      if (file) {
        insertFileReference(file);
      }
    };

    window.addEventListener('insertFileReference', handleInsertFileReference as EventListener);
    
    return () => {
      window.removeEventListener('insertFileReference', handleInsertFileReference as EventListener);
    };
  }, [insertFileReference]);

  // 统一的消息发送处理
  const handleSendMessage = useCallback(() => {
    // 🔥 展开代码块标记为完整格式
    const messageToSend = expandAllCodeBlocks(input.trim());
    
    if (messageToSend || (files && files.length > 0)) {
      // 🔥 检查文件上传状态
      const uploadStatus = checkFilesUploadStatus();
      if (!uploadStatus.allUploaded) {
        const { uploadingCount, errorCount } = uploadStatus;
        if (uploadingCount > 0) {
          toast.warning(`请稍候，还有 ${uploadingCount} 个文件正在上传中...`);
        } else if (errorCount > 0) {
          toast.error(`有 ${errorCount} 个文件上传失败，请删除后重试`);
        }
        return;
      }
      
      logger.info('[OPTIMIZED-PANEL-CHAT] 发送消息', {
        messageLength: messageToSend.length,
        fileCount: files?.length || 0
      });
      
      try {
        const lang = detectPreferredLanguageFromText(messageToSend);
        const stored = localStorage.getItem('preferredLanguage');
        if (lang === 'zh') {
          if (stored !== 'zh') {
            localStorage.setItem('preferredLanguage','zh');
            localStorage.setItem('i18nextLng','zh');
            i18n.changeLanguage('zh').catch(() => {});
          }
        } else {
          if (!stored || stored !== 'zh') {
            localStorage.setItem('preferredLanguage','en');
            localStorage.setItem('i18nextLng','en');
            i18n.changeLanguage('en').catch(() => {});
          }
        }
        // TODO: 通过 home-web API 更新语言偏好
        if (isAuthenticated && user?.id) {
          const persistKey = `preferredLanguagePersisted:${user.id}`;
          localStorage.setItem(persistKey, '1');
        }
      } catch {}

      // 🔥 拼接资源引用（媒体模型/凭据）：提示 LLM 优先使用，风格与文件附件注入一致
      let finalMessage = messageToSend;
      if (selectedResources.length > 0) {
        const modelLines = selectedResources
          .filter(r => r.type === 'model')
          .map(r => {
            const kindLabel = r.kind === 'video' ? '视频生成' : r.kind === 'image-edit' ? '图片编辑' : '图片生成';
            const urlPart = r.url ? ` | 端点: ${r.url}` : '';
            return `- ${r.name}（${kindLabel}）| modelId: ${r.modelId}${urlPart}`;
          });
        const credLines = selectedResources
          .filter(r => r.type === 'credential')
          .map(r => `- ${r.name}${r.description ? ` | 描述: ${r.description}` : ''}`);

        const sections: string[] = [];
        if (modelLines.length > 0) {
          sections.push(
            `引用媒体模型：\n${modelLines.join('\n')}`
          );
        }
        if (credLines.length > 0) {
          sections.push(
            `引用凭据（项目或本地代码中用 os.environ['凭据名'] 引用会自动注入）：\n${credLines.join('\n')}`
          );
        }
        finalMessage = `${messageToSend}\n\n--- 用户主动引用资源 ---\n${sections.join('\n\n')}`;
      }

      onSendMessage(finalMessage, files || [], null);
      clearInput();
      // 🔥 发送后清空资源引用
      setSelectedResources([]);
    }
  }, [input, files, onSendMessage, clearInput, checkFilesUploadStatus, isAuthenticated, user, selectedResources]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 🔥 只处理 Enter 键（不按 Shift），允许 Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
    // 🔥 Shift+Enter 不做任何处理，允许默认的换行行为
  }, [handleSendMessage]);

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden">
      <ChatHeader
        userId={user?.id}
        userEmail={user?.email}
        onOpenDesktop={onOpenDesktop}
        isDesktopOpen={isDesktopOpen}
        onOpenDSE={onOpenDSE}
        isDSEOpen={isDSEOpen}
      />

      <ChatMessages
        messages={messages}
        isProcessing={isProcessing}
        // 🔥 移除 onFileView 和 onFileDownload，让 FilePreviewManager 直接调用 MediaViewer
        currentConversationId={currentConversationId}
        onLoadMore={onLoadMoreMessages} // 🔥 新增：传递加载更多回调
      />
      
      <OptimizedChatInput
        input={input}
        files={files || []}
        isProcessing={isProcessing}
        conversationId={currentConversationId}
        userId={user?.id}
        // 事件处理
        onInputChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onRemoveFile={removeFile}
        onClickUpload={() => fileInputRef.current?.click()}
        onSendMessage={handleSendMessage}
        onCancel={onCancel}
        onFileChange={handleFileChange}
        onOpenModelSettings={() => setIsModelSettingsOpen(true)}
        // 🔥 资源引用（媒体模型/凭据）
        selectedResources={selectedResources}
        onResourcesChange={setSelectedResources}
      />
      
      {/* 🔥 模型设置弹窗（从聊天输入框"添加模型"进入时，默认直达"我的模型"页） */}
      <ModelSettings
        open={isModelSettingsOpen}
        onOpenChange={setIsModelSettingsOpen}
        userId={user?.id || ''}
        defaultTab="custom"
      />
    </div>
  );
});

OptimizedChatPanel.displayName = 'OptimizedChatPanel';

export default OptimizedChatPanel;
