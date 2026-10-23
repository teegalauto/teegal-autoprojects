# -*- coding: utf-8 -*-
"""
Teegal ComputerUse 定位层（原型）

截屏 + UIA 控件探测 + OCR → 统一物理像素坐标候选表。

原则：
- 只产出确定性候选框（bbox），语义选择（"哪个是目标"）交给上层模型，本层永不"猜"坐标
- DPI awareness 最先声明：截屏 / OCR bbox / UIA rect / 点击坐标全链路统一物理像素，
  换算系数恒为 1，跨分辨率 / 跨缩放自动成立，无需校准与存储

CLI:
  python locator.py candidates [--out FILE] [--region X,Y,W,H] [--filter 文字] [--max N]
  python locator.py click --xy X,Y [--out FILE]                # 物理像素坐标点击并回读
  python locator.py type --text 文本                           # 剪贴板写入 + Ctrl+V 粘贴（支持中文）
  python locator.py key --name ctrl+s                          # 单键 / 组合键（enter/esc/tab/ctrl+s...）

工具化提示：TS 侧 computeruse tool 通过拼接驱动代码调用本文件（ perceive/click/type/key
走同一管线），stdout 以 "CU_JSON " 前缀行输出单行 JSON 供解析。
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import tempfile
import time

# ── DPI：必须先于一切窗口/截屏调用 ──
def _init_dpi():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # Per-Monitor DPI Aware
        return True
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
            return True
        except Exception:
            return False

DPI_AWARE = _init_dpi()


def screen_info():
    """aware 进程内 GetSystemMetrics 返回物理像素"""
    user32 = ctypes.windll.user32
    w = user32.GetSystemMetrics(0)   # SM_CXSCREEN
    h = user32.GetSystemMetrics(1)   # SM_CYSCREEN
    try:
        dpi = user32.GetDpiForSystem()
    except Exception:
        dpi = 96
    return {"physical": [w, h], "dpi": dpi, "scale": round(dpi / 96.0, 3), "dpi_aware": DPI_AWARE}


def take_screenshot(path):
    """主屏截屏，返回 RGB numpy 数组（物理像素）"""
    import mss
    import numpy as np
    from PIL import Image
    with mss.mss() as sct:
        raw = sct.grab(sct.monitors[1])  # 主屏
        img = np.array(raw)[:, :, :3][:, :, ::-1]  # BGRA → RGB
        Image.fromarray(img).save(path)
        return img


def list_windows(visible_only=True):
    """顶层窗口列表（名字+rect+hwnd+visible）——EnumWindows 实现（UIA 树遍历会瞬时漏窗口，不稳定）。
    visible_only=False 时含隐藏窗口（缩托盘的应用如微信，主窗口 hidden 但 hwnd 还在，可 SW_SHOW 拉回）"""
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    out = []
    Proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_ssize_t, ctypes.c_ssize_t)
    def cb(hwnd, _lparam):
        try:
            vis = bool(user32.IsWindowVisible(hwnd))
            if visible_only and not vis:
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            if r.left > -10000 and r.right > r.left and r.bottom > r.top:
                out.append({"name": buf.value.strip(), "hwnd": int(hwnd), "visible": vis,
                            "rect": [int(r.left), int(r.top), int(r.right - r.left), int(r.bottom - r.top)]})
        except Exception:
            pass
        return True
    user32.EnumWindows(Proc(cb), 0)
    return [w for w in out if w["name"]]


def find_window_rect(keyword):
    """按名字模糊匹配顶层窗口（大小写不敏感），返回 [x,y,w,h]；无命中返回 None"""
    kw = str(keyword).lower()
    for w in list_windows():
        if kw in w["name"].lower():
            return w["rect"]
    return None


def do_focus(window):
    """按窗口名置前（EnumWindows；托盘/隐藏窗口 SW_SHOW 拉回 + 最小化 SW_RESTORE 还原
    + Alt 键技巧绕前台锁 + 等窗口 rect 稳定——动画中截屏会错位，第7次点错行的根因）"""
    import ctypes
    from ctypes import wintypes
    kw = str(window).lower()
    hit = next((w for w in list_windows() if kw in w["name"].lower()), None)
    if hit is None:
        # 可见列表没有 → 扫隐藏窗口（点 X 缩托盘的微信等），拉回而不是报错放弃
        hit = next((w for w in list_windows(visible_only=False) if kw in w["name"].lower()), None)
        if hit is None:
            return {"error": f"未找到名称含 {window!r} 的窗口", "windows": list_windows()}
    hwnd = hit["hwnd"]
    user32 = ctypes.windll.user32
    if not user32.IsWindowVisible(hwnd):
        user32.ShowWindow(hwnd, 5)  # SW_SHOW：托盘化/隐藏窗口拉回
        time.sleep(0.4)
    else:
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE：最小化还原
    # Alt 键 down/up 包夹：绕过 SetForegroundWindow 的后台进程限制
    user32.keybd_event(0x12, 0, 0, 0)
    user32.SetForegroundWindow(hwnd)
    user32.keybd_event(0x12, 0, 2, 0)
    # 等窗口 rect 稳定（还原/显示动画中截屏内容会错位）：连续两次相同即认为稳定，上限 2.5s
    prev = None
    for _ in range(10):
        time.sleep(0.25)
        r = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        cur = (r.left, r.top, r.right, r.bottom)
        if cur == prev and cur[2] > cur[0]:
            break
        prev = cur
    fg = user32.GetForegroundWindow()
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    rect = [int(r.left), int(r.top), int(r.right - r.left), int(r.bottom - r.top)]
    if fg == hwnd:
        return {"focused": True, "rect": rect}
    return {"error": f"窗口 {window!r} 置前未生效（前台仍为其他窗口）", "rect": rect}


def uia_candidates(max_depth=5, max_items=800, window_filter=None):
    """遍历桌面顶层窗口的可交互控件，返回带物理像素 bbox 的候选。
    window_filter: 只遍历名字含该关键字的顶层窗口（窗口级收窄，其余窗口全跳过）"""
    import uiautomation as auto

    # 只收"有名且可交互"的控件类型：选号场景下无名/大容器框无意义
    INTEREST = {
        'ButtonControl', 'MenuItemControl', 'TextControl', 'EditControl',
        'HyperlinkControl', 'CheckBoxControl', 'RadioButtonControl',
        'TabItemControl', 'ListItemControl', 'ComboBoxControl', 'TreeItemControl',
        'DataItemControl',
    }
    out = []
    root = auto.GetRootControl()
    try:
        top_windows = root.GetChildren()
    except Exception:
        return out

    def rect_of(c):
        try:
            r = c.BoundingRectangle
            if r and r.right > r.left and r.bottom > r.top:
                # 过滤屏外矩形（Windows 最小化窗口 rect 在 -32000 区，IsOffscreen 拦不住）
                if r.left < -10000 or r.top < -10000:
                    return None
                return r
        except Exception:
            pass
        return None

    def walk(ctrl, depth, window_name):
        if depth > max_depth or len(out) > max_items:
            return
        try:
            children = ctrl.GetChildren()
        except Exception:
            return
        for c in children:
            try:
                ct = c.ControlTypeName
                # 过滤只决定"是否收录"，递归始终进行（顶层 WindowControl 不在
                # INTEREST 里，若因过滤 continue 跳过递归就永远进不了深层控件）
                if ct in INTEREST and not c.IsOffscreen:
                    r = rect_of(c)
                    if r:
                        name = (c.Name or '').strip()
                        if name:
                            out.append({
                                "source": "uia",
                                "text": name,
                                "type": ct,
                                "window": window_name,
                                "bbox": [int(r.left), int(r.top), int(r.right - r.left), int(r.bottom - r.top)],
                            })
            except Exception:
                pass
            walk(c, depth + 1, window_name)

    for w in top_windows:
        wname = (w.Name or '').strip()
        if window_filter and window_filter.lower() not in wname.lower():
            continue
        walk(w, 1, wname)
    return out


_OCR_ENGINE = None


def ocr_candidates(img):
    """RapidOCR 全屏识别，4 点框转正 bbox（引擎进程内单例，避免每次调用重载模型）"""
    global _OCR_ENGINE
    if _OCR_ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR
        _OCR_ENGINE = RapidOCR()
    result, _ = _OCR_ENGINE(img)
    out = []
    if not result:
        return out
    for box, text, score in result:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        out.append({
            "source": "ocr",
            "text": text,
            "conf": round(float(score), 3),
            "bbox": [int(x0), int(y0), int(x1 - x0), int(y1 - y0)],
        })
    return out


def cv_candidates(img, ocr_boxes=None, max_items=400):
    """图标候选层（无文字图形元素）：连通域找"图标尺寸"的紧凑深色块，
    排除 OCR 已框住的文字区域（文字笔画与图标线条同为深色，用 OCR 框区分）。
    膨胀把相邻笔画/三个点连成整块（如 "..." 图标），再按图标尺寸过滤"""
    import cv2
    import numpy as np
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    binary = cv2.adaptiveThreshold(255 - gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                   cv2.THRESH_BINARY, 15, -5)
    binary = cv2.dilate(binary, np.ones((7, 7), np.uint8), iterations=1)  # 桥接 "..." 三点间隙(~6px)
    n, _labels, stats, _ = cv2.connectedComponentsWithStats(binary)
    ocr_boxes = ocr_boxes or []
    out = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if not (10 <= w <= 90 and 10 <= h <= 90 and area >= 40):
            continue
        cx, cy = x + w // 2, y + h // 2
        # 中心落在 OCR 文字框内 → 是文字不是图标
        if any(ox <= cx <= ox + ow and oy <= cy <= oy + oh for ox, oy, ow, oh in ocr_boxes):
            continue
        out.append({
            "source": "cv",
            "text": "[图标]",
            "bbox": [int(x), int(y), int(w), int(h)],
        })
        if len(out) >= max_items:
            break
    return out


def _center(b):
    return [b[0] + b[2] // 2, b[1] + b[3] // 2]


def _pair_avatars(cv, ocr):
    """头像-名字配对增强：近方形 CV 块（40-100px，微信成员网格/聊天列表的头像尺寸）
    与 OCR 文字按几何关系自动配对，CV 条目 text 改写为 "[头像:xxx]"。
    两种布局：名字在头像正下方（成员网格，x 对齐）/ 名字在头像右侧（聊天/通讯录列表，y 对齐）。
    配对成功后 LLM 可直接选号点头像（微信弹资料卡要点头像，点名字文字无效）"""
    heads = [c for c in cv if 35 <= c["bbox"][2] <= 100 and 35 <= c["bbox"][3] <= 100
             and 0.6 <= c["bbox"][2] / max(c["bbox"][3], 1) <= 1.7]
    used = set()
    for h in heads:
        hx, hy, hw, hh = h["bbox"]
        hcx, hcy = hx + hw / 2, hy + hh / 2
        best, best_d = None, 1e9
        for o in ocr:
            name = (o.get("text") or "").strip()
            if not name or o.get("dup_of") or id(o) in used:
                continue
            ox_, oy_ = _center(o["bbox"])
            # 名字在头像下方（网格布局）：x 落在头像列内，名字顶距头像底 < 45px
            below = (hx - 12 <= ox_ <= hx + hw + 12) and (-6 <= oy_ - (hy + hh) <= 45)
            # 名字在头像右侧（列表布局）：y 中心对齐（差 < 45% 高），左缘距头像右缘 < 45px
            beside = (abs(oy_ - hcy) <= hh * 0.45) and (-6 <= ox_ - (hx + hw) <= 45)
            if not (below or beside):
                continue
            d = abs(ox_ - hcx) + abs(oy_ - hcy)
            if d < best_d:
                best, best_d = o, d
        if best is not None:
            used.add(id(best))
            h["text"] = f"[头像:{best['text'].strip()}]"
    return cv


def build_candidates(annotate=True, icons=True, region=None, text_filter=None, max_items=200, window=None):
    """完整管线：截屏 → UIA + OCR + CV图标 → 候选表（OCR 中心落在 UIA 框内时标 dup_of，保留供分析）

    window: 窗口名模糊匹配（如"微信"）——自动定位该顶层窗口 rect 作为 region，
    只感知窗口内元素（"帮我操作微信"场景的范围收窄）；匹配失败返回 windows 列表
    region=[x,y,w,h] 物理像素：OCR/CV 在裁剪区上跑（小图秒级返回），UIA 收集后按中心过滤，
    全部 bbox 统一平移回全屏坐标（点击直接可用）
    text_filter: 文字包含过滤（uia/ocr，大小写不敏感）；在 CV 图标排除之后执行，
    避免过滤后 OCR 框减少导致文字笔画被误判为图标
    max_items: 返回上限（超限按编号顺序截断，结果内注明截断前总数）"""
    if window and not region:
        rect = find_window_rect(window)
        if rect is None:
            return {"error": f"未找到名称含 {window!r} 的窗口", "windows": list_windows()}
        region = rect

    tmp = tempfile.gettempdir()
    stamp = int(time.time())
    shot_path = os.path.join(tmp, f"teegal_cu_shot_{stamp}.png")
    full_img = take_screenshot(shot_path)

    ox, oy = 0, 0
    img = full_img
    if region:
        ox, oy = int(region[0]), int(region[1])
        img = full_img[oy:oy + int(region[3]), ox:ox + int(region[2])]

    t0 = time.time()
    # UIA 段看门狗：UIA 跨进程 COM 调用碰到挂起/半初始化窗口（如托盘拉回中的微信）会无限阻塞，
    # 曾致 driver 整体 240s 超时被强杀——子线程限时 20s，超时放弃 UIA 段，OCR/CV 照常出候选
    import threading
    _uia_res: dict = {}
    def _uia_worker():
        try:
            _uia_res["items"] = uia_candidates(window_filter=window)
        except Exception:
            pass
    _th = threading.Thread(target=_uia_worker, daemon=True)
    _th.start()
    _th.join(20)
    uia = _uia_res.get("items") or []
    if region:
        # UIA bbox 天然是全屏坐标：按中心过滤即可，不平移（OCR/CV 的裁剪区坐标在下方 +ox/+oy 统一回全屏）
        uia = [c for c in uia
               if ox <= _center(c["bbox"])[0] < ox + region[2]
               and oy <= _center(c["bbox"])[1] < oy + region[3]]
    t1 = time.time()
    ocr = ocr_candidates(img)
    t2 = time.time()
    cv = cv_candidates(img, ocr_boxes=[c["bbox"] for c in ocr]) if icons else []
    t3 = time.time()
    if cv:
        cv = _pair_avatars(cv, ocr)

    if text_filter:
        tf = str(text_filter).lower()
        uia = [c for c in uia if tf in (c.get("text") or "").lower()]
        ocr = [c for c in ocr if tf in (c.get("text") or "").lower()]

    # 裁剪区坐标 → 全屏坐标（UIA 已在 region 分支平移）
    for c in ocr:
        c["bbox"] = [c["bbox"][0] + ox, c["bbox"][1] + oy, c["bbox"][2], c["bbox"][3]]
    for c in cv:
        c["bbox"] = [c["bbox"][0] + ox, c["bbox"][1] + oy, c["bbox"][2], c["bbox"][3]]

    cands = []
    for c in uia:
        c["id"] = len(cands) + 1
        c["center"] = _center(c["bbox"])
        cands.append(c)
    uia_n = len(cands)
    for c in ocr:
        c["id"] = len(cands) + 1
        c["center"] = _center(c["bbox"])
        cx, cy = c["center"]
        for u in cands[:uia_n]:
            ub = u["bbox"]
            if ub[0] <= cx <= ub[0] + ub[2] and ub[1] <= cy <= ub[1] + ub[3]:
                c["dup_of"] = u["id"]
                break
        cands.append(c)
    for c in cv:
        c["id"] = len(cands) + 1
        c["center"] = _center(c["bbox"])
        cands.append(c)

    total_before_trim = len(cands)
    if max_items and len(cands) > max_items:
        cands = cands[:max_items]

    annotated_path = None
    if annotate:
        annotated_path = os.path.join(tmp, f"teegal_cu_annotated_{stamp}.png")
        _annotate(full_img, cands, annotated_path)

    return {
        "screen": screen_info(),
        "screenshot": shot_path,
        "annotated": annotated_path,
        "candidates": cands,
        "total_before_trim": total_before_trim,
        "stats": {"uia": uia_n, "ocr": len(ocr), "cv": len(cv), "total": len(cands)},
        "elapsed": {"uia": round(t1 - t0, 2), "ocr": round(t2 - t1, 2), "cv": round(t3 - t2, 2)},
    }


def _annotate(img, cands, path):
    """标注图：UIA 橙框 / OCR 蓝框 / CV 图标绿框 + 编号，供人眼与 VLM 指认"""
    from PIL import Image, ImageDraw
    im = Image.fromarray(img).convert("RGB")
    d = ImageDraw.Draw(im)
    colors = {"uia": (255, 90, 0), "ocr": (0, 110, 255), "cv": (0, 160, 60)}
    for c in cands:
        x, y, w, h = c["bbox"]
        color = colors.get(c["source"], (128, 0, 128))
        d.rectangle([x, y, x + w, y + h], outline=color, width=2)
        d.text((x + 2, max(0, y - 13)), str(c["id"]), fill=color)
    im.save(path)


def do_click(x, y):
    """物理像素坐标点击（aware 进程内 SetCursorPos 即物理坐标）+ 光标回读"""
    user32 = ctypes.windll.user32
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.03)
    user32.mouse_event(2, 0, 0, 0, 0)   # LEFTDOWN
    time.sleep(0.04)
    user32.mouse_event(4, 0, 0, 0, 0)   # LEFTUP
    time.sleep(0.05)
    pt = wt.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return {"requested": [int(x), int(y)], "cursor": [pt.x, pt.y]}


def _set_clipboard(text):
    """写 CF_UNICODETEXT 到剪贴板（ctypes 原生，支持中文），不触发粘贴"""
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    # 64 位句柄安全：不声明 restype 时 HGLOBAL 会被截断为 32 位 int → access violation
    kernel32.GlobalAlloc.restype = wt.HGLOBAL
    kernel32.GlobalAlloc.argtypes = [wt.UINT, ctypes.c_size_t]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [wt.HGLOBAL]
    kernel32.GlobalUnlock.argtypes = [wt.HGLOBAL]
    user32.SetClipboardData.restype = wt.HANDLE
    user32.SetClipboardData.argtypes = [wt.UINT, wt.HANDLE]
    CF_UNICODETEXT, GMEM_MOVEABLE = 13, 0x0002
    buf = text.encode("utf-16-le") + b"\x00\x00"
    if not user32.OpenClipboard(None):
        return {"error": "OpenClipboard 失败（剪贴板被占用）"}
    try:
        user32.EmptyClipboard()
        h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(buf))
        p = kernel32.GlobalLock(h)
        ctypes.memmove(p, buf, len(buf))
        kernel32.GlobalUnlock(h)
        user32.SetClipboardData(CF_UNICODETEXT, h)
    finally:
        user32.CloseClipboard()
    return {"ok": True}


def do_type(text):
    """剪贴板写入 + Ctrl+V 粘贴。目标输入框的焦点由前置 click 保证。"""
    r = _set_clipboard(text)
    if r.get("error"):
        return r
    time.sleep(0.08)
    user32 = ctypes.windll.user32
    VK_CONTROL, VK_V = 0x11, 0x56
    user32.keybd_event(VK_CONTROL, 0, 0, 0)
    user32.keybd_event(VK_V, 0, 0, 0)
    time.sleep(0.03)
    user32.keybd_event(VK_V, 0, 2, 0)
    user32.keybd_event(VK_CONTROL, 0, 2, 0)
    time.sleep(0.05)
    return {"typed": text, "chars": len(text), "via": "clipboard+ctrlv"}


_KEY_MAP = {
    "enter": 0x0D, "return": 0x0D, "esc": 0x1B, "escape": 0x1B, "tab": 0x09,
    "backspace": 0x08, "delete": 0x2E, "del": 0x2E, "space": 0x20,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "insert": 0x2D, "win": 0x5B,
}
_KEY_MODS = {"ctrl": 0x11, "control": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B}


def do_key(name):
    """单键 / 组合键（如 enter、esc、ctrl+s、ctrl+shift+t），keybd_event 合成"""
    user32 = ctypes.windll.user32
    seq = []
    for part in str(name).lower().split("+"):
        p = part.strip()
        if not p:
            continue
        if p in _KEY_MODS:
            seq.append(_KEY_MODS[p])
        elif p in _KEY_MAP:
            seq.append(_KEY_MAP[p])
        elif len(p) == 1:
            seq.append(ord(p.upper()))
        elif p.startswith("f") and p[1:].isdigit():
            seq.append(0x70 + int(p[1:]) - 1)  # F1=0x70
        else:
            return {"error": f"未知按键: {p}"}
    if not seq:
        return {"error": "key 为空"}
    for vk in seq:
        user32.keybd_event(vk, 0, 0, 0)
        time.sleep(0.02)
    for vk in reversed(seq):
        user32.keybd_event(vk, 0, 2, 0)
        time.sleep(0.02)
    return {"key": name, "pressed": seq}


def _emit(data, out_path):
    text = json.dumps(data, ensure_ascii=False, indent=1)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"OK {out_path}")
    else:
        print(text)


def main():
    ap = argparse.ArgumentParser(description="Teegal ComputerUse 定位层")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pc = sub.add_parser("candidates", help="输出候选表")
    pc.add_argument("--out")
    pc.add_argument("--no-annotated", action="store_true")
    pc.add_argument("--region", help="x,y,w,h（物理像素，只感知该区域）")
    pc.add_argument("--window", help="窗口名模糊匹配（只感知该窗口，如 微信）")
    pc.add_argument("--filter", help="文字包含过滤")
    pc.add_argument("--max", type=int, default=200, help="返回上限")

    pck = sub.add_parser("click", help="物理像素坐标点击")
    pck.add_argument("--xy", required=True, help="x,y（物理像素）")
    pck.add_argument("--out")

    pt = sub.add_parser("type", help="剪贴板 + Ctrl+V 粘贴文本")
    pt.add_argument("--text", required=True)

    pk = sub.add_parser("key", help="单键/组合键")
    pk.add_argument("--name", required=True)

    args = ap.parse_args()

    if args.cmd == "candidates":
        region = None
        if args.region:
            region = [int(v) for v in args.region.split(",")]
        _emit(build_candidates(annotate=not args.no_annotated, region=region,
                               text_filter=args.filter, max_items=args.max,
                               window=args.window), args.out)
    elif args.cmd == "click":
        x, y = (int(v) for v in args.xy.split(","))
        _emit(do_click(x, y), args.out)
    elif args.cmd == "type":
        _emit(do_type(args.text), args.out)
    elif args.cmd == "key":
        _emit(do_key(args.name), args.out)


if __name__ == "__main__":
    # argv 为空 = 被工具驱动脚本拼接后整体执行（驱动段负责分发），跳过 CLI
    if len(sys.argv) > 1:
        main()
