import { summaryService, type SummaryTool } from '@/utils/auto/SummaryService';
import i18n from '@/i18n';

/**
 * 🔥 事件类型定义
 * 所有事件都通过 triggerEvent 触发，通过 waitForEvent 等待
 */
type ProcessEvent =
  | { type: 'userQuery'; content: string }
  | { type: 'agentMessage'; sessionId: string; message: string }
  | { type: 'sessionCompleted'; sessionId: string; success: boolean; completeReport?: string }
  | { type: 'userResponse'; response: string }
  | { type: 'contextReady'; sessionId: string; context: Array<{ apiRole?: string; content?: string; result?: string }> }
  | { type: 'sessionKilled'; sessionId: string }
  | { type: 'sessionLimitReached'; message: string }
  | { type: 'checkUpdateDone' }
  | { type: 'timeout' };

/**
 * 🔥 ThinkingResult 类型（从 types.ts 移入）
 * Summary 输出，用于驱动执行流程
 */
interface ThinkingResult {
  say_to_user?: string;
  say_to_agent?: string;
  tools?: SummaryTool[];  // 🔥 工具调用列表（替代 sessionActions）
  writeNotes?: string;  // 🔥 分析笔记
  requiresInteraction?: boolean;
  isInteraction?: boolean;  // 🔥 是否是 interaction++ 消息
}
import { getGatherToolsSummary } from '@/utils/auto/AvailableToolsRegistry';
import { ReActExecutor } from '@/utils/auto/ReActExecutor';
import { AbortManager } from '@/utils/abort/AbortManager';
import { agentCommunicationService } from '@/utils/auto/AgentCommunicationService';
import { translateError } from '../utils/messageFactory';

export interface SummaryHandlerParams {
  userId: string;
  conversationId: string;
  userEmail?: string;
}

export interface SummaryInput {
  content: string;
  conversationHistory?: Array<{ role: string; content: string; sessionId?: string; apiRole?: string; timestamp?: number }>;
  previousExecutionResult?: {
    completedSteps: number;
    failedSteps: number;
    totalSteps: number;
    executionSummary?: string;
    stepResults?: Array<{
      stepId: string;
      stepTitle: string;
      status: string;
      toolName?: string;
      letMeTodo?: string;
      result?: any;
      error?: string;
    }>;
  };
}

export interface SessionInfo {
  sessionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
  sessionGoal?: string; // 🔥 session 的目标（来自 tools）
  executionFlow?: {
    actual: string; // 🔥 实际执行轨迹
  };
  startedAt?: Date;
  completedAt?: Date;
}

export interface SummaryOutput {
  thinkingResult?: ThinkingResult;
}

export interface SummaryHandlerCallbacks {
  onMessage: (callId: string, message: Partial<{
    role: 'user' | 'assistant' | 'system' | 'auto';
    content: string;
    apiRole: 'summarizer' | 'reactor';
    result: string;
    status: 'pending' | 'streaming' | 'completed' | 'failed';
    iconText: string;
    metadata: Record<string, any>;
    sessionId: string;
    memory?: string;
  }>) => Promise<void>;

  onError?: (error: string) => Promise<void>;
}

interface SessionContext {
  sessionId: string;
  sessionInfo: SessionInfo;
  thinkingResult: ThinkingResult | null;
  status: 'running' | 'completed' | 'failed' | 'killed';
  lastCheckResult?: SummaryOutput;
  killed: boolean; // 🔥 是否被 kill
  abortManager: AbortManager; // 🔥 用于中断执行
  conversationId: string; // 🔥 kill/abort 需要——静态方法无实例上下文，从 context 取
}

interface PendingInteraction {
  message: string;
  sessionId?: string;
  timestamp: number;
  conversationHistory?: Array<{ role: string; content: string; sessionId?: string; apiRole?: string; timestamp?: number }>;
  resolve?: (response: string) => void;
}

export class SummaryHandler {
  private userId: string;
  private conversationId: string;
  private userEmail?: string;
  private callbacks: SummaryHandlerCallbacks;
  // 🔥 账本类级共享（static）：每轮 new SummaryHandler，但 UI 组件（SessionMessageGroup）与顶层
  //    设值的 useWorkspace 是各自独立的 useWorkspace 实例——实例字段会让 UI 永远拿到 null handler，
  //    计时器永远走兜底（0s/假活跃窗口）。static 后任何组件直接 SummaryHandler.xxx() 查账。
  private static sessionContexts: Map<string, SessionContext> = new Map();
  private static sessionList: SessionInfo[] = [];
  private static pendingInteractions: Map<string, PendingInteraction> = new Map();
  private static maxSessions = 50;
  private sessionId: string;
  // 🔥 存储当前对话历史（供所有方法使用）- 由调用方提供，不自动更新
  private conversationHistory?: Array<{ role: string; content: string; sessionId?: string; apiRole?: string; timestamp?: number }>;
  // 🔥 回调函数，用于获取最新的对话历史
  private getConversationHistoryCallback?: () => Promise<Array<{ role: string; content: string; sessionId?: string; apiRole?: string; timestamp?: number }>>;
  // 🔥 回调函数，用于获取特定 session 的上下文
  private getSessionContextCallback?: (sessionId: string) => Array<{ apiRole: string; content: string; result?: string }>;
  // 🔥 标记 process 是否正在运行
  private isProcessing = false;
  // 🔥 正在运行的 session promises（用于等待完成）
  private runningSessionPromises: Map<string, Promise<{ sessionId: string; completeReport?: string; success: boolean }>> = new Map();
  // 🔥 优先 session IDs（完成后立即触发 handleGather，不需要等待其他 session）
  private prioritySessionIds: Set<string> = new Set();
  // 🔥 事件队列（统一的事件驱动机制）
  private eventQueue: ProcessEvent[] = [];
  // 🔥 事件 resolver（用于等待事件）
  private eventResolver: ((event: ProcessEvent) => void) | null = null;

