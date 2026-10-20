import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

const resources = {
  en: {
    translation: {
      auth: {
        login: {
          title: "Login",
          email: "Email",
          password: "Password",
          emailPlaceholder: "Please enter your email",
          passwordPlaceholder: "Please enter your password",
          loginButton: "Login",
          loginButtonLoading: "Logging in...",
          forgotPassword: "Forgot password?",
          emailError: "Please enter a valid email address",
          passwordError: "Password must be at least 6 characters"
        },
        register: {
          title: "Register",
          name: "Nickname",
          email: "Email",
          password: "Password",
          confirmPassword: "Confirm Password",
          namePlaceholder: "Please enter your nickname",
          emailPlaceholder: "Please enter your email",
          passwordPlaceholder: "At least 8 characters, including uppercase, lowercase letters and numbers",
          confirmPasswordPlaceholder: "Please enter your password again",
          registerButton: "Register (Send Verification Code)",
          registerButtonLoading: "Sending verification code...",
          nameError: "Nickname must be at least 2 characters",
          nameMaxError: "Nickname cannot exceed 50 characters",
          nameFormatError: "Nickname can only contain Chinese, English, numbers, underscores and hyphens",
          emailError: "Please enter a valid email address",
          emailMaxError: "Email address cannot exceed 100 characters",
          passwordError: "Password must be at least 8 characters",
          passwordMaxError: "Password cannot exceed 100 characters",
          passwordFormatError: "Password must contain at least one uppercase letter, one lowercase letter and one number",
          confirmPasswordError: "Confirm password must be at least 8 characters",
          passwordMismatchError: "The two passwords entered do not match",
          agreeToTermsError: "Please read and agree to the Terms of Service and Privacy Policy",
          agreeToTermsText: "I have read and agree to the",
          termsOfService: "Terms of Service",
          and: "and",
          privacyPolicy: "Privacy Policy"
        },
        otp: {
          registerTitle: "Verify Email",
          resetTitle: "Verify Password Reset",
          subtitle: "We have sent a 6-digit verification code to {email}",
          verificationCode: "Verification Code",
          verifyButton: "Verify",
          verifyButtonLoading: "Verifying...",
          resendCode: "Resend Verification Code",
          resendCountdown: "Resend available in {seconds} seconds",
          backToRegister: "Back to Register",
          backToForgotPassword: "Back to Forgot Password",
          otpError: "Please enter a 6-digit verification code",
          verifySuccess: "Verification successful!",
          verifyError: "Verification code is incorrect, please try again",
          resendSuccess: "Verification code has been resent",
          resendError: "Failed to resend, please try again later",
          resetVerifySuccess: "Verification code verified successfully, please set a new password",
          title: "Verification"
        },
        forgotPassword: {
          title: "Forgot Password",
          subtitle: "Please enter your email address, we will send a verification code to your email",
          email: "Email",
          emailPlaceholder: "Please enter your email",
          sendButton: "Send Verification Code",
          sendButtonLoading: "Sending...",
          backToLogin: "Back to Login",
          emailError: "Please enter a valid email address"
        },
        resetPassword: {
          title: "Set New Password",
          subtitle: "Please enter your new password",
          newPassword: "New Password",
          confirmPassword: "Confirm New Password",
          newPasswordPlaceholder: "At least 8 characters, including uppercase, lowercase letters and numbers",
          confirmPasswordPlaceholder: "Please enter your new password again",
          resetButton: "Reset Password",
          resetButtonLoading: "Resetting...",
          backToVerification: "Back to Verification Code Entry",
          passwordError: "Password must be at least 8 characters",
          passwordMaxError: "Password cannot exceed 100 characters",
          passwordFormatError: "Password must contain at least one uppercase letter, one lowercase letter and one number",
          confirmPasswordError: "Confirm password must be at least 8 characters",
          passwordMismatchError: "The two passwords entered do not match",
          resetSuccess: "Password reset successful! Please log in with your new password",
          resetError: "Password reset failed, please try again"
        },
        modal: {
          description: "Please log in to continue"
        }
      },
      workspace: {
        historyPanel: {
          title: "History",
          loadingMore: "Loading...",
          loadMore: "Load More",
          noMoreHistory: "All history records displayed",
          execution: "Executing",
          files: "Contains {count} files",
          noFiles: "No files",
          markImportant: "Mark as Important Conversation",
          unmarkImportant: "Unmark as Important Conversation",
          broadcast: "Broadcast"
        },
        chatMessages: {
          greeting: "HI, tell me your requirements",
          initializing: "Initializing...",
          analyzing: "Thinking",
          analysisComplete: "Thinking complete",
          analysisFailed: "Thinking failed",
          waitingReply: "Waiting for reply"
        },
        chatInput: {
          placeholder: "Please enter your requirements...",
          datasetRefPrompt: "Please build a training project based on this dataset."
        },
        chatHeader: {
          title: "Chat",
          newChat: "New Chat",
          projects: "Projects",
          files: "Files",
          recharge: "Recharge",
          languagePreference: "Language",
          customModels: "Custom Models",
          credentialManager: "Credentials",
          checkUpdate: "Check Update",
          checking: "Checking...",
          logout: "Log Out",
          loginRegister: "Sign In / Sign Up",
          defaultUserName: "User"
        },
        workspaceGrid: {
          projectsTitle: "Projects",
          filesTitle: "Files",
          filterAll: "All",
          filterNormal: "Normal",
          filterSystemBase: "System Projects"
        },
        messageContent: {
          preview: "Preview",
          browser: "Browser",
          open: "Open",
          openInFolder: "Open in folder: {path}",
          previewImage: "Preview image: {path}",
          openInBrowser: "Open in browser: {path}",
          openInDesktop: "Open in Desktop: {path}",
          copyPath: "Copy path: {path}",
          trainingRunning: "Training in progress...",
          instanceCreating: "Creating instance...",
          appRunning: "App running...",
          trainingLongTime: "Training takes a while, you can continue other operations in chat",
          executeComplete: "Completed",
          executeFailed: "Failed",
          taskId: "Task ID",
          gpuSpec: "GPU Type",
          executionTime: "Execution Time"
        },
        mediaViewer: {
          image: {
            title: "Image Viewer",
            download: "Download",
            openNewWindow: "Open in New Window",
            copyLink: "Copy Link",
            zoomIn: "Zoom In",
            zoomOut: "Zoom Out",
            resetZoom: "Reset Zoom"
          },
          audio: {
            download: "Download",
            play: "Play",
            pause: "Pause",
            mute: "Mute",
            unmute: "Unmute",
            loading: "Loading...",
            unknownDuration: "Unknown duration"
          },
          document: {
            download: "Download",
            downloadAndOpenInSoftware: "Please download and open with appropriate software",
            downloadFile: "Download File",
            preview: "Preview",
            unableToPreviewPDF: "Unable to preview this PDF file",
            unsupportedOnlinePreview: "Online preview not supported for this document type"
          },
          ppt: {
            download: "Download",
            downloadFile: "Download File",
            googleDocsViewerCannotAccessFile: "Google Docs Viewer cannot access this file",
            onlinePreviewFailed: "Online preview failed",
            openInNewWindow: "Open in New Window",
            pptFile: "PPT File",
            pptFileRequiresDownload: "This PPT file needs to be downloaded and opened with PowerPoint or other compatible software"
          }
        },
        desktopModule: {
          codeEditor: {
            running: "Running...",
            saved: "Saved",
            saveFailed: "Save failed",
            executionResult: "Execution Result",
            cancel: "Cancel",
            loading: "Loading...",
            success: "Execution Successful",
            error: "Execution Error"
          },
          desktopAppViewer: {
            appUpdated: "Application updated successfully",
            errorOccurred: "An error occurred",
            unsupportedFileType: "This file type is not supported for inline preview",
            noAppsFound: "Create GPU Training Tasks",
            loadingApps: "Loading more...",
            appDetails: "Application Details",
            trainingHistory: "Training History",
            backToList: "Back to List",
            resourceAdjustmentWait: "Resource adjustment may occur, do not close",
            instanceCreatingWait: "Creating GPU instance, please wait...",
            trainingProgressWait: "Training in progress, you can close and check results later",
            noTrainingHistory: "No training history",
            trainingSuccess: "Training Success",
            trainingFailed: "Training Failed",
            trainingInProgress: "Training...",
            trainingTask: "Training Task",
            viewDetails: "View Details",
            defaultAppName: "Application",
            writeCodeFirst: "Please write some code first",
            devServerStarted: "Dev server started",
            clickToVisit: "Click to visit: {url}",
            openBrowser: "Open Browser",
            stopService: "Stop the dev server and release the port",
            serviceStopped: "Dev server stopped, resources released",
            backgroundTaskRunning: "A task is still running in the background, the result will be recorded when it finishes",
            executeSuccess: "Execution Successful",
            executeSuccessNoOutput: "Executed successfully, no output",
            executeFailed: "Execution Failed",
            executeException: "Execution Error",
            invalidResultFormat: "Invalid execution result format",
            envMissingTitle: "{env} is not installed on this computer, local execution blocked",
            envMissingDesc: "Installation request is ready, please return to chat and press send",
            trainingStopped: "Training Stopped",
            trainingStoppedDesc: "Cloud instance released, billing stopped",
            stopFailed: "Failed to stop",
            unknownError: "Unknown error",
            historyEmpty: "History version content is empty",
            viewHistoryVersion: "Viewing history version: {fileName}",
            saveFailed: "Save failed",
            hideFileTree: "Hide file tree",
            showFileTree: "Show file tree",
            openInBrowser: "Open in browser",
            save: "Save",
            stopTraining: "Stop Training",
            cloudTraining: "Cloud Run",
            executing: "Executing...",
            localExecute: "Run Locally",
            close: "Close",
            halfHalf: "Half & Half",
            codeMax: "Maximize Code",
            previewMax: "Maximize Preview",
            selectFileFromTree: "Select a file from the file tree on the left",
            orCreateNew: "or click + to create a new file",
            executionLog: "Execution Log ({count})",
            rechargeSuccess: "Recharge successful",
            rechargeSuccessDesc: "Balance updated, you can continue GPU training",
            gpuWarningTitle: "Not recommended to run GPU code on CPU",
            gpuWarningDefault: "Deep learning components detected in the code",
            gpuWarningDesc: "Local environments usually lack GPU and CUDA support. Such code may fail due to missing dependencies or run extremely slowly. Cloud GPU training is recommended.",
            cancel: "Cancel",
            stillExecute: "Execute Anyway",
            killConfirmDesc: "Are you sure you want to stop the running GPU training task? The cloud instance will be released and no longer billed.",
            killReasonPlaceholder: "Enter stop reason (optional)",
            stopping: "Stopping...",
            confirmStop: "Confirm Stop"
          },
          desktopPanel: {
            files: "Files",
            referenceApp: "Reference this app",
            splitVersion: "Split Version",
            systemProjectNoDelete: "System project cannot be deleted, but you can freely modify files within the project",
            systemProjectTitle: "System project, cannot be deleted",
            fileViewerTitle: "File Viewer"
          },
          fileTree: {
            copyFullPath: "Copy full path",
            copyRelativePath: "Copy relative path",
            delete: "Delete",
            rename: "Rename",
            copiedFullPath: "Full path copied",
            copiedRelativePath: "Relative path copied",
            hasHistoryVersion: "Has history versions (modified)",
            loadingTree: "Loading file tree...",
            retry: "Retry",
            currentFiles: "Current Files",
            importProject: "Import project",
            newFile: "New file",
            newFolder: "New folder",
            cancelImport: "Cancel import",
            fileNamePlaceholder: "File name",
            folderNamePlaceholder: "Folder name",
            noFiles: "No files",
            noFilesHint: "Click + to create a file",
            selectProjectFolder: "Select project folder",
            importSuccessTitle: "Import successful",
            importFailedTitle: "Import failed",
            importFailedDesc: "Failed to save the binding. The backend service may not be ready. Please retry in a few seconds.",
            openFileLocation: "Open file location",
            fileTooLargeTitle: "File too large to preview",
            fileTooLargeDesc: "Only files up to 2MB are previewed (current: {{size}})",
            changeHistory: "Changes",
            acceptAll: "Accept All",
            noChanges: "No changes",
            acceptCurrent: "Accept current version",
            revertToPrevious: "Revert to previous version"
          },
          previewViewer: {
            title: "Live preview",
            duration: "Duration",
            cost: "Cost",
            downloadModel: "Download Model",
            fromCloud: "From Cloud",
            downloadFile: "Download File",
            download: "Download",
            starting: "Starting..."
          },
          chartRenderer: {
            title: "Chart Renderer"
          },
          gpuTrainingStatus: {
            title: "GPU Training Start",
            resourceBusyTitle: "Resource Busy",
            resourceAdjustmentNotice: "! Due to heavy load, we've adjusted your GPU type. Pricing has changed accordingly. You can continue or cancel.",
            billingNotice: "Billing is based on actual training duration",
            unitMinute: "min",
            learningRate: "Training Price",
            startTraining: "Start Training"
          },
          desktopAppCard: {
            deleteApp: "Delete",
            updated: "Updated",
            deleteDescription: "This will permanently delete the application. Are you sure?",
            trainingLabel: "Training",
            inferenceLabel: "Inference",
            codeUpdated: "Code updated",
            statusExecuting: "⏳ Executing",
            statusTraining: "⏳ Train/Run",
            statusExecSuccess: "✅ Execution Succeeded",
            statusExecFailed: "❌ Execution Failed",
            statusCancelled: "⚠️ Cancelled",
            statusTrainingDone: "✅ Train/Run Completed",
            statusTrainingFailed: "❌ Train/Run Failed"
          },
          realTimeChart: {
            connected: "Connected",
            disconnected: "Disconnected"
          },
          dsePanel: {
            uploading: "Uploading... {current}/{total}",
            dropToUpload: "Drag files here to upload, or click to select",
            supportedTypes: "Images, CSV, ZIP, model files, etc.",
            selectFolder: "Select Folder",
            selectFiles: "Select Files",
            fileStats: "{count} files, {size} total",
            copyAllUrls: "Copy All URLs",
            copyUrl: "Copy URL",
            delete: "Delete",
            addToConversation: "Add to conversation (@)",
            noFiles: "No data files",
            noFilesHint: "Upload files to get URLs and reference them in training code",
            uploadComplete: "Upload complete: {count} files{failed}",
            uploadCompleteFailed: ", {count} failed",
            uploadAllFailed: "All file uploads failed",
            desktopOnly: "This feature is only available in the desktop app",
            selectDialogTitle: "Select files to upload",
            selectFailed: "File selection failed",
            selectFolderTitle: "Select a folder to upload",
            dirEmpty: "No files in the directory",
            readDirFailed: "Failed to read directory",
            folderSelectFailed: "Folder selection failed",
            copiedUrls: "Copied URLs of {count} files",
            deleteFailed: "Delete failed",
            presetDatasets: "Classic Datasets",
            presetAdd: "Add",
            presetAdded: "Added",
            presetAddSuccess: "Added: {name}",
            presetAddFailed: "Failed to add dataset",
            presetCategoryPretrain: "Pretrain",
            presetCategorySft: "SFT",
            presetCategoryDomain: "Domain",
            priceFree: "Free",
            purchased: "Purchased",
            purchaseAdd: "Buy for {price} credits",
            purchaseConfirm: "Buy dataset \"{name}\" for {price} credits? The amount will be deducted from your balance.",
            purchaseSuccess: "Purchased successfully ({price} credits deducted)",
            purchaseFailed: "Purchase failed",
            purchaseLoginRequired: "Please log in first to purchase datasets",
            serverDatasets: "Official datasets from server",
            offlineFallback: "Offline presets"
          },
          errorOccurred: "An error occurred"
        }
      },
      profile: {
        modelSettings: {
          title: "Custom Models",
          tabMyModels: "My Models",
          tabBindings: "Bindings",
          tabSearch: "Search Providers",
          agent: "Cloud Agent",
          summary: "Summary",
          plan: "Planning",
          execution: "Execution",
          chatModel: "Chat Model",
          selectModel: "Select a model",
          noModels: "No models available, please add a model first",
          noChatModels: "No chat models available, please add a chat model first",
          noApiKey: "No API Key",
          inputApiKey: "Enter API Key",
          reuseApiKey: "💡 Detected same endpoint for {source}, click to reuse API Key",
          edit: "Edit",
          configure: "Configure",
          configured: "Configured",
          searchProvidersCount: "/ {count} providers",
          needOneProvider: "At least one search provider is required",
          searchEngines: "Search Engines",
          webFetch: "Web Fetch",
          llmInstalled: "LLM-installed Providers",
          noConfigNeeded: "No config needed",
          notConfigured: "Not configured",
          usageTitle: "💡 Usage tips:",
          usageTip1: "Some search providers require an API key",
          usageTip2: "Multiple providers enable load balancing and result aggregation",
          usageTip3: "Built-in algorithm distributes search requests across providers",
          loadFailed: "Failed to load model config",
          loginFirst: "Please log in before saving config",
          saved: "Model bindings saved",
          saveFailedRetry: "Save failed, please retry",
          saveFailed: "Save failed",
          modelDeleted: "Model deleted",
          deleteFailed: "Delete failed",
          providerDeleted: "Search provider deleted",
          apiKeySaved: "API Key saved",
          cancel: "Cancel",
          saving: "Saving...",
          save: "Save"
        },
        customModelDialog: {
          configApiKey: "Configure API Key",
          editModel: "Edit Model",
          addModel: "Add Model",
          modelUpdated: "Model updated",
          modelAdded: "Model added",
          systemModelNote: "System default model: only the API Key can be modified, other properties are locked",
          systemModelInfo: "Model: {name} · URL: {url}",
          quickSelectProvider: "⚡ Quick select provider",
          selectModel: "Select model",
          modelIdLabel: "Model ID *",
          modelIdPlaceholder: "e.g. deepseek-chat, gpt-4o",
          enterModelId: "Please enter a model ID",
          modelIdExists: "This model ID already exists",
          visionModel: "Vision model (supports image input)",
          manuallySet: "· Manually set",
          autoDetect: "· Auto-detected by model ID",
          detected: " (detected)",
          urlLabel: "API URL *",
          enterUrl: "Please enter an API URL",
          urlStartHttp: "URL must start with http or https",
          apiKeyLabel: "API Key *",
          enterApiKey: "Please enter an API Key",
          getApiKey: "Get it",
          reuseApiKey: "💡 Detected {source} using the same endpoint, click to reuse API Key",
          cancel: "Cancel",
          saving: "Saving...",
          save: "Save",
          videoModel: "Video generation model",
          imageModel: "Image generation model",
          imageEditModel: "Image editing model",
          chatModel: "Chat model",
          visionChatModel: "Chat model (with vision support)"
        },
        searchProviderDialog: {
          editProvider: "Edit Search Provider",
          addProvider: "Add Search Provider",
          providerUpdated: "Search provider updated",
          providerAdded: "Search provider added",
          quickPresets: "Quick Presets",
          freeApiKey: "No API Key needed",
          getApiKey: "Get API Key",
          orManual: "or configure manually",
          typeLabel: "Type",
          selectType: "Select type",
          typeSearch: "Search Engine",
          typeFetch: "URL Reader",
          typeHint: "Search engines search the web, URL readers read page content",
          nameLabel: "Name",
          namePlaceholder: "e.g. {example}",
          enterName: "Please enter a name",
          nameExists: "This name already exists",
          enterUrl: "Please enter an API URL",
          urlStartHttp: "URL must start with http or https",
          apiKeyOptional: "Optional, for authentication",
          goGetApiKey: "Go get API Key",
          emptyMeansDisabled: "Leave empty to disable this provider",
          cancel: "Cancel",
          saving: "Saving...",
          save: "Save",
          add: "Add"
        },
        tokenUsage: {
          noRecords: "No usage records",
          title: "Token Usage (7 days)",
          calls: "{count} calls",
          input: "Input",
          output: "Output",
          total: "Total",
          weekTotal: "7-day total",
          modelPerf: "Model Performance",
          model: "Model",
          callCount: "Calls",
          avgDuration: "Avg Duration",
          avgInput: "Avg Input",
          reasoning: "Reasoning",
          actualOutput: "Actual Output",
          throughput: "Throughput",
          timesUnit: "{count}",
          depthTitle: "{model} multi-turn performance",
          round: "Round",
          arrivals: "Arrivals",
          initial: "Initial",
          roundN: "Round {n}"
        }
      },
      payment: {
        recharge: "Recharge",
        history: "History",
        rechargeDialog: {
          title: "Recharge Plan",
          selectAmount: "Select Recharge Amount",
          customAmount: "Or Custom Amount",
          customAmountPlaceholder: "Please enter recharge amount (Yuan)",
          amount: "Recharge Amount:",
          credits: "Credits Received:",
          discountBadge: "{off}% off",
          cancel: "Cancel",
          alipay: "Alipay",
          creatingOrder: "Creating Order...",
          error: {
            invalidAmount: "Please enter a valid recharge amount",
            minAmount: "Recharge amount cannot be less than 1 Yuan",
            maxAmount: "Single recharge amount cannot exceed 10,000 Yuan",
            notLoggedIn: "Please log in before recharging",
            configError: "Payment service configuration error, please contact administrator",
            networkError: "Network connection failed, please check network and try again",
            orderFailed: "Failed to create recharge order",
            paymentUrl: "Failed to get payment link",
            redirect: "Redirected to payment page, please complete payment"
          }
        }
      }
    }
  },
  zh: {
    translation: {
      auth: {
        login: {
          title: "登录",
          email: "邮箱",
          password: "密码",
          emailPlaceholder: "请输入邮箱",
          passwordPlaceholder: "请输入密码",
          loginButton: "登录",
          loginButtonLoading: "登录中...",
          forgotPassword: "忘记密码？",
          emailError: "请输入有效的邮箱地址",
          passwordError: "密码至少需要6个字符"
        },
        register: {
          title: "注册",
          name: "昵称",
          email: "邮箱",
          password: "密码",
          confirmPassword: "确认密码",
          namePlaceholder: "请输入昵称",
          emailPlaceholder: "请输入邮箱",
          passwordPlaceholder: "至少8位，包含大小写字母和数字",
          confirmPasswordPlaceholder: "请再次输入密码",
          registerButton: "注册（发送验证码）",
          registerButtonLoading: "发送验证码中...",
          nameError: "昵称至少需要2个字符",
          nameMaxError: "昵称不能超过50个字符",
          nameFormatError: "昵称只能包含中文、英文、数字、下划线和短横线",
          emailError: "请输入有效的邮箱地址",
          emailMaxError: "邮箱地址不能超过100个字符",
          passwordError: "密码至少需要8个字符",
          passwordMaxError: "密码不能超过100个字符",
          passwordFormatError: "密码必须包含至少一个大写字母、一个小写字母和一个数字",
          confirmPasswordError: "确认密码至少需要8个字符",
          passwordMismatchError: "两次输入的密码不一致",
          agreeToTermsError: "请阅读并同意服务条款和隐私政策",
          agreeToTermsText: "我已阅读并同意",
          termsOfService: "服务条款",
          and: "和",
          privacyPolicy: "隐私政策"
        },
        otp: {
          registerTitle: "验证邮箱",
          resetTitle: "验证重置密码",
          subtitle: "我们已向 {email} 发送了6位验证码",
          verificationCode: "验证码",
          verifyButton: "验证",
          verifyButtonLoading: "验证中...",
          resendCode: "重新发送验证码",
          resendCountdown: "{seconds}秒后可重新发送",
          backToRegister: "返回注册",
          backToForgotPassword: "返回忘记密码",
          otpError: "请输入6位验证码",
          verifySuccess: "验证成功！",
          verifyError: "验证码错误，请重试",
          resendSuccess: "验证码已重新发送",
          resendError: "重新发送失败，请稍后重试",
          resetVerifySuccess: "验证码验证成功，请设置新密码",
          title: "验证"
        },
        forgotPassword: {
          title: "忘记密码",
          subtitle: "请输入您的邮箱地址，我们将发送验证码到您的邮箱",
          email: "邮箱",
          emailPlaceholder: "请输入邮箱",
          sendButton: "发送验证码",
          sendButtonLoading: "发送中...",
          backToLogin: "返回登录",
          emailError: "请输入有效的邮箱地址"
        },
        resetPassword: {
          title: "设置新密码",
          subtitle: "请输入您的新密码",
          newPassword: "新密码",
          confirmPassword: "确认新密码",
          newPasswordPlaceholder: "至少8位，包含大小写字母和数字",
          confirmPasswordPlaceholder: "请再次输入新密码",
          resetButton: "重置密码",
          resetButtonLoading: "重置中...",
          backToVerification: "返回验证码输入",
          passwordError: "密码至少需要8个字符",
          passwordMaxError: "密码不能超过100个字符",
          passwordFormatError: "密码必须包含至少一个大写字母、一个小写字母和一个数字",
          confirmPasswordError: "确认密码至少需要8个字符",
          passwordMismatchError: "两次输入的密码不一致",
          resetSuccess: "密码重置成功！请使用新密码登录",
          resetError: "密码重置失败，请重试"
        },
        modal: {
          description: "请登录以继续"
        }
      },
      workspace: {
        historyPanel: {
          title: "对话历史",
          loadingMore: "加载中...",
          loadMore: "加载更多",
          noMoreHistory: "已显示全部历史记录",
          execution: "执行中",
          files: "包含 {count} 个文件",
          noFiles: "无文件",
          markImportant: "标记为重要对话",
          unmarkImportant: "取消重要对话标记",
          broadcast: "广播"
        },
        chatMessages: {
          greeting: "HI HI，今天我们做什么项目？",
          initializing: "初始化中...",
          analyzing: "思考中",
          analysisComplete: "思考完成",
          analysisFailed: "思考失败",
          waitingReply: "等待回复"
        },
        chatInput: {
          placeholder: "请输入您的需求、想法或者任意内容...",
          datasetRefPrompt: "请帮我根据此数据集构建一个训练项目。"
        },
        chatHeader: {
          title: "Chat",
          newChat: "新对话",
          projects: "项目",
          files: "文件",
          recharge: "充值",
          languagePreference: "语言偏好",
          customModels: "自定义模型",
          credentialManager: "凭据管理",
          checkUpdate: "检查更新",
          checking: "检查中...",
          logout: "退出登录",
          loginRegister: "登录 / 注册",
          defaultUserName: "用户"
        },
        workspaceGrid: {
          projectsTitle: "创建项目",
          filesTitle: "上传文件",
          filterAll: "全部",
          filterNormal: "普通项目",
          filterSystemBase: "基础项目"
        },
        messageContent: {
          preview: "预览",
          browser: "浏览器",
          open: "打开",
          openInFolder: "在文件夹中打开: {path}",
          previewImage: "预览图片: {path}",
          openInBrowser: "在浏览器中打开: {path}",
          openInDesktop: "在 Desktop 中打开: {path}",
          copyPath: "复制路径: {path}",
          trainingRunning: "训练进行中...",
          instanceCreating: "实例创建中...",
          appRunning: "应用执行中...",
          trainingLongTime: "训练时长较长，您可以在对话中继续其他操作",
          executeComplete: "执行完成",
          executeFailed: "执行失败",
          taskId: "任务 ID",
          gpuSpec: "GPU 规格",
          executionTime: "执行时间"
        },
        mediaViewer: {
          image: {
            title: "图片查看器",
            download: "下载",
            openNewWindow: "在新窗口打开",
            copyLink: "复制链接",
            zoomIn: "放大",
            zoomOut: "缩小",
            resetZoom: "重置缩放"
          },
          audio: {
            download: "下载",
            play: "播放",
            pause: "暂停",
            mute: "静音",
            unmute: "取消静音",
            loading: "加载中...",
            unknownDuration: "未知时长"
          },
          document: {
            download: "下载",
            downloadAndOpenInSoftware: "请下载后使用相应软件打开",
            downloadFile: "下载文件",
            preview: "预览",
            unableToPreviewPDF: "无法预览此PDF文件",
            unsupportedOnlinePreview: "暂不支持在线预览此文档类型"
          },
          ppt: {
            download: "下载",
            downloadFile: "下载文件",
            googleDocsViewerCannotAccessFile: "Google Docs Viewer 无法访问此文件",
            onlinePreviewFailed: "在线预览失败",
            openInNewWindow: "在新窗口打开",
            pptFile: "PPT 文件",
            pptFileRequiresDownload: "此PPT文件需要下载后使用 PowerPoint 或其他兼容软件打开"
          }
        },
        desktopModule: {
          codeEditor: {
            running: "运行中...",
            saved: "已保存",
            saveFailed: "保存失败",
            executionResult: "执行结果",
            cancel: "取消",
            loading: "加载中...",
            success: "执行成功",
            error: "执行错误"
          },
          desktopAppViewer: {
            appUpdated: "应用更新成功",
            errorOccurred: "发生错误",
            unsupportedFileType: "该文件类型暂不支持在线渲染",
            noAppsFound: "创建项目以获得GPU资源",
            loadingApps: "加载更多项目...",
            appDetails: "应用详情",
            trainingHistory: "训练历史",
            backToList: "返回列表",
            resourceAdjustmentWait: "可能存在算力调剂，请勿关闭",
            instanceCreatingWait: "正在创建GPU实例，请稍候...",
            trainingProgressWait: "训练中，可以关闭，后续查看结果",
            noTrainingHistory: "暂无训练历史",
            trainingSuccess: "训练成功",
            trainingFailed: "训练失败",
            trainingInProgress: "训练中...",
            trainingTask: "训练任务",
            viewDetails: "查看详情",
            defaultAppName: "应用",
            writeCodeFirst: "请先编写代码",
            devServerStarted: "开发服务器已启动",
            clickToVisit: "点击访问: {url}",
            openBrowser: "打开浏览器",
            stopService: "停止开发服务器，释放端口",
            serviceStopped: "开发服务器已停止，资源已释放",
            backgroundTaskRunning: "有任务仍在后台执行中，完成后将自动记录结果",
            executeSuccess: "执行成功",
            executeSuccessNoOutput: "执行成功，无输出",
            executeFailed: "执行失败",
            executeException: "执行异常",
            invalidResultFormat: "执行结果格式错误",
            envMissingTitle: "检测到电脑未安装 {env}，本地执行受阻",
            envMissingDesc: "已为你准备好安装请求，请回到对话按发送",
            trainingStopped: "训练已停止",
            trainingStoppedDesc: "云端实例已释放，不再计费",
            stopFailed: "停止失败",
            unknownError: "未知错误",
            historyEmpty: "历史版本内容为空",
            viewHistoryVersion: "查看历史版本: {fileName}",
            saveFailed: "保存失败",
            hideFileTree: "隐藏文件树",
            showFileTree: "显示文件树",
            openInBrowser: "在浏览器中打开",
            save: "保存",
            stopTraining: "停止训练",
            cloudTraining: "云端运行（训练/普通计算）",
            executing: "执行中...",
            localExecute: "本地执行",
            close: "关闭",
            halfHalf: "一半一半",
            codeMax: "代码区最大",
            previewMax: "Preview最大",
            selectFileFromTree: "请从左侧文件树选择一个文件",
            orCreateNew: "或点击 + 创建新文件",
            executionLog: "执行日志 ({count})",
            rechargeSuccess: "充值成功",
            rechargeSuccessDesc: "余额已更新，可以继续使用GPU训练",
            gpuWarningTitle: "不建议在 CPU 环境执行 GPU 代码",
            gpuWarningDefault: "检测到代码中包含深度学习相关组件",
            gpuWarningDesc: "本地环境通常没有 GPU 和 CUDA 支持，此类代码可能因缺少依赖而失败，或执行极慢。建议使用云端 GPU 训练。",
            cancel: "取消",
            stillExecute: "仍要执行",
            killConfirmDesc: "确定要停止正在运行的 GPU 训练任务吗？云端实例将被释放，不再计费。",
            killReasonPlaceholder: "请输入停止原因（可选）",
            stopping: "停止中...",
            confirmStop: "确认停止"
          },
          desktopPanel: {
            files: "文件",
            referenceApp: "引用此应用",
            splitVersion: "拆分版本",
            systemProjectNoDelete: "系统项目不可删除，可在项目内自由修改文件内容",
            systemProjectTitle: "系统项目，不可删除",
            fileViewerTitle: "文件查看器"
          },
          fileTree: {
            copyFullPath: "复制完整路径",
            copyRelativePath: "复制相对路径",
            delete: "删除",
            rename: "重命名",
            copiedFullPath: "已复制完整路径",
            copiedRelativePath: "已复制相对路径",
            hasHistoryVersion: "有历史版本（已修改）",
            loadingTree: "加载文件树...",
            retry: "重试",
            currentFiles: "当前文件",
            importProject: "导入项目",
            newFile: "新建文件",
            newFolder: "新建文件夹",
            cancelImport: "取消导入",
            fileNamePlaceholder: "文件名",
            folderNamePlaceholder: "文件夹名",
            noFiles: "暂无文件",
            noFilesHint: "点击 + 新建文件",
            selectProjectFolder: "选择项目文件夹",
            importSuccessTitle: "导入成功",
            importFailedTitle: "导入失败",
            importFailedDesc: "绑定关系保存失败，后端服务可能未就绪，请稍后重试",
            openFileLocation: "打开文件位置",
            fileTooLargeTitle: "文件过大，已停止预览",
            fileTooLargeDesc: "仅预览 2MB 以内的文件（当前 {{size}}）",
            changeHistory: "变更记录",
            acceptAll: "全部接受",
            noChanges: "暂无变更记录",
            acceptCurrent: "接受当前版本",
            revertToPrevious: "回退到上一版本"
          },
          previewViewer: {
            title: "实时预览",
            duration: "时长",
            cost: "产生费用",
            downloadModel: "下载权重模型",
            fromCloud: "来自云端存储",
            downloadFile: "下载文件",
            download: "下载",
            starting: "启动中..."
          },
          chartRenderer: {
            title: "图表渲染器"
          },
          gpuTrainingStatus: {
            title: "开始GPU训练",
            resourceBusyTitle: "计算资源紧张",
            resourceAdjustmentNotice: "！因计算资源紧张，为您调剂到其他GPU类型，单价会有一些调整，您可以继续或者取消。",
            billingNotice: "扣费以实际训练时长为主",
            unitMinute: "分钟",
            learningRate: "训练单价",
            startTraining: "开始训练"
          },
          desktopAppCard: {
            deleteApp: "删除",
            updated: "更新于",
            deleteDescription: "这将永久删除该应用。您确定吗？",
            trainingLabel: "训练",
            inferenceLabel: "推理",
            codeUpdated: "代码已更新",
            statusExecuting: "⏳执行中",
            statusTraining: "⏳Train/Run中",
            statusExecSuccess: "✅执行成功",
            statusExecFailed: "❌执行失败",
            statusCancelled: "⚠️已取消",
            statusTrainingDone: "✅Train/Run完成",
            statusTrainingFailed: "❌Train/Run失败"
          },
          realTimeChart: {
            connected: "已连接",
            disconnected: "已断开"
          },
          dsePanel: {
            uploading: "上传中... {current}/{total}",
            dropToUpload: "拖拽文件到此处上传，或点击选择",
            supportedTypes: "支持图片、CSV、ZIP、模型文件等",
            selectFolder: "选择文件夹",
            selectFiles: "选择文件",
            fileStats: "{count} 个文件，共 {size}",
            copyAllUrls: "复制全部URL",
            copyUrl: "复制 URL",
            delete: "删除",
            addToConversation: "添加到对话（@）",
            noFiles: "暂无数据文件",
            noFilesHint: "上传文件后，可以获取 URL 并在训练代码中引用",
            uploadComplete: "上传完成: {count} 个文件{failed}",
            uploadCompleteFailed: "，{count} 个失败",
            uploadAllFailed: "所有文件上传失败",
            desktopOnly: "此功能仅支持桌面应用",
            selectDialogTitle: "选择要上传的文件",
            selectFailed: "文件选择失败",
            selectFolderTitle: "选择要上传的文件夹",
            dirEmpty: "目录中没有文件",
            readDirFailed: "读取目录失败",
            folderSelectFailed: "文件夹选择失败",
            copiedUrls: "已复制 {count} 个文件的 URL",
            deleteFailed: "删除失败",
            presetDatasets: "经典数据集",
            presetAdd: "添加",
            presetAdded: "已添加",
            presetAddSuccess: "已添加：{name}",
            presetAddFailed: "添加数据集失败",
            presetCategoryPretrain: "预训练",
            presetCategorySft: "指令微调",
            presetCategoryDomain: "领域数据",
            priceFree: "免费",
            purchased: "已购",
            purchaseAdd: "支付 {price} 积分购买",
            purchaseConfirm: "确定购买数据集「{name}」（{price} 积分）？将从余额中扣费。",
            purchaseSuccess: "购买成功，已扣费 {price} 积分",
            purchaseFailed: "购买失败",
            purchaseLoginRequired: "请先登录后再购买数据集",
            serverDatasets: "官方数据集（服务端）",
            offlineFallback: "离线预设"
          },
          errorOccurred: "发生错误"
        }
      },
      profile: {
        modelSettings: {
          title: "自定义模型",
          tabMyModels: "我的模型",
          tabBindings: "使用视图",
          tabSearch: "搜索源",
          agent: "云端代理",
          summary: "总结",
          plan: "规划",
          execution: "执行",
          chatModel: "chat模型",
          selectModel: "选择模型",
          noModels: "暂无可用模型，请先添加模型",
          noChatModels: "暂无可用模型，请先添加对话模型",
          noApiKey: "未配置 API Key",
          inputApiKey: "输入 API Key",
          reuseApiKey: "💡 检测到 {source} 相同端点，点击沿用 API Key",
          edit: "修改",
          configure: "配置",
          configured: "已配置",
          searchProvidersCount: "/ {count} 个搜索源",
          needOneProvider: "至少需要配置一个搜索源",
          searchEngines: "搜索引擎",
          webFetch: "网页爬取",
          llmInstalled: "LLM 安装的搜索源",
          noConfigNeeded: "无需配置",
          notConfigured: "未配置",
          usageTitle: "💡 使用说明：",
          usageTip1: "部分搜索源需要apikey",
          usageTip2: "配置多个搜索源可以实现负载均衡和结果聚合",
          usageTip3: "系统内置算法自动分配搜索请求到不同的搜索源",
          loadFailed: "加载模型配置失败",
          loginFirst: "请先登录后再保存配置",
          saved: "模型绑定配置已保存",
          saveFailedRetry: "保存失败，请重试",
          saveFailed: "保存失败",
          modelDeleted: "模型已删除",
          deleteFailed: "删除失败",
          providerDeleted: "搜索源已删除",
          apiKeySaved: "API Key 已保存",
          cancel: "取消",
          saving: "保存中...",
          save: "保存"
        },
        customModelDialog: {
          configApiKey: "配置 API Key",
          editModel: "编辑模型",
          addModel: "添加模型",
          modelUpdated: "模型已更新",
          modelAdded: "模型已添加",
          systemModelNote: "系统默认模型：只能修改 API Key，其他属性已锁定",
          systemModelInfo: "模型：{name} · URL：{url}",
          quickSelectProvider: "⚡ 快速选择服务商",
          selectModel: "选择模型",
          modelIdLabel: "模型 ID *",
          modelIdPlaceholder: "例如：deepseek-chat、gpt-4o",
          enterModelId: "请输入模型 ID",
          modelIdExists: "该模型 ID 已存在",
          visionModel: "视觉模型（支持图片输入）",
          manuallySet: "· 手动指定",
          autoDetect: "· 按模型 ID 自动识别",
          detected: "（已识别）",
          urlLabel: "API URL *",
          enterUrl: "请输入 API URL",
          urlStartHttp: "URL 必须以 http 或 https 开头",
          apiKeyLabel: "API Key *",
          enterApiKey: "请输入 API Key",
          getApiKey: "点击获取",
          reuseApiKey: "💡 检测到 {source} 使用相同端点，点击沿用 API Key",
          cancel: "取消",
          saving: "保存中...",
          save: "保存",
          videoModel: "视频生成模型",
          imageModel: "图片生成模型",
          imageEditModel: "图片编辑模型",
          chatModel: "对话模型",
          visionChatModel: "对话模型（支持视觉理解）"
        },
        searchProviderDialog: {
          editProvider: "编辑搜索源",
          addProvider: "添加搜索源",
          providerUpdated: "搜索源已更新",
          providerAdded: "搜索源已添加",
          quickPresets: "快速添加预设",
          freeApiKey: "免 API Key",
          getApiKey: "获取 API Key",
          orManual: "或手动配置",
          typeLabel: "类型",
          selectType: "选择类型",
          typeSearch: "搜索引擎",
          typeFetch: "url阅读",
          typeHint: "搜索引擎用于搜索网页，url阅读用于阅读url信息",
          nameLabel: "名称",
          namePlaceholder: "例如：{example}",
          enterName: "请输入搜索源名称",
          nameExists: "该名称已存在",
          enterUrl: "请输入 API URL",
          urlStartHttp: "URL 必须以 http 或 https 开头",
          apiKeyOptional: "可选，用于认证",
          goGetApiKey: "前往获取 API Key",
          emptyMeansDisabled: "留空表示不使用此搜索源",
          cancel: "取消",
          saving: "保存中...",
          save: "保存",
          add: "添加"
        },
        tokenUsage: {
          noRecords: "暂无使用记录",
          title: "Token 使用量 (7天)",
          calls: "{count} 次调用",
          input: "输入",
          output: "输出",
          total: "总计",
          weekTotal: "7天总计",
          modelPerf: "模型性能分析",
          model: "模型",
          callCount: "调用次数",
          avgDuration: "平均耗时",
          avgInput: "平均输入",
          reasoning: "推理",
          actualOutput: "实际输出",
          throughput: "吞吐量",
          timesUnit: "{count} 次",
          depthTitle: "{model} 多轮场景性能分析",
          round: "轮次",
          arrivals: "到达次数",
          initial: "初始",
          roundN: "第{n}轮",
          throughputHint: "吞吐量 (t/s) = 总 tokens / 总耗时(秒)，数值越高表示模型响应越快"
        }
      },
      payment: {
        recharge: "充值",
        history: "记录",
        rechargeDialog: {
          title: "充值计划",
          selectAmount: "选择充值金额",
          customAmount: "或自定义金额",
          customAmountPlaceholder: "请输入充值金额（元）",
          amount: "充值金额:",
          credits: "获得Credits:",
          discountBadge: "已享{zhe}折",
          cancel: "取消",
          alipay: "支付宝支付",
          creatingOrder: "创建订单中...",
          error: {
            invalidAmount: "请输入有效的充值金额",
            minAmount: "充值金额不能小于1元",
            maxAmount: "单次充值金额不能超过10000元",
            notLoggedIn: "请先登录后再充值",
            configError: "支付服务配置错误，请联系管理员",
            networkError: "网络连接失败，请检查网络后重试",
            orderFailed: "创建充值订单失败",
            paymentUrl: "获取支付链接失败",
            redirect: "已跳转到支付页面，请完成支付"
          }
        }
      }
    }
  }
};;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    debug: false,
    interpolation: {
      escapeValue: false,
      skipOnVariables: false, // 🔥 确保插值功能正常工作
      prefix: "{", // 🔥 明确指定插值前缀
      suffix: "}", // 🔥 明确指定插值后缀
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "i18nextLng",
      caches: ["localStorage"],
    },
  });

