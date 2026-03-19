import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Iterable

from pywinauto import Desktop, keyboard, mouse
import win32api
import win32con
import win32gui
import win32process


HOST_HINTS = {
    "wps": {
        "allow": ["writer", "document", ".doc", ".docx", "\u6587\u5b57", "\u6587\u6863", "opusapp"],
        "deny": ["\u5de5\u4f5c\u7c3f", "spreadsheet", "sheet", "\u6f14\u793a\u6587\u7a3f", "presentation"],
    },
    "et": {
        "allow": ["et", "spreadsheet", "sheet", "\u5de5\u4f5c\u7c3f", "xlmain"],
        "deny": ["\u6f14\u793a\u6587\u7a3f", "presentation"],
    },
    "wpp": {
        "allow": ["wpp", "presentation", "\u6f14\u793a\u6587\u7a3f", "pp12frameclass"],
        "deny": ["\u5de5\u4f5c\u7c3f", "spreadsheet", "sheet"],
    },
}

ASSISTANT_NEEDLES = [
    "3???",
    "??????",
    "????",
    "???",
    "????",
    "Agent ????",
]

ASSISTANT_SCAN_HANDLES = [201142, 201158, 4722436, 1577892]
TASKPANE_BROWSER_CLASSES = {"Chrome_RenderWidgetHostHWND", "Chrome_WidgetWin_0", "CefBrowserWindow"}
BENCH_FIXTURE_DOCX = r"C:\Users\Public\Documents\ah32_bench_fixture.docx"


@dataclass
class WinInfo:
    index: int
    handle: int
    title: str
    class_name: str
    process_id: int
    left: int
    top: int
    right: int
    bottom: int


@dataclass
class Rect:
    left: int
    top: int
    right: int
    bottom: int


def _safe_text(value) -> str:
    try:
        return str(value or "").strip()
    except Exception:
        return ""


def _host_for_target(target: WinInfo | None) -> str:
    if target is None:
        return "any"
    # Check structured hosts before the generic Writer fallback.
    # WPP top frames often look like "WPS Office - WPS Office", which also matches
    # Writer's loose title fallback. If we check Writer first, WPP gets misrouted
    # to Writer ribbon coordinates and the assistant never opens.
    for host in ("et", "wpp", "wps"):
        if _matches_host(host, target.title, target.class_name):
            return host
    return "any"


def _matches_host(host: str, title: str, class_name: str) -> bool:
    combined = f"{title} {class_name}".lower()
    is_wps_candidate = (
        "wps office" in combined
        or "kingsoft" in combined
        or class_name.lower() == "kpromemainwindow"
        or class_name.lower() == "opusapp"
    )
    if host == "any":
        return is_wps_candidate
    if not is_wps_candidate:
        return False

    hints = HOST_HINTS.get(host, {})
    deny = [str(token).lower() for token in hints.get("deny", [])]
    if any(token and token in combined for token in deny):
        return False

    allow = [str(token).lower() for token in hints.get("allow", [])]
    if any(token and token in combined for token in allow):
        return True

    if host == "wps":
        lowered_title = str(title or "").strip().lower()
        return lowered_title.endswith(" - wps office") or lowered_title.endswith("- wps office")

    return False


def _iter_wps_windows(host: str) -> Iterable[WinInfo]:
    out: list[WinInfo] = []

    def _cb(hwnd: int, _lparam) -> bool:
        try:
            if not win32gui.IsWindowVisible(hwnd):
                return True
            title = _safe_text(win32gui.GetWindowText(hwnd))
            class_name = _safe_text(win32gui.GetClassName(hwnd))
            if not title and not class_name:
                return True
            _tid, pid = win32process.GetWindowThreadProcessId(hwnd)
            if int(pid or 0) <= 0:
                return True
            if not _matches_host(host, title, class_name):
                return True
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            out.append(
                WinInfo(
                    index=len(out),
                    handle=int(hwnd),
                    title=title,
                    class_name=class_name,
                    process_id=int(pid),
                    left=int(left),
                    top=int(top),
                    right=int(right),
                    bottom=int(bottom),
                )
            )
        except Exception:
            return True
        return True

    win32gui.EnumWindows(_cb, None)
    return out


def _iter_child_hwnds(hwnd: int) -> Iterable[int]:
    children: list[int] = []

    def _cb(child: int, _lparam) -> bool:
        children.append(child)
        return True

    try:
        win32gui.EnumChildWindows(hwnd, _cb, None)
    except Exception:
        return []
    return children


def _select_window(host: str, index: int | None, title_contains: str | None = None) -> WinInfo:
    items = list(_iter_wps_windows(host))
    if not items:
        raise RuntimeError(f"no_visible_windows_for_host:{host}")
    if title_contains:
        needle = str(title_contains).strip().lower()
        for item in items:
            if needle and needle in item.title.lower():
                return item
        raise RuntimeError(f"title_not_found:{title_contains}")
    if index is None:
        return items[0]
    for item in items:
        if item.index == index:
            return item
    raise RuntimeError(f"window_index_not_found:{index}")


def _activate_window(hwnd: int) -> None:
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        else:
            win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
    except Exception:
        pass
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass
    try:
        win32gui.BringWindowToTop(hwnd)
    except Exception:
        pass
    time.sleep(0.4)


def _desktop_window(handle: int):
    return Desktop(backend="uia").window(handle=handle)


def _iter_descendants_text(handle: int) -> Iterable[tuple[str, str, str, tuple[int, int, int, int]]]:
    wrapper = _desktop_window(handle)
    for child in wrapper.descendants():
        try:
            info = child.element_info
            name = _safe_text(getattr(info, "name", ""))
            cls = _safe_text(getattr(info, "class_name", ""))
            ctrl = _safe_text(getattr(info, "control_type", ""))
            rect = child.rectangle()
            yield name, cls, ctrl, (rect.left, rect.top, rect.right, rect.bottom)
        except Exception:
            continue


def _click_ui_name(handle: int, name: str, cls: str | None = None) -> bool:
    wrapper = _desktop_window(handle)
    for child in wrapper.descendants():
        try:
            info = child.element_info
            child_name = _safe_text(getattr(info, "name", ""))
            child_cls = _safe_text(getattr(info, "class_name", ""))
            if child_name != name:
                continue
            if cls and child_cls != cls:
                continue
            child.click_input()
            return True
        except Exception:
            continue
    return False


def _has_modified_addin_dialog(target: WinInfo) -> bool:
    wrapper = _desktop_window(target.handle)
    for child in wrapper.descendants():
        try:
            info = child.element_info
            child_cls = _safe_text(getattr(info, "class_name", ""))
            if child_cls == "KWinMessageContentDlg":
                return True
        except Exception:
            continue
    return False


def _dismiss_modified_addin_dialog(target: WinInfo) -> bool:
    wrapper = _desktop_window(target.handle)
    dismissed = False
    for _ in range(6):
        if not _has_modified_addin_dialog(target):
            return dismissed
        clicked = False
        for child in wrapper.descendants():
            try:
                info = child.element_info
                child_name = _safe_text(getattr(info, "name", ""))
                child_cls = _safe_text(getattr(info, "class_name", ""))
                if child_cls != "KLiteButton" or child_name != "确定":
                    continue
                parent = child.parent()
                parent_info = parent.element_info if parent is not None else None
                parent_cls = _safe_text(getattr(parent_info, "class_name", "")) if parent_info is not None else ""
                grand = parent.parent() if parent is not None else None
                grand_info = grand.element_info if grand is not None else None
                grand_cls = _safe_text(getattr(grand_info, "class_name", "")) if grand_info is not None else ""
                if parent_cls not in {"QFrame", "KWinMessageContentDlg"} and grand_cls not in {"QFrame", "KWinMessageContentDlg"}:
                    continue
                child.click_input()
                clicked = True
                dismissed = True
                break
            except Exception:
                continue
        if not clicked:
            try:
                keyboard.send_keys("{ENTER}")
                dismissed = True
            except Exception:
                pass
        time.sleep(0.8)
    if dismissed:
        print("modified_addin_dialog=dismissed")
    return dismissed


