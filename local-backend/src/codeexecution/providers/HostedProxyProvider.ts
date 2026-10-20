/**
 * Hosted 代理 Provider（弹性算力 router 本地薄层）
 *
 * GPU_EXECUTION_MODE=hosted 时注册为唯一 provider：
 * - 实例生命周期/凭据/结算全部由 home-web/server /api/gpu/v1/* 承担，本地零云厂商依赖
 * - 凭据只存云端，本地仅通过 fetchStorageInfo 拿非密 bucket/region/appId（GpuWrapper URL 内网化用）
 * - waitForCompletion 轮询云端任务详情，终态返回 result.json 原文 + 云端权威 duration/cost
 * - generatePresignedUrl 走透传：云端已在 getTaskDetail 按 basename 即时重签，本地不做签名
 * - 前端契约不变：价格选项仍以 aliyun/tencent 厂商名透传，本地任务表仍为 UI 权威
 */

import {
  GpuCloudProvider,
  GpuSpec,
  PriceInfo,
  InstanceConfig,
  InstanceResult,
  InstanceStatus,
  CloudCredentials,
  ExecutionCompletionResult,
  GpuSelectionOption,
  GpuAvailabilityInfo,
  HostedStorageInfo,
} from './GpuCloudProvider';
import { userModelRegistry } from '../../utils/llm/UserModelRegistry';
import { isCloudProxyUrl, refreshPackageToken } from '../../utils/llm/CloudTokenRefresher';

export interface HostedProxyConfig {
  /** 云端 GPU 执行 API 根地址（默认 HOME_WEB_URL） */
  baseUrl?: string;
  /** 服务间认证密钥（GPU_WORKER_SECRET，两端同值） */
  secret?: string;
}

export class HostedProxyProvider implements GpuCloudProvider {
  readonly name = 'hosted';
  readonly displayName = '云端算力';
  // 🔥 云端 cleanupInstance 已等待对象存储最终一致，本地不再重复等待
  readonly fileSyncWaitSeconds = 0;

  private baseUrl: string;
  private secret: string;
  /** taskId -> (basename -> 云端已签 URL)，多任务并发互不串扰 */
  private latestUrlMapByTask: Map<string, Map<string, string>> = new Map();
  // 🔥 本地 taskId -> 云端 instanceId 映射：refreshUrlMap 以云端 instanceId 为 key，
  // 而 generatePresignedUrl 按 objectKey 里的本地 taskId 查——不映射则精确匹配恒 miss
  private taskIdToInstanceId: Map<string, string> = new Map();
  /** 云端规格表缓存（唯一权威在云端，首次使用时拉取一次；null=未拉取） */
  private specsCache: GpuSpec[] | null = null;
  private specsCachePromise: Promise<GpuSpec[]> | null = null;

  constructor(config: HostedProxyConfig) {
    this.baseUrl = (config.baseUrl || process.env.HOME_WEB_URL || 'https://www.workbees.space').replace(/\/$/, '');
    this.secret = config.secret || process.env.GPU_WORKER_SECRET || '';
    if (!this.secret) {
      console.warn('[GPU-HOSTED] GPU_WORKER_SECRET 未配置：将使用用户 JWT 认证（用户未登录时云端调用会被拒绝）');
    }
  }

  /**
   * 从套餐模型快照取当前用户 JWT（开源版开箱即用通道：注册登录即用 GPU）
   * 快照由 llmProxy 401 自愈链路持续保鲜（CloudTokenRefresher）
   */
  private getUserJwt(): { accessToken: string; refreshToken?: string } | null {
    const userId = userModelRegistry.getCurrentUserId();
    if (!userId) return null;
    for (const model of userModelRegistry.getAllUserModels(userId)) {
      if (isCloudProxyUrl(model.url) && model.apiKey) {
        return { accessToken: model.apiKey, refreshToken: model.refreshToken };
      }
    }
    return null;
  }

