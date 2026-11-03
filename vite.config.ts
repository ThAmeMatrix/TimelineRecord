import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 开发 / 预览时自带的跨域代理：./cors-proxy?url=<目标地址>
 * 用于豆瓣、必应图片、百度图片等不允许浏览器跨域访问的网站；构建产物是纯静态文件，不包含它。
 */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const MAX_BYTES = 30 * 1024 * 1024;

function refererFor(host: string): string | null {
  if (host.endsWith('doubanio.com') || host === 'movie.douban.com') return 'https://movie.douban.com/';
  if (host === 'book.douban.com') return 'https://book.douban.com/';
  if (host === 'm.douban.com') return 'https://m.douban.com/';
  if (host === 'image.baidu.com' || host.endsWith('bdimg.com') || host.endsWith('bdstatic.com')) return 'https://image.baidu.com/';
  if (host.endsWith('baidu.com') || host.endsWith('bcebos.com')) return 'https://baike.baidu.com/';
  if (host.endsWith('bing.com') || host.endsWith('bing.net')) return 'https://cn.bing.com/';
  return null;
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || h === '::') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return h.includes(':') && (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80'));
}

let bingCookie = { value: '', at: 0 };
async function bingCookies(): Promise<string> {
  if (bingCookie.value && Date.now() - bingCookie.at < 20 * 60 * 1000) return bingCookie.value;
  try {
    const res = await fetch('https://cn.bing.com/', { headers: { 'User-Agent': DESKTOP_UA }, signal: AbortSignal.timeout(6000) });
    const value = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    bingCookie = { value, at: Date.now() };
    return value;
  } catch {
    return '';
  }
}

function readBody(req: Connect.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) reject(new Error('请求体过大'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const corsProxy: Connect.NextHandleFunction = async (req, res, next) => {
  if (!req.url || !/^\/cors-proxy(\?|$)/.test(req.url)) return next();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  const params = new URL(req.url, 'http://local').searchParams;
  if (params.get('ping')) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end('timeline-proxy-ok');
  }
  let target: URL;
  try {
    target = new URL(params.get('url') ?? '');
    if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) throw new Error('bad');
  } catch {
    res.statusCode = 400;
    return res.end('invalid url');
  }
  try {
    const host = target.hostname;
    const headers: Record<string, string> = {
      'User-Agent': host === 'wapbaike.baidu.com' || host === 'm.douban.com' ? MOBILE_UA : DESKTOP_UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
      Accept: String(req.headers.accept || '*/*'),
    };
    const referer = refererFor(host);
    if (referer) headers.Referer = referer;
    if (host === 'cn.bing.com') headers.Cookie = await bingCookies();
    if (req.headers['content-type']) headers['Content-Type'] = String(req.headers['content-type']);
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const upstream = await fetch(target, {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers,
      body: body ? new Uint8Array(body) : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      res.statusCode = 413;
      return res.end('too large');
    }
    if (host === 'cn.bing.com' && !buf.length) bingCookie = { value: '', at: 0 };
    const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', type.startsWith('image/') && upstream.ok ? 'public, max-age=604800' : 'no-store');
    res.end(buf);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`proxy error: ${(err as Error).message}`);
  }
};

const corsProxyPlugin = (): Plugin => ({
  name: 'timeline-cors-proxy',
  configureServer(server) {
    server.middlewares.use(corsProxy);
  },
  configurePreviewServer(server) {
    server.middlewares.use(corsProxy);
  },
});

const projectDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * 构建完成后把单文件产物复制到项目根目录的 index.html，可直接双击打开。
 * 源码模板放在 src/index.html（Vite 的 root 是 src），所以根目录的 index.html 只是产物，
 * 不会再被当成入口重新打包。
 */
const copyToRootPlugin = (): Plugin => ({
  name: 'timeline-copy-to-root',
  apply: 'build',
  closeBundle() {
    const from = path.join(projectDir, 'dist', 'index.html');
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(projectDir, 'index.html'));
  },
});

export default defineConfig({
  root: path.join(projectDir, 'src'),
  publicDir: path.join(projectDir, 'public'),
  // 相对路径：构建产物可以放在任意静态服务器的任意子目录下
  base: './',
  plugins: [react(), corsProxyPlugin(), viteSingleFile(), copyToRootPlugin()],
  server: { port: 5173 },
  preview: { port: 4173 },
  build: {
    outDir: path.join(projectDir, 'dist'),
    emptyOutDir: true,
    // 单文件打包：把所有 JS / CSS 内联进 index.html，使其可以直接双击（file://）打开运行
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 16_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
