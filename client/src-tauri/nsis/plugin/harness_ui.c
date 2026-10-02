// HarnessUI: an NSIS plugin for the Harness installer (installer.nsi).
//
// NSIS cannot draw a button with a hover state. This plugin subclasses a push button and paints
// it as text only: the background color of the installer, and a rounded highlight when the
// pointer is on the button (a stronger one while the button is pressed). Keyboard focus shows a
// thin rounded ring.
//
//   HarnessUI::Colors <bg> <text> <muted> <hover> <pressed>   ; Colors as 0xRRGGBB.
//   HarnessUI::TextButton <hwnd>                                 ; Paint this button as text.
//
// Build: build.cmd (MSVC, x86, Unicode). The DLL goes in ../plugins/x86-unicode.

#include <windows.h>
#include <commctrl.h>
#include <nsis/pluginapi.h>

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "uxtheme.lib")

#include <uxtheme.h>

#define SUBCLASS_ID 0x48524E53 // "HRNS"
#define HOT_PROP L"HarnessUI.Hot"

static HINSTANCE g_instance;
static COLORREF g_bg = RGB(31, 30, 29);
static COLORREF g_text = RGB(250, 249, 245);
static COLORREF g_muted = RGB(168, 165, 156);
static COLORREF g_hover = RGB(42, 41, 40);
static COLORREF g_pressed = RGB(58, 58, 55);

static COLORREF from_rgb(int value) {
  return RGB((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF);
}

static UINT dpi_of(HWND hwnd) {
  typedef UINT(WINAPI * GetDpiForWindowFn)(HWND);
  static GetDpiForWindowFn get_dpi;
  static BOOL looked;
  if (!looked) {
    get_dpi = (GetDpiForWindowFn)GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow");
    looked = TRUE;
  }
  UINT dpi = get_dpi ? get_dpi(hwnd) : 96;
  return dpi ? dpi : 96;
}

static void paint(HWND hwnd, HDC target) {
  RECT rc;
  GetClientRect(hwnd, &rc);
  int w = rc.right - rc.left, h = rc.bottom - rc.top;
  if (w <= 0 || h <= 0) return;

  HDC dc = CreateCompatibleDC(target);
  HBITMAP bmp = CreateCompatibleBitmap(target, w, h);
  HGDIOBJ old_bmp = SelectObject(dc, bmp);

  HBRUSH bg = CreateSolidBrush(g_bg);
  FillRect(dc, &rc, bg);
  DeleteObject(bg);

  BOOL enabled = IsWindowEnabled(hwnd);
  BOOL pressed = (SendMessageW(hwnd, BM_GETSTATE, 0, 0) & BST_PUSHED) != 0;
  BOOL hot = GetPropW(hwnd, HOT_PROP) != NULL;
  int radius = MulDiv(12, dpi_of(hwnd), 96); // The diameter of the corners: 6 px radius at 100 %.

  if (enabled && (hot || pressed)) {
    HBRUSH fill = CreateSolidBrush(pressed ? g_pressed : g_hover);
    HGDIOBJ old_brush = SelectObject(dc, fill);
    HGDIOBJ old_pen = SelectObject(dc, GetStockObject(NULL_PEN));
    RoundRect(dc, 0, 0, w + 1, h + 1, radius, radius);
    SelectObject(dc, old_pen);
    SelectObject(dc, old_brush);
    DeleteObject(fill);
  }

  LRESULT ui = SendMessageW(hwnd, WM_QUERYUISTATE, 0, 0);
  if (GetFocus() == hwnd && !(ui & UISF_HIDEFOCUS)) {
    HPEN ring = CreatePen(PS_SOLID, MulDiv(1, dpi_of(hwnd), 96), g_muted);
    HGDIOBJ old_pen = SelectObject(dc, ring);
    HGDIOBJ old_brush = SelectObject(dc, GetStockObject(NULL_BRUSH));
    RoundRect(dc, 0, 0, w, h, radius, radius);
    SelectObject(dc, old_brush);
    SelectObject(dc, old_pen);
    DeleteObject(ring);
  }

  WCHAR text[128];
  int len = GetWindowTextW(hwnd, text, (int)(sizeof(text) / sizeof(text[0])));
  HFONT font = (HFONT)SendMessageW(hwnd, WM_GETFONT, 0, 0);
  HGDIOBJ old_font = font ? SelectObject(dc, font) : NULL;
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, enabled ? g_text : g_muted);
  UINT flags = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS;
  if (ui & UISF_HIDEACCEL) flags |= DT_HIDEPREFIX;
  DrawTextW(dc, text, len, &rc, flags);
  if (old_font) SelectObject(dc, old_font);

  BitBlt(target, 0, 0, w, h, dc, 0, 0, SRCCOPY);
  SelectObject(dc, old_bmp);
  DeleteObject(bmp);
  DeleteDC(dc);
}

