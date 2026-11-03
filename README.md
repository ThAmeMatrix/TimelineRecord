# 时间轴记录（TimelineRecord）

把动画、漫画、小说、电影、电视剧和日常事件铺在同一条时间轴上。作品的封面与简介会自动联网获取，同名作品会串在一起点亮；每个节点都可以写 Markdown 评论（支持图片、视频、音频、附件）。

**纯前端项目**：没有服务端、没有数据库。数据保存在浏览器（IndexedDB）中，通过 JSON 文件保存、导入与迁移。

## 运行

```bash
npm install

npm run dev        # 开发：http://localhost:5173
npm run build      # 构建到 dist/index.html，并复制一份到项目根目录的 index.html
npm run preview    # 本地预览构建结果：http://localhost:4173
```

页面的源码模板是 `src/index.html`（Vite 的 root 是 `src/`）；项目根目录的 `index.html` 只是构建产物，不要手动编辑。

`dist/` 是**单文件**纯静态构建（JS / CSS 全部内联进 `index.html`），可直接放到任意静态托管（GitHub Pages、Nginx、对象存储等），也可以放在子目录下。

也可以**直接双击根目录的 `index.html`（或 `dist/index.html`）用浏览器打开（file://）运行**，无需任何服务器、构建步骤或 Service Worker；封面与评论里的本地媒体会从 IndexedDB 解析成 blob URL 显示。注意：不同浏览器 / 设备的数据互不共享，且 `file://` 是透明源，数据保存在打开它的那个浏览器里。

## 数据

- 所有修改实时保存在当前浏览器中，刷新、关闭后都不会丢失；不同浏览器 / 设备之间不共享。
- **保存为 JSON**：工具栏的保存按钮或 `Ctrl+S`（另存为 `Ctrl+Shift+S`）。有未保存到文件的修改时，按钮上会出现小圆点。
  支持文件系统访问 API 的浏览器（Chrome / Edge）首次选择保存位置后，`Ctrl+S` 会直接覆盖该文件；其他浏览器以下载方式保存。
- JSON 文件包含类型、国籍、节点、评论，默认还包含封面与评论里的图片/视频（base64，可在 设置 → 数据 中关闭）。
- **打开 JSON**：用文件内容替换当前全部数据；**导入并合并**：按 id 合并，不删除已有数据。也能导入旧版（服务端版本）导出的文件。
- 设置 → 数据 中还可以清理不再使用的媒体文件、清空全部数据。

## 封面与简介来源

浏览器只能直接访问允许跨域的网站，因此来源分两类：

| 来源 | 无需代理 | 说明 |
| --- | --- | --- |
| 维基百科、AniList、Bangumi | ✓ | 开放跨域（Bangumi 在部分网络环境下无法访问） |
| 百度百科 | ✓ | 通过 JSONP 词条卡片接口，只返回该名称的默认义项；有代理时可列出多个义项 |
| 豆瓣电影、豆瓣读书、必应图片、百度图片 | ✗ | 不允许跨域，需要代理 |

- `npm run dev` / `npm run preview` 自带一个本地代理（`./cors-proxy?url=`），这几个来源会自动可用。
- 部署为静态网站后，可在 **设置 → 数据 → 跨域代理** 填写自己的代理地址（用 `{url}` 表示目标地址），例如一个最简的 Cloudflare Worker：

  ```js
  export default {
    async fetch(req) {
      const target = new URL(req.url).searchParams.get('url');
      if (!target) return new Response('missing url', { status: 400 });
      const res = await fetch(target, { method: req.method, body: req.method === 'POST' ? await req.text() : undefined, headers: { 'Content-Type': req.headers.get('Content-Type') || '' } });
      const out = new Response(res.body, res);
      out.headers.set('Access-Control-Allow-Origin', '*');
      return out;
    },
  };
  ```

  地址填 `https://<你的 worker>/?url={url}`。注意豆瓣图片有防盗链，简易代理可能需要自行附加 `Referer`。
- 封面会尽量下载到本地（转为 webp 并生成缩略图）；对方不允许跨域下载的图片会直接引用原地址。
- 豆瓣对频繁请求会静默返回空结果，已串行限速，检测到限流时暂停约 3 分钟并改用其他来源。

## 主要功能

- **类型**：主类型（动画、漫画、小说、电影、电视剧、日常）可自由增删改，可设颜色、图标，以及「自动获取方式」（决定去哪些网站找封面/简介，「不自动获取」适合日常事件）。
- **子类型（国籍）**：默认国产、日本、美国、韩国，可自由添加；节点可不选。
- **点亮与跳转**：单击节点后按「同名 / 同类型 / 同子类」点亮（快捷键 1/2/3），同名节点之间有连线；`←` `→` 在点亮的节点间跳转，「仅显示」可隐藏其余节点。顶部类型标签可直接筛选，下拉可细分到「动画 · 日本」这样的子类型。
- **范围内搜索**：搜索框在当前点亮范围内检索标题、副标题、简介和评论，`Enter` / `Shift+Enter` 跳到下一个 / 上一个结果。
- **封面与简介**：添加时可从联网候选中直接选条目；保存后自动匹配。详情面板中可「换源」：多个来源并行检索、逐个出结果、预览后应用，也可上传本地图片、粘贴截图或图片链接、手动编辑简介。
- **评论**：所见即所得的 Markdown 编辑器——直接输入 `#`、`-`、`- [ ]`、`>`、` ``` `、`[文字](链接)` 等语法；`/` 打开命令菜单；粘贴或拖入图片/视频即保存到本地；可切换源码模式、全屏编辑；草稿自动保存；`Ctrl+Enter` 发表。
- **时间轴**：滚轮以鼠标为中心平滑缩放，拖动平移带惯性，按缩放与拥挤程度自动切换海报 / 卡片 / 紧凑 / 圆点；同一时间可并存多个节点；支持按类型分轨、缩略图导航、双击空白处在该日期添加节点。按 `?` 查看全部快捷键。

## 目录

- `src/local/`：浏览器端数据层——IndexedDB 存储（`db.ts`、`idb.ts`）、媒体（`media.ts`，把 `media/<id>` 解析成 blob URL）、JSON 保存与导入（`transfer.ts`）、联网来源（`sources.ts`、`http.ts`）、自动获取（`auto.ts`）、封面处理（`images.ts`）
- `src/components/Media.tsx`：`CoverImg` 组件，统一处理本地媒体与远程图片的显示
- `src/api.ts`：界面使用的数据接口（全部在本地完成）
