/**
 * 桌面版（Electron）桥接。
 *
 * window.desktop 由 electron/preload.cjs 注入，只在桌面版存在；
 * 网页版拿不到它，所有调用点都应判空并回落到浏览器行为（下载 / input[type=file]）。
 */

export interface DesktopApi {
  isDesktop: true;
  /** 保存文本到用户选择的文件；saveAs 为 true 时重新选择位置；取消返回 null */
  saveJson(opts: { text: string; name: string; saveAs?: boolean }): Promise<{ path: string; name: string } | null>;
  /** 用系统对话框打开 JSON；取消返回 null */
  openJson(): Promise<{ path: string; name: string; text: string } | null>;
  /** 当前记住的文件名（首次保存或打开后才有） */
  fileName(): Promise<string | null>;
  /** 取消与文件的关联 */
  unbind(): Promise<void>;
  info(): Promise<{ app: string; electron: string; chrome: string; node: string }>;
}

export function desktop(): DesktopApi | null {
  const d = (window as unknown as { desktop?: DesktopApi }).desktop;
  return d && d.isDesktop ? d : null;
}

export function isDesktop(): boolean {
  return desktop() != null;
}
