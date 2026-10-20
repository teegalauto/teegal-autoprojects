/**
 * GPU 多云调度器
 * 
 * 统一管理阿里云、腾讯云等多个 GPU 云厂商
 * 提供询价、选择、执行等功能
 */

import { ExecutionRequest, ExecutionResult } from './types';
import {
  GpuCloudProvider,
  GpuSpec,
  PriceInfo,
  GpuSelectionOption,
} from './providers';
import { HostedProxyProvider } from './providers/HostedProxyProvider';
import { OUTPUT_DIR } from './providers/JobBundleContract';
import { trainingTaskDatabase } from './TrainingTaskDatabase';
import { AppScheduler } from './AppScheduler';
import { wrapUserCodeForGpu, wrapMultiFileCode, isNodeEntry, pickNodeSingleFileName } from './GpuWrapper';
import axios from 'axios';

const HOME_WEB_URL = process.env.HOME_WEB_URL || 'https://www.workbees.space';

/**
 * GPU 执行配置
 * 🔥 仅 hosted 模式：本地只保留 HostedProxyProvider 薄代理，凭据/实例生命周期/结算全在云端
 */
export interface MultiCloudConfig {
  hosted?: boolean;
}

/**
 * GPU 多云调度器（hosted）
 */
export class GPUExecutor {
  private providers: Map<string, GpuCloudProvider> = new Map();
  private config: MultiCloudConfig;
  // 🔥 AbortController Map：用于通知 waitForCompletion 停止轮询
  private taskAbortControllers: Map<string, { controller: AbortController; reason?: string }> = new Map();

  constructor(config: MultiCloudConfig) {
    this.config = config;

    this.initProviders(config);
  }

  /**
   * 初始化 Provider：唯一注册 hosted 代理（实例生命周期/结算在云端）
   */
  private initProviders(config: MultiCloudConfig): void {
    const hostedProvider = new HostedProxyProvider({
      baseUrl: process.env.GPU_HOSTED_URL || HOME_WEB_URL,
      secret: process.env.GPU_WORKER_SECRET || ''
    });
    this.providers.set('hosted', hostedProvider);
    console.log('[GPU-MULTI] Hosted 代理 Provider 已初始化（凭据只存云端，本地零云厂商依赖）');
  }
  
  /**
   * 获取所有可用的 Provider
   */
  getProviders(): GpuCloudProvider[] {
    return Array.from(this.providers.values());
  }
  
  /**
   * 获取指定 Provider
   */
  getProvider(name: string): GpuCloudProvider | undefined {
    return this.providers.get(name);
  }
  
  /**
   * 🔥 根据实例 ID 定位 Provider（各厂商通过 ownsInstance 自判，调度器不感知前缀规则）
   */
  private resolveProviderForInstance(instanceId: string): { provider: GpuCloudProvider; providerName: string } | undefined {
    for (const [name, provider] of this.providers) {
      if (provider.ownsInstance(instanceId)) {
        return { provider, providerName: name };
      }
    }
    return undefined;
  }

  /**
   * 🔥 按厂商名定位 Provider：统一回退到 'hosted' 代理
   * （前端仍传 aliyun/tencent，hosted 模式由云端按 instanceType 路由到真实厂商）
   */
  private resolveProviderForName(name: string): GpuCloudProvider | undefined {
    return this.providers.get(name) || this.providers.get('hosted');
  }

  /**
   * 🔥 恢复场景结算：回写本地任务表（UI 展示权威值）。
   * 扣费只在云端进行——hostedSettled 有值时直接镜像云端权威 duration/cost；
   * 缺失时（如轮询中断）本地降级估算仅用于展示，不产生扣费，待下次恢复以云端为准。
   */
  private async settleRecoveredTask(
    task: any,
    spec: GpuSpec,
    success: boolean,
    output?: string,
    hostedSettled?: { duration: number; cost: number }
  ): Promise<{ duration: number; cost: number }> {
    let duration: number;
    let durationSource: string;

    if (hostedSettled) {
      duration = hostedSettled.duration;
      durationSource = '云端权威值';
    } else {
      // 🔥 降级：优先 result.json 中的 run_seconds，其次 created_at → now 封顶 24h（仅展示用）
      let runSeconds: number | undefined;
      if (output) {
        try {
          const parsed = JSON.parse(output);
          if (typeof parsed?.run_seconds === 'number' && parsed.run_seconds >= 0) {
            runSeconds = parsed.run_seconds;
          }
        } catch {} // output 不是 JSON（可能是纯日志），走降级逻辑
      }

      if (runSeconds !== undefined) {
        duration = Math.ceil(runSeconds);
        durationSource = `run_seconds(result.json)`;
      } else {
        const MAX_FALLBACK_SECONDS = 24 * 3600;
        duration = Math.min(
          Math.ceil((Date.now() - (task.created_at || Date.now())) / 1000),
          MAX_FALLBACK_SECONDS
        );
        durationSource = `created_at近似(封顶24h)`;
      }
    }

    const cost = hostedSettled?.cost ?? this.calculateCost(spec, duration);
    console.log(`[GPU-MULTI] 恢复结算: taskId=${task.id}, duration=${duration}s (${durationSource}), cost=${cost}积分`);

    await trainingTaskDatabase.updateTask(task.id, { duration, cost });

    return { duration, cost };
  }