def _click_auth_widget_button(target: WinInfo, button_name: str) -> bool:
    wrapper = _desktop_window(target.handle)
    queue: list[tuple[object, int, str, str]] = [(wrapper, 0, "", "")]
    while queue:
        node, depth, parent_cls, grand_cls = queue.pop(0)
        if depth > 4:
            continue
        try:
            children = list(node.children())
        except Exception:
            children = []
        for child in children:
            try:
                info = child.element_info
                child_name = _safe_text(getattr(info, "name", ""))
                child_cls = _safe_text(getattr(info, "class_name", ""))
                if child_name == button_name and child_cls in {"KLiteButton", ""}:
                    if parent_cls in {"KCefViewFailedPage", "KAuthPrivilegeWebWidget", ""} or grand_cls in {"KCefViewFailedPage", "KAuthPrivilegeWebWidget", ""}:
                        rect = getattr(info, "rectangle", None)
                        if rect is not None:
                            x = int((rect.left + rect.right) / 2)
                            y = int((rect.top + rect.bottom) / 2)
                            mouse.click(coords=(x, y))
                            print(f"auth_widget_button_clicked={button_name}")
                            return True
                queue.append((child, depth + 1, child_cls, parent_cls))
            except Exception:
                continue
    return False


def _has_auth_widget(target: WinInfo) -> bool:
    wrapper = _desktop_window(target.handle)
    for child in wrapper.descendants():
        try:
            info = child.element_info
            child_cls = _safe_text(getattr(info, "class_name", ""))
            if child_cls == "KAuthPrivilegeWebWidget":
                return True
        except Exception:
            continue
    return False


def _click_auth_widget_close_corner(target: WinInfo) -> bool:
    wrapper = _desktop_window(target.handle)
    for child in wrapper.descendants():
        try:
            info = child.element_info
            child_cls = _safe_text(getattr(info, "class_name", ""))
            if child_cls != "KAuthPrivilegeWebWidget":
                continue
            rect = child.rectangle()
            x = int(rect.right - 20)
            y = int(rect.top - 12 if rect.top > 20 else rect.top + 12)
            mouse.click(coords=(x, y))
            print("auth_widget_close_corner_clicked=True")
            return True
        except Exception:
            continue
    return False


def _dismiss_auth_widget(target: WinInfo) -> bool:
    dismissed = False
    for _ in range(8):
        if not _has_auth_widget(target):
            return dismissed
        clicked = False
        try:
            if _click_auth_widget_close_corner(target):
                clicked = True
                dismissed = True
        except Exception:
            pass
        for name in ("关闭", "确定", "取消", "以后再说", "稍后", "重试"):
            if clicked:
                break
            try:
                if _click_auth_widget_button(target, name):
                    print(f"auth_widget_dismiss_try={name}")
                    clicked = True
                    dismissed = True
                    break
            except Exception:
                continue
        if not clicked:
            try:
                keyboard.send_keys("{ESC}")
                clicked = True
            except Exception:
                pass
        time.sleep(0.8)
    return not _has_auth_widget(target) or dismissed


def _find_ribbon_rect(target: WinInfo) -> Rect | None:
    candidates: list[Rect] = []
    for child in _iter_child_hwnds(target.handle):
        try:
            cls = _safe_text(win32gui.GetClassName(child))
            title = _safe_text(win32gui.GetWindowText(child))
            if cls != "bosa_sdm_Microsoft Office Word 11.0" and title != "MsoDockTop":
                continue
            left, top, right, bottom = win32gui.GetWindowRect(child)
            if right > left and bottom > top:
                candidates.append(Rect(int(left), int(top), int(right), int(bottom)))
        except Exception:
            continue
    if not candidates:
        top = max(int(target.top), 0)
        bottom = max(top + 80, min(int(target.bottom), top + 170))
        right = max(int(target.right), int(target.left) + 400)
        return Rect(int(target.left), top + 40, right, bottom)
    candidates.sort(key=lambda r: ((r.right - r.left) * (r.bottom - r.top)), reverse=True)
    return candidates[0]


def _click_rect_point(rect: Rect, x_ratio: float, y_ratio: float) -> bool:
    try:
        width = max(1, rect.right - rect.left)
        height = max(1, rect.bottom - rect.top)
        x = rect.left + int(width * x_ratio)
        y = rect.top + int(height * y_ratio)
        mouse.click(coords=(x, y))
        return True
    except Exception:
        return False


def _rect_tuple(rect: Rect | None) -> tuple[int, int, int, int] | None:
    if rect is None:
        return None
    return (int(rect.left), int(rect.top), int(rect.right), int(rect.bottom))


def _click_rect_ratio(rect: Rect, x_ratio: float, y_ratio: float, label: str) -> bool:
    width = max(1, rect.right - rect.left)
    height = max(1, rect.bottom - rect.top)
    x = rect.left + int(width * x_ratio)
    y = rect.top + int(height * y_ratio)
    try:
        mouse.click(coords=(x, y))
        print(
            f"{label}=clicked rect={_rect_tuple(rect)} "
            f"at=({x},{y}) rel=({x_ratio:.4f},{y_ratio:.4f})"
        )
        return True
    except Exception as exc:
        print(f"{label}=failed rect={_rect_tuple(rect)} err={exc}")
        return False


def _click_ah32_tab(target: WinInfo) -> bool:
    rect = _find_ribbon_rect(target)
    if rect is None:
        return False
    host = _host_for_target(target)
    if host == "et":
        if _click_rect_ratio(rect, 0.73, 0.05, "assistant_tab_click_et"):
            time.sleep(0.8)
            return True
    if host == "wpp":
        if _click_rect_ratio(rect, 0.73, 0.05, "assistant_tab_click_wpp"):
            time.sleep(0.8)
            return True
    # Empirical ribbon ratios on maximized WPS Writer:
    # - Ah32 tab is near the upper row, around 63% width.
    # Keep a manual pixel fallback for older layouts.
    if _click_rect_ratio(rect, 0.63, 0.14, "assistant_tab_click_wps"):
        time.sleep(0.8)
        return True
    return _click_rect_point(Rect(0, 40, 1920, 150), 1207 / 1920, 15 / 110)


def _click_open_assistant_button(target: WinInfo) -> bool:
    rect = _find_ribbon_rect(target)
    if rect is None:
        return False
    host = _host_for_target(target)
    if host == "et":
        if _click_rect_ratio(rect, 0.53, 0.40, "assistant_button_click_et"):
            return True
    if host == "wpp":
        if _click_rect_ratio(rect, 0.53, 0.40, "assistant_button_click_wpp"):
            return True
    # Empirically, the left-most large button in the Ah32 ribbon group is "打开助手".
    # On 1920px-wide maximized Writer it sits around x=908, y=110.
    if _click_rect_ratio(rect, 0.473, 0.636, "assistant_button_click_wps"):
        return True
    return _click_rect_point(Rect(0, 40, 1920, 150), 908 / 1920, 70 / 110)


def _toggle_open_assistant(target: WinInfo, host: str = "wps") -> bool:
    for attempt in range(3):
        print(f"assistant_toggle_attempt={attempt + 1} host={host}")
        try:
            _activate_window(target.handle)
        except Exception:
            pass
        try:
            _dismiss_modified_addin_dialog(target)
        except Exception:
            pass
        if host == "wps":
            try:
                _dismiss_auth_widget(target)
            except Exception:
                pass
        if _assistant_seems_open_fast(target):
            print("assistant_toggle_state=already_open")
            return True
        tab_clicked = _click_ah32_tab(target)
        print(f"assistant_toggle_tab_clicked={tab_clicked}")
        if not tab_clicked:
            time.sleep(0.8)
            continue
        time.sleep(0.8)
        clicked = _click_open_assistant_button(target)
        print(f"assistant_toggle_button_clicked={clicked}")
        if not clicked:
            time.sleep(0.8)
            continue
        # "打开助手" in current WPS behaves like a toggle; if the first click races with
        # ribbon activation, a second click often opens the pane instead of doing nothing.
        for poll_idx in range(16):
            time.sleep(0.5)
            if _assistant_seems_open_fast(target):
                print("assistant_toggle_state=open_after_click")
                return True
            if poll_idx == 5:
                try:
                    _click_open_assistant_button(target)
                    print("assistant_toggle_button_clicked=retry")
                except Exception:
                    pass
    return False


