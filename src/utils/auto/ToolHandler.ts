import { AutoStep, AutoToolResult } from "@/utils/auto/types";


import { executeSimpleSearchTool } from "@/utils/webshell/simpleSearchTool";
import { executeUrlReaderTool } from "@/utils/webshell/urlReaderTool";
import { executeExecuteCommandTool, executeRunPythonTool, executeGetAccountInfoTool, executeGetLocalAppTool, executeListCredentialsTool, executeComputerUseTool, ExecuteCommandProgress } from "@/utils/systemtools";
import { executeGetAppCodeTool } from '@/utils/apptool/GetAppCodeTool';
import { executeRunGpuTrainTool } from '@/utils/apptool/RunGpuTrainTool';
import { executeCheckCreditsTool } from '@/utils/apptool/CheckCreditsTool';
import { executeTeeGalUseGuideTool } from '@/utils/apptool/TeeGalUseGuideTool';
import { executeSshInstanceTool } from '@/utils/systemtools/sshInstance';
import { executeSshRemoteTool } from '@/utils/systemtools/sshRemote';
import {
  executeListProjectFilesTool,
  executeReadProjectFileTool,
  executeSaveProjectFileTool,
  executeEditProjectFileTool,
  executeDeleteProjectFileTool,
  executeStopGpuTrainTool,
  executeUpsertProjectTool,
  executeUpdateTrainTaskRemarkTool,
} from '@/utils/apptool/TrainProjectFileTools';
import { listGpuTypes } from '@/utils/apptool/ListGpuTypesTool';
import { executeRunDevTool } from '@/utils/apptool/LocalExecutionTools';
import { executeListTasksTool, executeGetTaskDetailTool } from '@/utils/apptool/TaskHistoryTools';
import { executeListCloudFilesTool } from '@/utils/apptool/DSETools';
import { executeUploadFileToOsSTool } from '@/utils/apptool/UploadFileToOsSTool';
import { executeCallMemoryTool } from '@/utils/auto/context/CallMemoryTool';
import { extensionToolRegistry, ExtensionToolContext, ExtensionToolResult } from '@/utils/auto/ExtensionToolRegistry';
import { loadBaseProjectTools, BASE_PROJECT_ID } from '@/utils/auto/BaseProjectToolLoader';
import { ApiClient } from '@/utils/ApiClient';
import { ToolDefinition } from '@/utils/auto/AvailableToolsRegistry';
import { desktopAppEventService } from '@/services/events/DesktopAppEventService';

export class ToolHandler {
  private userId: string;
  private conversationId: string;
  private userEmail?: string;
  private sessionId?: string;

  private toolsRegistry = new Map<string, {
    execute: (step: AutoStep, sessionId: string, onProgress?: (progress: ExecuteCommandProgress) => void) => Promise<AutoToolResult>;
  }>();

  constructor(userId: string, conversationId: string, userEmail?: string, sessionId?: string) {
    this.userId = userId;
    this.conversationId = conversationId;
    this.userEmail = userEmail;
    this.sessionId = sessionId;
    this.initToolsRegistry();
    this.initExtensionTools();
    this.maybeLoadBaseProjectTools();
  }

  /**
   * 🔥 构造时异步加载基础项目工具（fire-and-forget）
   * loader 内部幂等（同一 userId 只加载一次），通常 ChatHeader 启动时已加载完成
   */
  private maybeLoadBaseProjectTools(): void {
    loadBaseProjectTools(this.userId).then((count) => {
      if (count > 0) {
        // 有工具加载，重新注册到 toolsRegistry（幂等，覆盖注册）
        this.initExtensionTools();
      }
    }).catch((e) => {
      console.warn('[ToolHandler] 基础项目工具加载失败:', e);
    });
  }

  private initExtensionTools(): void {
    const toolDefs = extensionToolRegistry.getAllToolDefinitions();
    
    for (const toolDef of toolDefs) {
      this.registerExtensionTool(toolDef);
    }
    
    console.log(`🔧 [ToolHandler] 已加载 ${toolDefs.length} 个扩展工具`);
  }