  /**
   * 恢复悬挂任务
   *
   * 后端重启时，数据库中可能存在 status=running/pending 的任务，
   * 但后端的 waitForCompletion 轮询已经停止。
   * 此方法查询云端实际状态，更新数据库，并恢复正在运行的任务轮询。
   */
  async recoverOrphanTasks(): Promise<void> {
    console.log('[GPU-MULTI] 开始恢复悬挂任务...');

    try {
      const activeTasks = await trainingTaskDatabase.getActiveTasks();

      if (activeTasks.length === 0) {
        console.log('[GPU-MULTI] 没有悬挂任务需要恢复');
        return;
      }

      console.log(`[GPU-MULTI] 发现 ${activeTasks.length} 个悬挂任务，开始检查云端状态...`);

      // 🔥 云端任务为权威。waitForCompletion 对终态任务立即返回（含云端权威
      //    duration/cost 与 result.json 原文），对运行中任务继续阻塞轮询，因此统一走 resumeTask
      const hostedProvider = this.providers.get('hosted');
      for (const task of activeTasks) {
        if (!hostedProvider) {
          await trainingTaskDatabase.updateTask(task.id, {
            status: 'failed',
            error_message: 'hosted Provider 未初始化'
          });
          continue;
        }
        if (!task.gpu_instance_id) {
          console.warn(`[GPU-MULTI] 任务 ${task.id} 无实例ID，标记为失败`);
          await trainingTaskDatabase.updateTask(task.id, {
            status: 'failed',
            error_message: '后端重启时发现任务无实例ID'
          });
          continue;
        }
        this.resumeTask(task.id, task.gpu_instance_id, hostedProvider);
      }

      console.log('[GPU-MULTI] 悬挂任务恢复完成');
    } catch (error: any) {
      console.error('[GPU-MULTI] 恢复悬挂任务失败:', error.message);
    }
  }
  
  /**
   * 恢复正在运行的任务轮询
   *
   * 🔥 调用前提：recoverOrphanTasks 已设置好凭证（setupProviderForTask）
   */
  private resumeTask(taskId: string, instanceId: string, provider: GpuCloudProvider): void {
    console.log(`[GPU-MULTI] 恢复任务轮询: taskId=${taskId}, instanceId=${instanceId}`);

    (async () => {
      // 🔥 注册 AbortController，使恢复后的任务也能被 stop() 停止
      const abortController = new AbortController();
      this.taskAbortControllers.set(taskId, { controller: abortController });

      try {
        // 🔥 获取任务信息（包含 gpu_instance_region / instance_type / user_id）
        const task = await trainingTaskDatabase.getTask(taskId);
        const instanceRegion = task?.gpu_instance_region || undefined;
        const spec = await this.parseInstanceType(task?.instance_type || '');

        const result = await provider.waitForCompletion(instanceId, 0, undefined, instanceRegion, abortController.signal);

        let finalOutput = result.output || '';
        let isSuccess = result.success;
        let internalError = result.error;

        // 🔥 构造ossPath
        const ossPath = `training-tasks/${taskId}/output/`;

        let charts: any[] = [];
        let files: { [key: string]: any } = {};

        try {
          const parsed = await this.parseExecutionOutput(finalOutput, ossPath, provider);
          isSuccess = parsed.success;
          internalError = parsed.error;
          finalOutput = parsed.output;
          charts = parsed.charts;
          files = parsed.files;
        } catch {}

        // 🔥 检查任务是否已被用户停止（stop() 会先标记 stopped 并通知前端）
        const currentTask = await trainingTaskDatabase.getTask(taskId);
        const stoppedByUser = currentTask?.status === 'stopped';

        // 🔥 修复：duration 按 created_at → now 计算（原来恒为 0）
        const updates: any = {
          stdout_output: finalOutput,
          charts_json: charts,
          files_json: files,
          error_message: internalError
        };
        if (!stoppedByUser) {
          updates.status = isSuccess ? 'success' : 'failed';
        }
        await trainingTaskDatabase.updateTask(taskId, updates);

        // 🔥 修复：恢复的任务完成后同样要结算扣费（原来漏扣），用户停止的也按已运行时长扣费
        // 传入 finalOutput（result.json 内容）以提取云端记录的 run_seconds 真实时长
        // 🔥 hosted 模式：duration/cost 镜像云端权威值（云端已结算扣费，本地不重复）
        await this.settleRecoveredTask(
          task,
          spec,
          isSuccess,
          finalOutput,
          result.duration !== undefined ? { duration: result.duration, cost: result.cost ?? 0 } : undefined
        );

        // 🔥 通知前端任务完成（原来恢复路径不发通知；用户停止时 stop() 已发过，跳过）
        const wsManager = AppScheduler.getInstance().getWsManager();
        if (!stoppedByUser && wsManager && task?.app_id) {
          wsManager.send(`app-${task.app_id}`, {
            type: 'gpu_task_complete',
            appId: task.app_id,
            taskId,
            result: {
              success: isSuccess,
              output: finalOutput,
              error: internalError,
              charts,
              files,
              executionMode: 'gpu',
              gpuStatus: 'stopped'
            }
          });
        }

        await this.cleanupInstance(provider, instanceId, isSuccess, instanceRegion);

        console.log(`[GPU-MULTI] 恢复任务完成: ${taskId}, success=${isSuccess}`);
      } catch (error: any) {
        console.error(`[GPU-MULTI] 恢复任务失败: ${taskId}`, error.message);
        const task = await trainingTaskDatabase.getTask(taskId);
        // 🔥 用户手动停止（abort 抛出）时不覆盖 stopped 状态
        if (task?.status !== 'stopped') {
          await trainingTaskDatabase.updateTask(taskId, {
            status: 'failed',
            error_message: error.message
          });
        }
        // 🔥 失败也要结算，避免计费泄漏
        if (task) {
          const spec = await this.parseInstanceType(task.instance_type || '');
          await this.settleRecoveredTask(task, spec, false);
        }
        // 注：轮询异常中断时拿不到 result.json，结算走降级逻辑（created_at 近似 + 24h 封顶）
        // 🔥 轮询已断，主动释放实例止损，防止云端持续计费无人管理
        try {
          await provider.stopInstance(instanceId, task?.gpu_instance_region || undefined);
        } catch (stopError) {
          console.error(`[GPU-MULTI] 恢复失败后停止实例失败: ${instanceId}`, stopError);
        }
      } finally {
        this.taskAbortControllers.delete(taskId);
      }
    })();
  }
  