def _assistant_visible_hits(target: WinInfo) -> list[tuple[str, str, str, tuple[int, int, int, int]]]:
    # Fast path only. Deep scanning multiple stale handles makes WPS UIA calls hang easily.
    # For automation we primarily rely on geometry/taskpane detection instead.
    return []


def _writer_doc_area_right_edges(target: WinInfo | None = None) -> list[int]:
    edges: list[int] = []
    if target is None:
        return edges

    seen: set[int] = set()

    def _walk(hwnd: int) -> None:
        if hwnd in seen:
            return
        seen.add(hwnd)
        try:
            cls = _safe_text(win32gui.GetClassName(hwnd))
            if cls in {"_WwF", "_WwB", "_WwG"}:
                left, top, right, bottom = win32gui.GetWindowRect(hwnd)
                if right > left and bottom > top:
                    edges.append(int(right))
        except Exception:
            pass
        for child in _iter_child_hwnds(hwnd):
            _walk(child)

    _walk(target.handle)
    return edges


def _normalize_writer_caption(text: str) -> str:
    s = str(text or "").strip().lower()
    for suffix in [
        " - wps office",
        " - wps 文字",
        "（预览）",
        "(preview)",
        "*",
    ]:
        s = s.replace(suffix, "")
    return "".join(ch for ch in s if not ch.isspace()).strip()


def _active_writer_doc_area_right_edge(target: WinInfo | None = None) -> int:
    if target is None:
        return 0

    active_caption = _normalize_writer_caption(target.title)
    best_match_hwnd: int | None = None
    best_match_score = -1
    fallback_docviews: list[tuple[int, int]] = []

    def _walk(hwnd: int, owner_wwb: int | None = None) -> None:
        nonlocal best_match_hwnd, best_match_score
        for child in _iter_child_hwnds(hwnd):
            try:
                cls = _safe_text(win32gui.GetClassName(child))
                title = _safe_text(win32gui.GetWindowText(child))
                left, top, right, bottom = win32gui.GetWindowRect(child)
                width = max(0, right - left)
                height = max(0, bottom - top)
            except Exception:
                continue

            current_owner = owner_wwb
            if cls == "_WwB":
                current_owner = child
                normalized = _normalize_writer_caption(title)
                score = -1
                if active_caption and normalized:
                    if normalized == active_caption:
                        score = 3
                    elif normalized.startswith(active_caption) or active_caption.startswith(normalized):
                        score = 2
                if score > best_match_score:
                    best_match_score = score
                    best_match_hwnd = child if score >= 0 else best_match_hwnd

            if cls == "_WwG":
                fallback_docviews.append((int(right), int(current_owner or 0)))

            _walk(child, current_owner)

    _walk(target.handle, None)

    if best_match_hwnd:
        matched_rights = [right for right, owner in fallback_docviews if owner == best_match_hwnd]
        if matched_rights:
            return max(matched_rights)

    if fallback_docviews:
        return max(right for right, _owner in fallback_docviews)

    edges = _writer_doc_area_right_edges(target)
    return max(edges) if edges else 0


def _taskpane_layout_visible(target: WinInfo, rect: Rect | None) -> bool:
    if rect is None:
        return False
    host = _host_for_target(target)
    if host in {"et", "wpp"}:
        pane_width = max(0, int(rect.right) - int(rect.left))
        pane_height = max(0, int(rect.bottom) - int(rect.top))
        # ET/WPP host window hierarchies differ a lot across builds:
        # some expose the taskpane against the full outer frame, others against a smaller inner frame.
        # If we already found a browser-sized pane, treat it as visible without insisting on a global-right-edge ratio.
        return pane_width >= 240 and pane_height >= 300
    doc_right = _active_writer_doc_area_right_edge(target)
    if doc_right <= 0:
        window_width = max(1, int(target.right) - int(target.left))
        pane_width = max(0, int(rect.right) - int(rect.left))
        return pane_width >= 280 and rect.left >= (target.left + int(window_width * 0.55))
    # A truly visible taskpane must squeeze the active doc view to the left.
    return doc_right <= (rect.left + 24)


def _find_taskpane_rect_raw(target: WinInfo) -> Rect | None:
    browser_rect = _find_taskpane_browser_rect_raw(target)
    if browser_rect is not None:
        return browser_rect
    host = _host_for_target(target)
    browser_candidates: list[Rect] = []
    fallback_candidates: list[Rect] = []
    doc_edges = _writer_doc_area_right_edges(target)
    narrowed_edges = [edge for edge in doc_edges if edge < (target.right - 80)]
    doc_right = min(narrowed_edges) if narrowed_edges else (max(doc_edges) if doc_edges else 0)

    def _walk(hwnd: int) -> None:
        children: list[int] = []

        def _cb(child: int, _lparam) -> bool:
            children.append(child)
            return True

        try:
            win32gui.EnumChildWindows(hwnd, _cb, None)
        except Exception:
            return

        for child in children:
            try:
                cls = _safe_text(win32gui.GetClassName(child))
                title = _safe_text(win32gui.GetWindowText(child))
                left, top, right, bottom = win32gui.GetWindowRect(child)
                width = max(0, right - left)
                height = max(0, bottom - top)
                if width >= 240 and height >= 300:
                    is_browser = cls in TASKPANE_BROWSER_CLASSES
                    is_right_side = left >= max(target.left + 320, doc_right - 24)
                    if is_browser and is_right_side:
                        browser_candidates.append(Rect(left, top, right, bottom))
                    elif is_right_side and cls in {"KxJSCTPWidget", "KxJSContentCTPWidget"}:
                        # Some WPS builds expose only a Qt taskpane host and hide the browser child.
                        # Keep this as a fallback so geometry-based taskpane clicks still work.
                        fallback_candidates.append(Rect(left, top, right, bottom))
                _walk(child)
            except Exception:
                continue

    _walk(target.handle)
    candidates = browser_candidates or fallback_candidates
    if not candidates:
        return None
    if host in {"et", "wpp"}:
        candidates.sort(key=lambda r: (r.left, (r.right - r.left) * (r.bottom - r.top)), reverse=True)
        return candidates[0]
    candidates.sort(key=lambda r: (r.left, (r.right - r.left) * (r.bottom - r.top)), reverse=True)
    return candidates[0]


def _find_taskpane_rect(target: WinInfo) -> Rect | None:
    rect = _find_taskpane_rect_raw(target)
    if not _taskpane_layout_visible(target, rect):
        return None
    return rect


def _find_taskpane_browser_rect_raw(target: WinInfo) -> Rect | None:
    hwnd = _find_taskpane_target_hwnd_raw(target)
    if not hwnd:
        return None
    try:
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    except Exception:
        return None
    if right <= left or bottom <= top:
        return None
    return Rect(int(left), int(top), int(right), int(bottom))


def _find_taskpane_browser_rect(target: WinInfo) -> Rect | None:
    rect = _find_taskpane_browser_rect_raw(target)
    if not _taskpane_layout_visible(target, rect):
        return None
    return rect


