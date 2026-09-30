import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { PlusSquare } from 'lucide-react';
import { useDesktopApp } from '@/hooks/workspace/desktopapp/useDesktopApp';
import { useAuth } from '@/context/AuthContext';
import { toast } from 'sonner';
import { desktopAppEventService } from '@/services/events/DesktopAppEventService';

const isElectron = typeof window !== 'undefined' && !!(window as any).electron;

interface QuickCreateAppProps {
  disabled?: boolean;
}

export const QuickCreateApp: React.FC<QuickCreateAppProps> = ({ disabled = false }) => {
  const { user } = useAuth();
  const { createApp } = useDesktopApp(user?.id);
  const [isCreatingApp, setIsCreatingApp] = useState(false);

  const handleCreateBlankApp = async () => {
    if (!user?.id) {
      toast.error('请先登录');
      return;
    }

    setIsCreatingApp(true);
    try {
      const timestamp = new Date().toLocaleTimeString();
      const newApp = await createApp({
        name: `新项目 ${timestamp} 🌈`,
        description: '通过快捷按钮创建的空白项目',
        current_code: '',
        code: '',
        preview: '',
        config: {}
      });

      if (newApp) {
        toast.success('空白项目创建成功');
        desktopAppEventService.emitAppCreated(newApp.id, user.id, newApp);
      } else {
        toast.error('应用创建失败：无法连接本地服务，请重启应用');
      }
    } catch (error) {
      console.error('Failed to create app:', error);
      const msg = error instanceof Error ? error.message : '创建过程中出错';
      toast.error(msg.includes('fetch') || msg.includes('Failed to fetch')
        ? '无法连接本地服务，请重启应用'
        : msg);
    } finally {
      setIsCreatingApp(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCreateBlankApp}
      disabled={disabled || isCreatingApp}
      title="创建空白应用"
      className="h-7 w-7 p-0"
      style={isElectron ? { WebkitAppRegion: 'no-drag' } as React.CSSProperties : {}}
    >
      {isCreatingApp ? (
        <div className="h-4 w-4 border-2 border-gray-300 border-t-blue-600 rounded-full animate-spin" />
      ) : (
        <PlusSquare className="h-4 w-4" />
      )}
    </Button>
  );
};