  /**
   * 查询 GPU 价格选项
   *
   * 🔥 hosted：一次透传云端完整价格选项（含各厂商名），不做本地逐规格询价
   */
  async queryAllPrices(): Promise<GpuSelectionOption[]> {
    const hosted = this.providers.get('hosted');
    if (hosted?.fetchAllPriceOptions) {
      try {
        return await hosted.fetchAllPriceOptions();
      } catch (error: any) {
        console.warn('[GPU-MULTI] hosted 价格透传失败:', error.message);
        return [];
      }
    }
    return [];
  }
  
  /**
   * 执行 GPU 任务
   * 
   * 支持两种模式：
   * 1. 自动模式：使用默认 Provider 或最便宜的可用 Provider
   * 2. 用户选择模式：使用用户指定的 Provider 和规格
   */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startTime = Date.now();
    
    // 🔥 在 try 块之前定义，确保 catch 块可以访问
    let provider: GpuCloudProvider | undefined = undefined;
    let instanceId: string | undefined = undefined;
    let instanceRegion: string | undefined = undefined;  // 实例所在区域
    
    try {
      if (request.requireGpuConfirmation) {
        const options = await this.queryAllPrices();
        return {
          success: true,
          output: '等待 GPU 确认...',
          executionTime: 0,
          executionMode: 'gpu',
          gpuNeeded: true,
          estimatedCost: options[0]?.price.pricePerHour || 3.0,
          gpuStatus: 'pending',
          message: JSON.stringify({ gpuOptions: options })
        };
      }
      
      const taskId = request.taskId || `task-${Date.now()}`;
      request.taskId = taskId;
      
      const instanceType = request.gpuInstanceType || '';
      // 🔥 hosted 模式：本地无渠道概念，统一走 hosted 代理（前端传的 aliyun/tencent 由云端按 instanceType 路由）
      const providerName = request.gpuProvider || 'aliyun';
      provider = this.resolveProviderForName(providerName);

      if (!provider) {
        throw new Error(`Provider ${providerName} 未配置`);
      }

      console.log(`[GPU-MULTI] GPU规格: ${instanceType}, 最终使用: ${providerName} (${provider.displayName})`);

      const spec: GpuSpec = await this.parseInstanceType(
        request.gpuInstanceType || '',
        request.config?.env_vars?.GPU_TYPE
      );
      
      // 🔥 提取 OSS/COS 信息（用于 URL 替换）
      // 🔥 凭据只存云端，本地仅取非密存储信息（bucket/region/appId）做 URL 内网化
      let ossBucket: string | undefined;
      let ossRegion: string | undefined;
      let ossAppId: string | undefined;
      const storage = await provider.fetchStorageInfo?.();
      ossBucket = providerName === 'aliyun' ? storage?.ossBucket : storage?.cosBucket;
      ossRegion = providerName === 'aliyun' ? storage?.ossRegion : storage?.cosRegion;
      ossAppId = providerName === 'tencent' ? storage?.appId : undefined;

      const ossPath = `training-tasks/${taskId}/output/`;

      // 🔥 统一输出目录（Job Bundle 契约约定；所有云厂商都使用云端本地磁盘，Provider 自己处理上传）
      const outputDir = `${OUTPUT_DIR}/`;

      // 🔥 包装用户代码（传入 OSS/COS 信息，用于替换外网 URL 为内网 URL）
      // 🔥 node 运行时（入口扩展名或 node shebang 判定）：统一走多文件引导壳
      //    （文件写入 /tmp/project 后由 node/tsx 执行，退出码透传）——云端执行壳无需感知语言
      const entryPoint = request.entryPoint || request.mainFile || '';
      const isNodeRuntime = (!!entryPoint && isNodeEntry(entryPoint)) ||
        (!request.isMultiFile && /^#!.*node/.test((request.code || '').slice(0, 100)));
      let wrappedCode: string;
      if (isNodeRuntime) {
        const nodeEntry = entryPoint || pickNodeSingleFileName(request.code || '');
        const nodePkg = (request.isMultiFile && request.codePackage)
          ? request.codePackage
          : Buffer.from(JSON.stringify([{ path: nodeEntry, content: request.code || '' }]), 'utf-8').toString('base64');
        console.log(`[GPU-NODE] node 运行时，入口: ${nodeEntry}`);
        wrappedCode = wrapMultiFileCode(nodePkg, nodeEntry, outputDir, ossBucket, ossRegion, ossAppId, providerName);
      } else if (request.isMultiFile && request.codePackage) {
        console.log(`[GPU-MULTI] 多文件项目，解析打包内容...`);
        wrappedCode = wrapMultiFileCode(request.codePackage, entryPoint || 'main.py', outputDir, ossBucket, ossRegion, ossAppId, providerName);
      } else {
        wrappedCode = wrapUserCodeForGpu(request.code, { outputDir, ossBucket, ossRegion, ossAppId, provider: providerName });
      }
      
      const createResult = await provider.createInstance({
        spec,
        taskId,
        // 🔥 不传 containerImage，让 Provider 使用自己的默认值
        command: wrappedCode,
        envVars: request.config?.env_vars || {},
        ossPath,
        // 🔥 hosted 代理：云端扣费/任务登记需要用户与应用标识
        userId: request.userId,
        appId: request.appId
      });
      
      if (!createResult.success) {
        throw new Error(createResult.error || '实例创建失败');
      }
      
      instanceId = createResult.instanceId!;
      instanceRegion = createResult.region;  // 保存实例所在区域
      console.log(`[GPU-MULTI] 实例已创建: ${instanceId} (Provider: ${providerName}, Region: ${instanceRegion || 'default'})`);
      
      if (request.taskId) {
        await trainingTaskDatabase.createTask({
          id: request.taskId,
          user_id: request.userId || 'unknown',
          app_id: request.appId || 'unknown',
          status: 'pending',
          code_snapshot: request.code || '',
          instance_type: spec.instanceType || 'unknown',
          gpu_instance_id: instanceId,
          gpu_instance_region: instanceRegion  // 🔥 存储实例 region
        });
        console.log(`[GPU-MULTI] Task 已登记: ${request.taskId}, instanceId: ${instanceId}, region=${instanceRegion}, status=pending`);

        const wsManager = AppScheduler.getInstance().getWsManager();
        if (wsManager && request.appId) {
          wsManager.send(`app-${request.appId}`, {
            type: 'gpu_task_status',
            appId: request.appId,
            taskId: request.taskId,
            status: 'pending'
          });
          console.log(`[GPU-MULTI] 发送 pending 状态通知: appId=${request.appId}, taskId=${request.taskId}`);
        }
      }
      
      let taskStatusNotified = false;
      let instanceRunningAt: number | null = null;

      // 🔥 如果内存中 instanceRegion 为空，尝试从数据库获取备份
      if (!instanceRegion && request.taskId) {
        const existingTask = await trainingTaskDatabase.getTask(request.taskId);
        if (existingTask?.gpu_instance_region) {
          instanceRegion = existingTask.gpu_instance_region;
          console.log(`[GPU-MULTI] 从数据库恢复 region: ${instanceRegion}`);
        }
      }

      // 🔥 创建 AbortController，用于 stop() 通知 waitForCompletion 停止
      const abortController = new AbortController();
      if (request.taskId) {
        this.taskAbortControllers.set(request.taskId, { controller: abortController });
      }

      // 🔥 maxWaitTime = 0 表示无限等待（训练可能需要几小时甚至几天）
      // 🔥 传入 instanceRegion 和 abortSignal，确保在正确的区域查询实例状态
      const executionResult = await provider.waitForCompletion(instanceId, 0, (status) => {
        if (status === 'running' && !taskStatusNotified && request.taskId) {
          taskStatusNotified = true;
          instanceRunningAt = Date.now();
          console.log(`[GPU-MULTI] 实例已开始运行，更新任务状态: ${request.taskId}`);
          trainingTaskDatabase.updateTask(request.taskId, {
            status: 'running'
          }).catch(err => {
            console.error('[GPU-MULTI] 更新任务状态失败:', err.message);
          });
          
          const wsManager = AppScheduler.getInstance().getWsManager();
          if (wsManager && request.appId) {
            wsManager.send(`app-${request.appId}`, {
              type: 'gpu_task_status',
              appId: request.appId,
              taskId: request.taskId,
              status: 'running'
            });
          }
        }
      }, instanceRegion, abortController.signal);  // 🔥 传入 abortSignal

      // 🔥 清理 AbortController
      if (request.taskId) {
        this.taskAbortControllers.delete(request.taskId);
      }

      let finalOutput = executionResult.output || '';
      let charts: any[] = [];
      let files: { [key: string]: any } = {};
      let isSuccess = executionResult.success;
      let internalError = executionResult.error;

      console.log(`[GPU-MULTI] 执行结果: success=${executionResult.success}, error=${executionResult.error}`);
      console.log(`[GPU-MULTI] 原始输出长度: ${finalOutput.length}`);
      console.log(`[GPU-MULTI] 原始输出前 500 字符: ${finalOutput.substring(0, 500)}`);

      // 🔥 只有当输出不为空时才解析
      if (finalOutput.length > 0) {
        try {
          const parsed = await this.parseExecutionOutput(finalOutput, ossPath, provider!);
          console.log(`[GPU-MULTI] 解析结果: success=${parsed.success}, output长度=${parsed.output.length}, charts=${parsed.charts.length}, files=${Object.keys(parsed.files).length}`);
          console.log(`[GPU-MULTI] charts详情:`, JSON.stringify(parsed.charts, null, 2));
          console.log(`[GPU-MULTI] files详情:`, JSON.stringify(parsed.files, null, 2));
          // 🔥 如果解析成功，使用解析结果
          if (parsed.output.length > 0) {
            finalOutput = parsed.output;
          }
          charts = parsed.charts;
          files = parsed.files;
          // 🔥 如果解析结果有错误，使用解析的错误
          if (parsed.error) {
            internalError = parsed.error;
          }
        } catch (parseError) {
          console.warn('[GPU-MULTI] 解析输出失败:', parseError);
        }
      }
      
      // 🔥 hosted 模式：duration/cost 镜像云端权威值（云端已按 run_seconds 结算扣费）
      let actualDuration: number;
      if (executionResult.duration !== undefined) {
        actualDuration = executionResult.duration;
        console.log(`[GPU-MULTI] 实际运行时长: ${actualDuration}s (云端权威值)`);
      } else if (instanceRunningAt) {
        actualDuration = Math.ceil((Date.now() - instanceRunningAt) / 1000);
        console.log(`[GPU-MULTI] 实际运行时长: ${actualDuration}s (从 Running 开始计算)`);
      } else {
        actualDuration = 0;
        console.log(`[GPU-MULTI] 实例未进入 Running 状态，不计算运行时长`);
      }
      const cost = executionResult.cost ?? this.calculateCost(spec, actualDuration);
      
      // 🔥 解析 stdout，提取模型文件路径
      let modelOssUrl: string | undefined = undefined;
      const modelPathMatch = finalOutput.match(/✅\s*模型已保存:\s*([^\n]+)/);
      if (modelPathMatch && modelPathMatch[1]) {
        const modelPath = modelPathMatch[1].trim();
        console.log(`[GPU-MULTI] 检测到模型文件路径: ${modelPath}`);
        
        // 🔥 从路径中提取文件名
        const modelFileName = modelPath.split('/').pop();
        if (modelFileName) {
          // 🔥 构造 OSS URL
          modelOssUrl = provider.generatePresignedUrl(ossPath + modelFileName);
          console.log(`[GPU-MULTI] 模型文件 OSS URL: ${modelOssUrl}`);
        }
      }
      
      if (request.taskId) {
        await trainingTaskDatabase.updateTask(request.taskId, {
          status: isSuccess ? 'success' : 'failed',
          stdout_output: finalOutput,
          charts_json: charts,
          files_json: files,
          duration: actualDuration,
          error_message: internalError,
          cost,
          model_oss_url: modelOssUrl
        });
        
        // 🔥 扣费只在云端结算，本地仅回写展示值
        console.log(`[GPU-MULTI] 云端已结算扣费，本地镜像 duration/cost`);
        
        const wsManager = AppScheduler.getInstance().getWsManager();
        if (wsManager && request.appId) {
          wsManager.send(`app-${request.appId}`, {
            type: 'gpu_task_complete',
            appId: request.appId,
            taskId: request.taskId,
            result: {
              success: isSuccess,
              output: finalOutput,
              error: internalError,
              charts,
              files,
              executionTime: actualDuration * 1000,
              executionMode: 'gpu',
              gpuStatus: 'stopped'
            }
          });
        }
      }
      
      await this.cleanupInstance(provider, instanceId, isSuccess, instanceRegion);
      
      // 🔥 构造更清晰的失败原因
      let failureReason: 'execution_error' | 'timeout' | 'unknown' | undefined = undefined;
      if (!isSuccess) {
        // 🔥 根据错误信息判断失败原因
        if (internalError?.includes('timeout') || internalError?.includes('Timeout')) {
          failureReason = 'timeout';
        } else if (finalOutput && finalOutput.length > 100) {
          // 🔥 有输出内容，说明代码执行了但失败
          failureReason = 'execution_error';
        } else {
          failureReason = 'unknown';
        }
      }
      
      return {
        success: isSuccess,
        output: finalOutput,
        error: internalError,
        charts,
        files,
        executionTime: actualDuration * 1000,
        executionMode: 'gpu',
        gpuInstanceId: instanceId,
        gpuStatus: 'stopped',
        actualDuration,
        gpuInstanceType: spec.instanceType,
        gpuModelName: spec.gpuType,
        taskId,
        // 🔥 新增：帮助 LLM 区分失败原因
        instanceCreated: true, // 🔥 实例已成功创建并运行
        failureReason: isSuccess ? undefined : failureReason,
        message: isSuccess 
          ? `✅ GPU 训练成功完成！耗时 ${actualDuration}秒，使用 ${spec.gpuType} (${spec.instanceType})`
          : `⚠️ GPU 实例已成功运行 ${actualDuration}秒，但代码执行失败。请查看 output 日志分析错误原因。`
      };
      
    } catch (error: any) {
      console.error('[GPU-MULTI] 执行错误:', error);
      
      // 🔥 关键：如果实例已创建，必须关闭它！
      if (instanceId) {
        console.warn(`[GPU-MULTI] 实例已创建但执行失败，正在关闭实例: ${instanceId} (Region: ${instanceRegion || 'default'})`);
        try {
          await provider!.stopInstance(instanceId, instanceRegion);
          console.log(`[GPU-MULTI] 实例已关闭: ${instanceId}`);
        } catch (stopError) {
          console.error(`[GPU-MULTI] 关闭实例失败: ${instanceId}`, stopError);
        }
      }
      
      // 🔥 只有实例创建成功后才记录任务（避免记录询价失败）
      if (request.taskId && instanceId) {
        try {
          // 🔥 如果任务已被 stop() 标记为 stopped，不要覆盖为 failed
          const existingTask = await trainingTaskDatabase.getTask(request.taskId);
          if (existingTask?.status === 'stopped') {
            console.log(`[GPU-MULTI] 任务已被停止，跳过状态更新: ${request.taskId}`);
          } else if (!existingTask) {
            await trainingTaskDatabase.createTask({
              id: request.taskId,
              user_id: request.userId || 'unknown',
              app_id: request.appId || 'unknown',
              status: 'failed',
              code_snapshot: request.code || '',
              error_message: error.message,
              instance_type: request.gpuInstanceType || 'unknown',
              gpu_instance_id: instanceId,
              gpu_instance_region: instanceRegion  // 🔥 存储实例 region
            });
            console.log(`[GPU-MULTI] Task 已创建（失败状态）: ${request.taskId}, instanceId: ${instanceId}, region=${instanceRegion}`);
          } else {
            await trainingTaskDatabase.updateTask(request.taskId, {
              status: 'failed',
              error_message: error.message,
              gpu_instance_id: instanceId || existingTask.gpu_instance_id,
              gpu_instance_region: instanceRegion || existingTask.gpu_instance_region  // 🔥 更新实例 region
            });
            console.log(`[GPU-MULTI] Task 已更新为失败: ${request.taskId}, instanceId: ${instanceId}, region=${instanceRegion}`);
          }
        } catch (dbError) {
          console.error('[GPU-MULTI] Task 数据库操作失败:', dbError);
        }
      } else if (!instanceId) {
        // 🔥 实例未创建（询价失败/库存不足），不记录任务，只打印日志
        console.log(`[GPU-MULTI] 实例未创建，不记录任务: ${request.taskId}, 厬因: ${error.message}`);
      }
      
      // 🔥 区分失败原因
      const instanceCreated = !!instanceId;
      let failureReason: 'instance_unavailable' | 'network_error' | 'unknown' = 'unknown';
      
      if (!instanceCreated) {
        // 🔥 实例创建失败（库存不足、权限问题等）
        failureReason = 'instance_unavailable';
      } else if (error.message?.includes('network') || error.message?.includes('timeout')) {
        // 🔥 网络问题导致执行中断
        failureReason = 'network_error';
      }
      
      return {
        success: false,
        error: error.message,
        errorCode: error.code || 'UNKNOWN_ERROR',
        executionTime: Date.now() - startTime,
        executionMode: 'gpu',
        gpuStatus: 'error',
        gpuInstanceId: instanceId,
        // 🔥 新增：帮助 LLM 区分失败原因
        instanceCreated,
        failureReason,
        message: instanceCreated 
          ? `❌ GPU 实例已创建 (${instanceId})，但执行过程中发生错误: ${error.message}`
          : `❌ GPU 实例创建失败（库存不足或权限问题），请尝试其他 GPU 规格`
      };
    }
  }
  
