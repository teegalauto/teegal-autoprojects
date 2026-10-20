import { Message } from '@/components/workspace/types/ChatTypes';
import { messageStorage, storageMode } from '@/services/storage';

export class MessagePersistence {

   static async saveMessageAsync(conversationId: string, message: Message): Promise<boolean> {
    try {
      const result = await this.saveMessage(conversationId, message);
      return result;
    } catch (error) {
      console.error('❌ [MESSAGE-PERSISTENCE] 异步保存消息失败:', error);
      return false;
    }
  }

   static async saveMessage(conversationId: string, message: Message): Promise<boolean> {
     if (message.status === 'streaming') {
       return true;
     }

     console.log('💾 [MESSAGE-PERSISTENCE] 保存消息:', {
      conversationId,
      messageId: message.id,
      messageRole: message.role,
      apiRole: message.apiRole,
      content: message.content?.substring(0, 50),
      hasResult: !!message.result,
      messageType: message.type,
      hasFiles: !!(message.files && message.files.length > 0),
      filesCount: message.files?.length || 0
    });

    try {
      console.log('[MessagePersistence] 保存消息:', { 
        conversationId, 
        role: message.role,
        mode: storageMode.getMode()
      });
      
      const messageData = {
        conversation_id: conversationId,
        role: message.role,
        content: message.content || '',
        files: [],
        created_at: new Date().toISOString(),
        api_role: message.apiRole,
        result: message.result !== undefined 
          ? (typeof message.result === 'string' ? message.result : JSON.stringify(message.result))
          : null,
        status: message.status,
        call_id: message.callId,
        icon_text: message.iconText,
        session_id: message.sessionId,
        memory: message.memory,
        // 🔥 metadata 落库（messages 表已有 JSON 扩展列）：source 标签随 metadata 持久化，
        // 历史加载时经 formatDatabaseMessages 还原到 Message.source
        metadata: {
          ...(message.metadata || {}),
          ...(message.source ? { source: message.source } : {}),
        },
      };

      await messageStorage.create(messageData);

      console.log('✅ [MESSAGE-PERSISTENCE] 消息保存成功:', {
        conversationId,
        messageId: message.id
      });

      return true;

    } catch (error) {
      console.error('❌ [MESSAGE-PERSISTENCE] 保存消息异常:', error);
      return false;
    }
  }

  static async saveMessages(conversationId: string, messages: Message[]): Promise<boolean> {
    console.log('📋 [MESSAGE-PERSISTENCE] 批量保存消息:', {
      conversationId,
      messagesCount: messages.length
    });

    let allSuccess = true;

    for (const message of messages) {
      const success = await this.saveMessage(conversationId, message);
      if (!success) {
        allSuccess = false;
      }
    }

    return allSuccess;
  }

  static async updateMessageByCallId(
    conversationId: string,
    callId: string,
    updates: {
      result?: any;
      status?: 'pending' | 'streaming' | 'completed' | 'failed';
      iconText?: string;
      content?: string;
    }
  ): Promise<boolean> {
    try {
      const dbUpdates: any = {};
      if (updates.result !== undefined) {
        dbUpdates.result = typeof updates.result === 'string' 
          ? updates.result 
          : JSON.stringify(updates.result);
      }
      if (updates.status !== undefined) dbUpdates.status = updates.status;
      if (updates.iconText !== undefined) dbUpdates.icon_text = updates.iconText;
      if (updates.content !== undefined) dbUpdates.content = updates.content;

      const result = await messageStorage.updateByCallId(conversationId, callId, dbUpdates);

      return result;
    } catch (error) {
      console.error('❌ [MESSAGE-PERSISTENCE] 通过 callId 更新消息失败:', error);
      return false;
    }
  }
}