static LRESULT CALLBACK button_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR id, DWORD_PTR data) {
  switch (msg) {
    case WM_PAINT: {
      PAINTSTRUCT ps;
      HDC dc = BeginPaint(hwnd, &ps);
      paint(hwnd, dc);
      EndPaint(hwnd, &ps);
      return 0;
    }
    case WM_PRINTCLIENT:
      paint(hwnd, (HDC)wp);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_MOUSEMOVE:
      if (!GetPropW(hwnd, HOT_PROP)) {
        TRACKMOUSEEVENT tme = {sizeof(tme), TME_LEAVE, hwnd, 0};
        SetPropW(hwnd, HOT_PROP, (HANDLE)1);
        TrackMouseEvent(&tme);
        InvalidateRect(hwnd, NULL, FALSE);
      }
      break;
    case WM_MOUSELEAVE:
      RemovePropW(hwnd, HOT_PROP);
      InvalidateRect(hwnd, NULL, FALSE);
      break;
    case WM_NCDESTROY:
      RemovePropW(hwnd, HOT_PROP);
      RemoveWindowSubclass(hwnd, button_proc, id);
      break;
    case WM_LBUTTONDOWN:
    case WM_LBUTTONUP:
    case WM_CAPTURECHANGED:
    case WM_KEYDOWN:
    case WM_KEYUP:
    case WM_SETFOCUS:
    case WM_KILLFOCUS:
    case WM_ENABLE:
    case WM_SETTEXT:
    case WM_UPDATEUISTATE:
    case BM_SETSTATE:
    case BM_SETSTYLE:
    case BM_SETCHECK: {
      // The default button procedure can paint for these messages, outside WM_PAINT. Paint again.
      LRESULT result = DefSubclassProc(hwnd, msg, wp, lp);
      RedrawWindow(hwnd, NULL, NULL, RDW_INVALIDATE | RDW_UPDATENOW);
      return result;
    }
  }
  return DefSubclassProc(hwnd, msg, wp, lp);
}

// The DLL must stay loaded while the buttons use button_proc.
static UINT_PTR __cdecl plugin_callback(enum NSPIM msg) {
  return 0;
}

static void keep_loaded(extra_parameters *extra) {
  if (extra && extra->RegisterPluginCallback) extra->RegisterPluginCallback(g_instance, plugin_callback);
}

void __declspec(dllexport) Colors(HWND parent, int string_size, LPTSTR variables, stack_t **stacktop,
                                  extra_parameters *extra, ...) {
  EXDLL_INIT();
  keep_loaded(extra);
  g_bg = from_rgb(popint());
  g_text = from_rgb(popint());
  g_muted = from_rgb(popint());
  g_hover = from_rgb(popint());
  g_pressed = from_rgb(popint());
}

void __declspec(dllexport) TextButton(HWND parent, int string_size, LPTSTR variables, stack_t **stacktop,
                                      extra_parameters *extra, ...) {
  EXDLL_INIT();
  keep_loaded(extra);
  HWND button = (HWND)popintptr();
  if (!IsWindow(button)) return;
  SetWindowTheme(button, L"", L""); // No theme animations: this plugin paints the button.
  SetWindowSubclass(button, button_proc, SUBCLASS_ID, 0);
  InvalidateRect(button, NULL, TRUE);
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
  if (reason == DLL_PROCESS_ATTACH) g_instance = instance;
  return TRUE;
}