  /**
   * 解析实例类型（查云端规格缓存；未命中时用请求参数构造兜底 spec）
   */
  private async parseInstanceType(instanceType: string, gpuType?: string): Promise<GpuSpec> {
    const presets = await this.getSpecPresets();

    if (gpuType) {
      const preset = presets.find(s => s.gpuType === gpuType && s.gpuCount === 1);
      if (preset) return preset;
    }

    if (instanceType) {
      const preset = presets.find(s => s.instanceType === instanceType);
      if (preset) return preset;
    }

    // 兜底：规格缓存未就绪/未命中时用请求参数构造（价格为估算值，云端结算才是权威）
    return {
      provider: 'hosted',
      gpuType: gpuType || 'T4',
      gpuCount: 1,
      vcpuCount: 0,
      memoryGB: 0,
      instanceType: instanceType || '',
      pricePerHour: 10.0
    };
  }

  /**
   * 云端规格缓存（唯一权威在云端，hosted provider 首次使用时拉取一次）
   */
  private getSpecPresets(): Promise<GpuSpec[]> {
    const hosted = this.providers.get('hosted');
    if (hosted instanceof HostedProxyProvider) {
      return hosted.fetchSpecs().catch(() => [] as GpuSpec[]);
    }
    return Promise.resolve(hosted?.getSupportedSpecs() || []);
  }
  
