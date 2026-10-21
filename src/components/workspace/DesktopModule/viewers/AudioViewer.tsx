/**
 * AudioViewer - 音频文件预览组件
 *
 * 支持：mp3/wav/ogg/m4a/flac/aac
 * - HTTP URL → 直接用 <audio> 渲染
 * - 本地文件 → 通过 electron IPC 以 base64 读取 → Blob URL → <audio>
 *
 * 注意：本组件仅负责播放预览。
 * 若需音频转文字，应作为独立的业务操作（如 Chat tool 调用 LLM/Whisper），不在此内置。
 */

import React, { useEffect, useState, useRef } from 'react';
import { Loader2, AlertTriangle, Music } from 'lucide-react';

/** 判断文件扩展名是否为音频文件 */
export function isAudioFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext);
}

const MIME_MAP: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
};

// 🔥 流式协议失败时的回退整读上限：≤50MB 转内存 Blob 兜底播放，超大文件不整读（内存保护）
const FALLBACK_MAX_BYTES = 50 * 1024 * 1024;

interface AudioViewerProps {
  filePath: string;
  fileName?: string;
}

export const AudioViewer: React.FC<AudioViewerProps> = ({ filePath, fileName }) => {
  const [src, setSrc] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const fallbackTriedRef = useRef(false);

  useEffect(() => {
    fallbackTriedRef.current = false;
    // 🔥 本地文件走 teegal-file:// 流式协议：Chromium 按需从磁盘读（支持 seek），
    // 字节不过 IPC、不进内存——数百 MB 音频也可直接播放，无需大小门禁
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
        // Range 探针只取首字节；206/200 均为链路正常
        const resp = await fetch(url, { headers: { Range: 'bytes=0-0' } });
        if (resp.ok) {
          setSrc(url);
        } else {
          const body = (await resp.text().catch(() => ''))?.trim();
          setError(`音频加载失败（协议响应 ${resp.status}${body ? `: ${body}` : ''}）：${filePath}`);
        }
      } catch {
        setError('音频加载失败：teegal-file 协议不可用——请完全退出并重启应用（主进程协议需重启才注册生效）');
      }
      setLoading(false);
    }).catch(() => {
      setError('加载音频失败');
      setLoading(false);
    });
  }, [filePath]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        <span className="ml-2 text-sm text-gray-500">加载音频中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <AlertTriangle className="h-10 w-10 text-orange-400 mb-2" />
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  // 🔥 流式协议下媒体元素仍报错 → 回退 IPC 整读（≤FALLBACK_MAX_BYTES）转 Blob 兜底播放，
  // 与 VideoViewer 同一策略；超大文件不整读（内存保护），保持报错
  const handleMediaError = () => {
    if (fallbackTriedRef.current) return;
    fallbackTriedRef.current = true;
    if (!src.startsWith('teegal-file://')) {
      const err = audioRef.current?.error;
      setError(`音频无法解码：code=${err?.code ?? '?'} ${err?.message || ''}`);
      return;
    }
    (async () => {
      try {
        const electron = (window as any).electron;
        const st = await electron.userpcFile.exists(filePath);
        const size: number = st?.data?.size ?? 0;
        if (size > FALLBACK_MAX_BYTES) {
          const err = audioRef.current?.error;
          setError(`音频流式播放失败且超出回退整读上限 ${FALLBACK_MAX_BYTES / 1024 / 1024}MB（${(size / 1024 / 1024).toFixed(0)}MB）：code=${err?.code ?? '?'} ${err?.message || ''}`);
          return;
        }
        const r = await electron.userpcFile.read(filePath, 'base64');
        const content: string | undefined = r?.data?.content;
        if (!r?.success || !content) {
          setError(r?.error || '回退读取音频失败');
          return;
        }
        const bin = atob(content);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const ext = filePath.split('.').pop()?.toLowerCase() || 'mp3';
        setSrc(URL.createObjectURL(new Blob([bytes], { type: MIME_MAP[ext] || 'audio/mpeg' })));
      } catch (e: any) {
        setError(`回退播放失败: ${e?.message || e}`);
      }
    })();
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-6 bg-gray-50 dark:bg-gray-900">
      <Music className="h-16 w-16 text-blue-400 mb-4" />
      <p className="text-sm text-gray-700 dark:text-gray-300 mb-4 truncate max-w-full">
        {fileName || filePath.split('/').pop()}
      </p>
      <audio
        ref={audioRef}
        src={src}
        controls
        onError={handleMediaError}
        className="w-full max-w-md"
      >
        您的浏览器不支持音频播放
      </audio>
    </div>
  );
};

export default AudioViewer;