// 自动语言选择（本地信号优先，GeoIP 可选）
const USER_LANG_OVERRIDE_KEY = "preferredLanguage";
const GEOIP_CACHE_KEY = "geoip.country";
const GEOIP_TS_KEY = "geoip.ts";
const GEOIP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天缓存

const normalizeLang = (lng?: string | null) => {
  if (!lng) return "";
  const lower = lng.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("en")) return "en";
  return "";
};

const shouldUseGeoIP = () => {
  try {
    return typeof window !== "undefined" && localStorage.getItem("ENABLE_GEOIP") === "1";
  } catch {
    return false;
  }
};

function resolveLanguageSync(): string | null {
  try {
    const override = localStorage.getItem(USER_LANG_OVERRIDE_KEY) || localStorage.getItem("i18nextLng");
    const normOverride = normalizeLang(override);
    if (normOverride) return normOverride;

    // 浏览器语言
    const navLang = normalizeLang(navigator.language);
    if (navLang) return navLang;
    const hasZhByNavigatorArray = Array.isArray((navigator as any).languages)
      ? (navigator as any).languages.some((lng: string) => normalizeLang(lng) === "zh")
      : false;
    if (hasZhByNavigatorArray) return "zh";

    // 时区判断（中国大陆常用：Asia/Shanghai）
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.toLowerCase().includes("shanghai")) return "zh";
  } catch {
    // ignore
  }
  return null;
}

