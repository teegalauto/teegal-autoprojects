# -*- coding: utf-8 -*-
"""
定位层 ground-truth 测试编排（全自动，真值全部来自确定性代码，无人工标注）

T1 OCR 定位精度：tkinter 真值窗口（winfo 坐标 = 物理像素真值），
   OCR 候选中心 vs 真值中心偏差 —— 证明"截屏→OCR→bbox"整链路坐标系正确
T2 UIA×OCR 交叉一致性：同一物理元素（文字归一化相等的配对）UIA rect 中心 vs OCR 框
   中心偏差 —— 证明两源同坐标系（tk.Button 是 Tk 自绘控件，UIA 抓不到，属预期）
T3 点击闭环：用定位层候选坐标真实点击 → tkinter 事件回读比对 —— 验证坐标+执行全链路

用法:
  python test_locator.py            # 完整测试（含点击，跑时勿动鼠标）
  python test_locator.py --no-click # 只测定位
"""
import json
import os
import statistics
import subprocess
import sys
import time

import ctypes

HERE = os.path.dirname(os.path.abspath(__file__))
LOCATOR = os.path.join(HERE, "..", "locator.py")
OUT = os.path.join(HERE, "_out")
os.makedirs(OUT, exist_ok=True)

TRUTH = os.path.join(OUT, "truth.json")
EVENTS = os.path.join(OUT, "events.json")
CAND = os.path.join(OUT, "candidates.json")


def force_topmost():
    """跑 locator 前一刻用 Win32 强制测试窗口置顶+前台。
    tkinter 的 lift 竞不过正在被用户使用的 TRAE（截图帧被盖 → 按钮残缺），
    必须把"置顶"压到截图前毫秒级"""
    hwnd = ctypes.windll.user32.FindWindowW(None, "LocTestWindow")
    if hwnd:
        SWP_NOSIZE, SWP_NOMOVE, SWP_SHOWWINDOW = 0x0001, 0x0002, 0x0040
        ctypes.windll.user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0,
                                          SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
        ctypes.windll.user32.SetForegroundWindow(hwnd)

_norm = lambda s: (s or "").replace(" ", "").replace("_", "")


def run(cmd, timeout=120):
    return subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout, cwd=HERE)


def pct(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, int(p / 100 * len(s)))]


def match_candidates(t, cands):
    """按唯一前缀匹配候选（归一化空格/下划线后包含即命中，前缀含 BTN_ 保证环境零碰撞）。
    返回 (uia_best, ocr_best)：各源取离真值中心最近者 (dist, cand)；无则 None"""
    tcx = t["x"] + t["w"] // 2
    tcy = t["y"] + t["h"] // 2
    uia_hits, ocr_hits = [], []
    for c in cands:
        if _norm(t["prefix"]) not in _norm(c.get("text")):
            continue
        dist = ((c["center"][0] - tcx) ** 2 + (c["center"][1] - tcy) ** 2) ** 0.5
        (uia_hits if c["source"] == "uia" else ocr_hits).append((dist, c))
    best = lambda hits: min(hits, key=lambda h: h[0]) if hits else None
    return best(uia_hits), best(ocr_hits)


def cross_check(cands, margin=15):
    """T2: UIA×OCR 交叉一致性。
    两源语义不同（UIA 框控件、OCR 框文字），正确问法不是"中心重合"而是
    "OCR 文字框落在 UIA 控件框外扩 margin 内"——成立即证明两源同一物理坐标系。
    配对规则 = 文字归一化相等（双方同认一个字符串），排除跨窗口误配对"""
    ocr_by_text = {}
    for c in cands:
        if c["source"] == "ocr" and len(c["text"].strip()) >= 2:
            ocr_by_text.setdefault(_norm(c["text"]), []).append(c)
    total, contained = 0, 0
    misses = []
    for c in cands:
        if c["source"] != "uia" or len(c["text"].strip()) < 2:
            continue
        for o in ocr_by_text.get(_norm(c["text"]), []):
            ux, uy, uw, uh = c["bbox"]
            ox, oy, ow, oh = o["bbox"]
            # 排除同文字但物理位置不同的（另一窗口同名元素）
            ocx, ocy = o["center"]
            if not (ux - 80 <= ocx <= ux + uw + 80 and uy - 80 <= ocy <= uy + uh + 80):
                continue
            total += 1
            inside = (ux - margin <= ox and oy >= uy - margin
                      and ox + ow <= ux + uw + margin and oy + oh <= uy + uh + margin)
            if inside:
                contained += 1
            else:
                misses.append((c["text"], c["bbox"], o["bbox"]))
            break
    return total, contained, misses


