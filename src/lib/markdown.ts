import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : '';
    try {
      const html = language
        ? hljs.highlight(code, { language, ignoreIllegals: true }).value
        : code.length < 4000
          ? hljs.highlightAuto(code).value
          : escapeHtml(code);
      return `<pre class="hljs"><code${language ? ` class="language-${language}"` : ''}>${html}</code></pre>`;
    } catch {
      return '';
    }
  },
}).use(taskLists, { label: true });

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|flac|aac|weba)(\?|#|$)/i;

// ![](视频/音频地址) 直接渲染成播放器
const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet('src') || '';
  if (VIDEO_EXT.test(src)) return `<video src="${escapeHtml(src)}" controls preload="metadata"></video>`;
  if (AUDIO_EXT.test(src)) return `<audio src="${escapeHtml(src)}" controls preload="metadata"></audio>`;
  return defaultImage(tokens, idx, options, env, self);
};

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;
  if (el.tagName === 'A') {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  } else if (el.tagName === 'IMG') {
    el.setAttribute('loading', 'lazy');
  } else if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
    el.setAttribute('controls', '');
    el.setAttribute('preload', 'metadata');
  }
});

const cache = new Map<string, string>();

export function renderMarkdown(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(md.render(src), {
    ADD_TAGS: ['video', 'audio', 'source'],
    ADD_ATTR: ['controls', 'preload', 'playsinline', 'loop', 'muted', 'poster', 'target', 'checked', 'disabled'],
  });
  cache.set(src, html);
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  return html;
}