  /**
   * 解析执行输出
   * 🔥 从日志中提取包装器输出的 JSON 结果
   */
  private async parseExecutionOutput(output: string, ossPath: string, provider: GpuCloudProvider): Promise<{
    success: boolean;
    output: string;
    error?: string;
    charts: any[];
    files: { [key: string]: any };
  }> {
    const cleanLog = output.replace(/[\x00-\x1F\x7F-\x9F]/g, (char: string) => {
      return (char === '\n' || char === '\r' || char === '\t') ? char : '';
    });

    // 🔥 使用花括号计数法提取 JSON（正则无法处理包含转义引号的内容）
    // 查找 {"success": 标记的位置
    const resultMarker = '{"success":';
    const jsonStart = cleanLog.indexOf(resultMarker);

    let parsed: any = null;

    if (jsonStart !== -1) {
      // 🔥 从标记位置开始，用花括号计数法找到完整的 JSON
      let braceCount = 0;
      let inString = false;
      let escape = false;
      let jsonEnd = -1;

      for (let i = jsonStart; i < cleanLog.length; i++) {
        const ch = cleanLog[i];

        if (escape) {
          escape = false;
          continue;
        }

        if (ch === '\\' && inString) {
          escape = true;
          continue;
        }

        if (ch === '"' && !escape) {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (ch === '{') braceCount++;
        if (ch === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i;
            break;
          }
        }
      }

      if (jsonEnd !== -1) {
        const jsonStr = cleanLog.substring(jsonStart, jsonEnd + 1);
        try {
          parsed = JSON.parse(jsonStr);
          console.log(`[GPU-MULTI] 解析 JSON 成功: success=${parsed.success}, output长度=${parsed.output?.length || 0}`);
        } catch (e) {
          console.warn('[GPU-MULTI] JSON 解析失败:', e);
        }
      }
    }

    if (parsed) {
        // 🔥 将 files 数组转换为对象格式
        let filesObj: { [key: string]: any } = {};
        if (Array.isArray(parsed.files)) {
          parsed.files.forEach((filePath: string) => {
            // 🔥 提取文件名（去掉 /tmp/output/ 或 C:\xxx\ 等路径前缀）
            let filename = filePath;
            if (filePath.includes('/')) {
              filename = filePath.split('/').pop() || filename;
            } else if (filePath.includes('\\')) {
              filename = filePath.split('\\').pop() || filename;
            }
            const url = provider.generatePresignedUrl(ossPath + filename);
            filesObj[filename] = {
              url: url,
              type: 'model',
              name: filename
            };
          });
        } else if (typeof parsed.files === 'object') {
          filesObj = parsed.files;
        }

        // 🔥 将 charts 数组转换为对象格式
        let chartsArray: any[] = [];
        if (Array.isArray(parsed.charts)) {
          chartsArray = parsed.charts.map((chart: any, index: number) => {
            // 如果是字符串（文件名），构造图表对象
            if (typeof chart === 'string') {
              // 🔥 提取文件名（去掉路径前缀）
              let chartFilename = chart;
              if (chart.includes('/')) {
                chartFilename = chart.split('/').pop() || chartFilename;
              } else if (chart.includes('\\')) {
                chartFilename = chart.split('\\').pop() || chartFilename;
              }
              const url = provider.generatePresignedUrl(ossPath + chartFilename);
              return {
                type: 'image/png',
                url: url,
                title: url ? chartFilename : `${chartFilename}（云端未上传该文件）`,
                name: chartFilename
              };
            }
            // 如果已经是对象，直接使用
            // 🔥 确保data字段存在
            if (chart.data) {
              return {
                ...chart,
                type: chart.type || 'image/png',
                title: chart.title || chart.name || `chart-${index}`
              };
            }
            // 如果有url字段
            if (chart.url) {
              return {
                ...chart,
                type: chart.type || 'image/png',
                title: chart.title || chart.name || `chart-${index}`
              };
            }
            return chart;
          });
        }

        // 🔥 如果有 full_log_url，从 OSS 下载完整日志替换 output
        // 避免阿里云 ECI Tail=10000 限制导致的日志截断
        let finalOutput = parsed.output || '';
        if (parsed.full_log_url) {
          try {
            const fullLogUrl = provider.generatePresignedUrl(parsed.full_log_url);
            console.log(`[GPU-MULTI] 检测到 full_log_url，尝试下载完整日志: ${parsed.full_log_url}`);
            const response = await axios.get(fullLogUrl, {
              responseType: 'text',
              timeout: 30000,
              maxContentLength: 100 * 1024 * 1024  // 100MB 上限
            });
            if (response.data && typeof response.data === 'string' && response.data.length > 0) {
              console.log(`[GPU-MULTI] 完整日志下载成功，长度: ${response.data.length}（原 output 长度: ${finalOutput.length}）`);
              finalOutput = response.data;
            }
          } catch (e: any) {
            console.warn(`[GPU-MULTI] 下载 full_log.txt 失败，使用原 output: ${e.message}`);
          }
        }

        return {
          success: parsed.success || false,
          output: finalOutput,
          error: parsed.error,
          charts: chartsArray,
          files: filesObj
        };
    }

    // 🔥 JSON 解析失败或未找到 JSON 标记，尝试用正则提取 output 字段
    // 这种情况通常发生在日志被截断，JSON 不完整时
    if (jsonStart !== -1) {
      console.warn('[GPU-MULTI] JSON 不完整，尝试用正则提取 output 字段');
      // 尝试匹配完整的 output 字段: "output": "..."
      const fullOutputMatch = cleanLog.match(/"output"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (fullOutputMatch && fullOutputMatch[1]) {
        console.log('[GPU-MULTI] 正则提取 output 字段成功（完整匹配）');
        // 解码 JSON 字符串转义
        let outputStr = fullOutputMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');

        const hasError = outputStr.includes('Error:') ||
                         outputStr.includes('Exception:') ||
                         outputStr.includes('Traceback');

        return {
          success: !hasError,
          output: outputStr,
          error: hasError ? '执行过程中出现错误' : undefined,
          charts: [],
          files: {}
        };
      }

      // 尝试匹配不完整的 output 字段（日志被截断，output 值没有闭合引号）
      const partialOutputMatch = cleanLog.match(/"output"\s*:\s*"(.*)$/s);
      if (partialOutputMatch && partialOutputMatch[1]) {
        console.log('[GPU-MULTI] 正则提取 output 字段成功（部分匹配，日志被截断）');
        let outputStr = partialOutputMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');

        const hasError = outputStr.includes('Error:') ||
                         outputStr.includes('Exception:') ||
                         outputStr.includes('Traceback');

        return {
          success: !hasError,
          output: outputStr,
          error: hasError ? '执行过程中出现错误' : undefined,
          charts: [],
          files: {}
        };
      }
    }

    // 🔥 JSON 解析失败或未找到 JSON 标记，返回原始日志
    const hasError = cleanLog.includes('Error:') ||
                     cleanLog.includes('Exception:') ||
                     cleanLog.includes('Traceback');

    // 🔥 最终兜底：如果日志包含 {"success": 但前面提取都失败了
    // 尝试提取 "output": " 后面的所有内容（即使没有闭合引号）
    if (cleanLog.includes('{"success":')) {
      const lastResortMatch = cleanLog.match(/"output"\s*:\s*"(.+)/s);
      if (lastResortMatch && lastResortMatch[1]) {
        console.log('[GPU-MULTI] 最终兜底：提取 output 字段内容');
        let outputStr = lastResortMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
        // 移除可能的尾部 JSON 残留
        outputStr = outputStr.replace(/",\s*"charts"[\s\S]*$/, '');
        outputStr = outputStr.replace(/",\s*"files"[\s\S]*$/, '');
        outputStr = outputStr.replace(/"\s*\}[\s]*$/, '');

        return {
          success: !hasError,
          output: outputStr,
          error: hasError ? '执行过程中出现错误' : undefined,
          charts: [],
          files: {}
        };
      }
    }

    return {
      success: !hasError,
      output: cleanLog,
      error: hasError ? '执行过程中出现错误' : undefined,
      charts: [],
      files: {}
    };
  }
  
  /**
   * 计算费用
   */
  private calculateCost(spec: GpuSpec, durationSeconds: number): number {
    // 🔥 价格取自 spec 本身（parseInstanceType 从云端规格缓存解析，自带权威单价）
    const pricePerHour = spec.pricePerHour || 10.0;
    // 🔥 按分钟向上取整计费（最少 1 分钟）
    const minutes = Math.max(Math.ceil(durationSeconds / 60), 1);
    const cost = pricePerHour * (minutes / 60) * spec.gpuCount;

    console.log(`[GPU-MULTI] 费用计算: ${spec.gpuType} ${spec.gpuCount}卡, ${minutes}分钟, 单价=${pricePerHour}元/小时, 费用=${Math.ceil(cost)}积分`);
    return Math.max(Math.ceil(cost), 1); // 🔥 最少 1 积分
  }

  /**
   * 清理实例
   */
  private async cleanupInstance(
    provider: GpuCloudProvider,
    instanceId: string,
    success: boolean,
    region?: string
  ): Promise<void> {
    if (success) {
      // 🔥 等待文件同步：各厂商对象存储最终一致延迟不同（由 provider 自带配置）
      const waitSeconds = provider.fileSyncWaitSeconds;
      console.log(`[GPU-MULTI] 任务成功，等待 ${waitSeconds} 秒确保文件同步...`);
      await new Promise(r => setTimeout(r, waitSeconds * 1000));
      await provider.stopInstance(instanceId, region);
    } else {
      console.log('[GPU-MULTI] 任务失败，立即删除实例');
      await provider.stopInstance(instanceId, region);
    }
  }
  
  /**
   * 停止任务
   */
  async stop(taskId: string, appId?: string, reason?: string): Promise<boolean> {
    try {
      const task = await trainingTaskDatabase.getTask(taskId);
      if (!task || !task.gpu_instance_id) {
        console.log(`[GPU-MULTI] 任务不存在或无实例ID: ${taskId}`);
        return false;
      }

      // 🔥 通知 waitForCompletion 停止轮询，传入用户原因
      const abortInfo = this.taskAbortControllers.get(taskId);
      if (abortInfo) {
        // 🔥 通过 abort(reason) 传入原因（signal.reason 会自动设置）
        const abortReason = reason || '用户停止';
        abortInfo.controller.abort(abortReason);
        console.log(`[GPU-MULTI] 已通知 waitForCompletion 停止: ${abortReason}`);
        this.taskAbortControllers.delete(taskId);
      }

      // 🔥 hosted 代理统一处理停止（HostedProxy 先查云端终态再决定是否调 stop）
      const instanceId = task.gpu_instance_id;
      const resolved = this.resolveProviderForInstance(instanceId);
      const providerName = resolved?.providerName || 'hosted';
      const provider = resolved?.provider || this.getProvider('hosted');
      if (!provider) {
        console.error(`[GPU-MULTI] ${providerName} Provider 不可用`);
        return false;
      }

      const instanceRegion: string | undefined = task.gpu_instance_region || undefined;

      // 🔥 先更新任务状态为 stopped，确保即使 stopInstance 失败也不会残留 running 状态
      await trainingTaskDatabase.updateTask(taskId, {
        status: 'stopped'
      });
      
      // 🔥 传入 instanceRegion 参数，确保在正确的区域删除实例
      try {
        await provider.stopInstance(instanceId, instanceRegion);
      } catch (stopInstanceError) {
        console.warn(`[GPU-MULTI] 停止实例失败（状态已更新为 stopped）: ${instanceId}`, stopInstanceError);
      }
      
      // 🔥 通知前端任务已停止
      if (appId) {
        const wsManager = AppScheduler.getInstance().getWsManager();
        if (wsManager) {
          wsManager.send(`app-${appId}`, {
            type: 'gpu_task_complete',
            appId,
            taskId,
            result: {
              success: false,
              error: '用户手动停止训练',
              executionMode: 'gpu',
              gpuStatus: 'stopped'
            }
          });
        }
      }
      
      console.log(`[GPU-MULTI] 任务已停止: ${taskId} (provider: ${providerName})`);
      return true;
    } catch (error: any) {
      console.error('[GPU-MULTI] 停止任务失败:', error);
      return false;
    }
  }
  
  getInstanceId(): string | undefined {
    return undefined;
  }
}

/**
 * 创建默认 GPUExecutor
 * 🔥 仅 hosted 模式：本地不持有云厂商配置与凭据，
 *    实例生命周期/结算全部由 home-web/server 承担，本地仅保留 HostedProxyProvider（薄代理层）
 */
export function createDefaultGPUExecutor(): GPUExecutor {
  console.log('[GPU-MULTI] hosted 模式启动：providers 迁入云端');
  return new GPUExecutor({ hosted: true });
}