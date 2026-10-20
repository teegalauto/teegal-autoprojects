/**
 * 环境注入策略定义
 *
 * 职责：
 * 1. 定义各角色各轮次的注入策略
 * 2. 提供策略选择逻辑
 * 3. 支持动态调整策略参数
 */

import { InjectionStrategy, LoopInfo, EnvironmentRole } from './types';

/**
 * 默认策略
 */
export const DEFAULT_STRATEGY: InjectionStrategy = {
  name: 'default',
  includeUserQuery: true,
  includeHistory: true,
  includeGatherTools: false,
  includeExecutionTools: false,
  includeUserPC: false,
  includeUserInjectMessages: false,
  includeKnowledgeBase: true, // 🔥 默认启用知识库
  includeImportantObjects: true, // 🔥 默认启用重要对象引用
};

/**
 * Summary 角色策略
 */
export const SUMMARY_STRATEGIES: Record<string, InjectionStrategy> = {
  /** Summary 初始轮（depth=0） */
  summary_initial: {
    name: 'summary_initial',
    includeUserQuery: true,
    includeHistory: true,
    includeGatherTools: false,
    includeExecutionTools: true,
    includeUserPC: true,
    includeUserInjectMessages: true,
    includeKnowledgeBase: true,
    includeImportantObjects: true,
  },
  /** Summary 调查轮（depth>=1） */
  summary_investigation: {
    name: 'summary_investigation',
    includeUserQuery: false, // 🔥 depth>=1 时不重复携带 userQuery，已在 callHistory depth 0 中记录
    includeHistory: true, // 🔥 启用历史，但由 EnvironmentBuilder 根据 depth 动态调整窗口
    includeGatherTools: false,
    includeExecutionTools: true,
    includeUserPC: false,
    includeUserInjectMessages: true,
    includeKnowledgeBase: false,
    includeImportantObjects: true,
  },
};

/**
 * Reactor 角色策略
 */
export const REACTOR_STRATEGIES: Record<string, InjectionStrategy> = {
  /** Reactor 标准策略 */
  reactor_standard: {
    name: 'reactor_standard',
    includeUserQuery: false,
    includeHistory: false,
    includeGatherTools: false,
    includeExecutionTools: true,
    includeUserPC: true,
    includeUserInjectMessages: true,
    includeKnowledgeBase: false,
    includeImportantObjects: false,
  },
};

/**
 * 所有策略汇总
 */
export const ALL_STRATEGIES: Record<string, InjectionStrategy> = {
  ...SUMMARY_STRATEGIES,
  ...REACTOR_STRATEGIES,
};

/**
 * 策略选择器类
 */
export class StrategySelectorClass {
  /**
   * 根据循环信息选择策略
   */
  selectStrategy(loopInfo: LoopInfo): InjectionStrategy {
    const { role } = loopInfo;

    switch (role) {
      case 'summarizer':
        return this.selectSummaryStrategy(loopInfo);
      case 'reactor':
        return REACTOR_STRATEGIES.reactor_standard;
      default:
        return DEFAULT_STRATEGY;
    }
  }

  /**
   * 选择 Summary 策略
   * 注意：handleGather 从 depth=1 开始调用，第一轮用 summary_initial
   */
  private selectSummaryStrategy(loopInfo: LoopInfo): InjectionStrategy {
    const { currentRound } = loopInfo;

    if (currentRound <= 1) {
      return SUMMARY_STRATEGIES.summary_initial;
    } else {
      return SUMMARY_STRATEGIES.summary_investigation;
    }
  }

  /**
   * 动态调整策略参数
   * 可以根据剩余轮次等条件调整策略
   */
  adjustStrategy(strategy: InjectionStrategy, loopInfo: LoopInfo): InjectionStrategy {
    // 🔥 历史窗口大小现在由 EnvironmentBuilder.buildHistorySection 根据 depth 动态调整
    // 这里可以添加其他策略调整逻辑
    return strategy;
  }
}

/**
 * 默认策略选择器实例
 */
export const defaultStrategySelector = new StrategySelectorClass();