def main():
    only_locate = "--no-click" in sys.argv
    for f in (TRUTH, EVENTS):
        if os.path.exists(f):
            os.remove(f)

    # 1. 起真值窗口
    win = subprocess.Popen([sys.executable, os.path.join(HERE, "test_window.py"), TRUTH, EVENTS],
                           cwd=HERE)
    try:
        # 2. 等真值就绪
        truth = None
        deadline = time.time() + 15
        while time.time() < deadline:
            if os.path.exists(TRUTH):
                try:
                    t = json.load(open(TRUTH, encoding="utf-8"))
                    if len(t) == 5:
                        truth = t
                        break
                except Exception:
                    pass
            time.sleep(0.3)
        if not truth:
            print("❌ 真值窗口未就绪")
            sys.exit(2)
        time.sleep(0.8)  # 等窗口完全稳定

        # 3. 跑定位层（前置顶压制：截图帧必须完整拍到真值窗口）
        force_topmost()
        r = run([sys.executable, LOCATOR, "candidates", "--out", CAND])
        if r.returncode != 0:
            print("❌ locator 失败:\n" + (r.stderr or r.stdout)[-2000:])
            sys.exit(2)
        data = json.load(open(CAND, encoding="utf-8"))
        cands = data["candidates"]
        print("═══ 定位层 ground-truth 测试 ═══")
        print(f"屏幕: {data['screen']}")
        print(f"候选: UIA {data['stats']['uia']} | OCR {data['stats']['ocr']} | 合计 {data['stats']['total']}"
              f"  (UIA {data['elapsed']['uia']}s / OCR {data['elapsed']['ocr']}s)\n")

        # 4. T1 OCR 定位精度（受控真值）
        print("T1 OCR 定位精度（真值 = tkinter winfo 物理坐标）:")
        rows = []
        for t in truth:
            uia_best, ocr_best = match_candidates(t, cands)
            cn_ok = any(c["source"] == "ocr" and t["cn_word"] in _norm(c.get("text")) for c in cands)
            rows.append({
                "name": t["name"],
                "ocr_err": ocr_best[0] if ocr_best else None,
                "cn": cn_ok,
                "pick": ocr_best,
            })
            fmt = lambda v: f"{v:.1f}px" if v is not None else "—"
            print(f"  {t['name']:<22} OCR {fmt(rows[-1]['ocr_err'])} | 中文识别 {'✓' if cn_ok else '✗'}")

        ocr_errs = [r["ocr_err"] for r in rows if r["ocr_err"] is not None]
        n = len(truth)
        cn_n = sum(1 for r in rows if r["cn"])
        t1_ok = False
        if ocr_errs:
            print(f"  ▶ OCR 命中 {len(ocr_errs)}/{n} | 误差 P50 {statistics.median(ocr_errs):.1f}"
                  f" P95 {pct(ocr_errs, 95):.1f} max {max(ocr_errs):.1f}px | 中文词识别 {cn_n}/{n}")
            t1_ok = len(ocr_errs) == n and max(ocr_errs) <= 15

        # 5. T2 UIA×OCR 交叉一致性
        total, contained, misses = cross_check(cands)
        t2_ok = False
        print(f"\nT2 UIA×OCR 交叉一致性（OCR 文字框 ⊆ UIA 控件框外扩15px，同文字配对）:")
        if total:
            print(f"  ▶ 配对 {total} 组，包含 {contained} 组（{contained / total * 100:.0f}%）")
            for text, ub, ob in misses[:5]:
                print(f"    ✗ {text!r} UIA{ub} vs OCR{ob}")
            t2_ok = contained / total >= 0.8
        else:
            print("  ▶ 无配对样本（两源文字无交集）")

        # 6. T3 点击闭环
        click_ok = None
        if not only_locate:
            print("\nT3 点击回读闭环（用定位层坐标真实点击，请勿动鼠标）:")
            time.sleep(0.5)
            clicked = 0
            for row in rows:
                if not row["pick"]:
                    print(f"  {row['name']:<22} 无候选，跳过")
                    continue
                dist, c = row["pick"]
                cx, cy = c["center"]
                rr = run([sys.executable, LOCATOR, "click", "--xy", f"{cx},{cy}"], timeout=30)
                if rr.returncode != 0:
                    print(f"  {row['name']:<22} click 执行失败: {(rr.stderr or '')[-200:]}")
                    continue
                clicked += 1
                time.sleep(0.3)
            time.sleep(0.6)
            evs = []
            if os.path.exists(EVENTS):
                evs = json.load(open(EVENTS, encoding="utf-8"))
            by_name = {}
            for e in evs:
                by_name.setdefault(e["name"], []).append(e)
            passed = 0
            for row in rows:
                if not row["pick"]:
                    continue
                _, c = row["pick"]
                got = by_name.get(row["name"], [])
                if not got:
                    print(f"  {row['name']:<22} ✗ 未收到点击事件 (点击了 {c['center']})")
                    continue
                e = got[0]
                err = ((e["x_root"] - c["center"][0]) ** 2 + (e["y_root"] - c["center"][1]) ** 2) ** 0.5
                ok = err <= 5
                passed += 1 if ok else 0
                print(f"  {row['name']:<22} {'✓' if ok else '✗'} 定位{c['center']} → 事件"
                      f"({e['x_root']},{e['y_root']}) 误差 {err:.1f}px")
            print(f"  ▶ 点击闭环通过 {passed}/{clicked}")
            click_ok = clicked == n and passed == n

        # 7. 结论
        print("\n═══ 结论 ═══")
        print(f"T1 OCR 定位精度: {'✅ 通过（全部命中且 max ≤ 15px）' if t1_ok else '❌ 未达标'}")
        print(f"T2 UIA×OCR 一致性: {'✅ 通过（两源同坐标系）' if t2_ok else '❌ 未达标'}")
        if click_ok is not None:
            print(f"T3 点击闭环: {'✅ 通过' if click_ok else '❌ 未达标'}")
        print(f"标注图: {data['annotated']}")

        ok = t1_ok and t2_ok and (click_ok is None or click_ok)
        sys.exit(0 if ok else 1)
    finally:
        try:
            win.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    main()
