import React, { useState, useEffect } from 'react';
import { Mail } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { loadOfflineConfig, offlineChannel, getTodayCount, type OfflinePhase } from '@/utils/auto/offline/offlineChannel';

/**
 * 🔥 离线指挥状态徽标（聊天输入框左下角）：
 * 灰=未启用 / 绿=监听中 / 黄=执行中。点击回调 onOpen 打开设置弹窗（弹窗挂 OptimizedChatInput）。
 */
const OfflineStatusBadge: React.FC<{ onOpen?: () => void }> = ({ onOpen }) => {
  const { user } = useAuth();
  const [phase, setPhase] = useState<OfflinePhase>(offlineChannel.phase);
  const [todayCount, setTodayCount] = useState(0);

  useEffect(() => {
    const sync = () => {
      // 归属校验：只显示当前账号开启的配置（防切换账号沿用上一账号的徽标状态）
      setPhase(loadOfflineConfig(user?.id)?.enabled ? offlineChannel.phase : 'off');
      setTodayCount(getTodayCount());
    };
    sync();
    window.addEventListener('offline-channel-status', sync);
    window.addEventListener('offline-config-changed', sync);
    return () => {
      window.removeEventListener('offline-channel-status', sync);
      window.removeEventListener('offline-config-changed', sync);
    };
  }, [user?.id]);

  const title = phase === 'off'
    ? '离线指挥（未启用）'
    : phase === 'listening'
      ? '离线指挥：监听中，等待邮件指令'
      : `离线指挥：正在执行邮件指令（今日已完成 ${todayCount} 条）`;

  return (
    <button
      onClick={() => onOpen?.()}
      title={title}
      className="h-8 w-8 p-0 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100"
    >
      {/* 🔥 执行中只是变色（琥珀=忙），不换 spinner 图标——本地机子自己运作，不是"加载中" */}
      {phase === 'executing' ? (
        <Mail size={16} className="text-amber-500" />
      ) : phase === 'listening' ? (
        <span className="relative inline-flex">
          <Mail size={16} className="text-green-600" />
          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-green-500" />
        </span>
      ) : (
        <Mail size={16} className="text-gray-300" />
      )}
    </button>
  );
};

export default OfflineStatusBadge;
