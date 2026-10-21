/**
 * ImportantObjectTracker
 * 跟踪对话中的重要对象 ID
 *
 * 职责：
 * 1. 从对话历史中提取重要对象 ID（appId, fileId 等）
 * 2. 按时间顺序维护 ID 列表（由旧到新）
 * 3. 提供格式化输出供环境注入使用
 */

import { isSameProjectId } from '@/utils/apptool/ProjectIdResolver';
import { getAppBasePath } from '@/utils/apptool/AppPathHelper';

export interface ProjectActivityStats {
  trainCount: number;      // GPU 训练次数
  localRunCount: number;   // 本地运行次数
  fileOpsCount: number;    // 文件操作次数（读/写/列表）
  lastTrainAt?: number;    // 最近训练时间
  lastLocalRunAt?: number; // 最近本地运行时间
}

export interface ImportantObject {
  id: string;           // 对象 ID 或路径
  type: 'app' | 'file' | 'path' | 'conversation' | 'unknown';  // 对象类型
  firstSeenAt: number;  // 首次出现的时间戳
  lastSeenAt: number;   // 最后出现的时间戳
  mentionCount: number; // 🔥 被提及次数（活跃度指标）
  context?: string;     // 出现的上下文（可选）
  activityStats?: ProjectActivityStats;  // 🔥 项目活动统计（仅 type='app' 时有）
  inferredType?: 'training' | 'inference' | 'general';  // 🔥 推测的项目类型
}

export interface ImportantObjectsSnapshot {
  objects: ImportantObject[];
  extractedAt: number;
}

/**
 * 重要对象跟踪器
 */
export class ImportantObjectTracker {
  private static instance: ImportantObjectTracker;
  
  // 按 conversationId 存储重要对象
  private objectCache = new Map<string, Map<string, ImportantObject>>();
  