def _find_taskpane_target_hwnd_raw(target: WinInfo) -> int | None:
    matches: list[tuple[int, int, int, int]] = []
    host = _host_for_target(target)

    def _walk(hwnd: int) -> None:
        for child in _iter_child_hwnds(hwnd):
            try:
                cls = _safe_text(win32gui.GetClassName(child))
                left, top, right, bottom = win32gui.GetWindowRect(child)
                width = max(0, right - left)
                height = max(0, bottom - top)
                if width >= 240 and height >= 300 and cls in TASKPANE_BROWSER_CLASSES:
                    priority = {
                        "Chrome_RenderWidgetHostHWND": 3,
                        "Chrome_WidgetWin_0": 2,
                        "CefBrowserWindow": 1,
                    }.get(cls, 0)
                    matches.append((priority, int(left), width * height, int(child)))
                _walk(child)
            except Exception:
                continue

    _walk(target.handle)
    if not matches:
        return None
    if host in {"et", "wpp"}:
        matches.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    else:
        matches.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    return matches[0][3]


def _find_taskpane_target_hwnd(target: WinInfo) -> int | None:
    rect = _find_taskpane_browser_rect(target)
    if rect is None:
        return None
    return _find_taskpane_target_hwnd_raw(target)


def _click_hwnd_client(hwnd: int, client_x: int, client_y: int) -> bool:
    try:
        lparam = win32api.MAKELONG(int(client_x), int(client_y))
        win32gui.PostMessage(hwnd, win32con.WM_MOUSEMOVE, 0, lparam)
        time.sleep(0.05)
        win32gui.PostMessage(hwnd, win32con.WM_LBUTTONDOWN, win32con.MK_LBUTTON, lparam)
        time.sleep(0.05)
        win32gui.PostMessage(hwnd, win32con.WM_LBUTTONUP, 0, lparam)
        return True
    except Exception:
        return False


def _taskpane_click(target: WinInfo, x_rel: float, y_rel: float) -> Rect:
    rect = _find_taskpane_browser_rect(target) or _find_taskpane_rect(target)
    if rect is None:
        raise RuntimeError("taskpane_rect_not_found")
    width = max(1, rect.right - rect.left)
    height = max(1, rect.bottom - rect.top)
    abs_x = rect.left + int(width * x_rel)
    abs_y = rect.top + int(height * y_rel)
    mouse.move(coords=(abs_x, abs_y))
    time.sleep(0.08)
    mouse.click(coords=(abs_x, abs_y))
    print(
        f"taskpane_clicked rect=({rect.left},{rect.top},{rect.right},{rect.bottom}) "
        f"at=({abs_x},{abs_y}) rel=({x_rel:.4f},{y_rel:.4f})"
    )
    return rect


def _taskpane_wheel(target: WinInfo, x_rel: float, y_rel: float, delta: int) -> Rect:
    rect = _find_taskpane_rect(target)
    if rect is None:
        raise RuntimeError("taskpane_rect_not_found")
    width = max(1, rect.right - rect.left)
    height = max(1, rect.bottom - rect.top)
    abs_x = rect.left + int(width * x_rel)
    abs_y = rect.top + int(height * y_rel)
    mouse.move(coords=(abs_x, abs_y))
    time.sleep(0.1)
    mouse.scroll(coords=(abs_x, abs_y), wheel_dist=delta)
    print(
        f"taskpane_scrolled rect=({rect.left},{rect.top},{rect.right},{rect.bottom}) "
        f"at=({abs_x},{abs_y}) rel=({x_rel:.4f},{y_rel:.4f}) delta={delta}"
    )
    return rect


def _taskpane_drag(target: WinInfo, x1_rel: float, y1_rel: float, x2_rel: float, y2_rel: float) -> Rect:
    rect = _find_taskpane_rect(target)
    if rect is None:
        raise RuntimeError("taskpane_rect_not_found")
    width = max(1, rect.right - rect.left)
    height = max(1, rect.bottom - rect.top)
    x1 = rect.left + int(width * x1_rel)
    y1 = rect.top + int(height * y1_rel)
    x2 = rect.left + int(width * x2_rel)
    y2 = rect.top + int(height * y2_rel)
    mouse.press(coords=(x1, y1))
    time.sleep(0.15)
    mouse.move(coords=(x2, y2))
    time.sleep(0.15)
    mouse.release(coords=(x2, y2))
    print(
        f"taskpane_dragged rect=({rect.left},{rect.top},{rect.right},{rect.bottom}) "
        f"from=({x1},{y1}) rel_from=({x1_rel:.4f},{y1_rel:.4f}) "
        f"to=({x2},{y2}) rel_to=({x2_rel:.4f},{y2_rel:.4f})"
    )
    return rect


def _focus_taskpane(target: WinInfo) -> Rect:
    rect = _find_taskpane_rect(target)
    if rect is None:
        raise RuntimeError("taskpane_rect_not_found")
    center_x = rect.left + max(12, int((rect.right - rect.left) * 0.5))
    center_y = rect.top + max(12, int((rect.bottom - rect.top) * 0.5))
    try:
        mouse.click(coords=(center_x, center_y))
    except Exception:
        pass
    time.sleep(0.15)
    return rect


def _assistant_seems_open(target: WinInfo) -> bool:
    if len(_assistant_visible_hits(target)) > 0:
        return True
    return _assistant_seems_open_fast(target)


def _assistant_seems_open_fast(target: WinInfo | None = None) -> bool:
    if target is None:
        return False
    host = _host_for_target(target)
    if host in {"et", "wpp"}:
        if _find_taskpane_browser_rect_raw(target) is not None:
            return True
        raw = _find_taskpane_rect_raw(target)
        if raw is None:
            return False
        return _taskpane_layout_visible(target, raw)
    return _find_taskpane_rect(target) is not None


def _ensure_writer_document_via_com() -> bool:
    try:
        import pythoncom
        import win32com.client
    except Exception:
        return False

    try:
        pythoncom.CoInitialize()
    except Exception:
        pass

    for progid in ("kwps.Application", "wps.Application"):
        try:
            app = win32com.client.Dispatch(progid)
            try:
                app.Visible = True
            except Exception:
                pass
            docs = getattr(app, "Documents", None)
            if docs is None:
                continue
            if os.path.exists(BENCH_FIXTURE_DOCX) and hasattr(docs, "Open"):
                doc = docs.Open(BENCH_FIXTURE_DOCX)
            else:
                doc = docs.Add()
            try:
                if not os.path.exists(BENCH_FIXTURE_DOCX):
                    target_dir = r"C:\Users\Public\Documents"
                    os.makedirs(target_dir, exist_ok=True)
                    target_path = os.path.join(target_dir, f"ah32_autobench_{int(time.time() * 1000)}.docx")
                    if hasattr(doc, "SaveAs2"):
                        doc.SaveAs2(target_path)
                    elif hasattr(doc, "SaveAs"):
                        doc.SaveAs(target_path)
            except Exception:
                pass
            try:
                app.Activate()
            except Exception:
                pass
            return True
        except Exception:
            continue
    return False


def _ensure_et_workbook_via_com() -> bool:
    try:
        import win32com.client  # type: ignore
    except Exception:
        return False

    for progid in ("ket.Application", "KET.Application"):
        try:
            app = win32com.client.Dispatch(progid)
            try:
                app.Visible = True
            except Exception:
                pass
            wb = None
            try:
                wb = app.ActiveWorkbook
            except Exception:
                wb = None
            if wb is None:
                try:
                    workbooks = getattr(app, "Workbooks", None)
                    if workbooks is not None:
                        if getattr(workbooks, "Count", 0) > 0:
                            wb = workbooks.Item(1)
                        elif hasattr(workbooks, "Add"):
                            wb = workbooks.Add()
                except Exception:
                    wb = None
            if wb is None:
                continue
            try:
                app.Activate()
            except Exception:
                pass
            return True
        except Exception:
            continue
    return False


