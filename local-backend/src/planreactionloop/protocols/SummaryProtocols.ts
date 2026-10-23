/**
 * 总结协议模块
 *
 * 职责：
 * 1. SUMMARY: 统一总结 - 处理所有用户需求（初始分析 + 调查后分析）
 * 2. REVIEW_SUMMARY: 检查总结 - 执行结果检查
 */

export interface SummaryProtocolConfig {
  /** 系统提示词 */
  systemPrompt: string;
  /** 输出字段名 */
  outputFieldName: string;
  /** 最大 token 数 */
  maxTokens: number;
}

/**
 * 🔥 统一总结协议 - 处理所有用户需求
 *
 * 用于：
 * 1. 初始需求分析（depth=0）：理解用户需求，决定是直接执行、创建待办，还是需要调查
 * 2. 调查后分析（depth>=1）：基于工具查询结果，决定是继续调查还是生成执行计划
 *
 * 对应: SummaryModule.summary()
 */
const SUMMARY_PROTOCOL: SummaryProtocolConfig = {
  systemPrompt: `你正在teegal上面对用户

## 你的任务
管理session工具，推理并完成用户的需求：

## 返回格式（⚠️⚠️必须严格遵从以下JSON格式返回，不能返回自然语言）
{
  "tools": [
    {"name": "sessioncreate", "parameters": {"task": "详细的上下文描述任务"}}
  ],
  "say_to_user": "用户仅看到say_to_user字段的信息，看不到其他字段",
  "writeNotes": "（可选）记忆关键信息：【已确认】信息1 | 【已确认】信息2 | 【待确认】xxx | 【关键线索】xxx  "
}

### tools 字段说明
- tools 是管理session的工具调用数组，不需要调用工具时返回空数组 []
- 管理session工具：
  - sessioncreate：创建session分发任务。parameters: {"task": "任务描述"}
  - check_update：检查应用是否有新版本。parameters: {}（结果会随工具结果回传）
- 多任务并行：多个 sessioncreate 会同时执行，近似任务并行会重复执行、互相踩踏，严禁
- 多任务串行：先返回一个 sessioncreate，完成后再返回下一个
- ⚠️ 查看 "已完成的 Session 列表" - 如果有状态为 "completed" 的 session，说明任务已成功完成
- ⚠️ 不需要启动任务时 tools 返回空数组 []

## 交互轮次
- 当前轮次：第 {currentDepth} 轮 |共 {maxDepth} 轮 |剩 {remainingDepth} 轮
`,
  outputFieldName: 'summary',
  maxTokens: 20000
};

// 为了保持兼容性，保留旧名称的导出
const RECEPTION_SUMMARY_PROTOCOL = SUMMARY_PROTOCOL;
const INVESTIGATION_SUMMARY_PROTOCOL = SUMMARY_PROTOCOL;
const INITIAL_SUMMARY_PROTOCOL = SUMMARY_PROTOCOL;
const GATHER_SUMMARY_PROTOCOL = SUMMARY_PROTOCOL;

export const SummaryProtocols = {
  SUMMARY: SUMMARY_PROTOCOL,

  // 兼容性导出（都指向统一的 SUMMARY_PROTOCOL）
  RECEPTION_SUMMARY: RECEPTION_SUMMARY_PROTOCOL,
  INVESTIGATION_SUMMARY: INVESTIGATION_SUMMARY_PROTOCOL,
  INITIAL_SUMMARY: INITIAL_SUMMARY_PROTOCOL,
  GATHER_SUMMARY: GATHER_SUMMARY_PROTOCOL,

  /**
   * 获取总结协议
   * @param mode 协议模式
   */
  get: (mode: 'summary' | 'reception_summary' | 'investigation_summary' | 'initial_summary' | 'gather_summary' = 'summary'): SummaryProtocolConfig => {
    const protocols: Record<string, SummaryProtocolConfig> = {
      // 新名称
      summary: SUMMARY_PROTOCOL,
      // 旧名称（兼容）
      reception_summary: RECEPTION_SUMMARY_PROTOCOL,
      investigation_summary: INVESTIGATION_SUMMARY_PROTOCOL,
      initial_summary: INITIAL_SUMMARY_PROTOCOL,
      gather_summary: GATHER_SUMMARY_PROTOCOL,
    };

    const config = protocols[mode] || SUMMARY_PROTOCOL;
    return {
      ...config,
      systemPrompt: config.systemPrompt.replace('{userEnvironment}', '')
    };
  }
};
