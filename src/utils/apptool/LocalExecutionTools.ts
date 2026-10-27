/**
 * Local Execution Tools
 * 本地代码执行工具集
 *
 * 🔥 本地执行工具：
 * - run_project_onlocal: 本地执行项目代码（Python/Node/Shell），区别于 train_project 云端训练
 * - list_localrun_logs / get_localrun_logdetail: 已合并入 TaskHistoryTools（list_tasks / get_task_detail，本文件执行器仍保留供分发）
 */

import { AutoStep, AutoToolResult } from "../auto/types";
import { executeLocalCode } from "./LocalExecutor";
import { executionLogStorage, desktopAppStorage } from "@/services/storage";
import { checkGpuRequirement } from "./AppExecutionService";
import { getAppBasePath } from "./AppPathHelper";
import { resolveProjectId } from './ProjectIdResolver';

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 从参数中提取 appId
 */
function extractAppId(params: any, stepAppId?: string): string | undefined {
  return stepAppId ||
    params?.appId || params?.appid || params?.app_id ||
    params?.projectId || params?.projectid || params?.project_id ||
    params?.id;
}

/**
 * 🔥 解析 projectId 已抽取为共享实现：见 ./ProjectIdResolver.ts
 * （UUID / 8位前缀 / 固定ID如 base-extensiontool 均可解析）
 */

/**
 * 🔥 检查代码中是否包含 GPU 相关设置
 * 
 * 检测模式：
 * - device='cuda', device='gpu', device='cuda:0' 等
 * - torch.cuda, torch.device
 * - .to('cuda'), .to('gpu'), .cuda()
 * - CUDA_VISIBLE_DEVICES
 */