  // ID 提取正则表达式
  private readonly patterns = {
    // @appxxxx 或 @appid:xxxx 格式（完整 UUID）
    appMention: /@app(?:id)?[:\s]*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi,
    // @projectid:xxx 或 @project:xxx 格式（完整 UUID）
    projectMention: /@project(?:id)?[:\s]*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi,
    // 🔥 短 ID 格式：@projectid:54ec5d68 或 @appid:54ec5d68（8位短 ID）
    projectMentionShort: /@project(?:id)?[:\s]([a-f0-9]{8})(?![a-f0-9-])/gi,
    appMentionShort: /@app(?:id)?[:\s]([a-f0-9]{8})(?![a-f0-9-])/gi,
    // appId: xxx 或 app_id: xxx 格式（完整 UUID）
    appIdField: /(?:appId|app_id|appID)\s*[:=]\s*["']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["']?/gi,
    // projectId: xxx 或 project_id: xxx 格式（完整 UUID）
    projectIdField: /(?:projectId|project_id|projectID)\s*[:=]\s*["']?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})["']?/gi,
    // 🔥 短 ID 字段格式：projectId:54ec5d68 或 appId:54ec5d68（8位短 ID）
    projectIdFieldShort: /(?:projectId|project_id|projectID)\s*[:=]\s*["']?([a-f0-9]{8})(?![a-f0-9-])/gi,
    appIdFieldShort: /(?:appId|app_id|appID)\s*[:=]\s*["']?([a-f0-9]{8})(?![a-f0-9-])/gi,
    // @file_xxxx 格式
    fileMention: /@(file_[a-zA-Z0-9_-]+)/gi,
    // fileId: xxx 或 file_id: xxx 格式（英文）
    fileIdField: /(?:fileId|file_id|fileID)\s*[:=]\s*["']?(file_[a-zA-Z0-9_-]+)["']?/gi,
    // 文件ID: xxx 格式（中文）
    fileIdFieldCN: /文件ID\s*[:：]\s*(file_[a-zA-Z0-9_-]+)/gi,
    // 通用 UUID（不在上述格式中的）
    genericUUID: /(?<!@)(?<!appId[=:]\s*)(?<!app_id[=:]\s*)(?<!projectId[=:]\s*)(?<!project_id[=:]\s*)(?<!fileId[=:]\s*)(?<!file_id[=:]\s*)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi,
    // 🔥 本地路径: Unix/Mac (/path/to/file) 和 Windows (C:\Users\file.txt)
    // 使用更严格的匹配：只匹配 ASCII 字符，遇到空格、中文、换行等停止
    // 🔥 修复：Unix 路径必须以 / 开头，或 ~/ 开头（排除 ~1.76s 这种纯数字）
    unixPath: /(?<![A-Za-z])(?<![A-Za-z]:)(?:\/|~\/)[a-zA-Z0-9_\-.\/\\]+(?=[\s\"'\n\r<>，。！？]|$)/g,
    windowsPath: /[A-Za-z]:[\\/][a-zA-Z0-9_\-.\/\\]+(?=[\s\"'\n\r<>，。！？]|$)/g,
  };

  // 🔥 排除常见的示例路径模式
  private readonly excludedPathPatterns = [
    /\/path\/to\/file/i,
    /\/path\/to\/dir/i,
    /example\/path/i,
    /your\/path/i,
    /volume\/output/i,
    /some\/path/i,
    /target\/path/i,
    /destination\/path/i,
  ];

  static getInstance(): ImportantObjectTracker {
    if (!ImportantObjectTracker.instance) {
      ImportantObjectTracker.instance = new ImportantObjectTracker();
    }
    return ImportantObjectTracker.instance;
  }

  /**
   * 从消息内容中提取重要对象 ID
   */
  extractFromMessage(
    content: string,
    timestamp: number = Date.now()
  ): ImportantObject[] {
    const objects: ImportantObject[] = [];
    const seenIds = new Set<string>();

    // 提取 appId（@appxxxx 格式）
    let match;
    while ((match = this.patterns.appMention.exec(content)) !== null) {
      const id = match[1];
      if (!seenIds.has(id)) {
        seenIds.add(id);
        objects.push({
          id,
          type: 'app',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.appMention.lastIndex = 0;

    // 🔥 提取 projectId（@projectid: xxx 格式）
    while ((match = this.patterns.projectMention.exec(content)) !== null) {
      const id = match[1];
      if (!seenIds.has(id)) {
        seenIds.add(id);
        objects.push({
          id,
          type: 'app',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.projectMention.lastIndex = 0;

    // 提取 appId（appId: xxx 格式）
    while ((match = this.patterns.appIdField.exec(content)) !== null) {
      const id = match[1];
      if (!seenIds.has(id)) {
        seenIds.add(id);
        objects.push({
          id,
          type: 'app',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.appIdField.lastIndex = 0;

    // 🔥 提取 projectId（projectId: xxx 格式）
    while ((match = this.patterns.projectIdField.exec(content)) !== null) {
      const id = match[1];
      if (!seenIds.has(id)) {
        seenIds.add(id);
        objects.push({
          id,
          type: 'app',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.projectIdField.lastIndex = 0;

    // 🔥 提取短 ID（projectId:54ec5d68 格式，8位短 ID）
    while ((match = this.patterns.projectIdFieldShort.exec(content)) !== null) {
      const shortId = match[1];
      if (!seenIds.has(shortId)) {
        seenIds.add(shortId);
        objects.push({
          id: shortId,
          type: 'app',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.projectIdFieldShort.lastIndex = 0;

    // 🔥 提取短 ID（appId:54ec5d68 格式，8位短 ID）
    while ((match = this.patterns.appIdFieldShort.exec(content)) !== null) {
      const shortId = match[1];
      if (!seenIds.has(shortId)) {
        seenIds.add(shortId);
        objects.push({
          id: shortId,
          type: 'app',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.appIdFieldShort.lastIndex = 0;

    // 🔥 提取短 ID（@projectid:54ec5d68 格式）
    while ((match = this.patterns.projectMentionShort.exec(content)) !== null) {
      const shortId = match[1];
      if (!seenIds.has(shortId)) {
        seenIds.add(shortId);
        objects.push({
          id: shortId,
          type: 'app',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.projectMentionShort.lastIndex = 0;

    // 🔥 提取短 ID（@appid:54ec5d68 格式）
    while ((match = this.patterns.appMentionShort.exec(content)) !== null) {
      const shortId = match[1];
      if (!seenIds.has(shortId)) {
        seenIds.add(shortId);
        objects.push({
          id: shortId,
          type: 'app',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.appMentionShort.lastIndex = 0;

    // 提取 fileId（@file_xxxx 格式）
    while ((match = this.patterns.fileMention.exec(content)) !== null) {
      const id = match[1];
      if (!seenIds.has(id)) {
        seenIds.add(id);
        objects.push({
          id,
          type: 'file',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.fileMention.lastIndex = 0;

    // 提取 fileId（fileId: xxx 格式）
    while ((match = this.patterns.fileIdField.exec(content)) !== null) {
      const id = match[1];
      if (!seenIds.has(id)) {
        seenIds.add(id);
        objects.push({
          id,
          type: 'file',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.fileIdField.lastIndex = 0;

    // 🔥 提取 fileId（文件ID: xxx 中文格式）
    while ((match = this.patterns.fileIdFieldCN.exec(content)) !== null) {
      const id = match[1];
      if (!seenIds.has(id)) {
        seenIds.add(id);
        objects.push({
          id,
          type: 'file',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.fileIdFieldCN.lastIndex = 0;

    // 🔥 提取 Unix/Mac 本地路径
    while ((match = this.patterns.unixPath.exec(content)) !== null) {
      let path = match[0];
      path = path.replace(/[.,;:!?]+$/, '');
      if (this.isValidPath(path) && !seenIds.has(path)) {
        seenIds.add(path);
        objects.push({
          id: path,
          type: 'path',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.unixPath.lastIndex = 0;

    // 🔥 提取 Windows 本地路径
    while ((match = this.patterns.windowsPath.exec(content)) !== null) {
      let path = match[0];
      path = path.replace(/[.,;:!?]+$/, '');
      if (this.isValidPath(path) && !seenIds.has(path)) {
        seenIds.add(path);
        objects.push({
          id: path,
          type: 'path',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          mentionCount: 1,
          context: this.extractContext(content, match.index),
        });
      }
    }
    this.patterns.windowsPath.lastIndex = 0;

    return objects;
  }

  /**
   * 🔥 验证路径是否有效（参考 MessageContent.tsx 的逻辑）
   */
  private isValidPath(path: string): boolean {
    // 排除示例路径
    const isExample = this.excludedPathPatterns.some(pattern => pattern.test(path));
    if (isExample) return false;

    // 过滤包含中文的路径
    if (/[\u4e00-\u9fa5]/.test(path)) return false;

    // 🔥 过滤所有 URL-like 路径（包含 :// 或以域名格式开头）
    // 例如：s://xxx, http://xxx, bb-1storage.oss-cn-hangzhou.aliyuncs.com
    if (path.includes('://') || /\.?[a-z0-9-]+\.(com|cn|net|org|io|aliyuncs|oss)/i.test(path)) return false;

    // 过滤掉没有文件扩展名且不是已知目录的路径
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(path);
    const isKnownDir = /\/(output|files|docs|data|temp|tmp|downloads|desktop|documents)\//i.test(path);
    if (!hasExtension && !isKnownDir) return false;

    // 过滤代码示例中的相对路径
    if (path.match(/^src\//) || path.match(/^\/?utils\//)) return false;

    // 确保不是 URL（再次检查）
    if (path.startsWith('http') || path.startsWith('//') || path.startsWith('ftp')) return false;

    return true;
  }

  /**
   * 提取 ID 出现的上下文
   * 🔥 只提取匹配到的 ID 格式本身（如 @projectid:xxx），不包含后续的中文文字
   */
  private extractContext(content: string, index: number, radius: number = 50): string {
    const start = Math.max(0, index - radius);
    const end = Math.min(content.length, index + radius);

    // 提取前后 50 字符
    let context = content.slice(start, end).replace(/\s+/g, ' ').trim();

    // 🔥 如果是 @projectid:xxx 或 @appid:xxx 格式，只保留 ID 部分，不包含后面的中文文字
    // 匹配 @projectid:xxx 或 @appid:xxx 或 @project:xxx 或 @app:xxx
    const mentionMatch = context.match(/@(?:project(?:id)?|app(?:id)?)[:\s]*[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    if (mentionMatch) {
      return mentionMatch[0];
    }

    return context;
  }

  /**
   * 更新会话的重要对象列表
   * 🔥 同时处理 content 和 phase_result
   */
  updateConversationObjects(
    conversationId: string,
    messages: Array<{ content: string; phase_result?: string; timestamp?: number }>
  ): ImportantObject[] {
    if (!this.objectCache.has(conversationId)) {
      this.objectCache.set(conversationId, new Map());
    }

    const conversationObjects = this.objectCache.get(conversationId)!;

    // 按时间顺序处理消息（由旧到新）
    const sortedMessages = [...messages].sort((a, b) =>
      (a.timestamp || 0) - (b.timestamp || 0)
    );

    let totalExtracted = 0;
    for (const msg of sortedMessages) {
      const timestamp = msg.timestamp || Date.now();

      // 🔥 从 content 提取对象
      const contentObjects = this.extractFromMessage(msg.content, timestamp);
      for (const obj of contentObjects) {
        const existing = conversationObjects.get(obj.id);
        if (existing) {
          existing.lastSeenAt = Math.max(existing.lastSeenAt, obj.lastSeenAt);
          existing.mentionCount += 1; // 🔥 每次再出现，mentionCount +1
        } else {
          conversationObjects.set(obj.id, obj);
        }
      }
      totalExtracted += contentObjects.length;

      // 🔥 从 phase_result 提取对象
      if (msg.phase_result) {
        const phaseResultObjects = this.extractFromMessage(msg.phase_result, timestamp);
        for (const obj of phaseResultObjects) {
          const existing = conversationObjects.get(obj.id);
          if (existing) {
            existing.lastSeenAt = Math.max(existing.lastSeenAt, obj.lastSeenAt);
            existing.mentionCount += 1; // 🔥 每次再出现，mentionCount +1
          } else {
            conversationObjects.set(obj.id, obj);
          }
        }
        totalExtracted += phaseResultObjects.length;
      }
    }

    return Array.from(conversationObjects.values());
  }

  /**
   * 🔥 规范化路径（用于去重比较）
   * 
   * @param path 原始路径
   * @returns 规范化后的路径（统一使用正斜杠，小写）
   */
  private normalizePath(path: string): string {
    // 统一使用正斜杠，转小写，移除末尾斜杠
    return path.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
  }

  /**
   * 🔥 主动添加重要对象（供执行过程中调用）
   * 
   * @param conversationId 会话ID
   * @param id 对象ID或路径
   * @param type 对象类型
   * @param context 可选的上下文描述
   */
  addObject(
    conversationId: string,
    id: string,
    type: 'app' | 'file' | 'path' | 'conversation' | 'unknown',
    context?: string
  ): void {
    if (!this.objectCache.has(conversationId)) {
      this.objectCache.set(conversationId, new Map());
    }

    const conversationObjects = this.objectCache.get(conversationId)!;
    const timestamp = Date.now();

    // 🔥 对于路径类型，检查是否已存在相似路径（规范化后比较）
    if (type === 'path') {
      const normalizedNewPath = this.normalizePath(id);
      
      // 查找是否已存在相同规范化路径
      for (const [existingId, existingObj] of conversationObjects.entries()) {
        if (existingObj.type === 'path') {
          const normalizedExistingPath = this.normalizePath(existingId);
          if (normalizedExistingPath === normalizedNewPath) {
            // 路径已存在，更新时间和上下文，保留更完整的路径（带盘符的优先）
            existingObj.lastSeenAt = timestamp;
            existingObj.mentionCount += 1; // 🔥 每次再出现，mentionCount +1
            if (context && !existingObj.context) {
              existingObj.context = context;
            }
            // 如果新路径带盘符而旧路径不带，更新为带盘符的路径
            if (id.match(/^[A-Za-z]:/) && !existingId.match(/^[A-Za-z]:/)) {
              conversationObjects.delete(existingId);
              conversationObjects.set(id, {
                id,
                type,
                firstSeenAt: existingObj.firstSeenAt,
                lastSeenAt: timestamp,
                mentionCount: existingObj.mentionCount,
                context: context || existingObj.context,
              });
            }
            return;
          }
        }
      }
    }

    const existing = conversationObjects.get(id);
    if (existing) {
      // 更新最后出现时间
      existing.lastSeenAt = timestamp;
      existing.mentionCount += 1; // 🔥 每次再出现，mentionCount +1
      if (context && !existing.context) {
        existing.context = context;
      }
    } else {
      // 添加新对象
      conversationObjects.set(id, {
        id,
        type,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        mentionCount: 1,
        context,
      });
    }
  }

  /**
   * 🔥 记录项目活动（训练/本地运行/文件操作）
   * 在 ReActExecutor 工具执行成功后调用，根据工具名推断活动类型
   */
  recordProjectActivity(
    conversationId: string,
    projectId: string,
    activity: 'train' | 'local_run' | 'file_op' | 'create',
    timestamp: number = Date.now()
  ): void {
    // 确保对象存在
    this.addObject(conversationId, projectId, 'app');

    const conversationObjects = this.objectCache.get(conversationId);
    if (!conversationObjects) return;

    const obj = conversationObjects.get(projectId);
    if (!obj) return;

    // 初始化 activityStats
    if (!obj.activityStats) {
      obj.activityStats = {
        trainCount: 0,
        localRunCount: 0,
        fileOpsCount: 0,
      };
    }

    switch (activity) {
      case 'train':
        obj.activityStats.trainCount++;
        obj.activityStats.lastTrainAt = timestamp;
        break;
      case 'local_run':
        obj.activityStats.localRunCount++;
        obj.activityStats.lastLocalRunAt = timestamp;
        break;
      case 'file_op':
        obj.activityStats.fileOpsCount++;
        break;
      case 'create':
        // 创建项目，不需要统计
        break;
    }

    // 推测项目类型
    obj.inferredType = this.inferProjectType(obj.activityStats);
  }

  /**
   * 🔥 根据活动统计推测项目类型
   */
  private inferProjectType(stats: ProjectActivityStats): 'training' | 'inference' | 'general' {
    if (stats.trainCount > 0) return 'training';
    if (stats.localRunCount > 0 && stats.trainCount === 0) return 'inference';
    return 'general';
  }

  /**
   * 🔥 从执行结果中提取并添加重要对象
   * 
   * @param conversationId 会话ID
   * @param result 执行结果（包含文件路径、appId等）
   */
  extractFromExecutionResult(
    conversationId: string,
    result: {
      filePath?: string;
      fileId?: string;
      appId?: string;
      outputPath?: string;
      downloadPath?: string;
      [key: string]: any;
    }
  ): void {
    const timestamp = Date.now();

    // 提取文件路径
    if (result.filePath) {
      this.addObject(conversationId, result.filePath, 'path', '执行生成的文件');
    }

    // 提取 fileId
    if (result.fileId) {
      this.addObject(conversationId, result.fileId, 'file', '执行生成的文件ID');
    }

    // 提取 appId
    if (result.appId) {
      this.addObject(conversationId, result.appId, 'app', '执行创建的应用');
    }

    // 提取输出路径
    if (result.outputPath) {
      this.addObject(conversationId, result.outputPath, 'path', '执行输出目录');
    }

    // 提取下载路径
    if (result.downloadPath) {
      this.addObject(conversationId, result.downloadPath, 'path', '下载的文件路径');
    }

    // 🔥 递归处理数组中的路径
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string') {
        // 检测路径格式
        if (value.match(/^[A-Za-z]:[\\/]/) || value.match(/^[~\/]/)) {
          if (value.includes('.') || value.includes('output') || value.includes('temp')) {
            this.addObject(conversationId, value, 'path', `执行结果字段: ${key}`);
          }
        }
        // 检测 fileId 格式
        if (value.match(/^file_[a-zA-Z0-9_-]+$/)) {
          this.addObject(conversationId, value, 'file', `执行结果字段: ${key}`);
        }
        // 检测 appId 格式 (UUID)
        if (value.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)) {
          this.addObject(conversationId, value, 'app', `执行结果字段: ${key}`);
        }
      }
    }
  }

  /**
   * 获取会话的重要对象列表（按首次出现时间排序）
   */
  getConversationObjects(conversationId: string): ImportantObject[] {
    const conversationObjects = this.objectCache.get(conversationId);
    if (!conversationObjects) return [];

    // 按首次出现时间排序（由旧到新）
    return Array.from(conversationObjects.values())
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  }

  /**
   * 获取格式化的重要对象列表（用于环境注入）
   * 🔥 排序策略：先按 mentionCount 降序（活跃度），再按 lastSeenAt 降序（最近性）
   * @param activeInstances 活跃 SSH 实例快照（可选）：归属匹配的项目条目下直接带出，免调 ssh_instance 查询省一轮
   */
  async getFormattedObjects(conversationId: string, activeInstances?: any[], rootHints?: Map<string, string>): Promise<string> {
    const objects = this.getConversationObjects(conversationId);

    if (objects.length === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push('## 对话内存里提到的重要内容（按活跃度排序，最活跃的在前）');
    lines.push('');

    // 🔥 按活跃度排序：mentionCount 降序 → lastSeenAt 降序
    const sortByActivity = (a: ImportantObject, b: ImportantObject) => {
      if (b.mentionCount !== a.mentionCount) return b.mentionCount - a.mentionCount;
      return b.lastSeenAt - a.lastSeenAt;
    };

    // 按类型分组，每种类型最多保留最新的 MAX_PER_TYPE 条
    const MAX_PER_TYPE = 3;
    const apps = objects.filter(o => o.type === 'app').sort(sortByActivity).slice(0, MAX_PER_TYPE);
    const files = objects.filter(o => o.type === 'file').sort(sortByActivity).slice(0, MAX_PER_TYPE);
    const paths = objects.filter(o => o.type === 'path').sort(sortByActivity).slice(0, MAX_PER_TYPE);
    const others = objects.filter(o => o.type === 'unknown').sort(sortByActivity).slice(0, MAX_PER_TYPE);

    // 🔥 辅助函数：格式化时间戳
    const formatTime = (timestamp: number): string => {
      const date = new Date(timestamp);
      return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
    };

    if (apps.length > 0) {
      lines.push('### 对话中提到的项目 (Projects)');
      // 🔥 项目本地代码目录（getAppBasePath：code_path 或默认 userDataPath/apps/{appId}）：
      //    不告知此路径，LLM 做本地渲染/执行类任务只能全盘搜索项目文件
      //    （真实案例：manim 渲染搜不到落盘文件，被迫用脚本重抄一遍代码）
      //    注意不能用 getCodePath——普通项目 code_path 为 null，会漏掉默认路径
      const codePaths = new Map<string, string>();
      await Promise.all(apps.map(async (app) => {
        const p = await getAppBasePath(app.id).catch(() => null);
        if (p) codePaths.set(app.id, p);
      }));
      apps.forEach((app, index) => {
        const timeStr = formatTime(app.lastSeenAt);
        const shortId = app.id.substring(0, 8);

        // 🔥 构建活动摘要
        let summary = `提及${app.mentionCount}次`;
        if (app.activityStats) {
          const parts: string[] = [];
          if (app.activityStats.trainCount > 0) {
            parts.push(`训练${app.activityStats.trainCount}次`);
          }
          if (app.activityStats.localRunCount > 0) {
            parts.push(`本地${app.activityStats.localRunCount}次`);
          }
          if (parts.length > 0) {
            summary += `，${parts.join('/')}`;
          }
        }
        if (app.inferredType && app.inferredType !== 'general') {
          summary += `，推测${app.inferredType === 'training' ? '训练' : '推理'}项目`;
        }

        lines.push(`${index + 1}. [${timeStr}] ${shortId} (${summary})`);

        // 🔥 内容根提示（穿透子目录名）：LLM 直接写对 read/push 的相对路径前缀，免跑一轮文件树确认
        const rootHint = rootHints?.get(app.id) || [...(rootHints?.keys() || [])].find(k => isSameProjectId(k, app.id) && rootHints!.get(k));
        if (rootHint) {
          lines.push(`   内容根: ${rootHint}/`);
        }

        // 🔥 本地落盘地址：shell/python 等本地执行类任务直接用，免全盘搜索
        const codePath = codePaths.get(app.id);
        if (codePath) {
          lines.push(`   本地目录: ${codePath}/`);
        }

        // 🔥 附带该项目归属的活跃实例（快照，免调 ssh_instance 查询）；无实例也明示"无"——
        //    这本身是有效信息（LLM 据此知道不能 ssh、应先开机，而非误连或反复查询）
        const owned = activeInstances ? activeInstances.filter(it => isSameProjectId(it.app_id, app.id)) : [];
        for (const it of owned) {
          const addr = it.host ? `${it.username || 'ubuntu'}@${it.host}` : (it.public_ip || '开机中');
          const status = it.status === 'pending' ? '开机中' : (it.status || '');
          lines.push(`   实例: ${it.id} (${it.instance_type || '未知规格'}, ${addr}${status ? `, ${status}` : ''})`);
        }
        if (owned.length === 0) {
          lines.push('   实例: 无');
        }
      });
      lines.push('');
    }

    // 🔥 聚焦项目关联：Files/Paths/其他对象段已移除——fileId/路径在执行历史里随取随用，
    // 常驻注入只会膨胀上下文，对"快速建立项目认知"没有增量价值

    return lines.join('\n');
  }

  /**
   * 清除会话的缓存
   */
  clearConversation(conversationId: string): void {
    this.objectCache.delete(conversationId);
  }

  /**
   * 获取特定类型的对象 ID 列表
   */
  getObjectIdsByType(conversationId: string, type: ImportantObject['type']): string[] {
    return this.getConversationObjects(conversationId)
      .filter(obj => obj.type === type)
      .map(obj => obj.id);
  }
}

// 导出单例
export const importantObjectTracker = ImportantObjectTracker.getInstance();
