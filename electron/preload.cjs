'use strict';

/** 只暴露最小的一组能力给页面；网页版没有 window.desktop，调用点会回落浏览器行为 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  /** 保存到系统文件（saveAs 时重新选择位置）；取消返回 null */
  saveJson: (opts) => ipcRenderer.invoke('desktop:save', opts),
  /** 用系统对话框打开 JSON，返回 { name, text }；取消返回 null */
  openJson: () => ipcRenderer.invoke('desktop:open'),
  /** 当前绑定的文件名 */
  fileName: () => ipcRenderer.invoke('desktop:fileName'),
  unbind: () => ipcRenderer.invoke('desktop:unbind'),
  info: () => ipcRenderer.invoke('desktop:info'),
});
