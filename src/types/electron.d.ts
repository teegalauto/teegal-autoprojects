/**
 * Electron API 类型声明
 */

declare global {
  interface Window {
    electron?: {
      updater?: {
        check: () => Promise<{ success: boolean; updateInfo?: any; error?: string }>;
        install: () => Promise<{ success: boolean; error?: string }>;
        getStatus: () => Promise<{ status: string; progress: number }>;
        onUpdateAvailable: (callback: (event: any, data: any) => void) => void;
        onUpdateProgress: (callback: (event: any, data: any) => void) => void;
        onUpdateReady: (callback: (event: any, data: any) => void) => void;
        onUpdateInstalling: (callback: (event: any, data: any) => void) => void;
        onUpdateError: (callback: (event: any, data: any) => void) => void;
      };
      getAppVersion?: () => Promise<string>;
      getUserDataPath?: () => Promise<string>;
      setOfflinePowerSave?: (on: boolean) => Promise<void>;
      systemCommand?: (options: { command: string; timeout?: number; workingDir?: string }) => Promise<{ success: boolean; message?: string; error?: string }>;
    };
  }
}

export {};
