/**
 * Run GPU Train Tool
 * GPU 训练工具 - 从文件加载代码并启动 GPU 训练
 *
 * 功能：
 * 1. 传入 appId：直接启动现有应用进行 GPU 训练
 * 2. 传入文件路径：创建新应用，然后启动 GPU 训练
 * 
 * 简化版：
 * - 取消调剂逻辑
 * - 取消授权逻辑
 * - 如果需要 GPU 但没有传 gpuInstanceType，返回错误并告知支持的卡类型和价格
 */

import { appDatabaseService } from './AppDatabaseService';
import { AutoStep, AutoToolResult } from '../auto/types';
import { appExecutionService, checkGpuRequirement } from './AppExecutionService';
import { uploadOutputFiles, replacePathsWithUrls } from './AppOutputFileUploader';
import { showTrainingStatus, dismissTrainingToast } from '@/components/workspace/DesktopModule/TrainingToastManager';
import { traceInfo, traceDecision, traceError, traceProgress } from '@/utils/auto/ExecutionTraceStore';
import { desktopAppStorage } from '@/services/storage';
import { BalanceService } from '@/services/BalanceService';
import { resolveProjectId } from './ProjectIdResolver';

/**
 * 🔥 从错误信息推断状态码（原 utils/workspace/ExecutionStatusCodes.ts，唯一消费方就这里，就近内联）
 */
function inferStatusCodeFromError(error: string): number {
  const errorLower = error.toLowerCase();

  // Python 错误
  if (errorLower.includes('keyerror') || errorLower.includes('key error')) return 508;
  if (errorLower.includes('indexerror') || errorLower.includes('index error')) return 509;
  if (errorLower.includes('typeerror') || errorLower.includes('type error')) return 510;
  if (errorLower.includes('valueerror') || errorLower.includes('value error')) return 511;
  if (errorLower.includes('zerodivision') || errorLower.includes('division by zero')) return 512;
  if (errorLower.includes('importerror') || errorLower.includes('module not found')) return 506;
  if (errorLower.includes('syntaxerror') || errorLower.includes('syntax error')) return 502;
  if (errorLower.includes('python')) return 501;

  // 资源错误
  if (errorLower.includes('gpu') && errorLower.includes('sold out')) return 602;
  if (errorLower.includes('gpu')) return 601;
  if (errorLower.includes('credit') || errorLower.includes('balance')) return 603;
  if (errorLower.includes('quota')) return 604;
  if (errorLower.includes('memory')) return 505;

  // 网络错误
  if (errorLower.includes('timeout')) return 504;
  if (errorLower.includes('network') || errorLower.includes('connection')) return 702;
  if (errorLower.includes('rate limit')) return 301;

  // 输入错误
  if (errorLower.includes('not found')) return 404;
  if (errorLower.includes('invalid')) return 400;
  if (errorLower.includes('unauthorized') || errorLower.includes('api key')) return 401;
  if (errorLower.includes('forbidden')) return 403;
  if (errorLower.includes('cancelled') || errorLower.includes('canceled')) return 412;

  // 默认
  return 500;
}

function parseTrainQuery(query: string): {
  appId?: string;
  instructions: string;
  gpuInstanceType?: string;
} {
  if (!query || !query.trim()) {
    return { instructions: '' };
  }

  const trimmedQuery = query.trim();

  const appId = extractAppId(trimmedQuery);
  const gpuInstanceType = extractGpuInstanceType(trimmedQuery);

  const remaining = trimmedQuery
    .replace(appId || '', '')
    .replace(gpuInstanceType || '', '')
    .trim();

  return {
    appId,
    gpuInstanceType,
    instructions: remaining || '开始训练',
  };
}

/**
 * 🔥 提取 appId：支持完整 UUID 或前8位缩写
 */
