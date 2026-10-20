import { FileAttachment, Message } from "@/components/workspace/types/ChatTypes";
import {
  createNewChatHandler,
} from "./handlers/executionHandlers";
import { createSelectHistoryHandler } from "./handlers/execution/selectHistoryHandler";
import { loadMessagesForConversation } from "./handlers/messageHandlers";
import { generateTitle } from "./utils/titleUtils";

import { SummaryHandler, SummaryInput, SummaryHandlerCallbacks } from "./handlers/SummaryHandler";
import { splitRounds, renderRoundLines } from "@/utils/auto/context/RoundMemory";
import { MessageFactory } from "./utils/messageFactory";
import { MessagePersistence } from "./handlers/message/MessagePersistence";
import { globalAbortManager } from "@/utils/abort/AbortManager";
import { useAuth } from "@/context/AuthContext";
import { useRef, useEffect } from "react";

export const useWorkspaceHandlers = (workspace: any) => {
  const authContext = useAuth();
  const userEmail = authContext.user?.email;

  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  // 🔥🔥🔥 关键修复：使用 Set 跟踪已处理的 callId，确保正确区分新消息和更新
  const processedCallIdsRef = useRef<Set<string>>(new Set());

  const loadMessagesWrapper = (conversationId: string) =>
    loadMessagesForConversation(conversationId, workspace.setMessages);

  /**
   * 🔥 简化的回调工厂 - 只保留 onMessage
   */
  const createSimpleCallbacks = (conversationId?: string): SummaryHandlerCallbacks => {
    return {
      /**
       * 🔥 核心回调：添加或更新消息
       * @param callId API 调用 ID，用于关联同一条消息的更新
       * @param message 消息数据（部分字段）
       */
      onMessage: async (callId: string, message: Partial<{
        role: 'user' | 'assistant' | 'system' | 'auto';
        content: string;
        apiRole: 'summarizer' | 'reactor';
        result: string;
        status: 'pending' | 'streaming' | 'completed' | 'failed';
        iconText: string;
        metadata: Record<string, any>;
        sessionId: string;
        memory?: string;
      }>) => {

        // 🔥🔥🔥 关键修复：使用 Set 跟踪已处理的 callId，确保正确区分新消息和更新
        // 这是同步操作，可以确保即使 onMessage 被快速连续调用，也能正确判断
        const isNewMessage = !processedCallIdsRef.current.has(callId);

        // 🔥 在 setMessages 回调中处理
        workspaceRef.current.setMessages((prev: any[]) => {
          // 🔥 再次检查，确保状态一致性
          const existingIndex = prev.findIndex(
            (msg: any) => msg.callId === callId
          );

          if (existingIndex >= 0) {
            // 🔥 更新现有消息 - 只更新有值的字段，避免覆盖已有数据
            // 但 sessionId 字段特殊处理：undefined 表示清理 sessionId
            const filteredUpdate = Object.fromEntries(
              Object.entries(message).filter(([k, v]) => {
                // sessionId 字段：undefined 表示清理，需要保留
                if (k === 'sessionId') return true;
                // 其他字段：过滤掉 undefined 和空字符串
                return v !== undefined && v !== '';
              })
            );
            return prev.map((msg, index) =>
              index === existingIndex
                ? { ...msg, ...filteredUpdate }
                : msg
            );
          } else {
            // 🔥 创建新消息
            const newMessage: Message = {
              id: `auto_${Date.now()}_${Math.random().toString(36).substring(2)}`,
              role: 'auto',
              content: message.content || '',
              timestamp: new Date(),
              apiRole: message.apiRole,
              result: message.result,
              status: message.status,
              callId: callId,
              iconText: message.iconText,
              sessionId: message.sessionId,
              memory: message.memory,
              metadata: {
                ...message.metadata,
                autoMode: true,
              },
            };
            return [...prev, newMessage];
          }
        });

        // 🔥 异步更新数据库
        if (conversationId) {
          // 🔥 streaming 消息不保存到数据库，只在前端展示
          // 不标记为已处理，等 completed/failed 时作为新消息创建
          if (message.status === 'streaming') {
          } else if (isNewMessage) {
            // 🔥 新消息（completed/failed）：保存完整消息
            processedCallIdsRef.current.add(callId);

            // 🔥 新消息：保存完整消息
            const newMessage: Message = {
              id: `auto_${Date.now()}_${Math.random().toString(36).substring(2)}`,
              role: 'auto',
              content: message.content || '',
              timestamp: new Date(),
              apiRole: message.apiRole,
              result: message.result,
              status: message.status,
              callId: callId,
              iconText: message.iconText,
              sessionId: message.sessionId,
              memory: message.memory,
              metadata: {
                ...message.metadata,
                autoMode: true,
              },
            };
            MessagePersistence.saveMessageAsync(conversationId, newMessage).catch((error) => {
              console.error('❌ [WORKSPACE-HANDLERS] 消息保存异常:', { callId, error });
            });
          } else {
            // 🔥 更新消息：只更新有值的字段
            const dbUpdate: any = {};
            if (message.result !== undefined && message.result !== '') {
              dbUpdate.result = message.result;
            }
            if (message.status !== undefined) {
              dbUpdate.status = message.status;
            }
            if (message.iconText !== undefined && message.iconText !== '') {
              dbUpdate.iconText = message.iconText;
            }
            if (message.content !== undefined && message.content !== '') {
              dbUpdate.content = message.content;
            }
            if (message.memory !== undefined) {
              dbUpdate.memory = message.memory;
            }
            if (Object.keys(dbUpdate).length > 0) {
              MessagePersistence.updateMessageByCallId(conversationId, callId, dbUpdate).catch((error) => {
                console.error('❌ [WORKSPACE-HANDLERS] 消息更新异常:', { callId, error });
              });
            }
          }
        }
      },

      onError: async (error: string) => {
        console.error("❌ [WORKSPACE-HANDLERS] 错误:", { error });
        const errorMessage = MessageFactory.createErrorMessage("Auto执行失败", error);
        workspaceRef.current.setMessages((prev: any[]) => [...prev, errorMessage]);
      },
    };
  };

  const handleAutoModeExecution = async (
    content: string,
    conversationId: string,
    currentMessages: any[] = []
  ) => {

    try {
      globalAbortManager.start(conversationId);

      const effectiveUserId = workspace.userId || `guest_${Math.random().toString(36).slice(2, 8)}`;

      // 🔥 从凭据表读取 param 型参数：对话历史窗口的回合数（一个回合 = 一条 userquery + 它引发的全部消息），
      // 默认 5，按值执行（非上限）。实测 5 回合上下文前缀稳定，上游缓存命中可达 60%-80%；窗口越长前缀漂移越大命中越差
      let contextHistoryRounds = 5;
      try {
        const electron = (window as any).electron;
        if (electron?.localStorage?.getCredentialByName) {
          const param = await electron.localStorage.getCredentialByName('contextHistoryRounds', effectiveUserId);
          if (param && param.type === 'param') {
            const parsed = parseInt(param.value, 10);
            if (!isNaN(parsed) && parsed > 0) contextHistoryRounds = parsed;
          }
        }
      } catch (error) {
        console.warn('[AUTO-MODE] 读取 contextHistoryRounds 参数失败，使用默认值 5:', error);
      }

      // 🔥 提取特定 session 的上下文消息
      const extractSessionContext = (sessionId: string): Array<{ apiRole: string; content: string; result?: string }> => {
        
        // 🔥 使用 workspaceRef 获取最新的消息状态
        const currentWorkspace = workspaceRef.current;
        const messagesToUse = currentWorkspace?.messages || [];
        
        // 🔥 查看所有消息的 sessionId
        const allSessionIds = [...new Set(messagesToUse.map((m: any) => m.sessionId).filter(Boolean))];
        
        const filtered = messagesToUse
          .filter((msg: any) => {
            const match = msg.sessionId === sessionId;
            return match;
          })
          .filter((msg: any) => {
            // 🔥 过滤掉 streaming 状态的流式消息
            if (msg.status === 'streaming') {
              return false;
            }
            // 🔥 保留有 content 或 result 的消息
            if (!msg.content && !msg.result) {
              return false;
            }
            return true;
          })
          .map((msg: any) => ({
            apiRole: msg.apiRole || 'unknown',
            content: msg.content || '',
            result: msg.result,
          }));
        
        return filtered;
      };

      const extractConversationHistory = async (): Promise<Array<{ role: string; content: string; sessionId?: string; apiRole?: string; timestamp?: number }>> => {
        // 🔥 总是从 workspaceRef 获取最新的消息，确保实时更新
        const currentWorkspace = workspaceRef.current;
        let messagesToUse = currentWorkspace?.messages || [];
        
        // 🔥 合并传入的 currentMessages（避免 React 异步状态更新导致消息丢失）
        // 去重：如果 currentMessages 中的消息已经在 messagesToUse 中，不再重复添加
        if (currentMessages && currentMessages.length > 0) {
          const existingIds = new Set(messagesToUse.map((m: any) => m.id).filter(Boolean));
          const newMessages = currentMessages.filter((m: any) => !existingIds.has(m.id));
          messagesToUse = [...messagesToUse, ...newMessages];
        }
        
        // 🔥 过滤消息：只保留 user 和 auto，且 content 或 result 有值
        const filtered = messagesToUse.filter((msg: any) => {
          if (!["user", "auto"].includes(msg.role)) return false;
          
          const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
          const resultStr = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result || "");
          
          const hasContent = contentStr && contentStr.trim().length > 0 && contentStr !== 'null' && contentStr !== '""';
          const hasResult = resultStr && resultStr.trim().length > 0 && resultStr !== 'null' && resultStr !== '""';
          
          return hasContent || hasResult;
        });

        // 🔥 按时间戳排序
        const sortedMessages = filtered.sort((a: any, b: any) => {
          const timeA = typeof a.timestamp === 'number' ? a.timestamp : a.timestamp?.getTime?.() || 0;
          const timeB = typeof b.timestamp === 'number' ? b.timestamp : b.timestamp?.getTime?.() || 0;
          return timeA - timeB;
        });

        // 🔥 回合切分 + 窗口 + 渲染（与 call_memory 记忆回忆共用 RoundMemory 模块）：
        // userquery（user 且无 sessionId 且无注入标记）为回合起点；保留最近 contextHistoryRounds 个回合（按值执行）。
        // 三层降维（一层递减）：当前回合（最后一个）全量实时展示 → 相邻回合（倒数第二个）summarizer 全文 + 📋
        // （防方案细节丢失，如待确认的 A/B/C 档定义只在 say_to_user 正文里）→ 更早回合 summarizer 截 20 字 + 📋；
        // reactor 按 sessionId 折叠
        const rounds = splitRounds(sortedMessages);
        const windowedRounds = rounds.length > contextHistoryRounds ? rounds.slice(rounds.length - contextHistoryRounds) : rounds;
        const flatLines = windowedRounds.flatMap((round, i) =>
          renderRoundLines(round, {
            currentRound: i === windowedRounds.length - 1,
            fullSummarizer: i === windowedRounds.length - 2,
            truncateCode: true,
          })
        );

        // 🔥 全局时序排序 + 去重（键含 timestamp：截断后的骨架文本易碰撞）
        flatLines.sort((a, b) => a.timestamp - b.timestamp);
        const seen = new Set<string>();
        const history: Array<{ role: string; content: string; sessionId?: string; apiRole?: string; timestamp?: number }> = [];
        for (const line of flatLines) {
          const key = `${line.role}:${line.timestamp}:${line.content.substring(0, 100)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          history.push(line);
        }

        // 🔥 监控：回合窗口当前值 + 历史体积（每轮 summarizer 刷新一次）
        const historyChars = history.reduce((s, l) => s + l.content.length, 0);
        console.log(`[HISTORY] contextHistoryRounds=${contextHistoryRounds} 总回合=${rounds.length} 保留=${windowedRounds.length} 历史条数=${history.length} 体积=${(historyChars / 1024).toFixed(1)}KB (~${Math.round(historyChars / 3)} tokens)`);

        return history;
      };

      const conversationHistory = await extractConversationHistory();
      const callbacks = createSimpleCallbacks(conversationId);

      const summaryHandler = new SummaryHandler(
        { userId: effectiveUserId, conversationId, userEmail },
        callbacks
      );

      // 🔥 设置获取最新对话历史的回调函数
      summaryHandler.setConversationHistoryCallback(extractConversationHistory);
      // 🔥 设置获取 session 上下文的回调函数
      summaryHandler.setSessionContextCallback(extractSessionContext);

      workspace.setSummaryHandler(summaryHandler);

      await summaryHandler.process({ content, conversationHistory });

      workspace.setSummaryHandler(null);
      globalAbortManager.reset();
    } catch (error) {

      const errorMessage = MessageFactory.createErrorMessage(
        "Auto模式执行失败",
        error instanceof Error ? error.message : "未知错误"
      );
      workspace.setMessages((prev: any[]) => [...prev, errorMessage]);
      globalAbortManager.reset();
    }
  };

  const handleSendMessage = async (
    content: string,
    files: FileAttachment[] = [],
    opts?: { source?: string } // 🔥 来源标签（离线指挥桥传 'email'，ChatUI 缺省不传）
  ) => {
    const userSource = opts?.source;
    const summaryHandler = workspace.summaryHandler;

    if (summaryHandler?.hasPendingInteraction?.()) {
      const sessionId = summaryHandler.getPendingInteractionSessionId?.();
      const userMessage = MessageFactory.createUserMessage(content, files);
      if (userSource) userMessage.source = userSource;
      
      if (sessionId) {
        (userMessage as any).sessionId = sessionId;
      }
      
      workspace.setMessages((prev: any[]) => [...prev, userMessage]);
      
      if (workspace.currentConversationId) {
        MessagePersistence.saveMessageAsync(workspace.currentConversationId, userMessage);
      }
      
      try {
        const result = await summaryHandler.handleUserInteractionResponse(content);
        
        if (result.thinkingResult?.requiresInteraction) {
          const interactionMessage = MessageFactory.createAutoMessage(
            result.thinkingResult.say_to_user || '',
            'Teegal',
            [],
            { requiresInteraction: true }
          );
          workspace.setMessages((prev: any[]) => [...prev, interactionMessage]);
        } else if (result.thinkingResult?.say_to_user) {
          const replyMessage = MessageFactory.createAutoMessage(
            result.thinkingResult.say_to_user,
            'Teegal'
          );
          workspace.setMessages((prev: any[]) => [...prev, replyMessage]);
        }
      } catch (error) {
        console.error("❌ [WORKSPACE-HANDLERS] 交互处理失败:", error);
      }
      
      return;
    }

    if (workspace.isProcessing) {
      const conversationId = workspace.currentConversationId;
      if (conversationId) {
        const { UserInjectMessageManager } = await import('@/utils/auto/environment/UserInjectMessageManager');

        const validFileAttachments = files.filter((file) => {
          const isValid = file && typeof file === "object" && "id" in file && "content" in file;
          return isValid;
        });

        const fullContent = `${content}\n---✅ 消息已加入队列`;

        const userInjectMessage = MessageFactory.createUserMessage(fullContent, validFileAttachments, {
          isInjectMessage: true,
          isPending: true,
        });
        if (userSource) userInjectMessage.source = userSource;
        workspace.setMessages((prev: any[]) => [...prev, userInjectMessage]);

        MessagePersistence.saveMessageAsync(conversationId, userInjectMessage);

        UserInjectMessageManager.addMessage(
          conversationId,
          content,
          files.map(f => ({ id: f.id, name: f.name, type: f.type }))
        );
      }
      return;
    }

    try {
      workspace.setIsProcessing(true);

      const validFileAttachments = files.filter((file) =>
        file && typeof file === "object" && "id" in file && "content" in file
      );

      let conversationId = workspace.currentConversationId;
      let isNewConversation = false;
      let conversationTitle = '';

      if (!conversationId || conversationId === "null") {
        isNewConversation = true;
        conversationTitle = generateTitle(content);

        if (workspace.userId) {
          conversationId = workspace.createConversation(conversationTitle);
          if (workspace.setActiveHistoryId && conversationId) {
            workspace.setActiveHistoryId(conversationId);
          }
        } else {
          conversationId = `guest-conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          workspace.setCurrentConversationId(conversationId);
        }
      }

      let finalContent = content;
      if (validFileAttachments.length > 0) {
        const fileInfoList = validFileAttachments.map(file => {
          const parts = [];
          if (file.id) parts.push(`文件ID: ${file.id}`);
          if (file.name) parts.push(`文件名: ${file.name}`);
          if (file.localPath) parts.push(`本地路径: ${file.localPath}`);
          if (file.storageUrl) parts.push(`URL: ${file.storageUrl}`);
          return `[${parts.join(' | ')}]`;
        }).join('\n');
        finalContent = `${content}\n\n--- 已上传文件 ---\n${fileInfoList}`;
      }

      const userMessage = MessageFactory.createUserMessage(finalContent, validFileAttachments);
      if (userSource) userMessage.source = userSource;
      workspace.setMessages((prev: any[]) => [...prev, userMessage]);

      if (workspace.userId && conversationId) {
        if (isNewConversation && workspace.insertConversationToDatabase) {
          await workspace.insertConversationToDatabase(conversationId, conversationTitle, workspace.userId);
          if (workspace.addConversationToHistory) {
            workspace.addConversationToHistory(conversationId, conversationTitle);
          }
        }
        MessagePersistence.saveMessageAsync(conversationId, userMessage);
      }

      // 🔥 传入刚创建的用户消息，避免 React 异步状态更新导致消息丢失
      // 🔥 传 finalContent（含上传文件段）：Summary 的 buildMultimodalContent 依赖
      // userQuery 段内的「--- 已上传文件 ---」标记提取图片/视频 URL 组多模态。
      // 只传原始 content 会导致带图/带视频的提问永远走不到 Summary 直读，绕路 urlread
      await handleAutoModeExecution(finalContent, conversationId, [userMessage]);
    } catch (error) {
      console.error("❌ [WORKSPACE-HANDLERS] 处理异常:", error);
      const errorMessage = MessageFactory.createErrorMessage("发送失败", error);
      workspace.setMessages((prev: any[]) => [...prev, errorMessage]);
    } finally {
      workspace.setIsProcessing(false);
    }
  };

  const handleNewChat = createNewChatHandler(workspace);
  const handleSelectHistory = createSelectHistoryHandler(workspace, loadMessagesWrapper);

  return {
    handleSendMessage,
    handleNewChat,
    handleSelectHistory,

    handleCancel: () => {
      console.log('🛑 [WORKSPACE-HANDLERS] 用户请求中止');

      const summaryHandler = workspace.summaryHandler;
      if (summaryHandler) {
        summaryHandler.killAllSessions();
        workspace.setSummaryHandler(null);
      }

      globalAbortManager.abort();

      workspace.setIsProcessing(false);
    },

    handleLoadMoreMessages: async (): Promise<boolean> => {
      const conversationId = workspace.currentConversationId;
      if (!conversationId || conversationId === 'null') return false;

      const { loadMoreMessagesBackward } = await import('./handlers/messagePaginationHandlers');
      return await loadMoreMessagesBackward(conversationId, workspace.setMessages);
    },

    handleAutoModeExecution,
  };
};

export const createHandlers = (workspace: any) => {
  return useWorkspaceHandlers(workspace);
};
