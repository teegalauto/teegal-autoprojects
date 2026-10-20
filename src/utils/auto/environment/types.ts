/**
 * 环境构建模块类型定义
 * 
 * 职责：
 * 1. 定义 Loop 信息类型（轮次控制）
 * 2. 定义环境上下文类型（环境数据）
 * 3. 定义注入策略类型
 * 4. 定义构建结果类型
 */

/**
 * 🔥 角色类型 - 与 API 调用角色统一
 * - summarizer: 总结阶段（初始需求分析）
 * - reactor: 执行阶段（工具调用和执行）
 */
export type EnvironmentRole = 'summarizer' | 'reactor';

/**
 * Loop 信息（轮次控制）
 * 由调用方传入，仅用于决策注入策略
 */
export interface LoopInfo {
  /** 当前角色 */
  role: EnvironmentRole;
  /** 当前轮次（从1开始，handleGather 不会以 depth=0 调用） */
  currentRound?: number;
  /** 最大轮次 */
  maxRounds?: number;
}

/**
 * 环境数据（实际要注入的内容）
 * 由调用方提供原始数据，EnvironmentBuilder 决定如何注入
 */
export interface EnvironmentData {
  /** 当前用户需求 */
  userQuery: string;
  // files 通过 ContextWindow 管理，不再直接传递
}

/**
 * 对话历史条目
 */
export interface ConversationEntry {
  role: 'user' | 'assistant' | 'system' | 'auto';
  content: string;
  timestamp?: number;
  sessionId?: string; // 🔥 关联的 session ID
  apiRole?: 'summarizer' | 'reactor'; // 🔥 API 调用角色
}

/**
 * 环境上下文（从各处获取的数据）
 * 与 InjectionStrategy 对齐，只包含需要注入的内容
 */
export interface EnvironmentContext {
  /** 对话历史 */
  conversationHistory: ConversationEntry[];
  /** Agent 执行能力 */
  agentCapabilities: string[];
  /** UserPC 环境信息 */
  userPC?: Record<string, any>;
  /** 用户注入消息（处理过程中用户发送的补充消息，将自动注入到上下文） */
  userInjectMessages?: Array<{
    id: string;
    content: string;
    timestamp: number;
    files?: Array<{
      id: string;
      name: string;
      type: string;
    }>;
  }>
}

/**
 * 注入策略配置
 */
export interface InjectionStrategy {
  /** 策略名称 */
  name: string;
  /** 是否注入用户需求 */
  includeUserQuery: boolean;
  /** 是否注入对话历史 */
  includeHistory: boolean;
  /** 是否注入 Gather 阶段可用工具 */
  includeGatherTools: boolean;
  /** 是否注入 Execution 阶段可用工具 */
  includeExecutionTools: boolean;
  /** 是否注入 UserPC 环境 */
  includeUserPC: boolean;
  /** 是否注入用户注入消息 */
  includeUserInjectMessages: boolean;
  /** 🔥 是否注入知识库 */
  includeKnowledgeBase: boolean;
  /** 🔥 是否注入重要对象引用（appId, fileId 等） */
  includeImportantObjects: boolean;
}

/**
 * 环境构建结果
 */
export interface EnvironmentResult {
  /** 构建好的环境文本（完整，向后兼容） */
  text: string;
  /** 🔥 固定部分的环境文本（ExecutionTools、UserPC 等，每轮不变，可缓存命中） */
  staticText: string;
  /** 🔥 动态部分的环境文本（ImportantObjects、UserInjectMessages、KnowledgeBase 等，可能每轮变化） */
  dynamicText: string;
  /** 实际注入的字段列表 */
  injectedFields: string[];
  /** 使用的策略名称 */
  strategy: string;
}

/**
 * 策略选择器接口
 */
export interface IStrategySelector {
  select(loopInfo: LoopInfo): InjectionStrategy;
  adjustStrategy(strategy: InjectionStrategy, loopInfo: LoopInfo): InjectionStrategy;
}