  constructor(params: SummaryHandlerParams, callbacks: SummaryHandlerCallbacks) {
    this.userId = params.userId;
    this.conversationId = params.conversationId;
    this.userEmail = params.userEmail;
    this.callbacks = callbacks;
    this.sessionId = Date.now().toString(36);
    
    agentCommunicationService.setAgentMessageHandler(
      this.handleAgentMessage.bind(this)
    );
  }

  private async safeOnMessage(
    callId: string,
    message: Parameters<SummaryHandlerCallbacks['onMessage']>[1]
  ): Promise<void> {
    try {
      await this.callbacks.onMessage(callId, message);
    } catch (error) {
      console.error('⚠️ [SUMMARY-HANDLER] onMessage 回调异常:', {
        callId,
        apiRole: message.apiRole,
        status: message.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 🔥 设置获取对话历史的回调函数
   */
  setConversationHistoryCallback(
    callback: () => Promise<Array<{ role: string; content: string; sessionId?: string; apiRole?: string; timestamp?: number }>>
  ): void {
    this.getConversationHistoryCallback = callback;
  }

  /**
   * 🔥 获取当前对话历史（优先使用回调获取最新）
   */
  private async getCurrentConversationHistory(): Promise<Array<{ role: string; content: string; sessionId?: string; apiRole?: string; timestamp?: number }>> {
    if (this.getConversationHistoryCallback) {
      try {
        return await this.getConversationHistoryCallback();
      } catch (error) {
        console.warn('[SUMMARY-HANDLER] 获取最新对话历史失败，使用缓存:', error);
      }
    }
    return this.conversationHistory || [];
  }

  /**
   * 🔥 设置获取 session 上下文的回调函数
   */
  setSessionContextCallback(
    callback: (sessionId: string) => Array<{ apiRole: string; content: string; result?: string }>
  ): void {
    this.getSessionContextCallback = callback;
  }

  /**
   * 🔥 获取特定 session 的上下文
   */
  private getSessionContext(sessionId: string): Array<{ apiRole: string; content: string; result?: string }> {
    if (this.getSessionContextCallback) {
      return this.getSessionContextCallback(sessionId);
    }
    return [];
  }

  /**
   * 🔥 处理 Agent 消息
   * 只负责触发 process 循环处理消息
   * 回复将通过 agentCommunicationService.handleReply 发送
   */
  async handleAgentMessage(
    sessionId: string,
    agentMessage: string
  ): Promise<void> {
    console.log('[SUMMARY-HANDLER] 收到 Agent 消息:', { sessionId, agentMessage: agentMessage.substring(0, 50) });

    // 🔥 触发 agentMessage 事件
    this.triggerEvent({
      type: 'agentMessage',
      sessionId,
      message: agentMessage,
    });
  }

  hasPendingInteraction(): boolean {
    const result = SummaryHandler.pendingInteractions.size > 0;
    console.log('[SUMMARY-HANDLER] hasPendingInteraction:', result, SummaryHandler.pendingInteractions.size);
    return result;
  }

  getPendingInteraction(): PendingInteraction | null {
    // 返回第一个 pendingInteraction（兼容旧代码）
    const first = SummaryHandler.pendingInteractions.values().next().value;
    return first || null;
  }

  clearPendingInteraction(): void {
    SummaryHandler.pendingInteractions.clear();
  }

  /**
   * 🔥 Kill 指定 session
   */
  static killSession(sessionId: string): boolean {
    console.log('🛑 [SUMMARY-HANDLER] Kill session:', sessionId);

    const context = SummaryHandler.sessionContexts.get(sessionId);
    if (!context) {
      console.warn('[SUMMARY-HANDLER] Session 不存在:', sessionId);
      return false;
    }

    if (context.status !== 'running') {
      console.log('[SUMMARY-HANDLER] Session 已完成，无法 kill:', sessionId, context.status);
      return false;
    }

    // 🔥 标记为 killed
    context.killed = true;
    context.status = 'killed';
    context.sessionInfo.status = 'killed';
    // 🔥 kill 瞬间落账终态（completedAt + 终态快照）：此前只在 executeSession 检查点落账，
    //    但 abort 打断时检查点被跳过 → endTime 恒空 → UI 兜底只剩启动 running 条目，
    //    计时器定格不了真实终止时刻，且下一轮消息触发重查时误入 unknown 活跃窗口假走字
    context.sessionInfo.completedAt = new Date();
    SummaryHandler.sessionList.push({ ...context.sessionInfo });
    SummaryHandler.persistFinalState(context.sessionInfo);

    // 🔥 通知 ReActExecutor 停止（静态方法无实例上下文，conversationId 从 context 取）
    const reActExecutor = ReActExecutor.getInstance();
    reActExecutor.abort(context.conversationId);
    context.abortManager.abort(context.conversationId);

    // 🔥 清理 agentCommunication
    agentCommunicationService.clearSession(sessionId);

    // 🔥 resolve 等待该 session 的 pendingInteraction
    const pendingInteraction = SummaryHandler.pendingInteractions.get(sessionId);
    if (pendingInteraction?.resolve) {
      console.log('🛑 [SUMMARY-HANDLER] Resolve pending interaction for killed session:', sessionId);
      pendingInteraction.resolve('KILLED');
      SummaryHandler.pendingInteractions.delete(sessionId);
    }

    console.log('✅ [SUMMARY-HANDLER] Session 已 kill:', sessionId);
    return true;
  }

  /**
   * 🔥 Kill 所有 running session
   */
  static killAllSessions(): void {
    console.log('🛑 [SUMMARY-HANDLER] Kill 所有 sessions');

    for (const [sessionId, context] of SummaryHandler.sessionContexts) {
      if (context.status === 'running') {
        SummaryHandler.killSession(sessionId);
      }
    }
  }

  /**
   * 🔥 检查 session 是否被 kill
   */
  static isSessionKilled(sessionId: string): boolean {
    const context = SummaryHandler.sessionContexts.get(sessionId);
    return context?.killed ?? false;
  }

  /**
   * 🔥 获取 session 状态（供 UI 组件使用）
   */
  static getSessionStatus(sessionId: string): { status: 'running' | 'completed' | 'failed' | 'killed' | 'unknown'; startTime?: Date; endTime?: Date } {
    const context = SummaryHandler.sessionContexts.get(sessionId);
    if (!context) {
      // 🔥 sessionCompleted 时 context 会被删除（phase 编排清理），但 sessionList 保留终态——
      //    兜底查 sessionList，让 UI 拿到真实 startTime/endTime（否则计时器冻结后跳变）。
      //    ⚠️ 必须取最后一条：启动时 push 过一条 running、完成时再 push 一条 completed（L599/L657 双条并存），
      //    find() 会命中 running 那条（无 completedAt）→ endTime 空 → UI 活跃窗口误判"仍活跃"，计时器走满 5 分钟
      const info = [...SummaryHandler.sessionList].reverse().find(s => s.sessionId === sessionId);
      if (info) {
        // pending（已登记未启动）此时 context 已不在，按 unknown 走；running 说明 promise 已终结（完成后才删 context），按 completed 走
        const mapped = info.status === 'running' ? 'completed' as const
          : info.status === 'pending' ? 'unknown' as const
          : info.status;
        return {
          status: mapped,
          startTime: info.startedAt,
          endTime: info.completedAt,
        };
      }
      // 🔥 内存账全空（典型：Ctrl+R 刷新后回看已完成 session，static 账本不跨刷新）——
      //    查 localStorage 终态持久化兜底。拿到终态就能给 UI 真实 endTime，计时器直接定格，
      //    不会再落进"unknown+近 5 分钟消息"的活跃窗口假走字（实测刷新后计时器走满 5 分钟才自愈）
      const persisted = SummaryHandler.readFinalState(sessionId);
      if (persisted) return persisted;
      return { status: 'unknown' };
    }
    return {
      status: context.status,
      startTime: context.sessionInfo.startedAt,
      endTime: context.sessionInfo.completedAt,
    };
  }

  // 🔥 终态持久化（localStorage，跨刷新存活）：sessionContexts/sessionList 都是内存 static，
  //    刷新后全空——刚结束的 session 被组件的 5 分钟活跃窗口误判"仍活跃"，计时器假走字。
  //    只存终态（completed/failed/killed）的最小元组，容量上限 100 条，FIFO 逐出
  private static finalStateKey(sessionId: string): string {
    return `teegal_session_final:${sessionId}`;
  }

  private static persistFinalState(info: SessionInfo): void {
    try {
      if (!info.sessionId) return;
      if (info.status !== 'completed' && info.status !== 'failed' && info.status !== 'killed') return;
      localStorage.setItem(SummaryHandler.finalStateKey(info.sessionId), JSON.stringify({
        status: info.status,
        startedAt: info.startedAt?.toISOString(),
        completedAt: info.completedAt?.toISOString(),
        at: Date.now(),
      }));
      const indexKey = 'teegal_session_final_index';
      const idx: string[] = JSON.parse(localStorage.getItem(indexKey) || '[]');
      if (!idx.includes(info.sessionId)) idx.push(info.sessionId);
      while (idx.length > 100) {
        const evict = idx.shift();
        if (evict) localStorage.removeItem(SummaryHandler.finalStateKey(evict));
      }
      localStorage.setItem(indexKey, JSON.stringify(idx));
    } catch { /* 存储异常不影响主流程 */ }
  }

  private static readFinalState(sessionId: string): { status: 'completed' | 'failed' | 'killed'; startTime?: Date; endTime?: Date } | null {
    try {
      const raw = localStorage.getItem(SummaryHandler.finalStateKey(sessionId));
      if (!raw) return null;
      const e = JSON.parse(raw);
      if (!e?.status) return null;
      return {
        status: e.status,
        startTime: e.startedAt ? new Date(e.startedAt) : undefined,
        endTime: e.completedAt ? new Date(e.completedAt) : undefined,
      };
    } catch { return null; }
  }

  private parseSayToUser(sayToUser: string): { isInteraction: boolean; message: string } {
    if (!sayToUser) {
      return { isInteraction: false, message: '' };
    }

    const trimmed = sayToUser.trim();

    // 🔥 解析 interaction++（可以在消息开头或结尾）
    if (trimmed.startsWith('interaction++') || trimmed.endsWith('interaction++')) {
      return {
        isInteraction: true,
        message: trimmed.replace(/^interaction\+\+\s*|\s*interaction\+\+$/g, '').trim(),
      };
    }

    return { isInteraction: false, message: trimmed };
  }

  getPendingInteractionSessionId(): string | undefined {
    const first = SummaryHandler.pendingInteractions.values().next().value;
    return first?.sessionId;
  }

  async handleUserInteractionResponse(response: string): Promise<SummaryOutput> {
    console.log('[SUMMARY-HANDLER] handleUserInteractionResponse 被调用:', response);
    console.log('[SUMMARY-HANDLER] pendingInteractions count:', SummaryHandler.pendingInteractions.size);
    
    if (SummaryHandler.pendingInteractions.size === 0) {
      console.log('[SUMMARY-HANDLER] 没有待处理的交互请求');
      return { thinkingResult: { say_to_user: '' } };
    }

    // 🔥 resolve 所有等待的 interaction
    const resolvedCount = SummaryHandler.pendingInteractions.size;
    for (const [sessionId, interaction] of SummaryHandler.pendingInteractions) {
      if (interaction.resolve) {
        console.log('[SUMMARY-HANDLER] resolve Promise for session:', sessionId, 'with:', response);
        interaction.resolve(response);
      }
    }
    SummaryHandler.pendingInteractions.clear();

    console.log('[SUMMARY-HANDLER] 已 resolve', resolvedCount, '个 pending interactions');
    return { thinkingResult: { say_to_user: '' } };
  }

  async process(input: SummaryInput): Promise<SummaryOutput> {
    const { content, conversationHistory } = input;

    this.conversationHistory = conversationHistory;

    const MAX_DEPTH = 30;
    let depth = 0;
    // 🔥 账本静态化后绝不能在这里清 sessionList：它已是跨轮共享的历史账，
    //    清掉 = 上一轮所有 session 终态蒸发 → UI 查账落空变 unknown → 计时器假复活走字。
    //    并发上限由 sessionContexts（maxSessions）控制，与 sessionList 无关。
    //    喂给 LLM 的上下文用本轮切片（sessionListRoundStart 起），保持"本轮 session 记录"的原语义。
    const sessionListRoundStart = SummaryHandler.sessionList.length;
    const callHistory: Array<{ depth: number; actions: string[]; result: string }> = [];
    let accumulatedWriteNotes = '';
    let sessionContext: Array<{ apiRole?: string; content?: string; result?: string }> | undefined;

    try {
      this.isProcessing = true;

      // 🔥 记录 depth 0：用户原始查询
      callHistory.push({
        depth: 0,
        actions: ['user_query'],
        result: `user_query为：${content}`,
      });

      // 🔥 触发初始事件：userQuery
      this.triggerEvent({ type: 'userQuery', content });

      // 🔥 depth 0 是用户查询，从 depth 1 开始记录操作
      depth = 1;

      while (depth <= MAX_DEPTH) {
        // 🔥 1. 等待事件
        const event = await this.waitForEvent();
        console.log('[SUMMARY-HANDLER] 收到事件:', event.type);

        // 🔥 2. 根据事件类型准备参数
        let agentMessage: string | undefined;
        
        if (event.type === 'agentMessage') {
          agentMessage = `来自 ${event.sessionId} 的消息：${event.message}`;
          callHistory.push({
            depth,
            actions: ['agent_message'],
            result: agentMessage,
          });
        } else if (event.type === 'sessionCompleted') {
          this.runningSessionPromises.delete(event.sessionId);
          SummaryHandler.sessionContexts.delete(event.sessionId);
          
          const isPriority = this.prioritySessionIds.has(event.sessionId);
          if (isPriority) {
            this.prioritySessionIds.delete(event.sessionId);
          }
          
          const sessionInfo = SummaryHandler.sessionList.find(s => s.sessionId === event.sessionId);
          if (sessionInfo) {
            sessionInfo.status = event.success ? 'completed' : 'failed';
          }
          
          // 🔥 合并到已有的 session++ 条目，而不是新增一条
          const existingEntry = callHistory.find(
            entry => entry.actions.some(a => a.startsWith('sessioncreate')) &&
                     entry.result.includes(event.sessionId)
          );
          if (existingEntry) {
            // 🔥 在已有条目的 result 中追加 session 完成信息
            existingEntry.result += `\n→ 完成: ${event.success ? '成功' : '失败'}${isPriority ? ' [优先]' : ''}${event.completeReport ? `\n${event.completeReport}` : ''}`;
          } else {
            // fallback: 找不到已有条目时，仍新增一条
            callHistory.push({
              depth,
              actions: ['session_completed'],
              result: `Session [${event.sessionId}] 完成: ${event.success ? '成功' : '失败'}${isPriority ? ' [优先]' : ''}${event.completeReport ? `\n${event.completeReport}` : ''}`,
            });
          }
          
          // 🔥 优先 session 立即调用 handleGather，不需要等待其他 session
          if (isPriority) {
            console.log(`[SUMMARY-HANDLER] 优先 session ${event.sessionId} 完成，立即调用 handleGather`);
          }
          // 🔥 普通 session：如果还有未完成的 session，不调用 handleGather，继续等待
          else if (this.runningSessionPromises.size > 0) {
            console.log(`[SUMMARY-HANDLER] Phase 未完成，还有 ${this.runningSessionPromises.size} 个 session 运行中`);
            // 🔥 不再 depth++，因为 session_completed 已合并到 session++ 条目，不会导致 depth 重复
            continue; // 跳过本次循环，继续等待下一个事件
          }
          
          console.log('[SUMMARY-HANDLER] Phase 完成，所有 session 已结束');
        } else if (event.type === 'userResponse') {
          callHistory.push({
            depth,
            actions: ['user_response'],
            result: event.response,
          });
        } else if (event.type === 'contextReady') {
          sessionContext = event.context;
          callHistory.push({
            depth,
            actions: ['get_context'],
            result: `获取 session [${event.sessionId}] 的上下文`,
          });
        } else if (event.type === 'sessionKilled') {
          callHistory.push({
            depth,
            actions: ['session_killed'],
            result: `Session [${event.sessionId}] 已终止`,
          });
        } else if (event.type === 'sessionLimitReached') {
          callHistory.push({
            depth,
            actions: ['session_limit_reached'],
            result: event.message,
          });
        } else if (event.type === 'checkUpdateDone') {
          // 检查更新结果已在 executeActions 写入 callHistory，直接进入 gather 让 LLM 组织回复
        } else if (event.type === 'timeout') {
          console.log('[SUMMARY-HANDLER] 事件超时');
          if (this.runningSessionPromises.size === 0) {
            return { thinkingResult: { say_to_user: '处理超时' } };
          }
          continue;
        }

        // 🔥 3. 调用 handleGather
        console.log(`[SUMMARY-HANDLER] Depth ${depth} 调用 handleGather`);
        const gatherResult = await this.handleGather({
          userQuery: content,
          agentMessage,
          conversationHistory: await this.getCurrentConversationHistory(),
          depth,
          maxDepth: MAX_DEPTH,
          sessionList: SummaryHandler.sessionList.slice(sessionListRoundStart),
          callHistory,
          sessionContext,
          writeNotes: accumulatedWriteNotes,
        });

        sessionContext = undefined;

        if (gatherResult.thinkingResult?.writeNotes) {
          const roundNote = `【Depth ${depth}】\n${gatherResult.thinkingResult.writeNotes}`;
          accumulatedWriteNotes = accumulatedWriteNotes ? `${accumulatedWriteNotes}\n---\n${roundNote}` : roundNote;
        }

        // 🔥 4. 执行操作（操作完成后会触发事件）
        await this.executeActions(gatherResult, { depth, content, callHistory });

        // 🔥 5. 检查是否应该退出
        // 🔥 注意：如果有 say_to_agent，应该继续循环，等待下一个事件
        // 🔥 注意：如果事件队列不为空，应该继续循环处理事件
        if (!gatherResult.thinkingResult?.tools &&
            !gatherResult.thinkingResult?.isInteraction &&
            !gatherResult.thinkingResult?.say_to_agent &&
            this.runningSessionPromises.size === 0 &&
            this.eventQueue.length === 0) {
          return gatherResult;
        }

        depth++;
      }

      console.warn('[SUMMARY-HANDLER] 循环意外结束，depth=', depth);
      return { thinkingResult: { say_to_user: '处理完成' } };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('🛑 [SUMMARY-HANDLER] process 被中断 (AbortError)');
        return { thinkingResult: { say_to_user: '执行已被中断' } };
      }

      const rawError = error instanceof Error ? error.message : '未知错误';
      // 🔥 复用 messageFactory 的错误翻译表（余额不足/配额超限/认证失败等 → 友好中文）
      const errorMessage = translateError(rawError);
      console.error('❌ [SUMMARY-HANDLER] process 异常:', rawError);
      await this.callbacks.onMessage(`summary-error-${Date.now()}`, {
        role: 'auto',
        apiRole: 'summarizer',
        content: i18n.t('workspace.chatMessages.analysisFailed'),
        result: `${i18n.t('workspace.chatMessages.analysisFailed')}: ${errorMessage}`,
        status: 'failed',
        iconText: i18n.t('workspace.chatMessages.analysisFailed'),
      });

      return { thinkingResult: { say_to_user: errorMessage } };
    } finally {
      this.isProcessing = false;
      this.runningSessionPromises.clear();
    }
  }


  private async createSessionListContext(
    sessionId: string,
    thinkingResult: ThinkingResult,
    content: string
  ): Promise<SessionContext> {
    // 🔥 从 tools 获取 session 目标
    const sessionGoal = thinkingResult.tools
      ?.filter(t => t.name === 'sessioncreate')
      .map(t => t.parameters.task || '')
      .join(' | ') || '';

    const sessionInfo: SessionInfo = {
      sessionId,
      status: 'running',
      sessionGoal,
      startedAt: new Date(),
    };

    const context: SessionContext = {
      sessionId,
      sessionInfo,
      thinkingResult,
      status: 'running',
      killed: false,
      abortManager: new AbortManager(),
      conversationId: this.conversationId,
    };

    // 🔥 立即加入 sessionList，让 handleGather 能看到正在运行的 session
    SummaryHandler.sessionList.push(sessionInfo);

    return context;
  }

  /**
   * 🔥 kill 终态落账：killed 分支此前直接 return——sessionInfo 滞留 running、completedAt 不写、
   *    sessionList 永远只有启动时的 running 引用条目 → UI 兜底映射成 completed 但 endTime 恒为空，
   *    计时器定格不到真实终止时刻（只能退化用最后一条消息时间凑）。kill 后必须在此落账终态。
   */
  private static finalizeKilledSession(context: SessionContext): void {
    if (context.sessionInfo.status !== 'running' && context.sessionInfo.status !== 'pending') return;
    context.sessionInfo.status = 'killed';
    context.sessionInfo.completedAt = new Date();
    SummaryHandler.sessionList.push({ ...context.sessionInfo });
    SummaryHandler.persistFinalState(context.sessionInfo);
    context.status = 'killed';
  }

  private async executeSession(
    context: SessionContext,
    content: string
  ): Promise<{ sessionId: string; completeReport?: string; success: boolean }> {
    if (!context.thinkingResult?.tools) {
      // 🔥 无工具提前返回：必须翻转状态并入 sessionList，否则 context 滞留 running
      //    → getSessionStatus 永远返回 running → UI 计时器无限走字
      context.sessionInfo.status = 'failed';
      context.sessionInfo.completedAt = new Date();
      SummaryHandler.sessionList.push({ ...context.sessionInfo });
      SummaryHandler.persistFinalState(context.sessionInfo);
      context.status = 'failed';
      return { sessionId: context.sessionId, success: false };
    }

    // 🔥 检查是否被 kill
    if (context.killed) {
      SummaryHandler.finalizeKilledSession(context);
      return { sessionId: context.sessionId, success: false };
    }

    context.sessionInfo.status = 'running';
    context.sessionInfo.startedAt = new Date();

    // 🔥 直接使用 ReActExecutor 执行 session
    let executionResult: { success: boolean; executionTrace: string; completeReport?: string };
    try {
      console.log(`[SUMMARY-HANDLER] DEBUG 开始执行 Reactor, context.sessionId: ${context.sessionId}`);
      const reActExecutor = ReActExecutor.getInstance();
      // 🔥 从 tools 获取 letAgentTodo
      const letAgentTodo = context.sessionInfo.sessionGoal || content;
      executionResult = await reActExecutor.execute({
        sessionId: context.sessionId,
        userId: this.userId,
        conversationId: this.conversationId,
        userEmail: this.userEmail,
        userQuery: content,
        letAgentTodo,
        callbacks: {
          onMessage: this.callbacks.onMessage,
          onError: this.callbacks.onError,
        },
        abortSignal: context.abortManager.getSignal(),
      });
    } catch (error) {
      executionResult = { success: false, executionTrace: `执行失败: ${error}`, completeReport: undefined };
    }

    // 🔥 执行后再次检查是否被 kill（执行中途被终止：结果作废，但终态必须落账）
    if (context.killed) {
      SummaryHandler.finalizeKilledSession(context);
      return { sessionId: context.sessionId, success: false };
    }

    context.sessionInfo.status = executionResult.success ? 'completed' : 'failed';
    context.sessionInfo.completedAt = new Date();
    // 🔥 不再在 sessionInfo 中存储 completeReport，改为放到 callHistory 中
    context.sessionInfo.executionFlow = {
      actual: executionResult.executionTrace, // 🔥 实际执行轨迹
    };

    // 🔥 把完成的 session 加入 sessionList（不包含 completeReport）
    SummaryHandler.sessionList.push({ ...context.sessionInfo });
    SummaryHandler.persistFinalState(context.sessionInfo);
    context.status = 'completed';

    // 🔥 等待收尾消息落库：工具回包经异步 IPC 逐条写入 workspace.messages，gather 立即触发会让
    //    summarizer 消息先于迟到的工具回包到达（用户观感"subagent 尾巴慢慢补上，吓以为坏了"）。
    //    100ms 实测不够（大结果消息可拖到数百毫秒），放宽到 500ms；根治需 onMessage 完成计数，暂不引入
    await new Promise(resolve => setTimeout(resolve, 500));

    // 🔥 返回执行结果，供 callHistory 记录
    return {
      sessionId: context.sessionId,
      completeReport: executionResult.completeReport,
      success: executionResult.success,
    };
  }

  /**
   * 🔥 异步执行 session（不阻塞 process 循环）
   * 
   * 启动 session 后立即返回 Promise，process 循环使用 waitForAnyEvent 等待完成
   * 
   * ⚠️ 重要：使用 setTimeout 确保在下一个事件循环中执行，避免死锁
   * 如果同步执行，executeSession 会阻塞在 sendAndWaitForReply，导致 process 循环无法进入 waitForAnyEvent
   */
  private async executeSessionAsync(
    context: SessionContext,
    content: string
  ): Promise<{ sessionId: string; completeReport?: string; success: boolean }> {
    return new Promise((resolve) => {
      setTimeout(async () => {
        try {
          const result = await this.executeSession(context, content);
          
          // 🔥 session 完成后触发事件
          this.triggerEvent({
            type: 'sessionCompleted',
            sessionId: result.sessionId,
            success: result.success,
            completeReport: result.completeReport,
          });
          
          resolve(result);
        } catch (error) {
          console.error(`[SUMMARY-HANDLER] executeSessionAsync 异常:`, error);

          // 🔥 异常时也必须翻转状态（否则 context 滞留 running → UI 计时器无限走字）再触发事件
          if (context.status === 'running') {
            context.status = 'failed';
            context.sessionInfo.status = 'failed';
            context.sessionInfo.completedAt = new Date();
            SummaryHandler.sessionList.push({ ...context.sessionInfo });
            SummaryHandler.persistFinalState(context.sessionInfo);
          }

          // 🔥 异常时也触发 sessionCompleted 事件
          this.triggerEvent({
            type: 'sessionCompleted',
            sessionId: context.sessionId,
            success: false,
            completeReport: error instanceof Error ? error.message : '执行异常',
          });
          
          resolve({ sessionId: context.sessionId, success: false });
        }
      }, 0);
    });
  }

  /**
   * 🔥 触发事件（统一的事件触发机制）
   */
  private triggerEvent(event: ProcessEvent): void {
    console.log('[SUMMARY-HANDLER] 触发事件:', event.type);
    
    if (this.eventResolver) {
      this.eventResolver(event);
      this.eventResolver = null;
    } else {
      this.eventQueue.push(event);
    }
  }

  /**
   * 🔥 等待事件（统一的事件等待机制）
   */
  private async waitForEvent(): Promise<ProcessEvent> {
    if (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift()!;
      console.log('[SUMMARY-HANDLER] 从队列中取出事件:', event.type);
      return event;
    }

    return new Promise((resolve) => {
      this.eventResolver = resolve;
      
      setTimeout(() => {
        if (this.eventResolver === resolve) {
          console.log('[SUMMARY-HANDLER] 等待事件超时');
          this.eventResolver = null;
          resolve({ type: 'timeout' });
        }
      }, 60000);
    });
  }

  /**
   * 🔥 执行操作（统一处理所有操作，操作完成后触发事件）
   */
  private async executeActions(
    gatherResult: SummaryOutput,
    params: {
      depth: number;
      content: string;
      callHistory: Array<{ depth: number; actions: string[]; result: string }>;
    }
  ): Promise<void> {
    const { depth, content, callHistory } = params;

    // 🔥 1. 处理 say_to_user
    if (gatherResult.thinkingResult?.say_to_user && !gatherResult.thinkingResult?.isInteraction) {
      // 发送消息给用户（非 interaction）
      console.log('[SUMMARY-HANDLER] 发送消息给用户:', gatherResult.thinkingResult.say_to_user);
    }

    // 🔥 2. 处理 say_to_agent
    if (gatherResult.thinkingResult?.say_to_agent) {
      callHistory.push({
        depth,
        actions: ['say_to_agent'],
        result: gatherResult.thinkingResult.say_to_agent,
      });
      
      const match = gatherResult.thinkingResult.say_to_agent.match(/向\s+session[_\s]*(\S+)\s+回复[：:]\s*(.+)/i);
      if (match) {
        let sessionId = match[1];
        const reply = match[2].trim();

        console.log('[SUMMARY-HANDLER] 向 Agent 发送回复:', { sessionId, reply });
        agentCommunicationService.handleReply(sessionId, reply);
      } else {
        console.warn('[SUMMARY-HANDLER] 无法解析 say_to_agent 格式:', gatherResult.thinkingResult.say_to_agent);
        console.warn('[SUMMARY-HANDLER] 正确格式应为: 向 session_xxx 回复：你的回复内容');
      }
    }

    // 🔥 3. 处理 interaction++
    if (gatherResult.thinkingResult?.isInteraction) {
      const sayToUser = gatherResult.thinkingResult?.say_to_user || '';
      callHistory.push({
        depth,
        actions: ['interaction++'],
        result: sayToUser,
      });

      const parsedInteraction = this.parseSayToUser(sayToUser);
      const currentConversationHistory = await this.getCurrentConversationHistory();

      const userResponse = await new Promise<string>((resolve) => {
        const interactionId = `main-${this.sessionId}-${depth}`;
        SummaryHandler.pendingInteractions.set(interactionId, {
          message: parsedInteraction.message,
          sessionId: interactionId,
          timestamp: Date.now(),
          conversationHistory: currentConversationHistory,
          resolve,
        });

        this.safeOnMessage(`interaction-${interactionId}`, {
          role: 'assistant',
          apiRole: 'summarizer',
          content: parsedInteraction.message,
          status: 'pending',
          iconText: i18n.t('workspace.chatMessages.waitingReply'),
        });
      });

      const interactionId = `main-${this.sessionId}-${depth}`;
      SummaryHandler.pendingInteractions.delete(interactionId);

      callHistory.push({
        depth,
        actions: ['user_response'],
        result: userResponse,
      });

      // 🔥 触发 userResponse 事件
      this.triggerEvent({ type: 'userResponse', response: userResponse });
      return;
    }

    // 🔥 4. 处理 tools
    if (!gatherResult.thinkingResult?.tools) {
      return;
    }

    const tools = gatherResult.thinkingResult.tools;
    console.log(`[SUMMARY-HANDLER] depth=${depth}, tools:`, tools);

    const sessionTasks: Array<{ task: string; priority: boolean }> = [];
    const getContextRequests: string[] = [];
    const killSessionRequests: string[] = [];
    let hasCheckUpdate = false;

    for (const tool of tools) {
      if (tool.name === 'sessioncreate') {
        sessionTasks.push({ task: tool.parameters.task || '', priority: tool.parameters.priority || false });
      } else if (tool.name === 'getContext') {
        getContextRequests.push(tool.parameters.sessionId || '');
      } else if (tool.name === 'killsession') {
        killSessionRequests.push(tool.parameters.sessionId || '');
      } else if (tool.name === 'check_update') {
        hasCheckUpdate = true;
      }
    }

    // 🔥 转换为 callHistory 用的字符串标签
    const actionLabels = tools.map(t =>
      t.name === 'sessioncreate' ? `sessioncreate: ${t.parameters.task || ''}`
      : t.name === 'check_update' ? 'check_update'
      : `${t.name}: ${t.parameters.sessionId || ''}`
    );

    // 🔥 4.0 处理 check_update（结果写入 callHistory，触发事件让循环继续 → LLM 组织回复）
    if (hasCheckUpdate) {
      await this.performCheckUpdate(callHistory, depth, actionLabels);
    }

    // 🔥 4.1 处理 killSession
    for (const sessionId of killSessionRequests) {
      SummaryHandler.killSession(sessionId);
      this.triggerEvent({ type: 'sessionKilled', sessionId });
    }

    // 🔥 4.2 处理 sessioncreate（异步启动，不阻塞；必须在 getContext 之前执行——
    //    getContext 分支末尾会 return，若放后面，同批返回的 sessioncreate 会被吞掉）
    if (sessionTasks.length > 0) {
      console.log(`[SUMMARY-HANDLER] depth=${depth}, 创建 ${sessionTasks.length} 个 sessions`);

      const createdSessionIds: string[] = [];
      const prioritySessionIds: string[] = [];
      const skippedTasks: string[] = [];
      const baseTimestamp = Date.now();

      for (let i = 0; i < sessionTasks.length; i++) {
        if (SummaryHandler.sessionContexts.size >= SummaryHandler.maxSessions) {
          skippedTasks.push(sessionTasks[i].task);
          continue;
        }

        const { task: cleanTask, priority: isPriority } = sessionTasks[i];

        const sessionId = baseTimestamp.toString(36) + '_' + i;
        createdSessionIds.push(sessionId);

        if (isPriority) {
          this.prioritySessionIds.add(sessionId);
          prioritySessionIds.push(sessionId);
        }

        const context = await this.createSessionListContext(
          sessionId,
          {
            tools: [{ name: 'sessioncreate', parameters: { task: cleanTask, priority: isPriority } }],
            say_to_user: i === 0 ? (gatherResult.thinkingResult.say_to_user || '') : ''
          },
          content
        );
        SummaryHandler.sessionContexts.set(sessionId, context);

        const sessionPromise = this.executeSessionAsync(context, content);
        this.runningSessionPromises.set(sessionId, sessionPromise);
      }

      if (prioritySessionIds.length > 0) {
        console.log(`[SUMMARY-HANDLER] 优先 sessions: [${prioritySessionIds.join(', ')}]`);
      }

      if (skippedTasks.length > 0) {
        const limitMessage = `已创建 sessions: [${createdSessionIds.join(', ')}]。⚠️ 达到最大 session 数量限制 (${SummaryHandler.maxSessions})，跳过 ${skippedTasks.length} 个任务。请整理当前进度并报告给用户，让用户决定是否继续。`;
        callHistory.push({
          depth,
          actions: actionLabels,
          result: limitMessage,
        });
        console.log(`[SUMMARY-HANDLER] ${limitMessage}`);

        if (createdSessionIds.length === 0) {
          this.triggerEvent({ type: 'sessionLimitReached', message: limitMessage });
        }
      } else {
        callHistory.push({
          depth,
          actions: actionLabels,
          result: `创建并启动 sessions: [${createdSessionIds.join(', ')}]`,
        });
      }
    }

    // 🔥 4.3 处理 getContext（放在最后：触发 contextReady 后 return，结束本批处理）
    if (getContextRequests.length > 0) {
      const contexts: Array<{ apiRole?: string; content?: string; result?: string }> = [];
      for (const sessionId of getContextRequests) {
        const ctx = this.getSessionContext(sessionId);
        contexts.push(...ctx);
      }

      callHistory.push({
        depth,
        actions: actionLabels,
        result: `获取 sessions [${getContextRequests.join(', ')}] 的上下文`,
      });

      // 🔥 触发 contextReady 事件
      this.triggerEvent({ type: 'contextReady', sessionId: getContextRequests[0], context: contexts });
      return;
    }
  }

  /**
   * 🔥 check_update：检查应用更新
   * 有新版（Windows）时设定时自动安装，给 LLM 留出回复用户的时间；
   * 结果写入 callHistory 后触发 checkUpdateDone 事件，循环继续 → LLM 组织回复
   */
  private async performCheckUpdate(
    callHistory: Array<{ depth: number; actions: string[]; result: string }>,
    depth: number,
    actionLabels: string[]
  ): Promise<void> {
    const electron = (window as any).electron;
    let resultText: string;

    try {
      if (!electron?.updater) {
        resultText = 'check_update 失败：仅桌面端支持检查更新';
      } else {
        const appVersion = (await electron.getAppVersion?.()) || '';
        const res = await electron.updater.check();
        const latest = res?.updateInfo?.version;

        if (!res?.success || !latest || !appVersion) {
          resultText = `check_update 失败：${res?.error || '未获取到版本信息'}（当前版本 ${appVersion || '未知'}）`;
        } else if (latest === appVersion) {
          resultText = `check_update 完成：当前版本 ${appVersion} 已是最新，无可用更新。`;
        } else if (electron.platform === 'darwin') {
          resultText = `check_update 完成：当前版本 ${appVersion}，发现新版本 ${latest}。macOS 无自动安装，将通知用户手动下载。请立即回复用户版本信息并尽快结束对话。`;
        } else {
          this.scheduleInstall(2);
          resultText = `check_update 完成：当前版本 ${appVersion}，发现新版本 ${latest}，已设定约 2 分钟后自动安装。请立即回复用户（新版本 ${latest}，当前版本 ${appVersion}，约 2 分钟后自动安装，请尽快结束对话），然后结束流程等待安装。`;
        }
      }
    } catch (e: any) {
      resultText = `check_update 失败：${e?.message || e}`;
    }

    callHistory.push({ depth, actions: actionLabels, result: resultText });
    this.triggerEvent({ type: 'checkUpdateDone' });
  }

  /**
   * 🔥 定时自动安装：到点后确认更新已下载完成（status=ready）再安装；
   * 未下载完则再等一个周期重试，最多 3 次
   */
  private scheduleInstall(minutes: number): void {
    const electron = (window as any).electron;
    if (!electron?.updater) return;
    const waitMs = minutes * 60 * 1000;

    const tryInstall = async (retries: number): Promise<void> => {
      try {
        const status = await electron.updater.getStatus();
        if (status?.status === 'ready') {
          await electron.updater.install();
        } else if (retries > 0) {
          setTimeout(() => { tryInstall(retries - 1); }, waitMs);
        } else {
          console.warn('[SUMMARY-HANDLER] 更新尚未下载完成，放弃本次自动安装（下次启动会重新检查）');
        }
      } catch (e) {
        console.warn('[SUMMARY-HANDLER] 自动安装更新失败:', e);
      }
    };

    setTimeout(() => { tryInstall(3); }, waitMs);
  }

  /**
   * 🔥 统一 Gather 流程（单次调用，不再递归执行工具）
   *
   * 职责：分析用户输入和已完成 session，决定下一步行动
   * - 返回 tools: 执行 session 操作（创建、查看、终止）
   * - 返回 say_to_user: 直接回复用户
   */
  private async handleGather(params: {
    userQuery: string;
    agentMessage?: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    depth?: number;
    maxDepth?: number;
    sessionList?: SessionInfo[];
    callHistory?: Array<{ depth: number; actions: string[]; result: string }>;
    sessionContext?: Array<{ apiRole?: string; content?: string; result?: string }>;
    writeNotes?: string;
  }): Promise<SummaryOutput> {
    const { userQuery, agentMessage, conversationHistory, depth = 0, maxDepth = 30, sessionList = [], callHistory = [], sessionContext, writeNotes } = params;

    const callId = `gather-${this.sessionId}-${depth}`;

    try {
    // 🔥 先发送 streaming 消息
    await this.safeOnMessage(callId, {
      role: 'auto',
      apiRole: 'summarizer',
      content: '',
      status: 'streaming',
      iconText: i18n.t('workspace.chatMessages.analyzing'),
    });

    // 🔥 获取当前对话历史（通过回调获取最新）
    const currentConversationHistory = await this.getCurrentConversationHistory();

    // 🔥 调用 summaryService，传递所有上下文
    const summaryResult = await summaryService.summary({
      userQuery,
      agentMessage, // 🔥 传递 Agent 消息
      context: {
        conversationId: this.conversationId,
        userId: this.userId,
        conversationHistory: currentConversationHistory,
      },
      gatherTools: getGatherToolsSummary(),
      sessionList,
      callHistory,
      sessionContext,
      depth,
      maxDepth, // 🔥 传递 maxDepth
      writeNotes, // 🔥 传递累加的笔记
    });

    if (!summaryResult.success) {
      await this.safeOnMessage(callId, {
        role: 'auto',
        apiRole: 'summarizer',
        content: '',
        result: summaryResult.error || i18n.t('workspace.chatMessages.analysisFailed'),
        status: 'failed',
        iconText: i18n.t('workspace.chatMessages.analysisFailed'),
      });

      return {
        thinkingResult: {
          say_to_user: summaryResult.error || i18n.t('workspace.chatMessages.analysisFailed'),
        },
      };
    }

    const parsedResult = this.parseSayToUser(summaryResult.say_to_user || '');

    // 🔥 如果是 interaction++，不在 handleGather 中发送消息，由 process 方法统一处理
    if (!parsedResult.isInteraction) {
      await this.safeOnMessage(callId, {
        role: 'auto',
        apiRole: 'summarizer',
        content: '',
        result: parsedResult.message,
        // 🔥 本轮 writeNotes 落 Message 表 memory 字段（reactor 每轮笔记不落库，只有 summary 的有总结性）；
        //    最后一条 summary 消息的 memory = 最终交差笔记，配合 userQuery 即强上下文
        memory: summaryResult.writeNotes,
        status: 'completed',
        iconText: i18n.t('workspace.chatMessages.analysisComplete'),
      });
    }

    // 🔥 如果没有 tools，直接回复用户
    if (!summaryResult.tools || summaryResult.tools.length === 0) {
      return {
        thinkingResult: {
          say_to_user: parsedResult.message,
          say_to_agent: summaryResult.say_to_agent, // 🔥 返回 say_to_agent
          isInteraction: parsedResult.isInteraction,
          writeNotes: summaryResult.writeNotes, // 🔥 返回 writeNotes
        },
      };
    }

    return {
      thinkingResult: {
        tools: summaryResult.tools,
        say_to_user: parsedResult.message,
        say_to_agent: summaryResult.say_to_agent, // 🔥 返回 say_to_agent
        isInteraction: parsedResult.isInteraction,
        writeNotes: summaryResult.writeNotes, // 🔥 返回 writeNotes
      },
    };
    } catch (gatherError) {
      console.error(`❌ [SUMMARY-HANDLER] handleGather 异常:`, gatherError instanceof Error ? gatherError.message : gatherError);
      throw gatherError;
    }
  }
}
