import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
 type Session = any;
import { ModelManager } from '@/utils/llm/ModelManager'; // 🔥 导入 ModelManager
import { CloudAuthService } from '@/services/cloud/CloudAuthService'; // 🔥 云端认证服务
import { offlineChannel, saveOfflineConfig } from '@/utils/auto/offline/offlineChannel'; // 🔥 离线指挥随登出停机

// 🔥 认证模式：仅支持 'cloud'（home-web 云端认证）
const AUTH_MODE = 'cloud' as const;

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  avatar_url?: string;
  phone?: string;
  is_member: boolean;
  is_admin: boolean;
  registrationDate: Date;
  usage_count: number;
  usage_limit: number;
  free_usage_count: number;
  member_until?: Date;
}

interface AuthContextType {
  user: UserProfile | null;
  session: Session | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authError: string | null;
  showAuthModal: boolean;
  authModalView: 'login' | 'register' | 'otp' | 'forgot-password' | 'reset-password';
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  registerWithOtp: (name: string, email: string, password: string) => Promise<void>;
  verifyOtp: (email: string, token: string) => Promise<void>;
  resendOtp: (email: string) => Promise<void>;
  forgotPassword: (email: string) => Promise<void>;
  resetPassword: (email: string, token: string, newPassword: string) => Promise<void>;
  verifyResetCode: (email: string, code: string) => Promise<boolean>;
  logout: () => Promise<void>;
  setShowAuthModal: (show: boolean) => void;
  setAuthModalView: (view: 'login' | 'register' | 'otp' | 'forgot-password' | 'reset-password') => void;
  refreshSession: () => Promise<void>;
  pendingEmail: string | null;
  pendingPassword: string | null;
  pendingResetEmail: string | null;
  pendingResetCode: string | null;
  setPendingResetCode: (code: string | null) => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  isAuthenticated: false,
  isLoading: true,
  authError: null,
  showAuthModal: false,
  authModalView: 'login',
  login: async () => {},
  register: async () => {},
  registerWithOtp: async () => {},
  verifyOtp: async () => {},
  resendOtp: async () => {},
  forgotPassword: async () => {},
  resetPassword: async () => {},
  verifyResetCode: async () => false,
  logout: async () => {},
  setShowAuthModal: () => {},
  setAuthModalView: () => {},
  refreshSession: async () => {},
  pendingEmail: null,
  pendingPassword: null,
  pendingResetEmail: null,
  pendingResetCode: null,
  setPendingResetCode: () => {},
});

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authModalView, setAuthModalView] = useState<'login' | 'register' | 'otp' | 'forgot-password' | 'reset-password'>('login');
  const [authError, setAuthError] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [pendingPassword, setPendingPassword] = useState<string | null>(null);
  const [pendingResetEmail, setPendingResetEmail] = useState<string | null>(null);
  const [pendingResetCode, setPendingResetCode] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;

    console.log('🔐 AuthProvider初始化开始 (Cloud 模式)');

    const initializeAuth = async () => {
      try {
        // 🔥 Cloud 模式：只检查 Cloud 登录状态
        console.log('🔄 检查 Cloud 登录状态');
        
        if (CloudAuthService.isLoggedIn()) {
          console.log('✅ Cloud 有 token，尝试恢复登录状态');
          
          // 🔥 先从本地缓存快速恢复用户，减少等待时间
          const cachedUser = localStorage.getItem('teegal-user');
          if (cachedUser) {
            try {
              const cloudUser = JSON.parse(cachedUser);
              const userProfile: UserProfile = {
                id: cloudUser.id.toString(),
                name: cloudUser.name,
                email: cloudUser.email,
                avatar_url: cloudUser.avatar_url,
                phone: cloudUser.phone,
                is_member: cloudUser.is_member,
                is_admin: cloudUser.is_admin,
                registrationDate: new Date(cloudUser.created_at),
                usage_count: cloudUser.usage_count,
                usage_limit: cloudUser.usage_limit,
                free_usage_count: cloudUser.free_usage_count,
                member_until: cloudUser.member_until ? new Date(cloudUser.member_until) : undefined,
              };

              if (mounted) {
                setUser(userProfile);
                setSession(null);
                setAuthError(null);
                console.log('✅ 从本地缓存恢复用户:', userProfile.email);
              }

              // 🔥 后台异步验证 token 并更新用户信息，同时初始化 ModelManager
              const profileResult = await CloudAuthService.getProfile();

              if (profileResult.success && profileResult.user) {
                const updatedUser = profileResult.user;
                const updatedProfile: UserProfile = {
                  id: updatedUser.id.toString(),
                  name: updatedUser.name,
                  email: updatedUser.email,
                  avatar_url: updatedUser.avatar_url,
                  phone: updatedUser.phone,
                  is_member: updatedUser.is_member,
                  is_admin: updatedUser.is_admin,
                  registrationDate: new Date(updatedUser.created_at),
                  usage_count: updatedUser.usage_count,
                  usage_limit: updatedUser.usage_limit,
                  free_usage_count: updatedUser.free_usage_count,
                  member_until: updatedUser.member_until ? new Date(updatedUser.member_until) : undefined,
                };

                if (mounted) {
                  setUser(updatedProfile);
                  localStorage.setItem('teegal-user', JSON.stringify(updatedUser));
                  console.log('✅ 更新用户信息:', updatedProfile.email);
                }

                // 🔥 初始化 ModelManager（必须完成才能加载数据）
                try {
                  await ModelManager.initialize(updatedProfile.id);
                  console.log('✅ ModelManager 初始化成功, userId:', updatedProfile.id);
                } catch (err) {
                  console.error('⚠️ ModelManager 初始化失败:', err);
                }
              } else {
                console.log('⚠️ Cloud token 无效，清除登录状态');
                CloudAuthService.logout();
                if (mounted) {
                  setUser(null);
                }
              }

              // 🔥 只有在 ModelManager 初始化完成后才结束 loading
              if (mounted) {
                setIsLoading(false);
              }

              return; // 🔥 已经处理完成，不需要继续执行
            } catch (e) {
              console.log('⚠️ 本地缓存解析失败，尝试网络请求');
            }
          }
          
          // 🔥 没有本地缓存，使用网络请求
          const profileResult = await CloudAuthService.getProfile();
          
          if (profileResult.success && profileResult.user) {
            console.log('✅ Cloud 登录状态恢复成功:', profileResult.user.email);
            const cloudUser = profileResult.user;
            const userProfile: UserProfile = {
              id: cloudUser.id.toString(),
              name: cloudUser.name,
              email: cloudUser.email,
              avatar_url: cloudUser.avatar_url,
              phone: cloudUser.phone,
              is_member: cloudUser.is_member,
              is_admin: cloudUser.is_admin,
              registrationDate: new Date(cloudUser.created_at),
              usage_count: cloudUser.usage_count,
              usage_limit: cloudUser.usage_limit,
              free_usage_count: cloudUser.free_usage_count,
              member_until: cloudUser.member_until ? new Date(cloudUser.member_until) : undefined,
            };
            
            if (mounted) {
              setUser(userProfile);
              setSession(null);
              setAuthError(null);
              localStorage.setItem('teegal-user', JSON.stringify(cloudUser));
            }
            
            // 🔥 初始化 ModelManager
            try {
              await ModelManager.initialize(userProfile.id);
              console.log('✅ ModelManager 初始化成功, userId:', userProfile.id);
            } catch (err) {
              console.error('⚠️ ModelManager 初始化失败:', err);
            }
          } else {
            console.log('⚠️ Cloud token 无效，清除登录状态');
            CloudAuthService.logout();
            if (mounted) {
              setUser(null);
            }
          }
        } else {
          console.log('ℹ️ Cloud 未登录');
          if (mounted) {
            setUser(null);
          }
        }
        
        if (mounted) {
          setIsLoading(false);
        }
      } catch (error) {
        console.error('❌ 认证初始化错误:', error);
        setAuthError('认证系统初始化失败: ' + (error as Error).message);
        if (mounted) {
          setUser(null);
          setIsLoading(false);
        }
      }
    };

    initializeAuth();

    return () => {
      mounted = false;
    };
  }, []);

  const refreshSession = async () => {
    console.log('🔄 手动刷新用户资料 (Cloud 模式)');
    setIsLoading(true);
    setAuthError(null);
    try {
      // Cloud 模式：直接获取最新用户信息
      const profileResult = await CloudAuthService.getProfile();
      if (profileResult.success && profileResult.user) {
        const cloudUser = profileResult.user;
        const userProfile: UserProfile = {
          id: cloudUser.id.toString(),
          name: cloudUser.name,
          email: cloudUser.email,
          avatar_url: cloudUser.avatar_url,
          phone: cloudUser.phone,
          is_member: cloudUser.is_member,
          is_admin: cloudUser.is_admin,
          registrationDate: new Date(cloudUser.created_at),
          usage_count: cloudUser.usage_count,
          usage_limit: cloudUser.usage_limit,
          free_usage_count: cloudUser.free_usage_count,
          member_until: cloudUser.member_until ? new Date(cloudUser.member_until) : undefined,
        };
        setUser(userProfile);
        
        // 🔥 更新 localStorage 中的用户信息
        localStorage.setItem('teegal-user', JSON.stringify(cloudUser));
      } else {
        // Token 无效，退出登录
        console.log('⚠️ 刷新失败，token 无效');
        CloudAuthService.logout();
        setUser(null);
        setAuthError('登录已过期，请重新登录');
      }
    } catch (error) {
      console.error('❌ 刷新用户资料时出错:', error);
      setAuthError('刷新用户资料时出错: ' + (error as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (email: string, password: string) => {
    console.log('🔐 开始登录流程 (Cloud 模式)');
    setIsLoading(true);
    setAuthError(null);
    try {
      // 🔥 仅使用云端认证
      const cloudResult = await CloudAuthService.login({ email: email.trim(), password });
      if (!cloudResult.success) {
        throw new Error(cloudResult.error || '登录失败');
      }
      // 云端登录成功，创建本地用户状态
      if (cloudResult.user) {
        const userProfile: UserProfile = {
          id: cloudResult.user.id.toString(),
          name: cloudResult.user.name,
          email: cloudResult.user.email,
          avatar_url: cloudResult.user.avatar_url,
          phone: cloudResult.user.phone,
          is_member: cloudResult.user.is_member,
          is_admin: cloudResult.user.is_admin,
          registrationDate: new Date(cloudResult.user.created_at),
          usage_count: cloudResult.user.usage_count,
          usage_limit: cloudResult.user.usage_limit,
          free_usage_count: cloudResult.user.free_usage_count,
          member_until: cloudResult.user.member_until ? new Date(cloudResult.user.member_until) : undefined,
        };
        console.log('🔐 [AuthContext] 登录成功，设置用户:', userProfile);
        setUser(userProfile);
        setSession(null); // Cloud 模式无 session 对象
        
        // 🔥 初始化 ModelManager
        try {
          await ModelManager.initialize(userProfile.id);
          console.log('✅ ModelManager 初始化成功, userId:', userProfile.id);
        } catch (err) {
          console.error('⚠️ ModelManager 初始化失败:', err);
        }
      }
      
      toast.success('登录成功！');
      setShowAuthModal(false);
      setIsLoading(false); // 🔥 登录成功后重置加载状态
    } catch (error: any) {
      console.error('❌ 登录失败:', error);
      const errorMessage = error.message || '登录失败，请检查您的凭据并重试。';
      toast.error(errorMessage);
      setAuthError(errorMessage);
      setIsLoading(false);
      throw error;
    }
  };

  const register = async (name: string, email: string, password: string) => {
    setIsLoading(true);
    setAuthError(null);
    try {
      if (AUTH_MODE === 'cloud') {
        // 🔥 仅使用云端注册
        const cloudResult = await CloudAuthService.register({ 
          email: email.trim(), 
          password, 
          name: name.trim() 
        });
        
        if (!cloudResult.success) {
          throw new Error(cloudResult.error || '注册失败');
        }
        
        // 云端注册成功，自动登录
        if (cloudResult.accessToken && cloudResult.user) {
          const userProfile: UserProfile = {
            id: cloudResult.user.id.toString(),
            name: cloudResult.user.name,
            email: cloudResult.user.email,
            avatar_url: cloudResult.user.avatar_url,
            phone: cloudResult.user.phone,
            is_member: cloudResult.user.is_member,
            is_admin: cloudResult.user.is_admin,
            registrationDate: new Date(cloudResult.user.created_at),
            usage_count: cloudResult.user.usage_count,
            usage_limit: cloudResult.user.usage_limit,
            free_usage_count: cloudResult.user.free_usage_count,
            member_until: cloudResult.user.member_until ? new Date(cloudResult.user.member_until) : undefined,
          };
          setUser(userProfile);
          setSession(null);
        }
        
        toast.success('注册成功！');
      }
      
      setShowAuthModal(false);
    } catch (error: any) {
      console.error('❌ 注册失败:', error);
      const errorMessage = error.message || '注册失败，请重试。';
      toast.error(errorMessage);
      setAuthError(errorMessage);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const registerWithOtp = async (name: string, email: string, password: string) => {
    setIsLoading(true);
    setAuthError(null);
    try {
      console.log('🔐 发送验证码到:', email);
      
      // 🔥 使用 home-web 后端发送 OTP
      const result = await CloudAuthService.sendOtp(email.trim(), name.trim(), 'register');
      
      if (!result.success) {
        throw new Error(result.error || '发送验证码失败');
      }
      
      setPendingEmail(email.trim());
      setPendingPassword(password);
      setAuthModalView('otp');
      toast.success('验证码已发送到您的邮箱');
      console.log('✅ Cloud 验证码发送成功');
    } catch (error: any) {
      console.error('❌ 发送验证码失败:', error);
      const errorMessage = error.message || '发送验证码失败，请重试。';
      toast.error(errorMessage);
      setAuthError(errorMessage);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const verifyOtp = async (email: string, token: string) => {
    setIsLoading(true);
    setAuthError(null);
    try {
      console.log('🔐 验证OTP:', { email, token });
      
      // 🔥 使用 home-web 后端验证 OTP
      const cloudResult = await CloudAuthService.verifyOtp(email.trim(), token.trim(), 'register');
      
      if (!cloudResult.success) {
        throw new Error(cloudResult.error || 'OTP验证失败');
      }
      
      // 验证成功后，先注册用户，再登录
      if (pendingPassword) {
        // 🔥 先注册用户
        const name = email.split('@')[0];
        const registerResult = await CloudAuthService.register({
          email: email.trim(),
          password: pendingPassword,
          name: name
        });
        
        if (!registerResult.success) {
          throw new Error(registerResult.error || '注册失败');
        }
        
        // 再登录
        const loginResult = await CloudAuthService.login({
          email: email.trim(),
          password: pendingPassword
        });
        
        if (!loginResult.success) {
          throw new Error(loginResult.error || '登录失败');
        }
        
        // 设置用户状态
        if (loginResult.user) {
          const userProfile: UserProfile = {
            id: loginResult.user.id.toString(),
            name: loginResult.user.name,
            email: loginResult.user.email,
            avatar_url: loginResult.user.avatar_url,
            phone: loginResult.user.phone,
            is_member: loginResult.user.is_member,
            is_admin: loginResult.user.is_admin,
            registrationDate: new Date(loginResult.user.created_at),
            usage_count: loginResult.user.usage_count,
            usage_limit: loginResult.user.usage_limit,
            free_usage_count: loginResult.user.free_usage_count,
            member_until: loginResult.user.member_until ? new Date(loginResult.user.member_until) : undefined,
          };
          setUser(userProfile);
          setSession(null);
        }
        
        toast.success('验证成功，已自动登录');
        setShowAuthModal(false);
        setPendingEmail(null);
        setPendingPassword(null);
        console.log('✅ Cloud OTP验证、注册并自动登录成功');
      } else {
        toast.success('验证成功，请登录');
        setAuthModalView('login');
      }
    } catch (error: any) {
      console.error('❌ OTP验证失败:', error);
      const errorMessage = error.message || 'OTP验证失败，请重试。';
      toast.error(errorMessage);
      setAuthError(errorMessage);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const resendOtp = async (email: string) => {
    try {
      console.log('🔄 重新发送验证码到:', email);
      
      // 从pendingEmail或其他地方获取用户名
      const userName = email.split('@')[0];
      
      // 🔥 使用 home-web 后端发送 OTP
      const result = await CloudAuthService.sendOtp(email.trim(), userName, 'register');
      
      if (!result.success) {
        throw new Error(result.error || '重新发送验证码失败');
      }
      
      toast.success('验证码已重新发送');
      console.log('✅ Cloud 验证码重新发送成功');
    } catch (error: any) {
      console.error('❌ 重新发送OTP失败:', error);
      const errorMessage = error.message || '重新发送验证码失败，请重试。';
      toast.error(errorMessage);
      throw error;
    }
  };

  const forgotPassword = async (email: string) => {
    setIsLoading(true);
    setAuthError(null);
    try {
      console.log('🔄 发送忘记密码验证码到:', email);
      
      // 🔥 使用 home-web 后端发送重置密码 OTP
      const result = await CloudAuthService.sendOtp(email.trim(), email.split('@')[0], 'reset_password');
      
      if (!result.success) {
        throw new Error(result.error || '发送重置密码验证码失败');
      }
      
      setPendingResetEmail(email.trim());
      setAuthModalView('otp');
      toast.success('重置密码验证码已发送到您的邮箱');
      console.log('✅ Cloud 重置密码验证码发送成功');
    } catch (error: any) {
      console.error('❌ 发送重置密码验证码失败:', error);
      const errorMessage = error.message || '发送重置密码验证码失败，请重试。';
      toast.error(errorMessage);
      setAuthError(errorMessage);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const resetPassword = async (email: string, token: string, newPassword: string) => {
    setIsLoading(true);
    setAuthError(null);
    try {
      console.log('🔄 重置密码:', { email, token });
      
      // 🔥 使用 home-web 后端重置密码
      const result = await CloudAuthService.resetPassword(email.trim(), newPassword, token.trim());
      
      if (!result.success) {
        throw new Error(result.error || '密码重置失败');
      }
      
      toast.success('密码重置成功！请使用新密码登录');
      setShowAuthModal(false);
      setPendingResetEmail(null);
      setPendingResetCode(null);
      setAuthModalView('login');
      console.log('✅ Cloud 密码重置成功');
    } catch (error: any) {
      console.error('❌ 密码重置失败:', error);
      const errorMessage = error.message || '密码重置失败，请重试。';
      setAuthError(errorMessage);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * 验证重置密码验证码
   */
  const verifyResetCode = async (email: string, code: string): Promise<boolean> => {
    try {
      console.log('🔐 验证重置密码验证码:', { email, code });
      
      // 🔥 使用 home-web 后端验证
      const result = await CloudAuthService.verifyOtp(email.trim(), code.trim(), 'reset_password');
      
      if (!result.success) {
        throw new Error(result.error || '验证码验证失败');
      }
      
      console.log('✅ Cloud 重置密码验证码验证成功');
      return true;
    } catch (error: any) {
      console.error('❌ 验证重置密码验证码失败:', error);
      throw error;
    }
  };

  const logout = async () => {
    if (isLoggingOut) {
      console.log('🔄 退出登录已在进行中，忽略重复调用');
      return;
    }

    console.log('🚪 开始退出登录流程 (Cloud 模式)');
    setIsLoggingOut(true);
    setAuthError(null);
    
    try {
      // 🔥 云端退出（先清除 token）
      CloudAuthService.logout();
      console.log('✅ 云端退出完成');

      // 🔥 清空模型管理器的用户态（模型列表/绑定配置/搜索源缓存），
      //    防止切换账号后残留上一用户的模型绑定关系
      ModelManager.setUserId(null);

      // 🔥 离线指挥随登出停止并清除本地配置：换账号登录后开关回归"关"，
      //    新账号重新开启才会走 register + 握手信（防沿用上一账号的通道收信执行）
      offlineChannel.stop();
      saveOfflineConfig(null);

      // 🔥 清除本地状态
      setUser(null);
      setSession(null);

      // 🔥 重置认证模态框状态
      setAuthModalView('login');
      setPendingEmail(null);
      setPendingPassword(null);
      setPendingResetEmail(null);
      setPendingResetCode(null);

      // 🔥 关键：重置加载状态，允许用户重新登录
      setIsLoading(false);

      // 🔥 显示登录模态框
      setShowAuthModal(true);

      toast.success('已安全退出');
    } catch (error: any) {
      console.error('❌ logout 函数内部错误:', error);
      // 🔥 即使出错也清除本地状态
      setUser(null);
      setSession(null);
      // 🔥 关键：重置加载状态
      setIsLoading(false);
      toast.error('退出操作时发生意外错误。');
      setAuthError('退出操作时发生意外错误: ' + error.message);
    } finally {
      setIsLoggingOut(false);
    }
  };

  // Cloud 模式：只看 user 状态
  const isAuthenticated = !!user;

  const handleSetShowAuthModal = (show: boolean) => {
    console.log('🔓 设置认证模态框状态:', show);
    if (show) {
      setAuthError(null);
    } else {
      setPendingEmail(null);
      setPendingPassword(null);
      setPendingResetEmail(null);
      setPendingResetCode(null);
      setAuthModalView('login');
    }
    setShowAuthModal(show);
  };

  const contextValue: AuthContextType = {
    user,
    session,
    isAuthenticated,
    isLoading,
    authError,
    login,
    register,
    registerWithOtp,
    verifyOtp,
    resendOtp,
    forgotPassword,
    resetPassword,
    verifyResetCode,
    logout,
    showAuthModal,
    setShowAuthModal: handleSetShowAuthModal,
    authModalView,
    setAuthModalView,
    refreshSession,
    pendingEmail,
    pendingPassword,
    pendingResetEmail,
    pendingResetCode,
    setPendingResetCode
  };

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
