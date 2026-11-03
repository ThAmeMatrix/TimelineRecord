'use strict';

/**
 * 打包后瘦身：Electron 默认把所有语言的资源、以及 WebGPU 相关的 DX 编译器一起带上，
 * 本应用都用不到，删掉后体积能小一截（见 scripts/afterPack.cjs 与 README「桌面版」一节）。
 */

const fs = require('node:fs');
const path = require('node:path');

const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);
const REMOVE_FILES = [
  'dxcompiler.dll', // WebGPU / Dawn 的 DX 着色器编译器，应用不使用
  'vk_swiftshader.dll', // Vulkan 软件渲染回退：本应用只有 2D 界面，无 GPU 时走 Chromium 的 CPU 合成
  'vk_swiftshader_icd.json',
  'electron_wer.dll', // Windows 错误报告上报，不需要
  'vulkan-1.dll', // Vulkan 加载器：Windows 上 ANGLE 默认走 D3D11，且已移除 SwiftShader
];

module.exports = async (context) => {
  const dir = context.appOutDir;
  const removed = [];

  const locales = path.join(dir, 'locales');
  if (fs.existsSync(locales)) {
    for (const name of fs.readdirSync(locales)) {
      if (KEEP_LOCALES.has(name)) continue;
      const file = path.join(locales, name);
      removed.push(`locales/${name}`);
      fs.rmSync(file, { force: true });
    }
  }

  for (const name of REMOVE_FILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    removed.push(name);
    fs.rmSync(file, { force: true });
  }

  console.log(`afterPack: removed ${removed.length} files from ${dir}`);
};
