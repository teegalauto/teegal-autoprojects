/**
 * ImageViewer - 本地图片文件预览组件
 *
 * 支持：jpg/jpeg/png/gif/webp/bmp/svg
 * 通过 electron IPC 读取本地文件为 Blob URL 渲染
 */

import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';

/** 判断文件扩展名是否为图片文件 */
export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
}

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

interface ImageViewerProps {
  filePath: string;
  fileName?: string;
}

export const ImageViewer: React.FC<ImageViewerProps> = ({ filePath, fileName }) => {
  const [src, setSrc] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    // 🔥 本地文件走 teegal-file:// 流式协议：字节不过 IPC、不做 base64 放大，
    // 大图片由 Chromium 按需解码，无需大小门禁
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

    // 先探存再给 src：返回结构为 { success, data: { exists } }，img 元素自身处理解码错误
    electron.userpcFile.exists(filePath).then((r: any) => {
      if (!r?.data?.exists) {
        setError(`文件不存在: ${filePath}`);
      } else {
        setSrc(`teegal-file://local/${encodeURIComponent(filePath)}`);
      }
      setLoading(false);
    }).catch(() => {
      setError('加载图片失败');
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

  return (
    <div className="flex items-center justify-center h-full bg-gray-900 overflow-auto p-4">
      <img
        src={src}
        alt={fileName || filePath}
        className="max-w-full max-h-full object-contain"
      />
    </div>
  );
};
