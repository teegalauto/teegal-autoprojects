import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { X, RefreshCw, AlertCircle, FileText, Download, CheckCircle2, Copy, Maximize2, FolderOpen, FileIcon, CloudUpload, Check, Image, FileSpreadsheet, FileCode, FileArchive, File, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import { ChartRenderer } from './ChartRenderer';
import { FileAttachment } from '@/components/workspace/types/ChatTypes';
import { uploadFileToCloud } from '@/utils/files/resultFileStorage';
import { getGpuDisplayName } from './HistoryTaskList';  // 🔥 导入 GPU 型号映射函数

// 🔥 根据文件扩展名返回对应图标和颜色
const getFileTypeIcon = (fileName: string): { icon: React.ReactNode; color: string; label: string } => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  
  // 图片
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) {
    return { icon: <Image size={16} />, color: 'text-blue-500', label: '图片' };
  }
  // Excel/CSV
  if (['xlsx', 'xls', 'csv', 'tsv'].includes(ext)) {
    return { icon: <FileSpreadsheet size={16} />, color: 'text-green-600', label: '表格' };
  }
  // 代码文件
  if (['py', 'js', 'ts', 'jsx', 'tsx', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'sql'].includes(ext)) {
    return { icon: <FileCode size={16} />, color: 'text-purple-500', label: '代码' };
  }
  // 压缩包
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) {
    return { icon: <FileArchive size={16} />, color: 'text-yellow-600', label: '压缩包' };
  }
  // 模型文件
  if (['pt', 'pth', 'onnx', 'bin', 'h5', 'model', 'weights'].includes(ext)) {
    return { icon: <File size={16} />, color: 'text-indigo-500', label: '模型' };
  }
  // 文本
  if (['txt', 'md', 'log', 'rst'].includes(ext)) {
    return { icon: <FileText size={16} />, color: 'text-gray-500', label: '文本' };
  }
  // PDF
  if (ext === 'pdf') {
    return { icon: <FileText size={16} />, color: 'text-red-500', label: 'PDF' };
  }
  // 默认
  return { icon: <FileIcon size={16} />, color: 'text-blue-500', label: '文件' };
};

interface PreviewViewerProps {
  content?: string;
  isLoading?: boolean;
  loadingMessage?: string;
  error?: string;
  files?: { [filename: string]: any };
  charts?: any[];
  appId?: string;
  executionTime?: number;
  lastExecutedAt?: string;
  onClose?: () => void;
  conversationId?: string;
  trainingInfo?: {
    status?: string;
    duration?: number;
    cost?: number;
    instanceType?: string;
    createdAt?: string;
    modelUrl?: string;
  };
}

/**
 * 🔥 本地路径到云端文件的映射存储 key
 */
const PATH_TO_FILE_KEY = 'preview_path_to_file_map';

/**
 * 🔥 渲染文本内容，URL 自动转为可点击链接（新窗口打开）
 * 用于执行日志中的服务地址（"✅ 服务已启动: http://localhost:8083/"）等
 */
