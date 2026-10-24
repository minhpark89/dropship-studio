"""Inspect only windows owned by the explicit test browser process."""
import ctypes
import json
import sys
from ctypes import wintypes

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()
user32.GetForegroundWindow.restype = wintypes.HWND
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsIconic.argtypes = [wintypes.HWND]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
target_pid = int(sys.argv[1])
action = sys.argv[2] if len(sys.argv) > 2 else "inspect"
windows = []
foreground = user32.GetForegroundWindow()
screen = {
    "left": user32.GetSystemMetrics(76),
    "top": user32.GetSystemMetrics(77),
    "width": user32.GetSystemMetrics(78),
    "height": user32.GetSystemMetrics(79),
}
callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


@callback_type
def inspect_window(handle, parameter):
    process_id = wintypes.DWORD()
    user32.GetWindowThreadProcessId(handle, ctypes.byref(process_id))
    if process_id.value != target_pid:
        return True
    class_name = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(handle, class_name, len(class_name))
    if class_name.value != "Chrome_WidgetWin_1":
        return True
    title = ctypes.create_unicode_buffer(1024)
    user32.GetWindowTextW(handle, title, len(title))
    rectangle = wintypes.RECT()
    user32.GetWindowRect(handle, ctypes.byref(rectangle))
    on_screen = (
        rectangle.right > screen["left"]
        and rectangle.bottom > screen["top"]
        and rectangle.left < screen["left"] + screen["width"]
        and rectangle.top < screen["top"] + screen["height"]
    )
    windows.append({
        "handle": int(handle),
        "title": title.value,
        "visible": bool(user32.IsWindowVisible(handle)),
        "minimized": bool(user32.IsIconic(handle)),
        "foreground": handle == foreground,
        "onScreen": on_screen,
        "rectangle": {
            "left": rectangle.left,
            "top": rectangle.top,
            "right": rectangle.right,
            "bottom": rectangle.bottom,
        },
    })
    if action == "minimize":
        user32.ShowWindow(handle, 6)
    return True


user32.EnumWindows(inspect_window, 0)
print(json.dumps({"pid": target_pid, "action": action, "screen": screen, "windows": windows}))
