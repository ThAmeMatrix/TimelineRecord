import { boundFileName, saveJson } from '../local/transfer';
import { toastError, useStore } from '../store';

const MEDIA_PREF = 'tl-export-media';

/** 保存 JSON 时是否包含图片/视频等本地媒体（默认包含） */
export function exportMediaPref(): boolean {
  try {
    return localStorage.getItem(MEDIA_PREF) !== '0';
  } catch {
    return true;
  }
}

export function setExportMediaPref(v: boolean): void {
  try {
    localStorage.setItem(MEDIA_PREF, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

let saving = false;

/** 保存到 JSON 文件（Ctrl+S）；saveAs 时总是让用户重新选择位置 */
export async function saveNow(saveAs = false): Promise<void> {
  if (saving) return;
  saving = true;
  const toast = useStore.getState().toast;
  try {
    const name = await saveJson({ saveAs, includeMedia: exportMediaPref() });
    if (name) toast(`已保存到 ${name}`, 'success');
  } catch (err) {
    toastError(err);
  } finally {
    saving = false;
  }
}

export { boundFileName };