  private registerExtensionTool(toolDef: ToolDefinition): void {
    const executor = async (step: AutoStep, sessionId: string): Promise<AutoToolResult> => {
      try {
        const result = await this.executeExtensionTool(toolDef.name, step, sessionId);
        return result;
      } catch (error) {
        return {
          success: false,
          error: `扩展工具 ${toolDef.name} 执行失败: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };

    this.registerTool(toolDef.name, executor);
  }

  private async executeExtensionTool(
    toolName: string,
    step: AutoStep,
    sessionId: string
  ): Promise<AutoToolResult> {
    console.log(`🔧 [ToolHandler] 执行扩展工具: ${toolName}`, step.toolParams);

    // 🔥 基础项目固定 ID（本地库按用户隔离，直接引用，无需 userId）
    const baseProjectId = BASE_PROJECT_ID;

    // 🔥 loadFile：加载基础项目内的辅助文件（多文件工具用）
    const loadFile = async (relativePath: string): Promise<any> => {
      const electron = (window as any).electron;
      if (!electron?.readAppCodeFile) {
        throw new Error('Electron API 不可用，无法加载辅助文件');
      }
      const result = await electron.readAppCodeFile({
        appId: baseProjectId,
        fileName: `tools/${relativePath}`,
      });
      if (!result?.success) {
        throw new Error(`辅助文件 ${relativePath} 读取失败: ${result?.error || '未知'}`);
      }
      // 辅助文件约定：return 出要导出的对象/函数
      const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFn('context', result.content);
      return await fn({ userId: this.userId, conversationId: this.conversationId });
    };

    // 🔥 超时保护：动态工具是 LLM 写的，core 不能无限等（慢 API/挂起的 fetch 等）
    // 超时后放弃等待，返回错误让 LLM 决定重试或换路径（工具本身可能仍在后台执行）
    const TOOL_TIMEOUT_MS = 20 * 60 * 1000; // 20 分钟
    const timeoutPromise = new Promise<ExtensionToolResult>((resolve) => {
      setTimeout(() => {
        resolve({
          success: false,
          error: `工具 ${toolName} 执行超时（系统限制 20 分钟），已放弃等待。编写扩展工具时请关注这一限制：长任务应分片执行或设计为可断点续跑，避免单个工具调用超过 20 分钟。`,
        });
      }, TOOL_TIMEOUT_MS);
    });

    const result = await Promise.race([
      extensionToolRegistry.executeTool(
        toolName,
        step.toolParams || {},
        {
          userId: this.userId,
          conversationId: this.conversationId,
          userEmail: this.userEmail,
          projectId: baseProjectId,
          llm: {
            call: (params) => ApiClient.llm.call(params),
            listModels: () => ApiClient.llm.listModels(),
          },
          loadFile,
        }
      ),
      timeoutPromise,
    ]);

    return {
      success: result.success,
      data: result.data,
      error: result.error,
      files: result.files?.map(filePath => ({
        id: `file-${Date.now()}`,
        name: filePath.split('/').pop() || filePath,
        path: filePath,
        type: 'application/octet-stream',
        content: '',
      })),
    };
  }

  // 🔥 项目文件写入成功后广播：ServicePreview webview 订阅后自动 reload——改完即见，用户不用手动刷新。
  //    双通道：① 同窗口内存事件总线（app_updated）② localStorage storage 事件（查看器是独立
  //    BrowserWindow，内存事件不互通；storage 事件只在"其他窗口"触发，恰好覆盖跨窗口方向）
  private emitProjectFilesChanged(step: AutoStep, result: AutoToolResult) {
    if (!result?.success) return;
    const projectId = step.toolParams?.projectId || step.appId;
    if (!projectId) {
      // 🔍 验证排查锚点：工具跑成功却没广播，第一嫌疑就是参数里没取到 projectId
      console.warn('📡 [SERVICE-RELOAD] 文件写入成功但拿不到 projectId，跳过广播:', step.toolName, step.toolParams ? Object.keys(step.toolParams) : null);
      return;
    }
    try {
      desktopAppEventService.emitAppUpdated(projectId, this.userId || '', { source: 'project_file_tool' });
      localStorage.setItem('projectFilesChangedSignal', JSON.stringify({ appId: projectId, t: Date.now() }));
      console.log('📡 [SERVICE-RELOAD] 已广播文件变更:', { projectId });
    } catch { /* 广播失败不影响工具结果 */ }
  }

  private registerTool(
    name: string,
    executor: (step: AutoStep, sessionId: string, onProgress?: (progress: ExecuteCommandProgress) => void) => Promise<AutoToolResult>
  ) {
    this.toolsRegistry.set(name, { execute: executor });
  }

  private initToolsRegistry() {
    this.toolsRegistry.clear();

    // 🔥 新工具名称（简洁版，无前缀）
    this.registerTool("web_search", (step, sessionId) => executeSimpleSearchTool(step, sessionId, this.userId, this.conversationId));
    this.registerTool("web_url_reader", (step, sessionId) => executeUrlReaderTool(step, sessionId, this.userId, this.conversationId));
    this.registerTool("list_projects", (step, sessionId) => executeGetLocalAppTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));
    this.registerTool("get_train_project_code", async (step: AutoStep, sessionId: string) => {
      return executeGetAppCodeTool(step, sessionId, { userId: this.userId });
    });
    
    // 🔥 项目文件操作工具
    this.registerTool("list_project_files", async (step: AutoStep, sessionId: string) => {
      return executeListProjectFilesTool(step, sessionId, { userId: this.userId });
    });
    this.registerTool("read_project_file", async (step: AutoStep, sessionId: string) => {
      return executeReadProjectFileTool(step, sessionId, { userId: this.userId });
    });
    this.registerTool("save_project_file", async (step: AutoStep, sessionId: string) => {
      const result = await executeSaveProjectFileTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId });
      this.emitProjectFilesChanged(step, result);
      return result;
    });
    this.registerTool("edit_project_file", async (step: AutoStep, sessionId: string) => {
      const result = await executeEditProjectFileTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId });
      this.emitProjectFilesChanged(step, result);
      return result;
    });
    this.registerTool("delete_project_file", async (step: AutoStep, sessionId: string) => {
      const result = await executeDeleteProjectFileTool(step, sessionId, { userId: this.userId });
      this.emitProjectFilesChanged(step, result);
      return result;
    });
    
    // 🔥 任务历史工具（合并版：云端训练 train + 本地执行 localrun 双源，见 TaskHistoryTools）
    this.registerTool("list_tasks", async (step: AutoStep, sessionId: string) => {
      return executeListTasksTool(step, sessionId, { userId: this.userId });
    });
    this.registerTool("get_task_detail", async (step: AutoStep, sessionId: string) => {
      return executeGetTaskDetailTool(step, sessionId, { userId: this.userId });
    });
    this.registerTool("stop_gpu_train", async (step: AutoStep, sessionId: string) => {
      return executeStopGpuTrainTool(step, sessionId, { userId: this.userId });
    });
    this.registerTool("update_train_task_remark", async (step: AutoStep, sessionId: string) => {
      return executeUpdateTrainTaskRemarkTool(step, sessionId);
    });

    // 🔥 upsert_project：创建/更新项目元信息（带 projectId 为更新模式）
    this.registerTool("upsert_project", async (step: AutoStep, sessionId: string) => {
      return executeUpsertProjectTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId });
    });
    
    // 🔥 新增：查询 GPU 类型列表
    this.registerTool("list_instance_types", async (step: AutoStep, sessionId: string) => {
      return listGpuTypes(step);
    });

    // 🔥 本地代码执行工具（run_project_onlocal 强调在本地执行）
    this.registerTool("run_project_onlocal", async (step: AutoStep, sessionId: string) => {
      return executeRunDevTool(step, sessionId, { userId: this.userId });
    });

    // 🔥 数据环境工具
    this.registerTool("list_cloud_files", async (step: AutoStep, sessionId: string) => {
      return executeListCloudFilesTool(step, sessionId, { userId: this.userId });
    });

    // 🔥 文件上传工具（从扩展工具迁移为内置工具）
    this.registerTool("uploadfiletooss", async (step: AutoStep, sessionId: string) => {
      return executeUploadFileToOsSTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId });
    });

    // 🔥 凭据管理工具（LLM 查询可用凭据列表，只看到名称不看到明文值）
    this.registerTool("list_credentials", async (step: AutoStep, sessionId: string) => {
      return executeListCredentialsTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId });
    });

    // 🔥 userpc_shell 传入 userId，支持 credentialName 参数注入环境变量
    this.registerTool("userpc_shell", (step, sessionId, onProgress) => executeExecuteCommandTool(step, sessionId, onProgress, { userId: this.userId }));

    // 🔥 SSH 实例租赁：开机云端 CPU 实例（公钥免密注入）→ userpc_shell ssh 操作 → close 关机结算
    this.registerTool("ssh_instance", (step, sessionId, onProgress) => executeSshInstanceTool(step, sessionId, onProgress, { userId: this.userId }));
    // 🔥 实例直连执行/写文件（Node spawn ssh argv 数组，免本地 shell 转义；userpc_shell+ssh 转义失败时的补充）
    this.registerTool("ssh_remote", (step, sessionId, onProgress) => executeSshRemoteTool(step, sessionId, onProgress, { userId: this.userId }));
    // 🔥 传入 userId，支持 credentialName 参数注入环境变量（与 userpc_shell 同通道）
    this.registerTool("userpc_run_python", (step, sessionId, onProgress) => executeRunPythonTool(step, sessionId, onProgress, { userId: this.userId }));
    // 🔥 电脑操作（Windows）：定位层产编号候选表 → LLM 选号 → 原子执行，LLM 永不接触坐标
    this.registerTool("computeruse", (step, sessionId, onProgress) => executeComputerUseTool(step, sessionId, onProgress));
    this.registerTool("get_account_info", (step, sessionId) => executeGetAccountInfoTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));
    // 🔥 云端运行项目（GPU 训练 + CPU 普通计算，instanceType 显式区分）
    this.registerTool("run_project_oncloud", (step, _sessionId) => executeRunGpuTrainTool(step, this.sessionId || '', { userId: this.userId, conversationId: this.conversationId, sessionId: this.sessionId }));
    this.registerTool("call_memory", (step, sessionId) => executeCallMemoryTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));
    // 🔥 check_user_credits 已合并到 get_account_info，保留注册向后兼容
    this.registerTool("check_user_credits", (step, sessionId) => executeCheckCreditsTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));
    this.registerTool("use_guide", (step, sessionId) => executeTeeGalUseGuideTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));

    // 🔥 向后兼容：teegal_ 前缀版本仍然可用
    this.registerTool("teegal_list_train_projects", (step, sessionId) => executeGetLocalAppTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));

    // 🔥 向后兼容：旧名称仍然可用
    this.registerTool("list_train_projects", (step, sessionId) => executeGetLocalAppTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));
    this.registerTool("list_train_project_files", async (step: AutoStep, sessionId: string) => {
      return executeListProjectFilesTool(step, sessionId, { userId: this.userId });
    });
    this.registerTool("read_train_project_file", async (step: AutoStep, sessionId: string) => {
      return executeReadProjectFileTool(step, sessionId, { userId: this.userId });
    });
    this.registerTool("save_train_project_file", async (step: AutoStep, sessionId: string) => {
      return executeSaveProjectFileTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId });
    });
    this.registerTool("edit_train_project_file", async (step: AutoStep, sessionId: string) => {
      return executeEditProjectFileTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId });
    });
    this.registerTool("delete_train_project_file", async (step: AutoStep, sessionId: string) => {
      return executeDeleteProjectFileTool(step, sessionId, { userId: this.userId });
    });
    this.registerTool("create_train_project", async (step: AutoStep, sessionId: string) => {
      return executeUpsertProjectTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId });
    });
    this.registerTool("teegal_get_train_project_code", async (step: AutoStep, sessionId: string) => {
      return executeGetAppCodeTool(step, sessionId, { userId: this.userId });
    });
    this.registerTool("teegal_get_account_info", (step, sessionId) => executeGetAccountInfoTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));
    this.registerTool("teegal_call_memory", (step, sessionId) => executeCallMemoryTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));
    // 🔥 teegal_check_user_credits 已合并到 teegal_get_account_info，保留注册向后兼容
    this.registerTool("teegal_check_user_credits", (step, sessionId) => executeCheckCreditsTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));
    this.registerTool("teegal_use_guide", (step, sessionId) => executeTeeGalUseGuideTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));
    
    // 🔥 向后兼容：app 旧名称仍然可用
    this.registerTool("teegal_list_apps", (step, sessionId) => executeGetLocalAppTool(step, sessionId, { userId: this.userId, conversationId: this.conversationId }));
    this.registerTool("teegal_get_app_code", async (step: AutoStep, sessionId: string) => {
      return executeGetAppCodeTool(step, sessionId, { userId: this.userId });
    });
  }

  async executeToolStep(step: AutoStep, sessionId: string, onProgress?: (progress: ExecuteCommandProgress) => void): Promise<AutoToolResult> {
    console.log("🔧 [TOOL-HANDLER] 执行工具步骤:", step.toolName);

    if (!step.toolName) {
      throw new Error("工具名称缺失");
    }

    const startTime = Date.now();

    try {
      let result: AutoToolResult;

      // 🔥 剥离工具名尾部的 * 标识（prompt 列表中扩展工具带 * 后缀，LLM 可能原样回传）
      const toolName = step.toolName.replace(/\*+$/, '');
      if (toolName !== step.toolName) {
        console.log(`🔧 [TOOL-HANDLER] 剥离 * 标识: ${step.toolName} -> ${toolName}`);
      }

      const reg = this.toolsRegistry.get(toolName);
      if (reg) {
        result = await reg.execute(step, sessionId, onProgress);
      } else if (extensionToolRegistry.hasTool(toolName)) {
        // 🔥 兜底：热重载新增的动态工具不在构造时快照里，实时查注册表
        // （save_project_file 保存基础项目 tools/ 后自动热重载，无需刷新页面）
        result = await this.executeExtensionTool(toolName, step, sessionId);
      } else {
        throw new Error(`未知工具类型: ${step.toolName}`);
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorResult: AutoToolResult = {
        success: false,
        error: error instanceof Error ? error.message : "工具执行失败",
        metadata: { toolName: step.toolName },
      };

      return errorResult;
    }
  }
}