function extractAppId(text: string): string | undefined {
  // 优先匹配完整 UUID
  const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
  const uuidMatch = text.match(uuidRegex);
  if (uuidMatch?.[0]) {
    return uuidMatch[0];
  }

  // 🔥 支持前8位短 ID（必须紧跟空格或行尾，避免匹配其他字符串）
  const shortIdRegex = /\b([a-f0-9]{8})\b(?![a-f0-9-])/gi;
  const shortIdMatch = text.match(shortIdRegex);
  if (shortIdMatch?.[0]) {
    return shortIdMatch[0].toLowerCase();
  }

  return undefined;
}

/**
 * 🔥 解析 projectId 已抽取为共享实现：见 ./ProjectIdResolver.ts
 * （UUID / 8位前缀 / 固定ID如 base-extensiontool 均可解析；签名统一为 (appId, resolved, userId)）
 */

/**
 * 🔥 校验并解析 appId：支持完整 UUID 或前8位缩写
 */
async function validateAndResolveAppId(
  appId: string,
  userId: string
): Promise<{ valid: boolean; error?: string; resolvedId?: string }> {
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, userId);

  if (resolveError) {
    return { valid: false, error: resolveError };
  }

  return { valid: true, resolvedId: resolved.id };
}

function extractGpuInstanceType(text: string): string | undefined {
  const aliyunRegex = /ecs\.gn[67]?[iv]?-[a-z0-9]+\.xlarge/i;
  const tencentRegex = /GN[0-9X]+\.?[0-9XLARGE]+/i;
  // 🔥 腾讯云 CPU 标准型（S5.MEDIUM4 等）
  const cpuRegex = /S\d+\.[A-Z0-9]+/i;
  const aliyunMatch = text.match(aliyunRegex);
  const tencentMatch = text.match(tencentRegex);
  const cpuMatch = text.match(cpuRegex);
  return aliyunMatch?.[0] || tencentMatch?.[0] || cpuMatch?.[0];
}

function inferProviderFromInstanceType(instanceType: string): string {
  if (instanceType.startsWith('ecs.') || instanceType.toLowerCase().includes('ecs.gn')) {
    return 'aliyun';
  }
  // 🔥 腾讯云：GPU 实例族（GN/GT/PNV/PTX）与 CPU 标准型（S5 等）
  if (/^(GN|PNV|GT|PTX)/i.test(instanceType) || /^S\d/i.test(instanceType)) {
    return 'tencent';
  }
  return 'aliyun';
}

