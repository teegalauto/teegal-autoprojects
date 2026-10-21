/**
 * VideoViewer - 本地视频文件预览组件
 *
 * 支持：mp4/webm/ogg/mov/avi/mkv
 * 通过 electron IPC 读取本地文件为 Blob URL 渲染
 */

import React, { useEffect, useState, useRef } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';

/** 判断文件扩展名是否为视频文件 */
export function isVideoFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'].includes(ext);
}

const MIME_MAP: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

// 🔥 流式协议失败时的回退整读上限：≤50MB 转内存 Blob 兜底播放，超大文件不整读（内存保护）
const FALLBACK_MAX_BYTES = 50 * 1024 * 1024;

interface VideoViewerProps {
  filePath: string;
  fileName?: string;
}

export const VideoViewer: React.FC<VideoViewerProps> = ({ filePath, fileName }) => {
  const [src, setSrc] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const fallbackTriedRef = useRef(false);

  useEffect(() => {
    fallbackTriedRef.current = false;
    // 🔥 本地文件走 teegal-file:// 流式协议：Chromium 按需从磁盘读（支持 Range/seek），
    // 字节不过 IPC、不进内存——数百 MB/GB 级视频也可直接播放，无需大小门禁
    if (filePath.startsWith('http')) {
      setSrc(filePath);
      setLoading(false);
      return;
    }

    const electron = (window as any).electron;
    if (!electron?.userpcFile?.read) {
      setError('无法读取本地文件');
      setLoading(false);
      return;
    }

    // 先探存，再用 fetch 探协议链路（teegal-file 已注册 supportFetchAPI），失败给出精确原因
    electron.userpcFile.exists(filePath).then(async (r: any) => {
      if (!r?.data?.exists) {
        setError(`文件不存在: ${filePath}`);
        setLoading(false);
        return;
      }
      const url = `teegal-file://local/${encodeURIComponent(filePath)}`;
      try {
        // Range 探针只取首字节，避免探测即全量拉流；206/200 均为链路正常
        const resp = await fetch(url, { headers: { Range: 'bytes=0-0' } });
        if (resp.ok) {
          setSrc(url);
        } else {
          const body = (await resp.text().catch(() => ''))?.trim();
          setError(`视频加载失败（协议响应 ${resp.status}${body ? `: ${body}` : ''}）：${filePath}`);
        }
      } catch {
        setError('视频加载失败：teegal-file 协议不可用——请完全退出并重启应用（主进程协议需重启才注册生效）');
      }
      setLoading(false);
    }).catch(() => {
      setError('加载视频失败');
      setLoading(false);
    });
  }, [filePath]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-gray-50 dark:bg-gray-900">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-gray-50 dark:bg-gray-900 text-gray-400">
        <AlertTriangle className="w-8 h-8 mb-2 text-yellow-500" />
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  // 🔥 流式协议下媒体元素仍报错 → 回退 IPC 整读（≤FALLBACK_MAX_BYTES）转 Blob 兜底播放。
  // Chromium 媒体栈对自定义协议的字节范围读取存在兼容性坑（code=4 data source error），
  // 中小文件整读兜底保证"能播"；超大文件不整读（内存保护），保持报错
  const handleMediaError = () => {
    if (fallbackTriedRef.current) return;
    fallbackTriedRef.current = true;
    if (!src.startsWith('teegal-file://')) {
      const err = videoRef.current?.error;
      setError(`视频无法解码：code=${err?.code ?? '?'} ${err?.message || ''}`);
      return;
    }
    (async () => {
      try {
        const electron = (window as any).electron;
        const st = await electron.userpcFile.exists(filePath);
        const size: number = st?.data?.size ?? 0;
        if (size > FALLBACK_MAX_BYTES) {
          const err = videoRef.current?.error;
          setError(`视频流式播放失败且超出回退整读上限 ${FALLBACK_MAX_BYTES / 1024 / 1024}MB（${(size / 1024 / 1024).toFixed(0)}MB）：code=${err?.code ?? '?'} ${err?.message || ''}`);
          return;
        }
        const r = await electron.userpcFile.read(filePath, 'base64');
        const content: string | undefined = r?.data?.content;
        if (!r?.success || !content) {
          setError(r?.error || '回退读取视频失败');
          return;
        }
        const bin = atob(content);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const ext = filePath.split('.').pop()?.toLowerCase() || 'mp4';
        setSrc(URL.createObjectURL(new Blob([bytes], { type: MIME_MAP[ext] || 'video/mp4' })));
      } catch (e: any) {
        setError(`回退播放失败: ${e?.message || e}`);
      }
    })();
  };

  return (
    <div className="flex items-center justify-center h-full bg-gray-900 p-4">
      <video
        ref={videoRef}
        src={src}
        controls
        onError={handleMediaError}
        className="w-full h-full object-contain"
      >
        您的浏览器不支持视频播放。
      </video>
    </div>
  );
};
