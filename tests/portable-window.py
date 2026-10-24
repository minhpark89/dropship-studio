"""Inspect/capture/close only a verified test Electron PID's main window."""
import ctypes
import json
import sys
from ctypes import wintypes

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
user32.SetProcessDPIAware()
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsIconic.argtypes = [wintypes.HWND]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]
gdi32.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]

class Header(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("width", wintypes.LONG), ("height", wintypes.LONG),
                ("planes", wintypes.WORD), ("bits", wintypes.WORD), ("compression", wintypes.DWORD),
                ("image_size", wintypes.DWORD), ("xppm", wintypes.LONG), ("yppm", wintypes.LONG),
                ("colors", wintypes.DWORD), ("important", wintypes.DWORD)]

pid = int(sys.argv[1])
action = sys.argv[2] if len(sys.argv) > 2 else "inspect"
windows = []
callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

@callback_type
def visit(handle, unused):
    owner = wintypes.DWORD()
    user32.GetWindowThreadProcessId(handle, ctypes.byref(owner))
    if owner.value != pid:
        return True
    title = ctypes.create_unicode_buffer(1024)
    kind = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(handle, title, len(title))
    user32.GetClassNameW(handle, kind, len(kind))
    dialog_action = action.endswith("-dialog")
    if dialog_action and kind.value != "#32770":
        return True
    if not dialog_action and (kind.value != "Chrome_WidgetWin_1" or "Dropship Studio" not in title.value):
        return True
    rect = wintypes.RECT()
    user32.GetWindowRect(handle, ctypes.byref(rect))
    info = {"handle": int(handle), "pid": pid, "title": title.value,
            "visible": bool(user32.IsWindowVisible(handle)), "minimized": bool(user32.IsIconic(handle)),
            "bounds": [rect.left, rect.top, rect.right, rect.bottom]}
    if dialog_action:
        children = []
        @callback_type
        def child_text(child, ignored):
            text = ctypes.create_unicode_buffer(16384)
            user32.GetWindowTextW(child, text, len(text))
            if text.value:
                children.append(text.value)
            return True
        user32.EnumChildWindows.argtypes = [wintypes.HWND, callback_type, wintypes.LPARAM]
        user32.EnumChildWindows(handle, child_text, 0)
        info["text"] = children
    if action in ("capture", "capture-dialog"):
        from PIL import Image
        width = rect.right - rect.left
        height = rect.bottom - rect.top
        dc = user32.GetDC(handle)
        memory = gdi32.CreateCompatibleDC(dc)
        bitmap = gdi32.CreateCompatibleBitmap(dc, width, height)
        previous = gdi32.SelectObject(memory, bitmap)
        try:
            if not user32.PrintWindow(handle, memory, 2):
                raise RuntimeError("PrintWindow failed")
            header = Header(ctypes.sizeof(Header), width, -height, 1, 32, 0, width * height * 4, 0, 0, 0, 0)
            pixels = ctypes.create_string_buffer(width * height * 4)
            if not gdi32.GetDIBits(memory, bitmap, 0, height, pixels, ctypes.byref(header), 0):
                raise RuntimeError("GetDIBits failed")
            Image.frombuffer("RGB", (width, height), pixels.raw, "raw", "BGRX", 0, 1).save(sys.argv[3])
            info["screenshot"] = sys.argv[3]
        finally:
            gdi32.SelectObject(memory, previous)
            gdi32.DeleteObject(bitmap)
            gdi32.DeleteDC(memory)
            user32.ReleaseDC(handle, dc)
    elif action in ("close", "close-dialog"):
        info["closePosted"] = bool(user32.PostMessageW(handle, 0x0010, 0, 0))
    windows.append(info)
    return True

user32.EnumWindows(visit, 0)
print(json.dumps({"pid": pid, "action": action, "windows": windows}))