async function executeGpuTraining(
  appId: string,
  gpuInstanceType: string | undefined,
  wait: boolean,
  sessionId: string,
  context: { userId: string; conversationId: string; sessionId?: string }
): Promise<AutoToolResult> {
  const userId = context.userId;
  let loadingToastId: string | number | undefined;

  try {
    // 🔥 代码以整个项目为单位（appId → 拉全项目），不支持单文件 code 传参；
    // LLM 想跑新代码先 save_project_file 保存到项目再启动训练
    const gpuCheck = checkGpuRequirement('import torch');
    const isGpu = true;

    console.log(`🚀 [RUN-GPU-TRAIN] GPU 需求检测:`, gpuCheck);
    if (sessionId) {
      traceProgress(sessionId, 'run_project_oncloud', 'GPU 需求检测完成', gpuCheck);
    }

    if (!gpuInstanceType) {
      // 🔥 不再硬编码规格列表，告诉用户先调用 list_instance_types 工具查询
      const errorMessage = `需要选择云端实例规格。请先调用 list_instance_types 工具查询当前支持的规格、价格和可用性，然后选择合适的 instanceType。

示例：
- 先调用 list_instance_types 查询支持的实例类型
- 然后在调用时传入 instanceType 参数，例如：
  - instanceType: "S5.LARGE8" (腾讯云 CPU 4C8G，普通计算)
  - instanceType: "GN7.2XLARGE32" (腾讯云 T4 GPU，训练)
  - instanceType: "ecs.gn6i-c4g1.xlarge" (阿里云 T4 GPU，训练)`;

      if (sessionId) {
        traceError(sessionId, 'run_project_oncloud', '缺少 gpuInstanceType 参数');
      }

      return {
        success: false,
        error: errorMessage,
        statusCode: 400,
        data: {
          type: 'gpu_selection_required',
          message: errorMessage,
        }
      };
    }

    // 🔥 余额预检：防止无余额用户启动 GPU 训练
    try {
      const balanceInfo = await BalanceService.checkBalance(userId, 1); // 至少需要 1 积分
      if (!balanceInfo.canAfford || balanceInfo.balance <= 0) {
        const balanceError = `⚠️ 余额不足，无法启动 GPU 训练。当前余额: ${BalanceService.formatBE(balanceInfo.balance)}。请告知用户需要先充值，充值后再重新启动训练。`;
        console.log(`🚫 [RUN-GPU-TRAIN] 余额不足: ${balanceInfo.balance}`);
        if (sessionId) {
          traceError(sessionId, 'run_project_oncloud', '余额不足', { balance: balanceInfo.balance });
        }
        return {
          success: false,
          error: balanceError,
          statusCode: 402,
          data: {
            type: 'insufficient_balance',
            message: balanceError,
            balance: balanceInfo.balance
          }
        };
      }
      console.log(`💰 [RUN-GPU-TRAIN] 余额检查通过: ${balanceInfo.balance}`);
    } catch (balanceError) {
      // 余额查询失败时允许继续（避免因网络问题阻止正常使用）
      console.warn('⚠️ [RUN-GPU-TRAIN] 余额查询失败，跳过预检:', balanceError);
    }

    loadingToastId = showTrainingStatus('正在train|run...', 'loading');

    if (sessionId) {
      traceProgress(sessionId, 'run_project_oncloud', '开始执行 GPU 训练', { appId, gpuInstanceType });
    }

    const app = await appDatabaseService.getDesktopApp(appId, userId);
    const appName = app?.name || '未知应用';

    const finalGpuInstanceType = gpuInstanceType;
    const finalGpuProvider = inferProviderFromInstanceType(finalGpuInstanceType);

    console.log(`[RUN-GPU-TRAIN] GPU规格: ${finalGpuInstanceType}, 推断Provider: ${finalGpuProvider}`);

    // 🔥 调用统一执行入口：恒走项目分支（拉全项目 zip + 入口探测），不传 code
    // waitResult=wait：false 时实例创建成功即返回（fire-and-forget 提交，云端自治），不挂起等训练终态
    const result = await appExecutionService.execute({
      appId,
      userId,
      conversationId: context.conversationId,
      isGpu: true,
      gpuInstanceType: finalGpuInstanceType,
      gpuProvider: finalGpuProvider,
      waitResult: wait,
    });

    dismissTrainingToast(loadingToastId);

    if (!result.success) {
      const statusCode = inferStatusCodeFromError(result.error || result.errorCode || '');
      if (sessionId) {
        traceError(sessionId, 'run_project_oncloud', '启动失败', { error: result.error, errorCode: result.errorCode });
      }
      return {
        success: false,
        error: result.error || "启动失败",
        statusCode,
        data: { type: 'appExecution', error: result.error || "启动失败", appId }
      };
    }

    if (result.gpuStatus === 'streaming') {
      // 🔥 更新 app 的 updatedAt，使经常训练的项目排在列表前面
      try { await desktopAppStorage.update(appId, {}); } catch (e) {}

      // 🔥 wait=false：机子创建成功即返回，用户稍后自己看结果（关电脑也不影响，云端自治）
      if (!wait) {
        if (sessionId) {
          traceInfo(sessionId, 'run_project_oncloud', '任务已启动，不等待结果', { taskId: result.taskId, appId });
        }
        return {
          success: true,
          data: {
            type: 'appExecution',
            status: 'streaming',
            taskStatus: 'pending',
            taskId: result.taskId,
            appId,
            gpuInstanceType,
            appName,
            message: `🚀 机子创建成功，云端计算正在进行（taskId: ${result.taskId}）。\n\n即使关闭电脑，云端任务也会继续执行；下次打开软件时，任务状态和结果会自动同步。请告知用户稍后通过项目任务详情查看结果，无需在本轮对话等待。`,
          },
          metadata: {
            toolName: 'run_project_oncloud',
            appId,
            taskId: result.taskId,
            executedAt: new Date(),
          },
        };
      }

      // 🔥 wait=true：挂起轮询直到任务终态（无超时；工具被 await，天然阻塞 ReAct 流程）
      if (sessionId) {
        traceInfo(sessionId, 'run_project_oncloud', '任务已启动，挂起等待完成', { taskId: result.taskId, appId });
      }

      const { trainingTaskStorage } = await import('@/services/storage');
      const { ReActExecutor } = await import('@/utils/auto/ReActExecutor');
      const reactExecutor = ReActExecutor.getInstance();

      const POLL_INTERVAL_MS = 10_000;
      const TERMINAL_STATUSES = ['success', 'completed', 'failed', 'stopped', 'error'];
      let lastStatus = '';
      let lastProgressTraceAt = 0;

      while (true) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

        // 🔥 用户中止了本轮 ReAct 对话 → 停止等待（云端任务继续自治执行，结果下次打开软件自动同步）
        if (reactExecutor.isConversationAborted(context.conversationId)) {
          if (sessionId) {
            traceInfo(sessionId, 'run_project_oncloud', '对话已中止，停止等待云端任务', { taskId: result.taskId });
          }
          return {
            success: true,
            data: {
              type: 'appExecution',
              status: 'streaming',
              taskStatus: 'pending',
              taskId: result.taskId,
              appId,
              gpuInstanceType,
              appName,
              message: `云端计算仍在后台进行（taskId: ${result.taskId}），本轮已停止等待；下次打开软件时结果会自动同步。`,
            },
            metadata: {
              toolName: 'run_project_oncloud',
              appId,
              taskId: result.taskId,
              aborted: true,
              executedAt: new Date(),
            },
          };
        }

        let task: any = null;
        try {
          task = await trainingTaskStorage.getById(result.taskId);
        } catch (e) {
          continue; // 查询偶发失败，下个周期重试
        }
        const status = task?.status || 'pending';

        if (status !== lastStatus) {
          lastStatus = status;
          lastProgressTraceAt = Date.now();
          if (sessionId) {
            traceProgress(sessionId, 'run_project_oncloud', `云端任务状态: ${status}`, { taskId: result.taskId });
          }
        } else if (sessionId && Date.now() - lastProgressTraceAt > 60_000) {
          lastProgressTraceAt = Date.now();
          traceInfo(sessionId, 'run_project_oncloud', '云端计算进行中，继续等待...', { taskId: result.taskId, status });
        }

        if (TERMINAL_STATUSES.includes(status)) {
          const ok = status === 'success' || status === 'completed';
          const output = task?.stdout_output || '';
          const chartsCount = Array.isArray(task?.charts_json) ? task.charts_json.length : 0;
          const filesCount = task?.files_json && typeof task.files_json === 'object' ? Object.keys(task.files_json).length : 0;

          if (sessionId) {
            traceInfo(sessionId, 'run_project_oncloud', `云端任务结束: ${status}`, { taskId: result.taskId, appId });
          }

          return {
            success: ok,
            error: ok ? undefined : (task?.error_message || `云端任务结束（${status}）`),
            data: {
              type: 'appExecution',
              status: ok ? 'completed' : 'failed',
              taskStatus: status,
              taskId: result.taskId,
              appId,
              gpuInstanceType,
              appName,
              output,
              charts: task?.charts_json || [],
              files: task?.files_json || {},
              duration: task?.duration,
              cost: task?.cost,
              message: ok
                ? `✅ 云端任务完成（${appName}）\n\n📋 执行详情：\n- 实例规格: ${gpuInstanceType}\n- 运行时长: ${task?.duration ?? '未知'}秒\n- 消耗: ${task?.cost ?? 0} 积分\n- 图表: ${chartsCount} 个 / 文件: ${filesCount} 个\n\n结果已在项目任务详情中展示，可直接向用户汇报。`
                : `❌ 云端任务失败：${task?.error_message || status}`,
            },
            metadata: {
              toolName: 'run_project_oncloud',
              appId,
              taskId: result.taskId,
              executedAt: new Date(),
            },
          };
        }
      }
    }

    // 🔥 更新 app 的 updatedAt（非 streaming 时也更新）
    try { await desktopAppStorage.update(appId, {}); } catch (e) {}

    return await processExecutionResult(result, appId, sessionId);

  } catch (error) {
    console.error('❌ [RUN-GPU-TRAIN] 执行异常:', error);
    if (loadingToastId) {
      dismissTrainingToast(loadingToastId);
    }
    if (sessionId) {
      traceError(sessionId, 'run_project_oncloud', '执行异常', { error: error instanceof Error ? error.message : String(error) });
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "执行异常",
      statusCode: 500,
      data: { type: 'app_execution', error: error instanceof Error ? error.message : "执行异常" }
    };
  }
}