def _ensure_wpp_presentation_via_com() -> bool:
    try:
        import win32com.client  # type: ignore
    except Exception:
        return False

    for progid in ("kwpp.Application", "KWPP.Application"):
        try:
            app = win32com.client.Dispatch(progid)
            try:
                app.Visible = True
            except Exception:
                pass
            pres = None
            try:
                pres = app.ActivePresentation
            except Exception:
                pres = None
            if pres is None:
                try:
                    presentations = getattr(app, "Presentations", None)
                    if presentations is not None:
                        if getattr(presentations, "Count", 0) > 0:
                            pres = presentations.Item(1)
                        elif hasattr(presentations, "Add"):
                            pres = presentations.Add()
                except Exception:
                    pres = None
            if pres is None:
                continue
            try:
                app.Activate()
            except Exception:
                pass
            return True
        except Exception:
            continue
    return False


def _ensure_writer_editor_ready(target: WinInfo) -> bool:
    try:
        current_title = _safe_text(win32gui.GetWindowText(target.handle)).lower()
    except Exception:
        current_title = ""
    if current_title and current_title != "wps office - wps office":
        return True

    if _ensure_writer_document_via_com():
        for _ in range(20):
            time.sleep(0.4)
            try:
                refreshed = _select_window("wps", None)
                title = _safe_text(win32gui.GetWindowText(refreshed.handle)).lower()
            except Exception:
                title = ""
            if title and title != "wps office - wps office":
                return True

    try:
        keyboard.send_keys("{ESC}")
    except Exception:
        pass
    time.sleep(0.25)
    try:
        keyboard.send_keys("^n")
    except Exception:
        return False
    for _ in range(12):
        time.sleep(0.5)
        edges = _writer_doc_area_right_edges(target)
        try:
            title = _safe_text(win32gui.GetWindowText(target.handle)).lower()
        except Exception:
            title = ""
        if edges and title != "wps office - wps office":
            return True
    return False


def _ensure_et_editor_ready(_target: WinInfo) -> bool:
    if _ensure_et_workbook_via_com():
        time.sleep(0.8)
        return True
    try:
        keyboard.send_keys("{ESC}")
    except Exception:
        pass
    time.sleep(0.25)
    try:
        keyboard.send_keys("^n")
    except Exception:
        return False
    time.sleep(1.0)
    return True


def _ensure_wpp_editor_ready(_target: WinInfo) -> bool:
    if _ensure_wpp_presentation_via_com():
        time.sleep(0.8)
        return True
    try:
        keyboard.send_keys("{ESC}")
    except Exception:
        pass
    time.sleep(0.25)
    try:
        keyboard.send_keys("^n")
    except Exception:
        return False
    time.sleep(1.0)
    return True


def _ensure_host_editor_ready(host: str, target: WinInfo) -> bool:
    normalized = str(host or "").strip().lower()
    if normalized == "et":
        return _ensure_et_editor_ready(target)
    if normalized == "wpp":
        return _ensure_wpp_editor_ready(target)
    return _ensure_writer_editor_ready(target)


def cmd_list(host: str) -> int:
    items = list(_iter_wps_windows(host))
    if not items:
        print("no_visible_windows")
        return 2
    for item in items:
        print(
            f"[{item.index}] pid={item.process_id} hwnd={item.handle} "
            f"class={item.class_name!r} rect=({item.left},{item.top},{item.right},{item.bottom}) "
            f"title={item.title!r}"
        )
    return 0


def cmd_dump(host: str, index: int | None, title_contains: str | None, depth: int, limit: int) -> int:
    target = _select_window(host, index, title_contains)
    wrapper = _desktop_window(target.handle)
    print(
        f"target index={target.index} hwnd={target.handle} pid={target.process_id} "
        f"class={target.class_name!r} title={target.title!r}"
    )
    seen = 0

    def walk(node, level: int) -> None:
        nonlocal seen
        if seen >= limit or level > depth:
            return
        try:
            info = node.element_info
            name = _safe_text(getattr(info, "name", ""))
            cls = _safe_text(getattr(info, "class_name", ""))
            ctrl = _safe_text(getattr(info, "control_type", ""))
            rid = _safe_text(getattr(info, "automation_id", ""))
            rect = node.rectangle()
            print(
                f"{'  ' * level}- level={level} name={name!r} class={cls!r} "
                f"ctrl={ctrl!r} auto_id={rid!r} rect=({rect.left},{rect.top},{rect.right},{rect.bottom})"
            )
            seen += 1
            if seen >= limit:
                return
            for child in node.children():
                walk(child, level + 1)
                if seen >= limit:
                    return
        except Exception as exc:
            print(f"{'  ' * level}- error={exc}")

    walk(wrapper, 0)
    return 0


def cmd_click_relative(host: str, index: int | None, title_contains: str | None, x_rel: float, y_rel: float, focus: bool) -> int:
    target = _select_window(host, index, title_contains)
    if focus:
        _activate_window(target.handle)
    wrapper = _desktop_window(target.handle)
    if focus:
        try:
            wrapper.set_focus()
            time.sleep(0.3)
        except Exception:
            pass
    width = max(1, target.right - target.left)
    height = max(1, target.bottom - target.top)
    abs_x = target.left + int(width * x_rel)
    abs_y = target.top + int(height * y_rel)
    mouse.click(coords=(abs_x, abs_y))
    print(
        f"clicked hwnd={target.handle} title={target.title!r} "
        f"at=({abs_x},{abs_y}) rel=({x_rel:.4f},{y_rel:.4f})"
    )
    return 0


def cmd_activate(host: str, index: int | None, title_contains: str | None) -> int:
    target = _select_window(host, index, title_contains)
    _activate_window(target.handle)
    left, top, right, bottom = win32gui.GetWindowRect(target.handle)
    print(
        f"activated hwnd={target.handle} title={target.title!r} "
        f"rect=({left},{top},{right},{bottom})"
    )
    return 0


def cmd_assistant_state(host: str, index: int | None, title_contains: str | None) -> int:
    target = _select_window(host, index, title_contains)
    _activate_window(target.handle)
    edges = _writer_doc_area_right_edges(target)
    rect = _find_taskpane_browser_rect(target)
    visible_rect = _find_taskpane_rect(target)
    raw_rect = _find_taskpane_browser_rect_raw(target)
    active_doc_right = _active_writer_doc_area_right_edge(target)
    is_open = visible_rect is not None
    print(
        f"assistant_open={is_open} "
        f"taskpane_rect={None if rect is None else (rect.left, rect.top, rect.right, rect.bottom)} "
        f"visible_rect={None if visible_rect is None else (visible_rect.left, visible_rect.top, visible_rect.right, visible_rect.bottom)} "
        f"raw_rect={None if raw_rect is None else (raw_rect.left, raw_rect.top, raw_rect.right, raw_rect.bottom)} "
        f"active_doc_right={active_doc_right} "
        f"doc_area_right_edges={edges}"
    )
    return 0


def cmd_toggle_ah32_assistant(host: str, index: int | None, title_contains: str | None) -> int:
    target = _select_window(host, index, title_contains)
    _activate_window(target.handle)
    ok = _toggle_open_assistant(target, host)
    print(f"toggle_sent={ok}")
    return 0 if ok else 2


def cmd_ensure_ah32_assistant_open(host: str, index: int | None, title_contains: str | None) -> int:
    target = _select_window(host, index, title_contains)
    _activate_window(target.handle)
    try:
        _dismiss_modified_addin_dialog(target)
    except Exception:
        pass
    if host == "wps":
        try:
            if _dismiss_auth_widget(target):
                time.sleep(2.0)
        except Exception:
            pass
    before_open = _assistant_seems_open_fast(target)
    if host == "wps" and before_open:
        print("assistant_state=already_open")
        print(f"doc_area_right_edges={_writer_doc_area_right_edges(target)}")
        return 0
    ok = _toggle_open_assistant(target, host)
    after_open = _assistant_seems_open_fast(target)
    if after_open:
        print("assistant_state=open_after_toggle")
        print(f"doc_area_right_edges={_writer_doc_area_right_edges(target)}")
        return 0
    if host == "wps":
        try:
            if _dismiss_auth_widget(target):
                time.sleep(1.0)
                ok = _toggle_open_assistant(target, host) or ok
                after_open = _assistant_seems_open_fast(target)
                if after_open:
                    print("assistant_state=open_after_retry_close")
                    print(f"doc_area_right_edges={_writer_doc_area_right_edges(target)}")
                    return 0
        except Exception:
            pass
    print(f"assistant_state=unknown_after_toggle toggle_sent={ok} doc_area_right_edges={_writer_doc_area_right_edges(target)}")
    return 2


