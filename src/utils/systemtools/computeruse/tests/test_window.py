# -*- coding: utf-8 -*-
"""
定位层 ground-truth 测试窗口

真值来源 = tkinter 自身的 winfo 查询（DPI aware 进程内即物理像素），零人工标注：
- 启动后导出每个按钮的物理屏幕坐标到 TRUTH_OUT
- 按钮点击回调把事件屏幕坐标（e.x_root/e.y_root，物理像素）追加写入 EVENTS_OUT
"""
import ctypes
import json
import sys

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

import tkinter as tk

TRUTH_OUT = sys.argv[1]
EVENTS_OUT = sys.argv[2]

# 前缀唯一（环境零碰撞），中文词独立考察中文 OCR 质量
BUTTONS = [
    ("BTN_ALPHA 文件", "#FFD700"),
    ("BTN_BRAVO 搜索", "#7FFFD4"),
    ("BTN_CHAR 确定", "#FFB6C1"),
    ("BTN_DELTA 设置", "#87CEFA"),
    ("BTN_ECHO 导出", "#DDA0DD"),
]

events = []


def save_events():
    with open(EVENTS_OUT, "w", encoding="utf-8") as f:
        json.dump(events, f, ensure_ascii=False)


def make_handler(label):
    def h(e):
        events.append({"name": label, "x_root": e.x_root, "y_root": e.y_root})
        save_events()
    return h


root = tk.Tk()
root.title("LocTestWindow")
root.geometry("1440x460+120+140")  # 3列按钮 350px+padding 需 ≥1266px，窗口过窄会把第3列裁掉
root.attributes("-topmost", True)
root.configure(bg="#F0F0F0")

buttons = []
for i, (label, color) in enumerate(BUTTONS):
    r, col = divmod(i, 3)
    b = tk.Button(root, text=label, bg=color, width=20, height=3,
                  font=("Microsoft YaHei", 14))
    b.grid(row=r, column=col, padx=36, pady=30)
    b.bind("<Button-1>", make_handler(label))
    buttons.append(b)


def export_truth():
    truth = []
    for (label, _), b in zip(BUTTONS, buttons):
        parts = label.split()
        truth.append({
            "name": label,
            "prefix": parts[0],        # 唯一定位关键词
            "cn_word": parts[1],       # 中文识别率考察项
            "x": b.winfo_rootx(), "y": b.winfo_rooty(),
            "w": b.winfo_width(), "h": b.winfo_height(),
        })
    with open(TRUTH_OUT, "w", encoding="utf-8") as f:
        json.dump(truth, f, ensure_ascii=False)


root.update_idletasks()
root.update()


def keep_top():
    """置顶自愈：OCR 跑十几秒期间前台焦点可能被切走（topmost 失效被别的窗口盖住），
    测试窗口每 400ms 弹回顶层，保证截图时刻按钮完整可见"""
    root.attributes("-topmost", True)
    root.lift()
    root.after(400, keep_top)


keep_top()
root.after(500, export_truth)
root.mainloop()
