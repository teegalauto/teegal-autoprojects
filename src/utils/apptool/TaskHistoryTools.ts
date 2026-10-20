/**
 * 任务历史工具（合并版）—— 降低工具面密度
 *
 * - list_tasks = list_train_tasks + list_localrun_logs（type 参数区分，缺省两源合并）
 * - get_task_detail = get_train_task_detail + get_localrun_logdetail（taskId 双源自动命中，回执带来源标签）
 *
 * 旧四个执行器保持原样，这里只做参数分发与来源标注。
 */

import { AutoStep, AutoToolResult } from '@/utils/auto/types';
import { executeListTrainTasksTool, executeGetTrainTaskDetailTool } from './TrainProjectFileTools';
import { executeListExecutionLogsTool, executeGetLogDetailTool } from './LocalExecutionTools';

const SOURCE_LABEL = {
  train: '【来源：云端训练 train】',
  localrun: '【来源：本地执行 localrun】',
} as const;

/** 给成功回执的 message 前加来源标签 */
function withSourcePrefix(res: AutoToolResult, label: string): AutoToolResult {
  const data: any = res.data || {};
  return { ...res, data: { ...data, message: `${label}\n${data.message || ''}`.trim() } };
}

/**
 * list_tasks：type=train|localrun 定向查询；缺省（或传错值）两源合并。
 * morePage（如 '11-20'）原样透传给底层执行器。
 */
export async function executeListTasksTool(
  step: AutoStep,
  planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const type = String((step.toolParams || {})?.type || '').trim().toLowerCase();

  if (type === 'train' || type === 'localrun') {
    const res = type === 'train'
      ? await executeListTrainTasksTool(step, planId, context)
      : await executeListExecutionLogsTool(step, planId, context);
    return res.success ? withSourcePrefix(res, SOURCE_LABEL[type]) : res;
  }

  // 两源合并：并发查询，分段标注（某一源为空/失败不影响另一源）
  const [train, local] = await Promise.all([
    executeListTrainTasksTool(step, planId, context),
    executeListExecutionLogsTool(step, planId, context),
  ]);
  if (!train.success && !local.success) {
    return {
      success: false,
      error: `云端训练与本地执行日志均查询失败：\n- train: ${train.error || '未知错误'}\n- localrun: ${local.error || '未知错误'}`,
    };
  }
  const sections: string[] = [];
  if (train.success) sections.push(`${SOURCE_LABEL.train}\n${(train.data as any)?.message || ''}`.trim());
  if (local.success) sections.push(`${SOURCE_LABEL.localrun}\n${(local.data as any)?.message || ''}`.trim());
  return {
    success: true,
    data: {
      type: 'taskList',
      message: sections.join('\n\n———\n\n'),
    },
  };
}

/**
 * get_task_detail：taskId 双源自动命中——先查云端训练任务，未命中再查本地执行日志，
 * 成功回执带来源标签；双双未命中给出两源错误汇总（省 LLM 再探测的一轮）。
 * 兼容 taskId/logId 两种参数名。
 */
export async function executeGetTaskDetailTool(
  step: AutoStep,
  planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params: any = (step.toolParams || (step as any).parameters || {});
  const taskId = String(
    params?.taskId || params?.taskid || params?.task_id || params?.logId || params?.logid || params?.log_id || params?.id || ''
  ).trim();

  if (!taskId) {
    return {
      success: false,
      error: "缺少 taskId 参数。用法: get_task_detail(taskId='xxx')",
    };
  }

  // 云端训练先试（命中即返回，本地毫秒级，无双源探测成本）
  const train = await executeGetTrainTaskDetailTool(
    { ...step, toolParams: { taskId }, parameters: { taskId } } as AutoStep,
    planId,
    context
  );
  if (train.success) return withSourcePrefix(train, SOURCE_LABEL.train);

  // 本地执行日志再试
  const local = await executeGetLogDetailTool(
    { ...step, toolParams: { logId: taskId }, parameters: { logId: taskId } } as AutoStep,
    planId,
    context
  );
  if (local.success) return withSourcePrefix(local, SOURCE_LABEL.localrun);

  return {
    success: false,
    error: `taskId 在两个来源中均未命中：\n- 云端训练: ${train.error || '未找到'}\n- 本地执行: ${local.error || '未找到'}`,
  };
}
