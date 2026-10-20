import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Loader2, Mail, Radio } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { OfflineCommandApi } from '@/services/cloud/OfflineCommandApi';
import { loadOfflineConfig, saveOfflineConfig, offlineChannel, type OfflineLocalConfig } from '@/utils/auto/offline/offlineChannel';
import { logger } from '@/utils/logger';

interface OfflineCommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 🔥 离线指挥设置：邮件远程指挥本地 agent
 * 极简面板：登记收发邮箱 + 保存 + 启用开关。指令地址不展示——
 * 启用后云端握手信直接发到登记邮箱，回复那封信即是指令。
 */
export const OfflineCommandDialog: React.FC<OfflineCommandDialogProps> = ({ open, onOpenChange }) => {
  const { user } = useAuth();
  const [config, setConfig] = useState<OfflineLocalConfig | null>(null);
  const [senderEmail, setSenderEmail] = useState(''); // 登记的收发邮箱
  const [loading, setLoading] = useState(false);      // 启用开关进行中
  const [saving, setSaving] = useState(false);        // 保存邮箱进行中
  const [phase, setPhase] = useState(offlineChannel.phase);

  useEffect(() => {
    if (!open) return;
    setConfig(loadOfflineConfig(user?.id)); // 归属校验：只显示当前账号开启的配置
    setPhase(offlineChannel.phase);
    const onStatus = () => setPhase(offlineChannel.phase);
    window.addEventListener('offline-channel-status', onStatus);

    // 打开即拉云端白名单：默认注册邮箱（未登记过时）
    (async () => {
      try {
        const cfg = await OfflineCommandApi.getConfig();
        const first = (cfg.whitelist || [])[0];
        if (first) setSenderEmail(first);
        else if (user?.email) setSenderEmail(user.email);
      } catch (e: any) {
        logger.warn('[OFFLINE-UI] 配置拉取失败:', e?.message);
        if (user?.email) setSenderEmail((s) => s || user.email);
      }
    })();

    return () => window.removeEventListener('offline-channel-status', onStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 启用开关：启用 = 分配地址 + 启动监听 + 同步登记邮箱；停用 = 关通道（云端保留配置） */
  const handleToggle = async (enabled: boolean) => {
    if (!user) {
      toast.error('请先登录后再启用离线指挥');
      return;
    }
    setLoading(true);
    try {
      if (enabled) {
        const r = await OfflineCommandApi.register();
        const cfg: OfflineLocalConfig = { enabled: true, addr: r.addr, token: r.token, userId: user.id };
        saveOfflineConfig(cfg);
        setConfig(cfg);
        // 顺手同步面板里登记的邮箱（与云端不同才提交）
        const email = senderEmail.trim().toLowerCase();
        if (email && EMAIL_RE.test(email) && !(r.whitelist || []).includes(email)) {
          await OfflineCommandApi.setWhitelist([email]);
        }
        toast.success('离线指挥已启用，握手邮件已发送到登记邮箱');
      } else {
        await OfflineCommandApi.disable();
        saveOfflineConfig({ ...(config || { addr: '', token: '' }), enabled: false });
        setConfig((c) => (c ? { ...c, enabled: false } : c));
        toast.success('离线指挥已停用');
      }
    } catch (e: any) {
      toast.error(e?.message || '操作失败');
    } finally {
      setLoading(false);
    }
  };

  /** 保存登记邮箱到云端白名单 */
  const saveSender = async () => {
    const email = senderEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      toast.error('请输入有效邮箱地址');
      return;
    }
    if (!config?.addr) {
      toast.error('请先启用离线指挥');
      return;
    }
    setSaving(true);
    try {
      await OfflineCommandApi.setWhitelist([email]);
      toast.success('已保存');
    } catch (e: any) {
      toast.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            离线指挥
            {config?.enabled && (
              <Badge
                variant="outline"
                title={phase === 'executing' ? '正在执行邮件指令' : '离线指挥已连接'}
                className="ml-1 h-4 w-4 p-0"
              >
                <Radio className={`h-3 w-3 ${phase === 'executing' ? 'animate-pulse text-blue-500' : 'text-green-500'}`} />
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* 登记收发邮箱 */}
          <div>
            <div className="text-sm font-medium mb-1.5">登记您的信息收发邮箱</div>
            <Input
              placeholder="默认注册邮箱，可修改"
              value={senderEmail}
              onChange={(e) => setSenderEmail(e.target.value)}
              className="h-9"
            />
            {/* QQ 邮箱的会话聚合藏在体验室里，不开会拆散多轮对话；网易/Gmail 默认聚合无需提示 */}
            {/@qq\.com$/i.test(senderEmail.trim()) && (
              <div className="text-xs text-muted-foreground mt-1.5">
                建议在 QQ 邮箱 设置 → 开启「会话模式」，多轮对话更直观
              </div>
            )}
          </div>

          {/* 底部操作行：保存 + 启用开关 */}
          <div className="flex items-center justify-between pt-3 border-t">
            <Button variant="outline" size="sm" onClick={saveSender} disabled={saving || !config?.addr}>
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              保存
            </Button>
            <div className="flex items-center gap-2">
              <span className="text-sm">启用</span>
              <Switch
                checked={!!config?.enabled}
                onCheckedChange={handleToggle}
                disabled={loading || !user}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