const renderContentWithLinks = (text: string) => {
  // 停止字符：空白、引号/反引号、Markdown 尾部 *、右括号等，避免链接尾部带脏字符
  const parts = text.split(/(https?:\/\/[^\s<>"'`)\]*,，。；]+)/g);
  return parts.map((part, i) => {
    if (!/^https?:\/\//.test(part)) return part;
    return (
      <a
        key={i}
        href={part}
        onClick={(e) => {
          e.preventDefault();
          window.open(part, '_blank');
        }}
        className="text-blue-600 underline break-all hover:text-blue-800 cursor-pointer"
      >
        {part}
      </a>
    );
  });
};

export const PreviewViewer: React.FC<PreviewViewerProps> = ({
  content,
  isLoading = false,
  loadingMessage,
  error,
  files,
  charts = [],
  appId,
  executionTime,
  lastExecutedAt,
  onClose,
  conversationId,
  trainingInfo
}) => {
  const { t } = useTranslation();
  const { toast } = useToast();

  // 🔥 安全处理 charts 和 files：确保类型正确
  const safeCharts = Array.isArray(charts) ? charts : [];
  const safeFiles = (files && typeof files === 'object' && !Array.isArray(files)) ? files : {};

  // 🔥 全屏图表查看状态
  const [enlargedChart, setEnlargedChart] = useState<any>(null);

  // 🔥 已上传文件的状态（localPath -> FileAttachment）
  const [uploadedFiles, setUploadedFiles] = useState<Map<string, FileAttachment>>(new Map());
  // 🔥 正在上传的路径集合
  const [uploadingPaths, setUploadingPaths] = useState<Set<string>>(new Set());
  // 🔥 复制链接成功标记（记录刚复制的 URL）
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  /**
   * 🔥 从 localStorage 加载已上传的文件映射
   */
  useEffect(() => {
    if (!conversationId) return;

    try {
      const key = `${PATH_TO_FILE_KEY}_${conversationId}`;
      const stored = localStorage.getItem(key);
      console.log('[PreviewViewer] 加载已上传文件映射:', { key, hasStored: !!stored });
      if (stored) {
        const parsed = JSON.parse(stored);
        console.log('[PreviewViewer] 解析的映射:', parsed);
        setUploadedFiles(new Map(Object.entries(parsed)));
      }
    } catch (e) {
      console.warn('[PreviewViewer] 加载已上传文件映射失败:', e);
    }
  }, [conversationId]);

  /**
   * 🔥 保存已上传的文件映射到 localStorage
   */
  const saveUploadedFiles = useCallback((map: Map<string, FileAttachment>) => {
    if (!conversationId) return;

    try {
      const key = `${PATH_TO_FILE_KEY}_${conversationId}`;
      const obj = Object.fromEntries(map);
      console.log('[PreviewViewer] 保存已上传文件映射:', { key, mapSize: map.size, obj });
      localStorage.setItem(key, JSON.stringify(obj));
    } catch (e) {
      console.warn('[PreviewViewer] 保存已上传文件映射失败:', e);
    }
  }, [conversationId]);

  /**
   * 🚀 解码 Unicode 转义序列 (如 \u6267\u884c -> 执行)
   */
  const decodeUnicode = (str: string): string => {
    if (!str) return str;
    try {
      return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, code) => {
        return String.fromCharCode(parseInt(code, 16));
      });
    } catch {
      return str;
    }
  };

  /**
   * 🚀 清洗执行输出
   * 
   * 🔥 如果 content 是 JSON 字符串（如 {"success": true, "output": "..."}），
   * 解析 JSON 并只提取 output 字段，避免渲染整个 JSON（可能包含 base64 图片数据）
   * 
   * 🔥 防御性措施：
   * 1. 解析 JSON 提取 output 字段
   * 2. 移除 base64 数据块（即使 JSON 解析失败也能清除）
   * 3. 截断超长内容（>100KB），防止 DOM 渲染崩溃
   */
  const cleanContent = useCallback((raw: string | undefined): string => {
    if (!raw) return '';
    // 先解码 Unicode 转义序列
    let decoded = decodeUnicode(raw);

    // 🔥 尝试解析 JSON，提取 output 字段
    // 后端可能因为解析失败，将整个 JSON 字符串作为 output 返回
    const trimmed = decoded.trim();
    const hasJsonMarker = trimmed.includes('{"success":');
    if (hasJsonMarker) {
      try {
        // 🔥 用花括号计数法提取完整 JSON（处理字符串中的转义引号）
        const jsonStart = trimmed.indexOf('{"success":');
        if (jsonStart !== -1) {
          let braceCount = 0;
          let inString = false;
          let escape = false;
          let jsonEnd = -1;

          for (let i = jsonStart; i < trimmed.length; i++) {
            const ch = trimmed[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"' && !escape) { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') braceCount++;
            if (ch === '}') {
              braceCount--;
              if (braceCount === 0) { jsonEnd = i; break; }
            }
          }

          if (jsonEnd !== -1) {
            const jsonStr = trimmed.substring(jsonStart, jsonEnd + 1);
            console.log(`[PreviewViewer] 尝试解析 JSON, 长度: ${jsonStr.length}`);
            const parsed = JSON.parse(jsonStr);
            if (parsed.output) {
              // 🔥 output 可能是非字符串（对象/数组/数字），直接赋给 decoded 会让后面的
              //    decoded.replace 炸掉（L.replace is not a function）——非字符串先序列化
              if (typeof parsed.output === 'string') {
                console.log(`[PreviewViewer] JSON 解析成功, output 长度: ${parsed.output.length}`);
                decoded = parsed.output;
              } else {
                console.log(`[PreviewViewer] JSON 解析成功, output 为非字符串(${typeof parsed.output})，已序列化`);
                decoded = JSON.stringify(parsed.output, null, 2);
              }
            } else {
              console.log(`[PreviewViewer] JSON 解析成功但无 output 字段`);
            }
          } else {
            // 🔥 JSON 不完整（日志被截断），用正则提取 output 字段
            console.log(`[PreviewViewer] JSON 不完整，尝试用正则提取 output 字段`);
            // 尝试匹配完整的 output 字段: "output": "..."
            const fullOutputMatch = trimmed.match(/"output"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (fullOutputMatch && fullOutputMatch[1]) {
              console.log(`[PreviewViewer] 正则提取 output 成功（完整匹配）`);
              decoded = fullOutputMatch[1]
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
            } else {
              // 尝试匹配不完整的 output 字段（日志被截断，output 值没有闭合引号）
              const partialOutputMatch = trimmed.match(/"output"\s*:\s*"(.*)$/s);
              if (partialOutputMatch && partialOutputMatch[1]) {
                console.log(`[PreviewViewer] 正则提取 output 成功（部分匹配，日志被截断）`);
                decoded = partialOutputMatch[1]
                  .replace(/\\n/g, '\n')
                  .replace(/\\t/g, '\t')
                  .replace(/\\"/g, '"')
                  .replace(/\\\\/g, '\\');
              } else {
                console.log(`[PreviewViewer] 正则提取 output 失败`);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[PreviewViewer] JSON 解析失败:', e);
      }
    }

    // 🔥 移除 base64 数据块（防御性：即使 JSON 解析失败也清除）
    // 匹配 data:image/...;base64,... 和裸 base64 长字符串
    decoded = decoded
      .replace(/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]{100,}/g, '[base64图片数据已省略]')
      .replace(/\[CAPTURED_CHARTS_START\][\s\S]*?\[CAPTURED_CHARTS_END\]/g, '');

    // 🔥 截断超长内容，防止 DOM 渲染崩溃（100KB 足够显示训练日志）
    const MAX_RENDER_LENGTH = 100 * 1024; // 100KB
    if (decoded.length > MAX_RENDER_LENGTH) {
      const truncated = decoded.substring(0, MAX_RENDER_LENGTH);
      decoded = truncated + `\n\n... [内容过长，已截断 ${Math.round(decoded.length / 1024)}KB 中的后 ${Math.round((decoded.length - MAX_RENDER_LENGTH) / 1024)}KB]`;
    }

    return decoded.trim();
  }, []);

  /**
   * 🔥 检测文本中的文件路径（Windows 和 Unix 格式）
   */
  const detectFilePaths = (text: string): Array<{ fullPath: string; isFile: boolean }> => {
    const paths: Array<{ fullPath: string; isFile: boolean }> = [];
    const matchedRanges: Array<{ start: number; end: number }> = [];
    
    // 🔥 首先排除 URL（http://, https://, s3:// 等）
    const urlRegex = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+/g;
    const urlRanges: Array<{ start: number; end: number }> = [];
    let urlMatch;
    while ((urlMatch = urlRegex.exec(text)) !== null) {
      urlRanges.push({ start: urlMatch.index, end: urlMatch.index + urlMatch[0].length });
    }
    
    // Windows 路径: C:\Users\... 或 C:/Users/...
    // 要求：盘符 + 冒号 + 至少一个反斜杠/斜杠 + 至少一个非空白字符
    // 🔥 使用负向回顾后发，确保前面不是另一个冒号（避免匹配 URL 的 scheme 部分）
    const windowsPathRegex = /(?<![a-zA-Z]:)[A-Za-z]:[\\/](?:[^\s]*[\\/])*[^\s]+/g;
    
    // Unix 路径: /home/user/... 或 /Users/user/...
    // 要求：以 / 开头（前面不是字母:）+ 常见目录名 + 后续路径
    // 使用负向回顾后发，确保不匹配 Windows 路径的一部分
    // 🔥 注意：/tmp/ 目录是云端 GPU 实例的临时目录，用户无法打开
    // 🔥 排除 Python traceback 格式：/path/to/file.py:92: 或 /path/to/file.py:line
    const unixPathRegex = /(?<![A-Za-z]:)\/(?:home|Users|tmp|var|opt|usr|mnt|data|workspace)[\\/][^\s:]+/g;
    
    // 🔥 云端路径黑名单：这些路径在云端 GPU 实例上，用户无法打开
    const cloudPathBlacklist = [
      '/tmp/',          // 云端临时目录（用户代码、缓存、输出等都在这里）
      '/home/',         // 云端用户目录
      '/opt/',          // 云端软件安装目录
      '/var/',          // 云端系统目录
      '/usr/',          // 云端系统目录
      '/mnt/',          // 云端挂载目录
      '/data/',         // 云端数据目录
      '/workspace/',    // 云端工作目录
    ];
    
    // 匹配 Windows 路径
    let match;
    while ((match = windowsPathRegex.exec(text)) !== null) {
      const path = match[0];
      const start = match.index;
      const end = start + path.length;
      
      // 🔥 检查是否与 URL 范围重叠
      const isInUrl = urlRanges.some(range => 
        (start >= range.start && start < range.end) ||
        (end > range.start && end <= range.end) ||
        (start <= range.start && end >= range.end)
      );
      
      if (isInUrl) {
        console.log('[PreviewViewer] 跳过 URL 中的路径:', path);
        continue;
      }
      
      // 过滤掉纯中文或特殊字符的路径（必须是有效的文件路径）
      if (/[A-Za-z]:[\\/][^\s]{2,}/.test(path)) {
        const hasExtension = /\.[^\\/\.]+$/.test(path);
        paths.push({ fullPath: path, isFile: hasExtension });
        matchedRanges.push({ start, end });
      }
    }
    
    // 匹配 Unix 路径（排除已匹配的范围）
    while ((match = unixPathRegex.exec(text)) !== null) {
      const path = match[0];
      const start = match.index;
      const end = start + path.length;
      
      // 检查是否与已匹配的 Windows 路径重叠
      const isOverlapping = matchedRanges.some(range => 
        (start >= range.start && start < range.end) ||
        (end > range.start && end <= range.end) ||
        (start <= range.start && end >= range.end)
      );
      
      // 🔥 检查是否是云端路径（用户无法打开）
      const isCloudPath = cloudPathBlacklist.some(blacklistPath => 
        path.startsWith(blacklistPath)
      );
      
      if (isCloudPath) {
        console.log('[PreviewViewer] 跳过云端路径:', path);
        continue;
      }
      
      if (!isOverlapping && /\/(?:home|Users|tmp|var|opt|usr|mnt|data|workspace)[\\/][^\s:]{2,}/.test(path)) {
        const hasExtension = /\.[^\\/\.]+$/.test(path);
        paths.push({ fullPath: path, isFile: hasExtension });
      }
    }
    
    // 去重（按路径字符串）
    const uniquePaths = paths.filter((item, index, self) => 
      index === self.findIndex((t) => t.fullPath === item.fullPath)
    );
    
    // 🔥 路径层级最小化：如果一个是另一个的父目录，只保留更具体的那个
    return minimizePaths(uniquePaths);
  };
  
  /**
   * 🔥 路径层级最小化
   * 如果路径A是路径B的父目录（B以A开头），则只保留B
   */
  const minimizePaths = (paths: Array<{ fullPath: string; isFile: boolean }>): Array<{ fullPath: string; isFile: boolean }> => {
    if (paths.length <= 1) return paths;
    
    // 按路径长度降序排序（长的在前，更具体的路径优先）
    const sorted = [...paths].sort((a, b) => b.fullPath.length - a.fullPath.length);
    
    const result: Array<{ fullPath: string; isFile: boolean }> = [];
    
    for (const current of sorted) {
      // 检查当前路径是否是已保留路径的父目录
      const isParentOfExisting = result.some(existing => {
        // 统一使用 / 进行比较
        const currentNormalized = current.fullPath.replace(/\\/g, '/');
        const existingNormalized = existing.fullPath.replace(/\\/g, '/');
        // existing 以 current 开头，且后面跟着 / 或结束
        return existingNormalized.startsWith(currentNormalized) && 
               (existingNormalized === currentNormalized || existingNormalized[currentNormalized.length] === '/');
      });
      
      // 如果不是任何已保留路径的父目录，则保留
      if (!isParentOfExisting) {
        result.push(current);
      }
    }
    
    return result;
  };

  /**
   * 🔥 打开文件或文件夹
   */
  const handleOpenPath = async (fullPath: string, isFile: boolean) => {
    try {
      const electron = (window as any).electron;
      if (!electron?.openPath) {
        toast({
          title: "功能不可用",
          description: "仅在桌面版应用中可用",
          variant: "destructive"
        });
        return;
      }

      const result = await electron.openPath(fullPath);
      if (result.success) {
        toast({
          title: isFile ? "正在打开文件" : "正在打开文件夹",
          description: fullPath
        });
      } else {
        toast({
          title: "打开失败",
          description: result.error || "无法打开路径",
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        title: "打开失败",
        description: error instanceof Error ? error.message : "未知错误",
        variant: "destructive"
      });
    }
  };

  /**
   * 🔥 在文件资源管理器中显示
   */
  const handleShowInFolder = async (fullPath: string) => {
    try {
      const electron = (window as any).electron;
      if (!electron?.showItemInFolder) {
        toast({
          title: "功能不可用",
          description: "仅在桌面版应用中可用",
          variant: "destructive"
        });
        return;
      }

      const result = await electron.showItemInFolder(fullPath);
      if (result.success) {
        toast({
          title: "已打开文件资源管理器",
          description: fullPath
        });
      } else {
        toast({
          title: "打开失败",
          description: result.error || "无法显示文件",
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        title: "打开失败",
        description: error instanceof Error ? error.message : "未知错误",
        variant: "destructive"
      });
    }
  };

  /**
   * 🔥 上传文件到云端
   */
  const handleUploadToCloud = async (fullPath: string) => {
    if (!conversationId) {
      toast({
        title: "无法上传",
        description: "缺少对话ID，请先创建或选择一个对话",
        variant: "destructive"
      });
      return;
    }

    // 检查是否已上传
    if (uploadedFiles.has(fullPath)) {
      toast({
        title: "文件已上传",
        description: "该文件已经上传到云端"
      });
      return;
    }

    // 标记为正在上传
    setUploadingPaths(prev => new Set(prev).add(fullPath));

    try {
      // 1. 读取本地文件内容
      const electron = (window as any).electron;
      if (!electron?.readLocalFile) {
        toast({
          title: "功能不可用",
          description: "仅在桌面版应用中可用",
          variant: "destructive"
        });
        return;
      }

      toast({
        title: "正在读取文件...",
        description: fullPath
      });

      const readResult = await electron.readLocalFile({ localPath: fullPath });
      if (!readResult.success || !readResult.content) {
        toast({
          title: "读取文件失败",
          description: readResult.error || "无法读取文件内容",
          variant: "destructive"
        });
        return;
      }

      // 2. 上传到云端
      toast({
        title: "正在上传...",
        description: "请稍候"
      });

      const fileName = fullPath.split(/[\\/]/).pop() || 'file';
      
      // 🔥 创建文件附件对象
      const fileAttachment: FileAttachment = {
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: fileName,
        type: 'application/octet-stream',
        content: readResult.content,
        source: 'step_output'
      };
      
      // 🔥 强制上传到云端（忽略当前存储模式）
      const uploadResult = await uploadFileToCloud(fileAttachment);

      if (uploadResult.success && uploadResult.file) {
        // 3. 保存映射关系
        const uploadedFileAttachment = uploadResult.file as FileAttachment;
        
        const newMap = new Map(uploadedFiles);
        newMap.set(fullPath, uploadedFileAttachment);
        setUploadedFiles(newMap);
        saveUploadedFiles(newMap);

        toast({
          title: "上传成功",
          description: `文件已上传到云端，ID: ${uploadedFileAttachment.id}`
        });

        // 4. 触发 ExecutionPanel 刷新（通过自定义事件）
        window.dispatchEvent(new CustomEvent('preview-file-uploaded', {
          detail: { conversationId, file: uploadedFileAttachment }
        }));
      } else {
        toast({
          title: "上传失败",
          description: uploadResult.error || "未知错误",
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        title: "上传失败",
        description: error instanceof Error ? error.message : "未知错误",
        variant: "destructive"
      });
    } finally {
      setUploadingPaths(prev => {
        const newSet = new Set(prev);
        newSet.delete(fullPath);
        return newSet;
      });
    }
  };

  // 🔥 缓存清洗后的内容，避免渲染时重复调用 cleanContent（每次调用都会解析 JSON + 正则替换）
  const cleanedContent = useMemo(() => cleanContent(content), [content, cleanContent]);

  // 🔥 检测内容中的文件路径
  const detectedPaths = useMemo(() => {
    return detectFilePaths(cleanedContent);
  }, [cleanedContent]);

  // 🔥 过滤 charts 中的大 base64 数据，防止内存飙升
  // 只保留有 URL 的图表，跳过纯 base64 数据（>100KB）
  const filteredCharts = useMemo(() => {
    if (!safeCharts || safeCharts.length === 0) return [];

    return safeCharts.filter((chart: any) => {
      // 如果有 URL，保留
      if (chart.url) return true;

      // 如果 data 是 base64 字符串，检查大小
      const data = chart.data || chart.base64_content || chart.content;
      if (data && typeof data === 'string') {
        // base64 数据大小估算：字符数 * 0.75
        const sizeKB = (data.length * 0.75) / 1024;
        if (sizeKB > 100) {
          console.log(`[PreviewViewer] 跳过大图表: ${chart.title || chart.name || 'unknown'}, 大小: ${Math.round(sizeKB)}KB`);
          return false;
        }
      }

      return true;
    });
  }, [safeCharts]);

  if (isLoading) {
    return (
      <div className="h-full overflow-auto flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-2"></div>
          <p className="text-gray-500">{loadingMessage || t('workspace.desktopModule.codeEditor.running')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full overflow-auto flex flex-col items-center justify-center p-4">
        <div className="text-center mb-4">
          <div className="text-red-500 mb-2">❌</div>
          <p className="text-red-600 font-medium">{error}</p>
        </div>
      </div>
    );
  }

  if (!content && (!safeFiles || Object.keys(safeFiles).length === 0) && filteredCharts.length === 0 && !executionTime) {
    return (
      <div className="h-full overflow-auto flex items-center justify-center p-4 text-gray-500">
        <div className="text-center">
          <p>{t('workspace.desktopModule.previewViewer.title')}</p>
          <p className="text-sm mt-1">{t('workspace.desktopModule.codeEditor.executionResult')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto max-w-full flex flex-col bg-gray-50">
      {/* 🚀 新增：训练概览摘要条（仅在有训练信息时显示） */}
      {trainingInfo && (
        <div className={`p-3 border-b flex items-center justify-between text-xs ${
          ['running', 'pending', 'starting'].includes(trainingInfo.status || '') 
            ? 'bg-blue-50 border-blue-100' 
            : trainingInfo.status === 'failed' 
              ? 'bg-red-50 border-red-100'
              : 'bg-indigo-50 border-indigo-100'
        }`}>
          <div className="flex items-center gap-4">
            <span className={`flex items-center gap-1 font-medium ${
              ['running', 'pending', 'starting'].includes(trainingInfo.status || '') 
                ? 'text-blue-700' 
                : trainingInfo.status === 'failed'
                  ? 'text-red-700'
                  : 'text-indigo-700'
            }`}>
              {['running', 'pending', 'starting'].includes(trainingInfo.status || '') && (
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              )}
              {trainingInfo.status === 'success' && <span>✅</span>}
              {trainingInfo.status === 'failed' && <span>❌</span>}
              {getGpuDisplayName(trainingInfo.instanceType)} GPU
              {trainingInfo.status === 'running' ? ` ${t('workspace.desktopModule.desktopAppViewer.trainingInProgress')}` : 
               trainingInfo.status === 'pending' || trainingInfo.status === 'starting' ? ` ${t('workspace.desktopModule.previewViewer.starting')}` :
               trainingInfo.status === 'failed' ? ` ${t('workspace.desktopModule.desktopAppViewer.trainingFailed')}` : ` ${t('workspace.desktopModule.desktopAppViewer.trainingSuccess')}`}
            </span>
            <span className="text-gray-500">{t('workspace.desktopModule.previewViewer.duration')}: {Math.ceil((trainingInfo.duration || 0) / 60)} {t('workspace.desktopModule.gpuTrainingStatus.unitMinute')}</span>
            <span className="font-bold text-green-600 inline-flex items-center gap-0.5">{t('workspace.desktopModule.previewViewer.cost')}: <Sparkles className="h-3 w-3" />{Math.ceil(trainingInfo.cost || 0)}</span>
          </div>
          {trainingInfo.modelUrl && (
            <a 
              href={trainingInfo.modelUrl} 
              target="_blank" 
              className="px-2 py-1 bg-white border border-indigo-200 rounded text-indigo-600 hover:bg-indigo-50 transition-colors shadow-sm"
            >
              💾 {t('workspace.desktopModule.previewViewer.downloadModel')}
            </a>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {/* 显示文本 output */}
        {(cleanedContent || executionTime || lastExecutedAt) && (
          <div className="p-4 border-b max-w-full bg-white">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium text-gray-700">📝 {t('workspace.desktopModule.codeEditor.executionResult')}</h3>
              <div className="flex items-center gap-2">
                {lastExecutedAt && (
                  <span className="text-[10px] text-gray-400">
                    🕒 {new Date(lastExecutedAt).toLocaleTimeString()}
                  </span>
                )}
                {executionTime !== undefined && (
                  <span className="text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                    ⏱️ {executionTime >= 1000 ? `${(executionTime / 1000).toFixed(2)}s` : `${executionTime}ms`}
                  </span>
                )}
              </div>
            </div>
            {cleanedContent && (
              <div className="bg-gray-50 p-3 rounded-lg overflow-x-auto font-mono text-sm text-gray-700 whitespace-pre-wrap">
                {renderContentWithLinks(cleanedContent)}
              </div>
            )}
          </div>
        )}

        {/* 🔥 显示检测到的文件路径（快速操作） */}
        {detectedPaths.length > 0 && (
          <div className="p-4 border-b bg-blue-50/50">
            <h3 className="font-medium text-gray-700 mb-3 flex items-center gap-2">
              <FolderOpen size={16} />
              检测到的文件路径
            </h3>
            <div className="space-y-2">
              {detectedPaths.map((item, index) => {
                const isUploaded = uploadedFiles.has(item.fullPath);
                const isUploading = uploadingPaths.has(item.fullPath);
                const uploadedFile = uploadedFiles.get(item.fullPath);

                return (
                  <div 
                    key={index} 
                    className="flex items-center justify-between p-2 bg-white rounded border border-blue-100 hover:border-blue-300 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {item.isFile ? (
                        <span className={`shrink-0 ${getFileTypeIcon(item.fullPath).color}`} title={getFileTypeIcon(item.fullPath).label}>
                          {getFileTypeIcon(item.fullPath).icon}
                        </span>
                      ) : (
                        <FolderOpen size={16} className="text-yellow-500 shrink-0" />
                      )}
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm text-gray-600 truncate" title={item.fullPath}>
                          {item.fullPath}
                        </span>
                        {isUploaded && uploadedFile && (
                          <span className="text-[10px] text-green-600 flex items-center gap-1">
                            <Check size={10} />
                            已上传: {uploadedFile.id}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <button
                        onClick={() => handleOpenPath(item.fullPath, item.isFile)}
                        className="px-2 py-1 text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 rounded transition-colors flex items-center gap-1"
                        title={item.isFile ? "打开文件" : "打开文件夹"}
                      >
                        {item.isFile ? <FileIcon size={12} /> : <FolderOpen size={12} />}
                        打开
                      </button>
                      <button
                        onClick={() => handleShowInFolder(item.fullPath)}
                        className="px-2 py-1 text-xs bg-gray-50 text-gray-600 hover:bg-gray-100 rounded transition-colors"
                        title="在文件夹中显示"
                      >
                        定位
                      </button>
                      {/* 🔥 云上传按钮 */}
                      {item.isFile && !isUploaded && (
                        <button
                          onClick={() => handleUploadToCloud(item.fullPath)}
                          disabled={isUploading}
                          className={`px-2 py-1 text-xs rounded transition-colors flex items-center gap-1 ${
                            isUploading 
                                ? 'bg-gray-50 text-gray-400 cursor-wait'
                                : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                          }`}
                          title={isUploading ? "上传中..." : "上传到云端"}
                        >
                          {isUploading ? (
                            <RefreshCw size={12} className="animate-spin" />
                          ) : (
                            <CloudUpload size={12} />
                          )}
                          {isUploading ? '上传中' : '上传'}
                        </button>
                      )}
                      {/* 🔥 复制 URL 按钮 - 上传成功后显示，点击直接复制无 toast */}
                      {isUploaded && (uploadedFile?.url || uploadedFile?.storageUrl) && (
                        <button
                          onClick={() => {
                            const urlToCopy = uploadedFile.url || uploadedFile.storageUrl;
                            navigator.clipboard.writeText(urlToCopy!);
                          }}
                          className="px-2 py-1 text-xs bg-green-50 text-green-600 hover:bg-green-100 rounded transition-colors flex items-center gap-1"
                          title="复制文件URL"
                        >
                          <Copy size={12} />
                          复制URL
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        
        {/* 显示生成的图表 */}
        {safeCharts.length > 0 && (
          <div className="p-4 border-b bg-white">
            <h3 className="font-medium text-gray-700 mb-3">📊 {t('workspace.desktopModule.chartRenderer.title')}</h3>
            <div className="space-y-4">
              {safeCharts.map((chart, index) => {
                const isStringUrl = typeof chart === 'string';
                const normalizedChart = isStringUrl ? {
                  url: chart,
                  type: 'image/png',
                  title: `chart-${index}`
                } : {
                  ...chart,
                  type: chart.type || 'image/png',
                  data: chart.data || chart.base64_content || chart.content,
                  url: chart.url,
                  title: chart.title || chart.name || chart.filename || `chart-${index}`
                };

                const chartKey = normalizedChart.title;
                const displayTitle = normalizedChart.title;
                return (
                  <div key={chartKey} className="border rounded-lg p-4 bg-white shadow-sm">
                    <div className="flex items-center justify-between mb-2">
                      {displayTitle && (
                        <h4 className="text-sm font-medium text-gray-600">{displayTitle}</h4>
                      )}
                      {/* 🔥 放大查看按钮 */}
                      <button
                        onClick={() => setEnlargedChart(normalizedChart)}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded transition-colors"
                        title="放大查看"
                      >
                        <Maximize2 size={14} />
                        放大
                      </button>
                    </div>
                    <div className="min-w-0 overflow-hidden">
                      <ChartRenderer 
                        chart={normalizedChart} 
                        width={800} 
                        height={500} 
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        
        {/* 显示生成的文件 */}
        {safeFiles && Object.keys(safeFiles).length > 0 && (
          <div className="p-4 bg-white">
            <h3 className="font-medium text-gray-700 mb-3">📁 {t('workspace.desktopModule.desktopPanel.files')}</h3>
            <div className="space-y-4">
              {Object.entries(safeFiles).map(([filename, fileInfo]: [string, any]) => {
                const fileUrl = fileInfo.url;
                const isBase64 = fileInfo.type === 'base64';

                // 1. 如果有 URL (OSS)，直接展示或提供下载
                if (fileUrl) {
                  const handleCopyUrl = (url: string) => {
                    navigator.clipboard.writeText(url);
                    setCopiedUrl(url);
                    setTimeout(() => setCopiedUrl(null), 1500);
                  };

                  // 图片预览
                  if (filename.match(/\.(png|jpg|jpeg|gif|svg)$/i)) {
                    return (
                      <div key={filename} className="border rounded-lg overflow-hidden">
                        <div className="bg-gray-100 px-3 py-2 text-sm font-medium border-b flex justify-between items-center">
                          <span className="flex items-center gap-2">🖼️ {filename}</span>
                          <div className="flex items-center gap-3">
                            <button 
                              onClick={() => handleCopyUrl(fileUrl)}
                              className="text-gray-500 hover:text-blue-600 transition-colors"
                              title="复制链接"
                            >
                              {copiedUrl === fileUrl ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                            </button>
                            <a href={fileUrl} target="_blank" className="text-gray-500 hover:text-blue-600 transition-colors" title={t('workspace.desktopModule.previewViewer.download')}>
                              <Download size={14} />
                            </a>
                          </div>
                        </div>
                        <div className="p-4 flex justify-center bg-white">
                          <img src={fileUrl} alt={filename} className="max-w-full h-auto" />
                        </div>
                      </div>
                    );
                  }
                  // 通用文件下载
                  return (
                    <div key={filename} className="border rounded-lg p-3 flex items-center justify-between bg-white shadow-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-xl">📄</span>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{filename}</span>
                          <span className="text-[10px] text-gray-400">{t('workspace.desktopModule.previewViewer.fromCloud')}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => handleCopyUrl(fileUrl)}
                          className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                          title="复制链接"
                        >
                          {copiedUrl === fileUrl ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                        </button>
                        <a 
                          href={fileUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                          title={t('workspace.desktopModule.previewViewer.downloadFile')}
                        >
                          <Download size={14} />
                        </a>
                      </div>
                    </div>
                  );
                }

                // 2. 兼容旧的 Base64 逻辑
                if (isBase64) {
                  const safeContent = typeof fileInfo.content === 'string' 
                    ? fileInfo.content.trim().replace(/\s/g, '').replace(/^["']|["']$/g, '')
                    : '';
                  return (
                    <div key={filename} className="border rounded-lg overflow-hidden">
                      <div className="bg-gray-100 px-3 py-2 text-sm font-medium border-b">
                        📄 {filename} ({(fileInfo.size / 1024).toFixed(2)} KB)
                      </div>
                      <div className="w-full overflow-x-auto">
                        <iframe
                          src={`data:text/html;base64,${safeContent}`}
                          className="w-full h-96 border-0 min-w-full"
                          title={filename}
                          sandbox="allow-scripts"
                        />
                      </div>
                    </div>
                  );
                }
                // 图片文件：使用图片显示
                else if (filename.match(/\.(png|jpg|jpeg|gif|svg)$/i)) {
                  return (
                    <ImageFileRenderer key={filename} filename={filename} fileInfo={fileInfo} />
                  );
                }
                
                return null;
              })}
            </div>
          </div>
        )}
      </div>
      
      {/* 🔥 全屏图表查看弹窗 */}
      {enlargedChart && (
        <div 
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setEnlargedChart(null)}
        >
          <div 
            className="bg-white rounded-lg shadow-2xl max-w-[90vw] max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 弹窗头部 */}
            <div className="sticky top-0 bg-white border-b px-4 py-3 flex items-center justify-between">
              <h3 className="font-medium text-gray-800">
                {enlargedChart.title || '图表详情'}
              </h3>
              <button
                onClick={() => setEnlargedChart(null)}
                className="p-1 hover:bg-gray-100 rounded-full transition-colors"
              >
                <X size={20} className="text-gray-500" />
              </button>
            </div>
            
            {/* 大图渲染 */}
            <div className="p-6 flex justify-center bg-gray-50">
              <ChartRenderer 
                chart={enlargedChart} 
                width={1200} 
                height={800}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * � 图片文件渲染组件
 */
const ImageFileRenderer: React.FC<{ filename: string; fileInfo: any }> = ({ filename, fileInfo }) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadImage = async () => {
      try {
        // 处理 base64 内容
        if (fileInfo.content) {
          const base64Content = typeof fileInfo.content === 'string' 
            ? fileInfo.content 
            : '';
          if (base64Content) {
            setImageUrl(`data:image/png;base64,${base64Content}`);
            return;
          }
        }
        
        // 处理本地文件路径
        if (fileInfo.path || fileInfo.localPath) {
          const localPath = fileInfo.path || fileInfo.localPath;
          const electron = (window as any).electron;
          if (electron?.readLocalFile) {
            const result = await electron.readLocalFile({ localPath });
            if (result.success && result.content) {
              setImageUrl(`data:image/png;base64,${result.content}`);
              return;
            }
          }
        }

        setError('无法加载图片');
      } catch (err) {
        setError('加载图片失败');
      }
    };

    loadImage();
  }, [fileInfo]);

  if (error) {
    return (
      <div className="border rounded-lg p-4 bg-gray-50 text-center text-gray-500">
        <p>📄 {filename}</p>
        <p className="text-sm text-red-500 mt-1">{error}</p>
      </div>
    );
  }

  if (!imageUrl) {
    return (
      <div className="border rounded-lg p-4 bg-gray-50 text-center text-gray-500">
        <p>📄 {filename}</p>
        <p className="text-sm mt-1">加载中...</p>
      </div>
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="bg-gray-100 px-3 py-2 text-sm font-medium border-b">
        🖼️ {filename}
      </div>
      <div className="p-4 flex justify-center bg-white">
        <img src={imageUrl} alt={filename} className="max-w-full h-auto" />
      </div>
    </div>
  );
};