async function processExecutionResult(
  result: any,
  appId: string,
  sessionId?: string
): Promise<AutoToolResult> {
  try {
    const outputText = result.output || '';
    if (outputText && outputText.length > 0) {
      console.log(`📤 [RUN-GPU-TRAIN] 开始上传输出文件`);
      if (sessionId) {
        traceProgress(sessionId, 'run_project_oncloud', '上传输出文件');
      }

      const uploadedFiles = await uploadOutputFiles(outputText);

      if (uploadedFiles.length > 0) {
        result.output = replacePathsWithUrls(result.output || '', uploadedFiles);
        console.log(`✅ [RUN-GPU-TRAIN] 文件上传完成，已替换路径`);
        if (sessionId) {
          traceInfo(sessionId, 'run_project_oncloud', '文件上传完成', { count: uploadedFiles.length });
        }
      }
    }

    if (sessionId) {
      traceInfo(sessionId, 'run_project_oncloud', '执行完成', { appId });
    }

    // 🔥 构造更清晰的返回消息
    let message = result.message || "GPU 训练执行完成";
    let errorDetail: string | undefined = undefined;
    
    // 🔥 根据失败原因提供更清晰的提示
    // 🔥 重要：将详细失败原因放到 error 字段，确保 LLM 能看到
    if (!result.success) {
      if (result.failureReason === 'instance_unavailable') {
        errorDetail = `GPU 实例创建失败（库存不足或权限问题）

📋 失败详情：
- 原因: 所有尝试的 GPU 规格都无可用实例
- 建议: 请稍后重试，或选择其他 GPU 规格

💡 可以使用 list_instance_types 查看可用的实例规格（GPU 卡型 / CPU 档位），然后重新发起。`;
      } else if (result.failureReason === 'execution_error' && result.instanceCreated) {
        // 🔥 直接内联日志尾部：Python traceback 恒在日志末尾，而 200k 全量 output 进 ReAct 历史
        //    会被截断保头（traceback 反而丢）——LLM 只能烧轮次"重读代码核对/查任务记录"。
        //    error 是 LLM 必读字段，尾部 3000 字符足够覆盖完整 traceback，一轮定位
        const logTail = (result.output || '').trim().slice(-3000);
        errorDetail = `GPU 实例已成功运行，但代码执行失败

📋 执行详情：
- GPU 实例: ${result.gpuInstanceType || '未知'}
- 运行时长: ${result.actualDuration || '未知'}秒

📋 错误日志（末尾部分，Python 报错通常在最后）：
\`\`\`
${logTail || '（日志为空，无 stderr 输出）'}
\`\`\`

💡 直接根据上述 traceback 修复代码（save_project_file），修复后重新 run_project_oncloud，无需重读全部代码。`;
      } else if (result.failureReason === 'timeout' && result.instanceCreated) {
        // 🔥 超时场景也内联日志尾部：末尾输出正是判断"训练慢/卡死/loss 不收敛"的一手依据
        const logTail = (result.output || '').trim().slice(-2000);
        errorDetail = `GPU 训练超时

📋 执行详情：
- GPU 实例: ${result.gpuInstanceType || '未知'}
- 运行时长: ${result.actualDuration || '未知'}秒
- 失败原因: 训练时间超过限制

📋 日志末尾（用于判断是训练慢还是卡死）：
\`\`\`
${logTail || '（日志为空）'}
\`\`\`

💡 建议：优化训练代码效率（减小数据量/epoch、简化模型），或选择更强的 GPU 规格。`;
      } else {
        // 🔥 其他失败情况，使用原始 error + 日志尾部（崩溃信息在日志末尾，同样内联给 LLM）
        const logTail = (result.output || '').trim().slice(-2000);
        errorDetail = result.error || '训练失败';
        if (logTail) {
          errorDetail += `\n\n📋 日志末尾（报错通常在最后）：\n\`\`\`\n${logTail}\n\`\`\``;
        }
      }
    } else {
      message = `✅ GPU 训练成功完成！

📋 执行详情：
- GPU 实例: ${result.gpuInstanceType || '未知'}
- 运行时长: ${result.actualDuration || '未知'}秒
- 图表数量: ${result.charts?.length || 0}
- 文件数量: ${Object.keys(result.files || {}).length}

📊 训练结果已在 output 中显示，请查看训练日志和输出结果。`;
    }

    return {
      success: result.success,
      // 🔥 关键：失败时将详细原因放到 error 字段，确保 LLM 能看到
      error: result.success ? undefined : errorDetail,
      data: {
        appId,
        output: result.output,
        outputFiles: result.files || [],
        charts: result.charts || [],
        // 🔥 新增：返回关键状态信息
        instanceCreated: result.instanceCreated,
        failureReason: result.failureReason,
        actualDuration: result.actualDuration,
        gpuInstanceType: result.gpuInstanceType,
        message: result.success ? message : undefined,  // 🔥 成功时才放 message
      },
      metadata: {
        toolName: 'run_project_oncloud',
        appId,
        taskId: result.taskId,
        executedAt: new Date(),
      },
    };
  } catch (error) {
    console.error('❌ [RUN-GPU-TRAIN] 处理结果失败:', error);
    return {
      success: result.success || false,
      data: {
        appId,
        output: result.output,
        message: result.message || "GPU 训练执行完成（结果处理有警告）"
      },
      metadata: {
        toolName: 'run_project_oncloud',
        appId,
        executedAt: new Date(),
      },
    };
  }
}