def cmd_ensure_writer_editor(host: str, index: int | None, title_contains: str | None) -> int:
    target = _select_window(host, index, title_contains)
    _activate_window(target.handle)
    ok = _ensure_host_editor_ready(host, target)
    print(f"host_editor_ready={ok} host={host} doc_area_right_edges={_writer_doc_area_right_edges(target)}")
    return 0 if ok else 2


def cmd_dump_win32_children(host: str, index: int | None, title_contains: str | None, depth: int) -> int:
    target = _select_window(host, index, title_contains)
    print(
        f"target index={target.index} hwnd={target.handle} pid={target.process_id} "
        f"class={target.class_name!r} title={target.title!r}"
    )

    def walk(hwnd: int, level: int) -> None:
        if level > depth:
            return
        try:
            title = _safe_text(win32gui.GetWindowText(hwnd))
        except Exception:
            title = ""
        try:
            cls = _safe_text(win32gui.GetClassName(hwnd))
        except Exception:
            cls = ""
        try:
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        except Exception:
            left = top = right = bottom = 0
        try:
            _tid, pid = win32process.GetWindowThreadProcessId(hwnd)
        except Exception:
            pid = 0
        print(
            f"{'  ' * level}- hwnd={hwnd} pid={pid} class={cls!r} "
            f"title={title!r} rect=({left},{top},{right},{bottom})"
        )
        if level >= depth:
            return

        children: list[int] = []

        def _cb(child: int, _lparam) -> bool:
            children.append(child)
            return True

        try:
            win32gui.EnumChildWindows(hwnd, _cb, None)
        except Exception:
            return
        for child in children:
            walk(child, level + 1)

    walk(target.handle, 0)
    return 0


def cmd_taskpane_info(host: str, index: int | None, title_contains: str | None) -> int:
    target = _select_window(host, index, title_contains)
    rect = _find_taskpane_rect(target)
    if rect is None:
        raw_rect = _find_taskpane_rect_raw(target)
        active_doc_right = _active_writer_doc_area_right_edge(target)
        print(
            "taskpane_rect_not_found "
            f"raw_rect={None if raw_rect is None else (raw_rect.left, raw_rect.top, raw_rect.right, raw_rect.bottom)} "
            f"active_doc_right={active_doc_right}"
        )
        return 2
    browser_rect = _find_taskpane_browser_rect(target)
    raw_rect = _find_taskpane_rect_raw(target)
    print(
        f"taskpane_rect=({rect.left},{rect.top},{rect.right},{rect.bottom}) "
        f"browser_rect={None if browser_rect is None else (browser_rect.left, browser_rect.top, browser_rect.right, browser_rect.bottom)} "
        f"raw_rect={None if raw_rect is None else (raw_rect.left, raw_rect.top, raw_rect.right, raw_rect.bottom)} "
        f"active_doc_right={_active_writer_doc_area_right_edge(target)}"
    )
    return 0


def cmd_taskpane_click_relative(host: str, index: int | None, title_contains: str | None, x_rel: float, y_rel: float, focus: bool) -> int:
    target = _select_window(host, index, title_contains)
    if focus:
        _activate_window(target.handle)
    _taskpane_click(target, x_rel, y_rel)
    return 0


def cmd_taskpane_scroll(host: str, index: int | None, title_contains: str | None, x_rel: float, y_rel: float, delta: int, focus: bool) -> int:
    target = _select_window(host, index, title_contains)
    if focus:
        _activate_window(target.handle)
    _taskpane_wheel(target, x_rel, y_rel, delta)
    return 0


def cmd_taskpane_drag_relative(
    host: str,
    index: int | None,
    title_contains: str | None,
    x1_rel: float,
    y1_rel: float,
    x2_rel: float,
    y2_rel: float,
    focus: bool,
) -> int:
    target = _select_window(host, index, title_contains)
    if focus:
        _activate_window(target.handle)
    _taskpane_drag(target, x1_rel, y1_rel, x2_rel, y2_rel)
    return 0


def cmd_taskpane_send_keys(host: str, index: int | None, title_contains: str | None, keys_spec: str, focus: bool) -> int:
    target = _select_window(host, index, title_contains)
    if focus:
        _activate_window(target.handle)
    rect = _focus_taskpane(target)
    keyboard.send_keys(keys_spec)
    print(
        f"taskpane_keys_sent rect=({rect.left},{rect.top},{rect.right},{rect.bottom}) "
        f"keys={keys_spec!r}"
    )
    return 0


def cmd_bench_start(host: str, index: int | None, title_contains: str | None, focus: bool) -> int:
    target = _select_window(host, index, title_contains)
    if focus:
        _activate_window(target.handle)
    rect = _focus_taskpane(target)
    keyboard.send_keys("^~")
    print(
        f"bench_start_sent rect=({rect.left},{rect.top},{rect.right},{rect.bottom}) "
        "strategy=taskpane_ctrl_enter"
    )
    return 0


def cmd_bench_open(host: str, index: int | None, title_contains: str | None, focus: bool) -> int:
    target = _select_window(host, index, title_contains)
    if focus:
        _activate_window(target.handle)
    rect = _focus_taskpane(target)
    keyboard.send_keys("^%b")
    print(
        f"bench_open_sent rect=({rect.left},{rect.top},{rect.right},{rect.bottom}) "
        "strategy=taskpane_ctrl_alt_b"
    )
    return 0


def cmd_bench_resume(host: str, index: int | None, title_contains: str | None, focus: bool) -> int:
    target = _select_window(host, index, title_contains)
    if focus:
        _activate_window(target.handle)
    rect = _focus_taskpane(target)
    keyboard.send_keys("^+~")
    print(
        f"bench_resume_sent rect=({rect.left},{rect.top},{rect.right},{rect.bottom}) "
        "strategy=taskpane_ctrl_shift_enter"
    )
    return 0


def cmd_bench_stop(host: str, index: int | None, title_contains: str | None, focus: bool) -> int:
    target = _select_window(host, index, title_contains)
    if focus:
        _activate_window(target.handle)
    rect = _focus_taskpane(target)
    keyboard.send_keys("{ESC}")
    print(
        f"bench_stop_sent rect=({rect.left},{rect.top},{rect.right},{rect.bottom}) "
        "strategy=taskpane_escape"
    )
    return 0


def cmd_dismiss_modified_dialog(host: str, index: int | None, title_contains: str | None) -> int:
    target = _select_window(host, index, title_contains)
    ok = _dismiss_modified_addin_dialog(target)
    print(f"modified_addin_dialog_dismissed={ok}")
    return 0 if ok else 2



def _inspect_wps_state() -> dict:
    try:
        import pythoncom  # type: ignore
        import win32com.client  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"pywin32_unavailable:{exc}") from exc

    pythoncom.CoInitialize()
    last_error: Exception | None = None
    for progid in ("kwps.Application", "wps.Application"):
        try:
            app = win32com.client.Dispatch(progid)
            doc = None
            try:
                doc = app.ActiveDocument
            except Exception:
                doc = None
            if not doc:
                try:
                    docs = app.Documents
                    if docs and docs.Count >= 1:
                        doc = docs.Item(1)
                except Exception:
                    doc = None
            if not doc:
                continue
            return {
                "host": "wps",
                "app_progid": progid,
                "document_name": _safe_text(getattr(doc, "Name", "")),
                "full_name": _safe_text(getattr(doc, "FullName", "")),
                "paragraph_count": int(getattr(getattr(doc, "Paragraphs", None), "Count", 0) or 0),
            }
        except Exception as exc:
            last_error = exc
            continue
    raise RuntimeError(f"active_document_missing:{last_error}")


