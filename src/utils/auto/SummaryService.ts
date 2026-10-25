import { ApiClient } from "@/utils/ApiClient";
import { getExecutionToolNames } from "./AvailableToolsRegistry";
import { EnvironmentBuilder } from "./environment/EnvironmentBuilder";

/**
 * 🔥 统一总结请求
 * 支持 sessionActions 协议
 */
export interface SummaryRequest {
  userQuery: string;
  context?: {
    conversationId?: string;
    userId?: string;
    conversationHistory?: Array<{ role: string; content: string; sessionId?: string; apiRole?: string; timestamp?: number }>;
  };
  gatherTools?: { name: string }[];
  agentCapabilities?: string[];
  // 🔥 新增：传递已完成的 session 列表
  sessionList?: SessionInfo[];
  // 🔥 新增：传递调用历史
  callHistory?: Array<{
    depth: number;
    actions: string[];
    result: string;
  }>;
  // 🔥 新增：传递指定 session 的详细上下文
  sessionContext?: Array<{
    apiRole?: string;
    content?: string;
    result?: string;
  }>;
  // 🔥 当前深度
  depth?: number;
  // 🔥 最大深度
  maxDepth?: number;
  // 🔥 传递累加的笔记
  writeNotes?: string;
  // 🔥 新增：Agent 消息（用于 Agent 与 SummaryHandler 通信）
  agentMessage?: string;
}

/**
 * 🔥 Summary 工具调用（替代旧的 sessionActions 字符串数组）
 */
export interface SummaryTool {
  name: string;  // 'sessioncreate' | 'getContext' | 'killsession'
  parameters: {
    task?: string;
    priority?: boolean;
    sessionId?: string;
  };
}

/**
 * 🔥 统一总结响应
 */
export interface SummaryResponse {
  success: boolean;
  tools?: SummaryTool[];  // 🔥 工具调用列表（替代 sessionActions）
  say_to_user?: string;
  say_to_agent?: string;  // 🔥 对 Agent 说的话
  writeNotes?: string;
  error?: string;
}

export interface SessionInfo {
  sessionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
  sessionGoal?: string;
  executionFlow?: {
    actual: string; // 🔥 实际执行轨迹
  };
}

// 兼容性导出
export type ReceptionSummaryRequest = SummaryRequest;
export type ReceptionSummaryResponse = SummaryResponse;
export type InvestigationSummaryRequest = SummaryRequest;
export type InvestigationSummaryResponse = SummaryResponse;

/**
 * Summary服务 - 用于生成用户需求的总结和执行方案描述
 * 
 * 职责：
 * 1. 总结 (Summary) - 统一处理用户需求（初始分析 + 调查后分析）
 * 2. 检查 (Review) - 执行结果检查
 */
class SummaryService {
  /**
   * 🔥 统一总结 - 处理所有用户需求
   * 
   * 合并了原来的 receptionSummary 和 investigationSummary
   * - depth=0: 初始需求分析（接待）
   * - depth>=1: 调查后分析（基于工具结果）
   */
  async summary(request: SummaryRequest, signal?: AbortSignal): Promise<SummaryResponse> {
    try {
      // 🔥 获取 execution 工具名称列表作为 Agent 能力
      const agentCapabilities = request.agentCapabilities || getExecutionToolNames();

      // 🔥 构建环境文本
      const environmentBuilder = new EnvironmentBuilder({
        enableDynamicAdjustment: true,
      });
      const environmentResult = await environmentBuilder.build(
        {
          role: 'summarizer',
          currentRound: request.depth, // 🔥 传递 depth 用于动态调整历史窗口
        },
        {
          userQuery: request.userQuery,
        },
        {
          conversationHistory: request.context?.conversationHistory,
          conversationId: request.context?.conversationId,
          userId: request.context?.userId, // 🔥 短 ID 置换：@projectid:短id → 完整 UUID（否则注入的"本地目录"是假路径）
        }
      );

      const result = await ApiClient.auto.summary({
        environmentText: environmentResult.text,
        // 🔥 传递 sessionActions 协议所需的上下文
        sessionList: request.sessionList,
        callHistory: request.callHistory,
        sessionContext: request.sessionContext,
        currentDepth: request.depth,
        maxDepth: request.maxDepth,
        agentMessage: request.agentMessage, // 🔥 传递 Agent 消息
        writeNotes: request.writeNotes, // 🔥 传递累加的笔记
      }, signal);

      const data = result;
      const error = result?.error || (result?.success === false ? result : undefined);


      if (error) {
        console.error("❌ [SummaryService] 总结失败:", error);
        return {
          success: false,
          error: error.message || "总结失败",
        };
      }

      return {
        success: true,
        tools: data.tools,
        say_to_user: data.say_to_user,
        say_to_agent: data.say_to_agent, // 🔥 返回 say_to_agent
        writeNotes: data.writeNotes,
      };
    } catch (error) {
      console.error("❌ [SummaryService] 总结异常:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      };
    }
  }

  // 🔥 兼容性方法（都指向统一的 summary 方法）
  async receptionSummary(request: SummaryRequest, signal?: AbortSignal): Promise<SummaryResponse> {
    return this.summary(request, signal);
  }

  async investigationSummary(request: SummaryRequest, signal?: AbortSignal): Promise<SummaryResponse> {
    return this.summary(request, signal);
  }
}

// 导出单例
export const summaryService = new SummaryService();