export async function executeRunGpuTrainTool(
  step: AutoStep,
  sessionId: string,
  context: { userId: string; conversationId: string; sessionId?: string }
): Promise<AutoToolResult> {
  console.log('[RUN-GPU-TRAIN] 执行 GPU 训练工具');

  if (sessionId) {
    traceInfo(sessionId, 'run_project_oncloud', '开始执行云端运行工具');
  }

  try {
    const params = step.toolParams || {};
    // 🔥 instanceType 为规范参数名，gpuInstanceType 为历史兼容
    const gpuInstanceType = (params.instanceType as string | undefined) || (params.gpuInstanceType as string | undefined);
    const appIdParam = (params.projectId as string | undefined) || (params.appId as string | undefined);
    // 🔥 wait：是否挂起等待任务完成（默认 true；兼容 LLM 传字符串 "false"）
    const wait = !(String((params as any).wait ?? true).toLowerCase() === 'false');

    const allValues = Object.values(params).filter(v => typeof v === 'string').join(' ');
    const query = (params.query as string) || allValues;

    console.log('[RUN-GPU-TRAIN] 原始参数:', params);
    console.log('[RUN-GPU-TRAIN] 解析结果:', { appIdParam, gpuInstanceType, query });

    // 🔥 run_project_oncloud 只接受 appId，不再支持 filePath 入口
    // LLM 想用本地文件训练时，应走 upsert_project → save_project_file → run_project_oncloud
    const missingAppIdError: AutoToolResult = {
      success: false,
      error: 'run_project_oncloud 需要 projectId 参数。请按以下流程操作：\n' +
        '1. 调用 upsert_project 创建项目（获取 projectId）\n' +
        '2. 调用 save_project_file 写入代码文件（filePath=main.py）\n' +
        '3. 调用 run_project_oncloud 启动训练（projectId=上一步的项目ID）',
      statusCode: 400,
      data: { type: 'missing_project_id', message: '缺少 projectId 参数' },
    };

    // 场景 1：appId 参数 → 直接启动现有应用训练
    if (appIdParam) {
      console.log('[RUN-GPU-TRAIN] 场景 1：直接启动现有应用训练:', appIdParam);

      // 🔥 校验并解析 appId（支持完整 UUID 或前8位缩写）
      const validation = await validateAndResolveAppId(appIdParam, context.userId);
      if (!validation.valid) {
        if (sessionId) {
          traceError(sessionId, 'run_project_oncloud', 'appId 格式校验失败', { appId: appIdParam });
        }
        return {
          success: false,
          error: validation.error,
          statusCode: 400,
          data: { type: 'invalid_app_id', appId: appIdParam, message: validation.error },
        };
      }

      // 🔥 使用解析后的完整 UUID
      const fullAppId = validation.resolvedId!;
      return await executeGpuTraining(fullAppId, gpuInstanceType, wait, sessionId, context);
    }

    // 场景 2：从 query 解析 appId
    if (!query || query.trim().length === 0) {
      return missingAppIdError;
    }

    const { appId, instructions } = parseTrainQuery(query);
    console.log('[RUN-GPU-TRAIN] 从 query 解析:', { query, appId, instructions, gpuInstanceType });

    if (appId) {
      console.log('[RUN-GPU-TRAIN] 场景 2（query解析）：直接启动现有应用训练:', appId);

      // 🔥 校验并解析 appId（支持完整 UUID 或前8位缩写）
      const validation = await validateAndResolveAppId(appId, context.userId);
      if (!validation.valid) {
        if (sessionId) {
          traceError(sessionId, 'run_project_oncloud', 'appId 格式校验失败', { appId });
        }
        return {
          success: false,
          error: validation.error,
          statusCode: 400,
          data: { type: 'invalid_app_id', appId, message: validation.error },
        };
      }

      // 🔥 使用解析后的完整 UUID
      const fullAppId = validation.resolvedId!;
      return await executeGpuTraining(fullAppId, gpuInstanceType, wait, sessionId, context);
    }

    // 没解析到 appId，返回引导提示
    if (sessionId) {
      traceError(sessionId, 'run_project_oncloud', '缺少 appId');
    }
    return missingAppIdError;

  } catch (error) {
    console.error('[RUN-GPU-TRAIN] 执行失败:', error);
    if (sessionId) {
      traceError(sessionId, 'run_project_oncloud', '执行失败', { error: error instanceof Error ? error.message : String(error) });
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : '执行 GPU 训练工具失败',
      statusCode: 500,
      data: { type: 'app_execution', error: error instanceof Error ? error.message : '执行 GPU 训练工具失败' },
    };
  }
}

export { executeRunGpuTrainTool as executeTeegalTrainTool };