def _inspect_et_state() -> dict:
    try:
        import pythoncom  # type: ignore
        import win32com.client  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"pywin32_unavailable:{exc}") from exc

    pythoncom.CoInitialize()
    last_error: Exception | None = None
    for progid in ("ket.Application", "et.Application", "KET.Application", "ET.Application"):
        try:
            app = win32com.client.Dispatch(progid)
            wb = None
            try:
                wb = app.ActiveWorkbook
            except Exception:
                wb = None
            if not wb:
                try:
                    books = app.Workbooks
                    if books and books.Count >= 1:
                        wb = books.Item(1)
                except Exception:
                    wb = None
            if not wb:
                continue
            sheet_names: list[str] = []
            sheet_summaries: list[dict] = []
            chart_titles: list[str] = []
            chart_count = 0
            worksheets = getattr(wb, "Worksheets", None)
            sheet_total = int(getattr(worksheets, "Count", 0) or 0)
            for idx in range(1, sheet_total + 1):
                sheet = worksheets.Item(idx)
                sheet_name = _safe_text(getattr(sheet, "Name", ""))
                sheet_names.append(sheet_name)
                used_range = ""
                try:
                    used_range = _safe_text(sheet.UsedRange.Address)
                except Exception:
                    used_range = ""
                sheet_chart_titles: list[str] = []
                sheet_chart_count = 0
                try:
                    chart_objects = sheet.ChartObjects()
                    sheet_chart_count = int(getattr(chart_objects, "Count", 0) or 0)
                    for chart_idx in range(1, sheet_chart_count + 1):
                        try:
                            chart = chart_objects.Item(chart_idx).Chart
                            title = ""
                            try:
                                if bool(getattr(chart, "HasTitle", False)):
                                    title = _safe_text(chart.ChartTitle.Text)
                            except Exception:
                                title = ""
                            if title:
                                chart_titles.append(title)
                                sheet_chart_titles.append(title)
                        except Exception:
                            continue
                except Exception:
                    sheet_chart_count = 0
                chart_count += sheet_chart_count
                sheet_summaries.append(
                    {
                        "name": sheet_name,
                        "used_range": used_range,
                        "chart_count": sheet_chart_count,
                        "chart_titles": sheet_chart_titles,
                    }
                )
            freeze_panes = False
            try:
                freeze_panes = bool(app.ActiveWindow.FreezePanes)
            except Exception:
                freeze_panes = False
            return {
                "host": "et",
                "app_progid": progid,
                "workbook_name": _safe_text(getattr(wb, "Name", "")),
                "full_name": _safe_text(getattr(wb, "FullName", "")),
                "sheet_count": len(sheet_names),
                "sheet_names": sheet_names,
                "freeze_panes": freeze_panes,
                "chart_count": chart_count,
                "chart_titles": chart_titles,
                "sheets": sheet_summaries,
            }
        except Exception as exc:
            last_error = exc
            continue
    raise RuntimeError(f"active_workbook_missing:{last_error}")


def _text_codepoints(text: str) -> str:
    return "-".join(f"{ord(ch):04X}" for ch in (text or ""))


def _shape_text(shape) -> str:
    try:
        if not bool(getattr(shape, "HasTextFrame", False)):
            return ""
        frame = getattr(shape, "TextFrame", None)
        if frame is None or not bool(getattr(frame, "HasText", False)):
            return ""
        text = _safe_text(frame.TextRange.Text)
        return text.replace("\r\n", "\n").replace("\r", "\n").strip()
    except Exception:
        return ""


def _inspect_wpp_state() -> dict:
    try:
        import pythoncom  # type: ignore
        import win32com.client  # type: ignore
    except Exception as exc:
        raise RuntimeError(f"pywin32_unavailable:{exc}") from exc

    pythoncom.CoInitialize()
    last_error: Exception | None = None
    for progid in ("kwpp.Application", "KWPP.Application", "wpp.Application", "WPP.Application"):
        try:
            app = win32com.client.Dispatch(progid)
            pres = None
            try:
                pres = app.ActivePresentation
            except Exception:
                pres = None
            if not pres:
                try:
                    presentations = app.Presentations
                    if presentations and presentations.Count >= 1:
                        pres = presentations.Item(1)
                except Exception:
                    pres = None
            if not pres:
                continue
            slides = getattr(pres, "Slides", None)
            slide_total = int(getattr(slides, "Count", 0) or 0)
            slide_summaries: list[dict] = []
            slide_titles: list[str] = []
            for idx in range(1, slide_total + 1):
                slide = slides.Item(idx)
                title = ""
                text_samples: list[str] = []
                shape_count = int(getattr(getattr(slide, "Shapes", None), "Count", 0) or 0)
                for shape_idx in range(1, shape_count + 1):
                    try:
                        shape = slide.Shapes.Item(shape_idx)
                    except Exception:
                        continue
                    text = _shape_text(shape)
                    if not text:
                        continue
                    compact = text.replace("\n", " / ")
                    if not title:
                        title = compact.split(" / ", 1)[0].strip()
                    if compact not in text_samples:
                        text_samples.append(compact)
                if title:
                    slide_titles.append(title)
                slide_summaries.append(
                    {
                        "index": idx,
                        "title": title,
                        "title_codepoints": _text_codepoints(title),
                        "shape_count": shape_count,
                        "texts": text_samples[:5],
                    }
                )
            return {
                "host": "wpp",
                "app_progid": progid,
                "presentation_name": _safe_text(getattr(pres, "Name", "")),
                "full_name": _safe_text(getattr(pres, "FullName", "")),
                "slide_count": slide_total,
                "slide_titles": slide_titles,
                "slide_title_codes": [_text_codepoints(title) for title in slide_titles],
                "slides": slide_summaries,
            }
        except Exception as exc:
            last_error = exc
            continue
    raise RuntimeError(f"active_presentation_missing:{last_error}")


