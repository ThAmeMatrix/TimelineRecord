'use strict';

/**
 * 桌面版内置的本地 HTTP 服务，做两件事：
 * 1. 提供打包后的单文件应用（dist/index.html）；
 * 2. 提供与 `npm run dev` 完全相同的 ./cors-proxy?url= 跨域代理，
 *    于是豆瓣、必应图片、百度图片这些不允许浏览器跨域的来源在桌面版里直接可用，
 *    不需要用户自己搭代理。
 *
 * 用 http://127.0.0.1 而不是 file://：localStorage / IndexedDB 需要正常源，
 * 相对地址请求（cors-proxy?ping=1）也才能命中代理。
 */

const fs = require('node:fs');
const http = require('node:http');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const MAX_BYTES = 30 * 1024 * 1024;

function refererFor(host) {
  if (host.endsWith('doubanio.com') || host === 'movie.douban.com') return 'https://movie.douban.com/';
  if (host === 'book.douban.com') return 'https://book.douban.com/';
  if (host === 'm.douban.com') return 'https://m.douban.com/';
  if (host === 'image.baidu.com' || host.endsWith('bdimg.com') || host.endsWith('bdstatic.com')) return 'https://image.baidu.com/';
  if (host.endsWith('baidu.com') || host.endsWith('bcebos.com')) return 'https://baike.baidu.com/';
  if (host.endsWith('bing.com') || host.endsWith('bing.net')) return 'https://cn.bing.com/';
  return null;
}

/** 拒绝内网地址：代理只用于访问公开站点 */
function isPrivateHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
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
async function bingCookies() {
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) reject(new Error('请求体过大'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleProxy(req, res, url) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (url.searchParams.get('ping')) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 200;
    return res.end('timeline-proxy-ok');
  }
  let target;
  try {
    target = new URL(url.searchParams.get('url') ?? '');
    if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) throw new Error('bad');
  } catch {
    res.statusCode = 400;
    return res.end('invalid url');
  }
  try {
    const host = target.hostname;
    const headers = {
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
    return res.end(buf);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(`proxy error: ${err.message}`);
  }
}

/**
 * 启动本地服务。file 为单文件构建产物（dist/index.html）。
 * 端口用 0（系统分配），避免与用户本机其它服务冲突。
 */
function startServer(file) {
  const html = fs.readFileSync(file);
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.statusCode = 400;
      return res.end('bad request');
    }
    if (url.pathname === '/cors-proxy') {
      handleProxy(req, res, url).catch(() => {
        if (!res.headersSent) res.statusCode = 502;
        try {
          res.end('proxy error');
        } catch {
          /* ignore */
        }
      });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      return res.end(html);
    }
    res.statusCode = 404;
    return res.end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}/` });
    });
  });
}

module.exports = { startServer };