  /**
   * 统一请求云端 /api/gpu/v1/*（双轨认证：优先用户 JWT，fallback 服务间密钥）
   * 401「令牌无效」时用 refreshToken 自愈续期并重试一次（与 llmProxy 同链路）
   */
  private async request<T = any>(method: string, apiPath: string, body?: any, timeoutMs = 15000, retried = false): Promise<T> {
    const userJwt = this.getUserJwt();
    const useWorkerSecret = !userJwt?.accessToken;

    if (useWorkerSecret && !this.secret) {
      throw new Error('未登录（GPU 需用户登录令牌）且 GPU_WORKER_SECRET 未配置');
    }

    const authHeader = `Bearer ${useWorkerSecret ? this.secret : userJwt!.accessToken}`;

    const response = await fetch(`${this.baseUrl}/api/gpu/v1${apiPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data: any = await response.json().catch(() => null);
    if (!response.ok) {
      // 🔥 用户 JWT 过期 → 401 自愈：refreshToken 换新后重试一次
      if (response.status === 401 && !useWorkerSecret && !retried && userJwt?.refreshToken) {
        const tokens = await refreshPackageToken({
          url: `${this.baseUrl}/api/llm-proxy/call`,
          refreshToken: userJwt.refreshToken
        });
        if (tokens?.accessToken) {
          return this.request<T>(method, apiPath, body, timeoutMs, true);
        }
      }
      const err: any = new Error(data?.error || `HTTP ${response.status}`);
      err.statusCode = response.status;
      err.code = data?.error || `HTTP_${response.status}`;
      throw err;
    }
    return data as T;
  }

  /**
   * 云端任务状态 -> 统一 InstanceStatus
   */
  private mapCloudStatus(status: string): InstanceStatus {
    switch (status) {
      case 'pending': return 'pending';
      case 'starting': return 'starting';
      case 'running': return 'running';
      case 'success': return 'stopped';
      case 'failed': return 'failed';
      case 'stopped': return 'stopped';
      default: return 'unknown';
    }
  }

  /**
   * 终态时刷新该任务的透传 URL 映射（basename -> 云端已签 URL）
   */
  private refreshUrlMap(taskId: string, task: any): void {
    const urlMap = new Map<string, string>();
    const files = task?.filesSigned;
    if (files && typeof files === 'object') {
      for (const [name, info] of Object.entries(files)) {
        const url = (info as any)?.url;
        if (typeof url === 'string' && url) urlMap.set(name, url);
      }
    }
    const charts = task?.chartsSigned;
    if (Array.isArray(charts)) {
      for (const chart of charts) {
        if (chart?.url && chart?.name) urlMap.set(chart.name, chart.url);
      }
    }
    if (task?.fullLogUrl) {
      urlMap.set('full_log.txt', task.fullLogUrl);
    }
    // 🔥 双 key 写入：instanceId（轮询返回）+ 云端 task.taskId（若有），保证 generatePresignedUrl
    // 无论按本地 taskId 还是云端 instanceId 查都能精确命中
    this.latestUrlMapByTask.set(taskId, urlMap);
    if (task?.taskId && task.taskId !== taskId) {
      this.latestUrlMapByTask.set(task.taskId, urlMap);
    }
  }

  async queryPrice(spec: GpuSpec): Promise<PriceInfo> {
    // hosted 模式价格由 queryAllPrices -> fetchAllPriceOptions 透传；此处仅返回内置估算（查云端规格缓存）
    const presets = await this.fetchSpecs().catch(() => [] as GpuSpec[]);
    const preset = presets.find(
      s => s.provider === spec.provider && s.gpuType === spec.gpuType && s.gpuCount === spec.gpuCount
    );
    return {
      pricePerHour: preset?.pricePerHour || 10.0,
      available: true,
      region: 'hosted',
      lastUpdated: new Date()
    };
  }

  async createInstance(config: InstanceConfig): Promise<InstanceResult> {
    let data: any = null;
    try {
      // 🔥 code 为本地 GpuWrapper 已包装的最终代码；spec.provider 透传给云端选择厂商
      data = await this.request('POST', '/execute', {
        taskId: config.taskId,
        userId: config.userId,
        appId: config.appId,
        instanceType: config.spec.instanceType,
        gpuProvider: config.spec.provider,
        code: config.command || '',
        envVars: config.envVars || {}
      }, 180000);
      return {
        success: true,
        instanceId: data?.instanceId || config.taskId,
        region: data?.region,
        status: 'pending'
      };
    } catch (error: any) {
      console.error(`[GPU-HOSTED] 启动云端任务失败: ${config.taskId}`, error.message);
      return { success: false, error: error.message, errorCode: error.code };
    } finally {
      // 🔥 记录 taskId <-> instanceId 映射（refreshUrlMap 用 instanceId 做 key，查询按 taskId）
      if (data?.instanceId && data.instanceId !== config.taskId) {
        this.taskIdToInstanceId.set(config.taskId, data.instanceId);
      }
    }
  }

  async queryStatus(instanceId: string, _region?: string): Promise<InstanceStatus> {
    try {
      const data = await this.request('GET', `/tasks/${instanceId}`);
      return this.mapCloudStatus(data?.task?.status || '');
    } catch (error: any) {
      if (error.statusCode === 404) return 'unknown';
      return 'network-error';
    }
  }

  async stopInstance(instanceId: string, _region?: string): Promise<{ success: boolean; error?: string }> {
    try {
      // 🔥 已终态的任务不再调云端 stop（避免云端对已完成实例做冗余删除重试）
      try {
        const data = await this.request('GET', `/tasks/${instanceId}`);
        const status = data?.task?.status;
        if (['success', 'failed', 'stopped'].includes(status)) {
          return { success: true };
        }
      } catch (queryError: any) {
        if (queryError.statusCode === 404) {
          return { success: true }; // 云端任务不存在 = 无需停止
        }
        // 查询失败时继续尝试 stop
      }
      await this.request('POST', `/tasks/${instanceId}/stop`, { reason: '用户停止' });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async waitForCompletion(
    instanceId: string,
    maxWaitTime: number = 0,
    onStatusChange?: (status: InstanceStatus) => void,
    _region?: string,
    abortSignal?: AbortSignal
  ): Promise<ExecutionCompletionResult> {
    const startTime = Date.now();
    let lastStatus = '';
    let lastLogTime = 0;

    while (maxWaitTime === 0 || Date.now() - startTime < maxWaitTime) {
      // 🔥 检查是否被 abort（用户停止）
      if (abortSignal?.aborted) {
        const abortReason = (abortSignal as any).reason || '用户停止';
        console.log(`[GPU-HOSTED] waitForCompletion 被 abort: ${abortReason}`);
        return { success: false, output: '', error: abortReason };
      }

      try {
        const data = await this.request('GET', `/tasks/${instanceId}`);
        const task = data?.task;
        if (!task) {
          return { success: false, error: '云端任务数据异常' };
        }

        const mapped = this.mapCloudStatus(task.status);
        const now = Date.now();
        if (mapped !== lastStatus || now - lastLogTime >= 60000) {
          console.log(`[GPU-HOSTED] 云端任务 ${instanceId} 状态: ${task.status}`);
          lastStatus = mapped;
          lastLogTime = now;
        }
        if (onStatusChange) {
          onStatusChange(mapped);
        }

        // 🔥 终态：返回 result.json 原文（本地 parseExecutionOutput 提取 files/charts/run_seconds），
        //    duration/cost 为云端已结算的权威值（本地镜像，不重复扣费）
        if (mapped === 'stopped' || mapped === 'failed') {
          this.refreshUrlMap(instanceId, task);
          return {
            success: mapped === 'stopped',
            output: task.resultJson || '',
            error: task.error || (mapped === 'failed' ? '云端任务执行失败' : undefined),
            duration: task.duration,
            cost: task.cost
          };
        }
      } catch (error: any) {
        // 404：云端任务不存在（可能已被清理），不无限重试
        if (error.statusCode === 404) {
          return { success: false, error: '云端任务不存在' };
        }
        // 网络抖动：继续轮询（瞬时错误不能误判失败）
        console.warn(`[GPU-HOSTED] 查询云端任务失败，继续轮询: ${error.message}`);
      }

      await new Promise(r => setTimeout(r, 5000));
    }

    return { success: false, error: '等待超时' };
  }

  async fetchLogs(instanceId: string, _region?: string): Promise<string> {
    try {
      const data = await this.request('GET', `/tasks/${instanceId}/logs?offset=0`);
      return data?.logs || '';
    } catch (error: any) {
      console.warn(`[GPU-HOSTED] 获取云端日志失败: ${error.message}`);
      return '';
    }
  }

  async checkAvailability(_spec: GpuSpec): Promise<boolean> {
    // hosted 模式库存由云端判断（创建实例时反馈），本地默认可用
    return true;
  }

  /**
   * 🔥 透传云端批量库存查询（GET /availability）
   */
  async checkAllAvailability(): Promise<GpuAvailabilityInfo[]> {
    const data = await this.request('GET', '/availability');
    return data?.availability || [];
  }

  /**
   * 🔥 透传云端规格表（GET /specs，唯一权威配置源），带进程内缓存与并发去重
   */
  async fetchSpecs(): Promise<GpuSpec[]> {
    if (this.specsCache) return this.specsCache;
    if (!this.specsCachePromise) {
      this.specsCachePromise = (async () => {
        const data = await this.request('GET', '/specs');
        const specs: GpuSpec[] = data?.specs || [];
        this.specsCache = specs;
        return specs;
      })().catch((error: any) => {
        // 拉取失败允许下次重试（缓存 promise 置空），但已有成功缓存时保持不变
        if (!this.specsCache) this.specsCachePromise = null;
        throw error;
      });
    }
    return this.specsCachePromise;
  }

  async fetchAllPriceOptions(): Promise<GpuSelectionOption[]> {
    const data = await this.request('GET', '/prices');
    return data?.options || [];
  }

  async fetchStorageInfo(): Promise<HostedStorageInfo> {
    const data = await this.request('GET', '/storage-info');
    return {
      ossBucket: data?.aliyun?.ossBucket,
      ossRegion: data?.aliyun?.ossRegion,
      cosBucket: data?.tencent?.cosBucket,
      cosRegion: data?.tencent?.cosRegion,
      appId: data?.tencent?.appId
    };
  }

  setCredentials(_credentials: CloudCredentials): void {
    // hosted 模式凭据只存云端，本地无凭证可设
  }

  getCredentials(): CloudCredentials | null {
    return null;
  }

  mapFetchedCredentials(_raw: any, _region?: string): CloudCredentials {
    return {};
  }

  /**
   * 🔥 hosted 模式下所有实例都属于本 provider（providers Map 中只有 'hosted'）
   */
  ownsInstance(_instanceId: string): boolean {
    return true;
  }

  /**
   * 🔥 透传：云端已在任务详情按 basename 即时重签 URL，本地按 taskId + basename 查映射
   */
  generatePresignedUrl(objectKey: string): string {
    const basename = objectKey.split('/').pop() || objectKey;
    // objectKey 形如 training-tasks/{taskId}/output/{filename}，按任务精确定位。
    // 🔥 严禁跨任务兜底：训练图表次次同名（loss_curve.png 等），按 basename 全局找
    // 会串到旧任务（v1.3.59 引入的缺陷，导致图片链接指向 failed 旧任务/已过期签名）。
    // 本任务查不到 = 云端未上传该文件 → 返回空串（诚实缺失），绝不拿别的任务顶包
    const taskMatch = objectKey.match(/training-tasks\/([^/]+)\/output\//);
    if (taskMatch) {
      const taskId = taskMatch[1];
      const instanceId = this.taskIdToInstanceId.get(taskId) || taskId;
      const url = this.latestUrlMapByTask.get(instanceId)?.get(basename)
        ?? this.latestUrlMapByTask.get(taskId)?.get(basename);
      return url || '';
    }
    // 兜底：仅限不含 taskId 的非标准 key
    for (const urlMap of this.latestUrlMapByTask.values()) {
      const url = urlMap.get(basename);
      if (url) return url;
    }
    return '';
  }

  getSupportedSpecs(): GpuSpec[] {
    // 同步接口：返回云端规格表缓存（未拉取时为空数组，异步路径请用 fetchSpecs）
    return this.specsCache || [];
  }
}