function checkGpuCode(code: string): { hasGpu: boolean; matches: string[] } {
  const patterns = [
    /device\s*[=:]\s*['"](cuda|gpu)/i,
    /torch\.cuda/i,
    /torch\.device\s*\(\s*['"](cuda|gpu)/i,
    /\.to\s*\(\s*['"](cuda|gpu)/i,
    /\.cuda\s*\(\s*\)/i,
    /CUDA_VISIBLE_DEVICES/i,
    /\.to\s*\(\s*torch\.device/i,
  ];

  const matches: string[] = [];
  
  for (const pattern of patterns) {
    const match = code.match(pattern);
    if (match) {
      matches.push(match[0]);
    }
  }

  return {
    hasGpu: matches.length > 0,
    matches,
  };
}

// ============================================================================
// 工具实现
// ============================================================================

/**
 * 本地执行项目代码（run_project_onlocal）
 *
 * 在本地执行项目代码，结果自动保存到 ExecutionLog
 * 只跑项目：只传 projectId 自动探测入口，或传 mainFile 指定入口；服务类自动脱管常驻
 * 🔥 临时脚本（单文件 python）请用 userpc_run_python，本工具不收 code（双入口是误用温床）
 *
 * 用法: run_project_onlocal(projectId='xxx')                     # 自动探测入口执行整个项目
 *       run_project_onlocal(projectId='xxx', mainFile='train.py')  # 指定入口执行
 */
export async function executeRunDevTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};

  const appId = extractAppId(params, step.appId);
  const userId = context?.userId;

  if (!appId) {
    return {
      success: false,
      error: "缺少 projectId 参数。用法: run_project_onlocal(projectId='xxx') 执行整个项目，或 run_project_onlocal(projectId='xxx', mainFile='train.py') 指定入口",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  if (!userId) {
    return {
      success: false,
      error: "缺少 userId，无法执行本地代码",
    };
  }

  // 🔥 code 参数已下线：临时脚本与 userpc_run_python 双入口是 LLM 误用的温床（实测会写 python
  //    脚本 subprocess 拉 npm dev，等 600s 超时假死）。本工具收窄为只跑项目，临时脚本走 userpc_run_python
  if (params?.code || params?.content) {
    return {
      success: false,
      error: "run_project_onlocal 已不支持 code 参数：临时脚本请改用 userpc_run_python。本工具只跑项目——只传 projectId 自动探测入口，或传 mainFile 指定入口。",
    };
  }

  // 🔥 提取参数
  const language = params?.language || 'auto';
  const mainFile = params?.mainFile || params?.main_file || params?.fileName;
  const timeout = params?.timeout ? parseInt(params.timeout) : 600;

  // 🔥 执行语义（code 已下线，只剩项目模式）：
  // - 只传 projectId → 执行整个项目（底层自动探测入口：package.json scripts / main.py / index.js...）
  // - 传 mainFile → 执行指定入口文件
  const isMultiFile = true;

  // 🔥 GPU 代码安全检查
  // 多文件项目：读取 mainFile 内容进行检查
  let codeToCheck = '';

  if (isMultiFile && mainFile) {
    const electron = (window as any).electron;
    const userDataPath = await getAppBasePath(fullAppId);
    const normalizedPath = mainFile.replace(/\//g, '\\');
    const fullPath = `${userDataPath}\\${normalizedPath}`;

    let readResult: any = null;
    try {
      readResult = await electron.userpcFile.read(fullPath);
    } catch (e) {
      console.warn('[RUN-DEV] 读取 mainFile 异常:', e);
    }

    if (!readResult?.success) {
      // 🔥 显式指定的 mainFile 不存在 → 直接报错，禁止底层静默回退自动探测入口
      // （否则"跑 sanity_check.py 校验"会被无声改成"跑 main.py 全量训练"，LLM 的执行意图被改写；
      //   且 GPU 安全检查也因读不到文件而落空）
      const fileName = mainFile.split(/[\\/]/).pop() || mainFile;
      return {
        success: false,
        error: `指定的入口文件「${mainFile}」在项目中不存在，已拒绝执行（防止静默误跑其他入口）。\n排查：① 文件可能尚未创建——先 save_project_file 保存；② 可能在子目录——用 list_project_files(projectId='${appId}', mode='search', query='${fileName}') 确认真实路径后再传完整相对路径。`,
        statusCode: 404,
      };
    }
    codeToCheck = readResult.data?.content || '';
  }

  if (codeToCheck && codeToCheck.trim()) {
    const gpuCheck = checkGpuRequirement(codeToCheck);
    if (gpuCheck.requiresGPU) {
      console.warn('[RUN-DEV] 检测到 GPU 代码，拒绝本地执行:', gpuCheck.reason);
      return {
        success: false,
        error: `🚫 检测到 GPU 相关代码，禁止本地执行。

原因：${gpuCheck.reason}

⚠️ 本地执行 GPU 代码可能导致本地算力崩溃或执行失败。

💡 请使用云端运行路径：run_project_oncloud(projectId='${appId}', instanceType='GN7.2XLARGE32')

� 如果确认要强制本地执行，请让用户在前端 UI 手动点击"运行"按钮。`,
        statusCode: 403,
      };
    }
  }

  try {
    console.log(`[RUN-DEV] 本地执行: appId=${fullAppId}, language=${language}, isMultiFile=${isMultiFile}`);

    const result = await executeLocalCode(
      {
        code: '',
        language,
        timeout,
        appId: fullAppId,
        userId,
        isMultiFile,
        // 🔥 mainFile 缺省时传空串，底层 executeMultiFileProject 会自动探测项目入口
        mainFile: mainFile || '',
      }
    );

    if (result.success) {
      const outputPreview = result.output
        ? (result.output.length > 2000 ? result.output.slice(0, 2000) + '\n...(输出过长已截断)' : result.output)
        : '(无输出)';

      return {
        success: true,
        data: {
          type: 'localExecution',
          logId: result.logId,
          exitCode: result.exitCode,
          duration: result.duration,
          output: outputPreview,
          message: `本地执行成功，耗时 ${(result.duration / 1000).toFixed(1)}秒，退出码 ${result.exitCode}\n\n输出:\n${outputPreview}`,
        },
      };
    } else {
      return {
        success: false,
        error: result.error || '本地执行失败',
        data: {
          type: 'localExecution',
          logId: result.logId,
          exitCode: result.exitCode,
          duration: result.duration,
          output: result.output?.slice(0, 500),
        },
      };
    }
  } catch (error) {
    console.error('[RUN-DEV] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "本地执行失败",
    };
  }
}

/**
 * 列出本地执行日志（list_localrun_logs）
 *
 * 获取指定项目的本地代码执行历史记录
 *
 * 用法: list_localrun_logs(projectId='xxx')
 */
export async function executeListExecutionLogsTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};

  const appId = extractAppId(params, step.appId);
  const userId = context?.userId;

  if (!appId) {
    return {
      success: false,
      error: "缺少 projectId 参数。用法: list_tasks(projectId='xxx')",
    };
  }

  // 🔥 解析 projectId（支持完整UUID或前8位缩写）
  const resolved = { id: '' };
  const resolveError = await resolveProjectId(appId, resolved, userId);
  if (resolveError) {
    return { success: false, error: resolveError };
  }
  const fullAppId = resolved.id;

  try {
    console.log(`[LIST-LOGS] 获取执行日志: appId=${fullAppId}`);

    // 🔥 使用 summary 接口，不返回大字段（stdout_output 等）
    const summaries = await executionLogStorage.getSummaryByAppId(fullAppId);

    if (!summaries || summaries.length === 0) {
      return {
        success: true,
        data: {
          type: 'executionLogList',
          appId: fullAppId,
          logs: [],
          logCount: 0,
          message: `项目尚无本地执行记录。可以使用 run_project_onlocal(projectId='${appId}') 执行整个项目（自动探测入口）。`,
        },
      };
    }

    const totalCount = summaries.length;

    // 🔥 分页：解析 morePage 参数（格式如 "11-20"）
    const morePage = params?.morePage || params?.more_page;
    let startIdx = 0;
    let endIdx = 10;
    if (morePage && typeof morePage === 'string') {
      const match = morePage.match(/^(\d+)-(\d+)$/);
      if (match) {
        startIdx = Math.max(0, parseInt(match[1]) - 1);
        endIdx = Math.min(totalCount, parseInt(match[2]));
      }
    }

    const pagedSummaries = summaries.slice(startIdx, endIdx);

    // 🔥 构造友好的摘要信息
    let logSummary = `项目共有 ${totalCount} 条本地执行记录，当前展示第 ${startIdx + 1}-${Math.min(endIdx, totalCount)} 条：\n\n`;
    pagedSummaries.forEach((log: any, index: number) => {
      logSummary += `${startIdx + index + 1}. 日志ID: ${log.id}\n`;
      logSummary += `   模式: ${log.execution_mode || 'python'}\n`;
      logSummary += `   状态: ${log.status}\n`;
      if (log.duration) logSummary += `   耗时: ${(log.duration / 1000).toFixed(1)}秒\n`;
      if (log.exit_code !== null && log.exit_code !== undefined) logSummary += `   退出码: ${log.exit_code}\n`;
      logSummary += `   时间: ${new Date(log.created_at).toLocaleString()}\n\n`;
    });

    logSummary += `💡 提示：使用 get_task_detail(taskId='完整的UUID') 获取执行日志详情`;
    if (totalCount > 10 && !morePage) {
      logSummary += `\n⚠️ 总共有 ${totalCount} 条记录，默认返回最近 10 条。如需查看更早记录，请使用 list_tasks(projectId='${appId}', type='localrun', morePage='11-20')`;
    }

    return {
      success: true,
      data: {
        type: 'executionLogList',
        appId: fullAppId,
        logs: pagedSummaries,
        logCount: totalCount,
        message: logSummary,
      },
    };
  } catch (error) {
    console.error('[LIST-LOGS] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "获取执行日志失败",
    };
  }
}

/**
 * 获取本地执行日志详情（get_localrun_logdetail）
 *
 * 获取单条本地执行日志的完整信息，包括输出内容
 *
 * 用法: get_localrun_logdetail(logId='xxx')
 */
export async function executeGetLogDetailTool(
  step: AutoStep,
  _planId: string,
  context?: { userId?: string }
): Promise<AutoToolResult> {
  const params = step.toolParams || step.parameters || {};

  // 🔥 提取 logId（支持多种参数名）
  const logId = params?.logId || params?.logid || params?.log_id || params?.id;

  if (!logId) {
    return {
      success: false,
      error: "缺少 logId 参数。用法: get_localrun_logdetail(logId='xxx')",
    };
  }

  try {
    console.log(`[LOG-DETAIL] 获取执行日志详情: logId=${logId}`);

    const log = await executionLogStorage.getById(logId);

    if (!log) {
      return {
        success: false,
        error: `执行日志不存在: ${logId}`,
      };
    }

    // 🔥 构造友好的详情信息
    let outputSummary = '';
    const stdout = (log as any).stdout_output || '';
    const stderr = (log as any).stderr_output || '';

    if (stdout) {
      const lines = stdout.split('\n');
      outputSummary = `\n\n📝 标准输出 (共${lines.length}行):\n`;
      outputSummary += lines.length <= 50
        ? stdout
        : `前20行:\n${lines.slice(0, 20).join('\n')}\n...\n后20行:\n${lines.slice(-20).join('\n')}`;
    }

    if (stderr) {
      outputSummary += `\n\n⚠️ 标准错误:\n${stderr.slice(0, 1000)}`;
    }

    return {
      success: true,
      data: {
        type: 'executionLogDetail',
        logId,
        log,
        message: `执行模式: ${(log as any).execution_mode || 'python'}\n状态: ${(log as any).status}\n退出码: ${(log as any).exit_code}\n耗时: ${((log as any).duration || 0) / 1000}秒${outputSummary}`,
      },
    };
  } catch (error) {
    console.error('[LOG-DETAIL] 异常:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "获取执行日志详情失败",
    };
  }
}