def cmd_inspect_host_state(host: str) -> int:
    if host == "wps":
        state = _inspect_wps_state()
    elif host == "et":
        state = _inspect_et_state()
    elif host == "wpp":
        state = _inspect_wpp_state()
    else:
        print("inspect_host_state_requires_specific_host")
        return 2
    print(json.dumps(state, ensure_ascii=False))
    return 0

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="WPS/ET/WPP taskpane desktop automation PoC")
    parser.add_argument("--host", choices=["any", "wps", "et", "wpp"], default="any")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list-windows", help="list visible candidate windows")

    p_dump = sub.add_parser("dump-controls", help="dump a window UIA subtree")
    p_dump.add_argument("--index", type=int, default=None)
    p_dump.add_argument("--title-contains", type=str, default=None)
    p_dump.add_argument("--depth", type=int, default=3)
    p_dump.add_argument("--limit", type=int, default=150)

    p_click = sub.add_parser("click-relative", help="click relative coordinates inside a target window")
    p_click.add_argument("--index", type=int, default=None)
    p_click.add_argument("--title-contains", type=str, default=None)
    p_click.add_argument("--x-rel", type=float, required=True)
    p_click.add_argument("--y-rel", type=float, required=True)
    p_click.add_argument("--focus", action="store_true")

    p_activate = sub.add_parser("activate-window", help="restore and bring a target window to foreground")
    p_activate.add_argument("--index", type=int, default=None)
    p_activate.add_argument("--title-contains", type=str, default=None)

    p_state = sub.add_parser("assistant-state", help="best-effort detect whether Ah32 assistant seems open")
    p_state.add_argument("--index", type=int, default=None)
    p_state.add_argument("--title-contains", type=str, default=None)

    p_toggle_assistant = sub.add_parser("toggle-ah32-assistant", help="click Ah32 tab then click the open-assistant toggle once")
    p_toggle_assistant.add_argument("--index", type=int, default=None)
    p_toggle_assistant.add_argument("--title-contains", type=str, default=None)

    p_ensure_assistant = sub.add_parser("ensure-ah32-assistant-open", help="open Ah32 assistant only when best-effort state probe says it is currently closed")
    p_ensure_assistant.add_argument("--index", type=int, default=None)
    p_ensure_assistant.add_argument("--title-contains", type=str, default=None)

    p_ensure_editor = sub.add_parser("ensure-host-editor", help="best-effort ensure the target host has an active editable document/workbook/presentation")
    p_ensure_editor.add_argument("--index", type=int, default=None)
    p_ensure_editor.add_argument("--title-contains", type=str, default=None)

    p_ensure_writer_editor = sub.add_parser("ensure-writer-editor", help="compat alias for ensure-host-editor")
    p_ensure_writer_editor.add_argument("--index", type=int, default=None)
    p_ensure_writer_editor.add_argument("--title-contains", type=str, default=None)

    p_dump_win32 = sub.add_parser("dump-win32-children", help="dump Win32 child window tree")
    p_dump_win32.add_argument("--index", type=int, default=None)
    p_dump_win32.add_argument("--title-contains", type=str, default=None)
    p_dump_win32.add_argument("--depth", type=int, default=2)

    p_taskpane_info = sub.add_parser("taskpane-info", help="print detected taskpane browser rect")
    p_taskpane_info.add_argument("--index", type=int, default=None)
    p_taskpane_info.add_argument("--title-contains", type=str, default=None)

    p_taskpane_click = sub.add_parser("taskpane-click-relative", help="click relative coordinates inside the detected taskpane browser rect")
    p_taskpane_click.add_argument("--index", type=int, default=None)
    p_taskpane_click.add_argument("--title-contains", type=str, default=None)
    p_taskpane_click.add_argument("--x-rel", type=float, required=True)
    p_taskpane_click.add_argument("--y-rel", type=float, required=True)
    p_taskpane_click.add_argument("--focus", action="store_true")

    p_taskpane_scroll = sub.add_parser("taskpane-scroll", help="scroll inside the detected taskpane browser rect")
    p_taskpane_scroll.add_argument("--index", type=int, default=None)
    p_taskpane_scroll.add_argument("--title-contains", type=str, default=None)
    p_taskpane_scroll.add_argument("--x-rel", type=float, default=0.5)
    p_taskpane_scroll.add_argument("--y-rel", type=float, default=0.5)
    p_taskpane_scroll.add_argument("--delta", type=int, required=True)
    p_taskpane_scroll.add_argument("--focus", action="store_true")

    p_taskpane_drag = sub.add_parser("taskpane-drag-relative", help="drag between two relative points inside the detected taskpane browser rect")
    p_taskpane_drag.add_argument("--index", type=int, default=None)
    p_taskpane_drag.add_argument("--title-contains", type=str, default=None)
    p_taskpane_drag.add_argument("--x1-rel", type=float, required=True)
    p_taskpane_drag.add_argument("--y1-rel", type=float, required=True)
    p_taskpane_drag.add_argument("--x2-rel", type=float, required=True)
    p_taskpane_drag.add_argument("--y2-rel", type=float, required=True)
    p_taskpane_drag.add_argument("--focus", action="store_true")

    p_taskpane_keys = sub.add_parser("taskpane-send-keys", help="focus the detected taskpane and send keyboard input")
    p_taskpane_keys.add_argument("--index", type=int, default=None)
    p_taskpane_keys.add_argument("--title-contains", type=str, default=None)
    p_taskpane_keys.add_argument("--keys", type=str, required=True)
    p_taskpane_keys.add_argument("--focus", action="store_true")

    p_bench_start = sub.add_parser("bench-start", help="start macro bench using the known stable start click path")
    p_bench_start.add_argument("--index", type=int, default=None)
    p_bench_start.add_argument("--title-contains", type=str, default=None)
    p_bench_start.add_argument("--focus", action="store_true")

    p_bench_open = sub.add_parser("bench-open", help="open macro bench panel using the taskpane hotkey")
    p_bench_open.add_argument("--index", type=int, default=None)
    p_bench_open.add_argument("--title-contains", type=str, default=None)
    p_bench_open.add_argument("--focus", action="store_true")

    p_bench_resume = sub.add_parser("bench-resume", help="resume chat bench using the known stable resume click path")
    p_bench_resume.add_argument("--index", type=int, default=None)
    p_bench_resume.add_argument("--title-contains", type=str, default=None)
    p_bench_resume.add_argument("--focus", action="store_true")

    p_bench_stop = sub.add_parser("bench-stop", help="stop bench using the known stable Escape path")
    p_bench_stop.add_argument("--index", type=int, default=None)
    p_bench_stop.add_argument("--title-contains", type=str, default=None)
    p_bench_stop.add_argument("--focus", action="store_true")

    p_dismiss_dialog = sub.add_parser("dismiss-modified-dialog", help="dismiss the WPS add-in modified confirmation dialog by clicking 确定")
    p_dismiss_dialog.add_argument("--index", type=int, default=None)
    p_dismiss_dialog.add_argument("--title-contains", type=str, default=None)

    sub.add_parser("inspect-host-state", help="dump active host document/workbook/presentation summary as JSON")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.cmd == "list-windows":
        return cmd_list(args.host)
    if args.cmd == "dump-controls":
        return cmd_dump(args.host, args.index, args.title_contains, args.depth, args.limit)
    if args.cmd == "click-relative":
        return cmd_click_relative(args.host, args.index, args.title_contains, args.x_rel, args.y_rel, args.focus)
    if args.cmd == "activate-window":
        return cmd_activate(args.host, args.index, args.title_contains)
    if args.cmd == "assistant-state":
        return cmd_assistant_state(args.host, args.index, args.title_contains)
    if args.cmd == "toggle-ah32-assistant":
        return cmd_toggle_ah32_assistant(args.host, args.index, args.title_contains)
    if args.cmd == "ensure-ah32-assistant-open":
        return cmd_ensure_ah32_assistant_open(args.host, args.index, args.title_contains)
    if args.cmd == "ensure-host-editor":
        return cmd_ensure_writer_editor(args.host, args.index, args.title_contains)
    if args.cmd == "ensure-writer-editor":
        return cmd_ensure_writer_editor(args.host, args.index, args.title_contains)
    if args.cmd == "dump-win32-children":
        return cmd_dump_win32_children(args.host, args.index, args.title_contains, args.depth)
    if args.cmd == "taskpane-info":
        return cmd_taskpane_info(args.host, args.index, args.title_contains)
    if args.cmd == "taskpane-click-relative":
        return cmd_taskpane_click_relative(args.host, args.index, args.title_contains, args.x_rel, args.y_rel, args.focus)
    if args.cmd == "taskpane-scroll":
        return cmd_taskpane_scroll(args.host, args.index, args.title_contains, args.x_rel, args.y_rel, args.delta, args.focus)
    if args.cmd == "taskpane-drag-relative":
        return cmd_taskpane_drag_relative(
            args.host, args.index, args.title_contains, args.x1_rel, args.y1_rel, args.x2_rel, args.y2_rel, args.focus
        )
    if args.cmd == "taskpane-send-keys":
        return cmd_taskpane_send_keys(args.host, args.index, args.title_contains, args.keys, args.focus)
    if args.cmd == "bench-start":
        return cmd_bench_start(args.host, args.index, args.title_contains, args.focus)
    if args.cmd == "bench-open":
        return cmd_bench_open(args.host, args.index, args.title_contains, args.focus)
    if args.cmd == "bench-resume":
        return cmd_bench_resume(args.host, args.index, args.title_contains, args.focus)
    if args.cmd == "bench-stop":
        return cmd_bench_stop(args.host, args.index, args.title_contains, args.focus)
    if args.cmd == "dismiss-modified-dialog":
        return cmd_dismiss_modified_dialog(args.host, args.index, args.title_contains)
    if args.cmd == "inspect-host-state":
        return cmd_inspect_host_state(args.host)
    parser.print_help()
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        raise SystemExit(130)