async function getGeoIpCountryCached(): Promise<string | null> {
  try {
    const now = Date.now();
    const tsStr = localStorage.getItem(GEOIP_TS_KEY);
    const cachedCountry = localStorage.getItem(GEOIP_CACHE_KEY);
    if (tsStr && cachedCountry && now - Number(tsStr) < GEOIP_TTL_MS) {
      return cachedCountry;
    }
    if (!shouldUseGeoIP()) {
      return cachedCountry || null;
    }
    const resp = await fetch("https://ipapi.co/json/");
    if (!resp.ok) return cachedCountry || null;
    const data = await resp.json();
    const c: string | null = data?.country || data?.country_code || null;
    if (c) {
      localStorage.setItem(GEOIP_CACHE_KEY, c);
      localStorage.setItem(GEOIP_TS_KEY, String(now));
    }
    return c;
  } catch {
    try {
      return localStorage.getItem(GEOIP_CACHE_KEY) || null;
    } catch {
      return null;
    }
  }
}

(async () => {
  try {
    const current = normalizeLang(i18n.language) || "en";
    let desired = resolveLanguageSync();
    if (!desired) {
      const country = await getGeoIpCountryCached();
      if (country && country.toUpperCase() === "CN") desired = "zh";
      else desired = "en";
    }
    if (desired && desired !== current) {
      await i18n.changeLanguage(desired);
      try { localStorage.setItem("i18nextLng", desired); } catch {}
    }
  } catch {
    // ignore
  }
})();

export default i18n;




