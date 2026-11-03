import type { Editor } from '@tiptap/core';
import { BubbleMenu, EditorContent, useEditor } from '@tiptap/react';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import {
  Bold,
  Code,
  CodeXml,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Loader2,
  Maximize2,
  Minimize2,
  Minus,
  Paperclip,
  Quote,
  Redo2,
  Send,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Undo2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { uploadFile } from '../../api';
import { toastError, useStore } from '../../store';
import { buildExtensions, getMarkdown, type SlashItem } from './extensions';

interface Props {
  initial?: string;
  draftKey?: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  onSubmit: (markdown: string) => Promise<unknown> | unknown;
  onCancel?: () => void;
}

interface SlashState {
  items: SlashItem[];
  active: number;
  rect: DOMRect | null;
}

function Btn({
  on,
  title,
  onClick,
  children,
  disabled,
}: {
  on?: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`ed-btn ${on ? 'on' : ''}`}
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SlashMenu({ state, onPick, onHover }: { state: SlashState; onPick: (i: number) => void; onHover: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = state.rect;
    if (!r) return;
    const h = ref.current?.offsetHeight ?? 280;
    const below = r.bottom + 6 + h < window.innerHeight;
    setPos({ left: Math.min(r.left, window.innerWidth - 250), top: below ? r.bottom + 6 : Math.max(8, r.top - h - 6) });
  }, [state.rect, state.items.length]);
  useEffect(() => {
    ref.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [state.active]);
  return createPortal(
    <div ref={ref} className="slash-menu" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
      {state.items.length ? (
        state.items.map((it, i) => (
          <button
            key={it.key}
            className={i === state.active ? 'on' : ''}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(i)}
          >
            <span className="t">{it.title}</span>
            {it.hint && <span className="h">{it.hint}</span>}
          </button>
        ))
      ) : (
        <div className="empty">没有匹配的命令</div>
      )}
    </div>,
    document.body,
  );
}

export function CommentEditor({ initial, draftKey, placeholder, submitLabel = '发表', autoFocus, onSubmit, onCancel }: Props) {
  const [mode, setMode] = useState<'rich' | 'source'>('rich');
  const [sourceText, setSourceText] = useState('');
  const [full, setFull] = useState(false);
  const [uploads, setUploads] = useState<Record<string, { name: string; progress: number }>>({});
  const [busy, setBusy] = useState(false);
  const [empty, setEmpty] = useState(true);
  const [linkUI, setLinkUI] = useState<{ href: string } | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [focused, setFocused] = useState(false);

  const editorRef = useRef<Editor | null>(null);
  const modeRef = useRef(mode);
  const sourceRef = useRef(sourceText);
  const uploadsRef = useRef(uploads);
  modeRef.current = mode;
  sourceRef.current = sourceText;
  uploadsRef.current = uploads;
  const submitRef = useRef<() => void>(() => {});
  const linkRef = useRef<() => void>(() => {});
  const filesRef = useRef<(files: File[], pos?: number) => void>(() => {});
  const pickRef = useRef<(accept: string) => void>(() => {});
  const slashCtl = useRef<{ props: SuggestionProps<SlashItem, SlashItem> | null; active: number }>({ props: null, active: 0 });
  const fileInput = useRef<HTMLInputElement>(null);
  const draftTimer = useRef(0);

  const initialContent = useMemo(
    () => initial ?? (draftKey ? (localStorage.getItem(draftKey) ?? '') : ''),
    // 只在挂载时读取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const slashItems = useMemo<SlashItem[]>(
    () => [
      { key: 'h1', title: '一级标题', hint: '#', keywords: 'h1 heading title biaoti', run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run() },
      { key: 'h2', title: '二级标题', hint: '##', keywords: 'h2 heading biaoti', run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run() },
      { key: 'h3', title: '三级标题', hint: '###', keywords: 'h3 heading biaoti', run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run() },
      { key: 'ul', title: '无序列表', hint: '-', keywords: 'ul list bullet liebiao', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
      { key: 'ol', title: '有序列表', hint: '1.', keywords: 'ol list ordered number liebiao', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
      { key: 'todo', title: '任务列表', hint: '[ ]', keywords: 'todo task check renwu', run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
      { key: 'quote', title: '引用', hint: '>', keywords: 'quote blockquote yinyong', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
      { key: 'code', title: '代码块', hint: '```', keywords: 'code pre daima', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
      { key: 'hr', title: '分割线', hint: '---', keywords: 'hr divider line fenge', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
      { key: 'table', title: '表格', hint: '3×3', keywords: 'table biaoge', run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      { key: 'image', title: '图片', hint: '上传', keywords: 'image img picture tupian', run: (e, r) => { e.chain().focus().deleteRange(r).run(); pickRef.current('image/*'); } },
      { key: 'video', title: '视频', hint: '上传', keywords: 'video shipin', run: (e, r) => { e.chain().focus().deleteRange(r).run(); pickRef.current('video/*'); } },
      { key: 'audio', title: '音频', hint: '上传', keywords: 'audio music yinpin', run: (e, r) => { e.chain().focus().deleteRange(r).run(); pickRef.current('audio/*'); } },
      { key: 'file', title: '附件', hint: '上传', keywords: 'file attach fujian', run: (e, r) => { e.chain().focus().deleteRange(r).run(); pickRef.current('*/*'); } },
      { key: 'link', title: '链接', hint: 'Ctrl+K', keywords: 'link url lianjie', run: (e, r) => { e.chain().focus().deleteRange(r).run(); linkRef.current(); } },
    ],
    [],
  );

  const extensions = useMemo(
    () =>
      buildExtensions({
        placeholder: placeholder ?? '写点什么…  支持 Markdown，输入 / 打开命令菜单，可直接粘贴或拖入图片、视频',
        onSubmit: () => submitRef.current(),
        onLink: () => linkRef.current(),
        suggestion: {
          items: ({ query }) => {
            const q = query.toLowerCase();
            return slashItems.filter((it) => !q || it.title.includes(query) || it.keywords.includes(q)).slice(0, 12);
          },
          render: () => {
            const show = (p: SuggestionProps<SlashItem, SlashItem>) => {
              slashCtl.current = { props: p, active: 0 };
              setSlash({ items: p.items, active: 0, rect: p.clientRect?.() ?? null });
            };
            return {
              onStart: show,
              onUpdate: show,
              onKeyDown: ({ event }: SuggestionKeyDownProps) => {
                const st = slashCtl.current;
                if (!st.props) return false;
                const items = st.props.items;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  if (!items.length) return true;
                  st.active = (st.active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                  setSlash((s) => (s ? { ...s, active: st.active } : s));
                  return true;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  const item = items[st.active];
                  if (!item) return false;
                  st.props.command(item);
                  return true;
                }
                if (event.key === 'Escape') {
                  st.props = null;
                  setSlash(null);
                  return true;
                }
                return false;
              },
              onExit: () => {
                slashCtl.current = { props: null, active: 0 };
                setSlash(null);
              },
            };
          },
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: initialContent,
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'md-body ed-body' },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length) return false;
        event.preventDefault();
        filesRef.current(files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        filesRef.current(files, pos);
        return true;
      },
    },
    onCreate: ({ editor: ed }) => {
      editorRef.current = ed;
      setEmpty(ed.isEmpty);
    },
    onUpdate: ({ editor: ed }) => {
      setEmpty(ed.isEmpty);
      scheduleDraft();
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  const currentMarkdown = () => {
    if (modeRef.current === 'source') return sourceRef.current;
    const ed = editorRef.current;
    return ed && !ed.isDestroyed ? getMarkdown(ed) : '';
  };

  function scheduleDraft() {
    if (!draftKey) return;
    window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      const md = currentMarkdown();
      if (md.trim() && !md.includes('blob:')) localStorage.setItem(draftKey, md);
      else if (!md.trim()) localStorage.removeItem(draftKey);
    }, 400);
  }

  /* ------------------------------ 上传 ------------------------------ */

  const replaceUrl = (blob: string, url: string) => {
    const ed = editorRef.current;
    if (ed && !ed.isDestroyed) {
      const { state } = ed;
      const tr = state.tr;
      let changed = false;
      state.doc.descendants((node, pos) => {
        if (node.attrs && node.attrs.src === blob) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: url });
          changed = true;
        }
        if (node.isText) {
          for (const m of node.marks) {
            if (m.type.name === 'link' && m.attrs.href === blob) {
              tr.removeMark(pos, pos + node.nodeSize, m.type);
              tr.addMark(pos, pos + node.nodeSize, m.type.create({ ...m.attrs, href: url }));
              changed = true;
            }
          }
        }
      });
      if (changed) ed.view.dispatch(tr.setMeta('addToHistory', false));
    }
    setSourceText((t) => t.split(blob).join(url));
    scheduleDraft();
  };

  const removeBlob = (blob: string) => {
    const ed = editorRef.current;
    if (!ed || ed.isDestroyed) return;
    const ranges: [number, number][] = [];
    ed.state.doc.descendants((node, pos) => {
      if (node.attrs && node.attrs.src === blob) ranges.push([pos, pos + node.nodeSize]);
      else if (node.isText && node.marks.some((m) => m.type.name === 'link' && m.attrs.href === blob)) ranges.push([pos, pos + node.nodeSize]);
    });
    if (!ranges.length) return;
    const tr = ed.state.tr;
    for (const [a, b] of ranges.reverse()) tr.delete(a, b);
    ed.view.dispatch(tr);
  };

  filesRef.current = (files: File[], pos?: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    let at = pos;
    for (const file of files) {
      const blob = URL.createObjectURL(file);
      const kind = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : file.type.startsWith('audio/')
            ? 'audio'
            : 'file';
      const content =
        kind === 'file'
          ? { type: 'paragraph', content: [{ type: 'text', text: `📎 ${file.name}`, marks: [{ type: 'link', attrs: { href: blob } }] }] }
          : { type: kind, attrs: kind === 'image' ? { src: blob, alt: file.name } : { src: blob } };
      if (at != null) ed.chain().focus().insertContentAt(at, content).run();
      else ed.chain().focus().insertContent(content).run();
      at = undefined;
      setUploads((u) => ({ ...u, [blob]: { name: file.name, progress: 0 } }));
      const { promise } = uploadFile(file, (p) =>
        setUploads((u) => (u[blob] ? { ...u, [blob]: { ...u[blob], progress: p } } : u)),
      );
      promise
        .then((res) => {
          replaceUrl(blob, res.url);
          window.setTimeout(() => URL.revokeObjectURL(blob), 3000);
        })
        .catch((err) => {
          removeBlob(blob);
          toastError(err);
        })
        .finally(() =>
          setUploads((u) => {
            const next = { ...u };
            delete next[blob];
            return next;
          }),
        );
    }
  };

  pickRef.current = (accept: string) => {
    const input = fileInput.current;
    if (!input) return;
    input.accept = accept;
    input.click();
  };

  /* ------------------------------ 链接 ------------------------------ */

  linkRef.current = () => {
    const ed = editorRef.current;
    if (!ed) return;
    setLinkUI({ href: (ed.getAttributes('link').href as string | undefined) ?? '' });
  };

  const applyLink = (href: string) => {
    const ed = editorRef.current;
    setLinkUI(null);
    if (!ed) return;
    const h = href.trim();
    if (!h) {
      ed.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const url = /^(https?:|mailto:|\/|#)/i.test(h) ? h : `https://${h}`;
    if (ed.state.selection.empty && !ed.isActive('link')) {
      ed.chain().focus().insertContent({ type: 'text', text: h, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    } else {
      ed.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  };

  /* ------------------------------ 提交 ------------------------------ */

  const submit = async () => {
    if (busy) return;
    if (Object.keys(uploadsRef.current).length) {
      useStore.getState().toast('还有文件正在上传，请稍候', 'info');
      return;
    }
    const md = currentMarkdown().trim();
    if (!md) return;
    setBusy(true);
    try {
      await onSubmit(md);
      if (draftKey) localStorage.removeItem(draftKey);
      window.clearTimeout(draftTimer.current);
      editorRef.current?.commands.clearContent(true);
      setSourceText('');
      setMode('rich');
      setFull(false);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  submitRef.current = () => void submit();

  const toggleSource = () => {
    const ed = editorRef.current;
    if (!ed) return;
    if (mode === 'rich') {
      setSourceText(getMarkdown(ed));
      setMode('source');
    } else {
      ed.commands.setContent(sourceText);
      setEmpty(ed.isEmpty);
      setMode('rich');
      requestAnimationFrame(() => ed.commands.focus('end'));
    }
  };

  const onWrapKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (linkUI) {
      setLinkUI(null);
      editorRef.current?.commands.focus();
    } else if (slash) {
      setSlash(null);
    } else if (full) {
      setFull(false);
    } else if (onCancel) {
      onCancel();
    } else {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
  };

  const uploadList = Object.values(uploads);
  const progress = uploadList.length ? uploadList.reduce((a, u) => a + u.progress, 0) / uploadList.length : 0;
  const canSubmit = !busy && !uploadList.length && (mode === 'source' ? sourceText.trim().length > 0 : !empty);
  const ed = editor;
  const inTable = !!ed?.isActive('table');

  return (
    <div className={`ed ${full ? 'full' : ''} ${focused ? 'focused' : ''}`} onKeyDown={onWrapKey}>
      {full && <div className="ed-full-backdrop" onClick={() => setFull(false)} />}
      <div className="ed-box">
        <div className="ed-toolbar">
          {mode === 'rich' && ed ? (
            <>
              <Btn title="加粗（Ctrl+B）" on={ed.isActive('bold')} onClick={() => ed.chain().focus().toggleBold().run()}>
                <Bold size={15} />
              </Btn>
              <Btn title="斜体（Ctrl+I）" on={ed.isActive('italic')} onClick={() => ed.chain().focus().toggleItalic().run()}>
                <Italic size={15} />
              </Btn>
              <Btn title="删除线" on={ed.isActive('strike')} onClick={() => ed.chain().focus().toggleStrike().run()}>
                <Strikethrough size={15} />
              </Btn>
              <Btn title="行内代码（Ctrl+E）" on={ed.isActive('code')} onClick={() => ed.chain().focus().toggleCode().run()}>
                <Code size={15} />
              </Btn>
              <span className="ed-sep" />
              <Btn title="二级标题" on={ed.isActive('heading', { level: 2 })} onClick={() => ed.chain().focus().toggleHeading({ level: 2 }).run()}>
                <Heading2 size={15} />
              </Btn>
              <Btn title="三级标题" on={ed.isActive('heading', { level: 3 })} onClick={() => ed.chain().focus().toggleHeading({ level: 3 }).run()}>
                <Heading3 size={15} />
              </Btn>
              <Btn title="无序列表" on={ed.isActive('bulletList')} onClick={() => ed.chain().focus().toggleBulletList().run()}>
                <List size={15} />
              </Btn>
              <Btn title="有序列表" on={ed.isActive('orderedList')} onClick={() => ed.chain().focus().toggleOrderedList().run()}>
                <ListOrdered size={15} />
              </Btn>
              <Btn title="任务列表" on={ed.isActive('taskList')} onClick={() => ed.chain().focus().toggleTaskList().run()}>
                <ListChecks size={15} />
              </Btn>
              <Btn title="引用" on={ed.isActive('blockquote')} onClick={() => ed.chain().focus().toggleBlockquote().run()}>
                <Quote size={15} />
              </Btn>
              <Btn title="代码块" on={ed.isActive('codeBlock')} onClick={() => ed.chain().focus().toggleCodeBlock().run()}>
                <SquareCode size={15} />
              </Btn>
              <Btn title="分割线" onClick={() => ed.chain().focus().setHorizontalRule().run()}>
                <Minus size={15} />
              </Btn>
              <span className="ed-sep" />
              <Btn title="链接（Ctrl+K）" on={ed.isActive('link')} onClick={() => linkRef.current()}>
                <Link2 size={15} />
              </Btn>
              <Btn title="插入图片 / 视频 / 音频 / 附件（也可直接粘贴或拖入）" onClick={() => pickRef.current('*/*')}>
                <Paperclip size={15} />
              </Btn>
              <Btn title="表格" on={inTable} onClick={() => ed.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
                <TableIcon size={15} />
              </Btn>
              <span className="ed-sep" />
              <Btn title="撤销（Ctrl+Z）" disabled={!ed.can().undo()} onClick={() => ed.chain().focus().undo().run()}>
                <Undo2 size={15} />
              </Btn>
              <Btn title="重做（Ctrl+Shift+Z）" disabled={!ed.can().redo()} onClick={() => ed.chain().focus().redo().run()}>
                <Redo2 size={15} />
              </Btn>
            </>
          ) : (
            <span className="ed-source-hint">Markdown 源码</span>
          )}
          <span className="ed-grow" />
          <Btn title={mode === 'rich' ? '切换到 Markdown 源码' : '切换回所见即所得'} on={mode === 'source'} onClick={toggleSource}>
            <CodeXml size={15} />
          </Btn>
          <Btn title={full ? '退出全屏（Esc）' : '全屏编辑'} onClick={() => setFull((f) => !f)}>
            {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </Btn>
        </div>

        {mode === 'rich' && inTable && ed && (
          <div className="ed-table-bar">
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => ed.chain().focus().addRowAfter().run()}>
              + 行
            </button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => ed.chain().focus().addColumnAfter().run()}>
              + 列
            </button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => ed.chain().focus().deleteRow().run()}>
              − 行
            </button>
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => ed.chain().focus().deleteColumn().run()}>
              − 列
            </button>
            <button className="danger" onMouseDown={(e) => e.preventDefault()} onClick={() => ed.chain().focus().deleteTable().run()}>
              删除表格
            </button>
          </div>
        )}

        <div className="ed-content" style={{ display: mode === 'rich' ? undefined : 'none' }}>
          <EditorContent editor={editor} />
          {ed && (
            <BubbleMenu
              editor={ed}
              tippyOptions={{ duration: 120, placement: 'top', maxWidth: 'none' }}
              shouldShow={({ editor: e, state }) =>
                !state.selection.empty && !e.isActive('codeBlock') && !e.isActive('image') && !e.isActive('video') && !e.isActive('audio')
              }
            >
              <div className="bubble">
                <Btn title="加粗" on={ed.isActive('bold')} onClick={() => ed.chain().focus().toggleBold().run()}>
                  <Bold size={14} />
                </Btn>
                <Btn title="斜体" on={ed.isActive('italic')} onClick={() => ed.chain().focus().toggleItalic().run()}>
                  <Italic size={14} />
                </Btn>
                <Btn title="删除线" on={ed.isActive('strike')} onClick={() => ed.chain().focus().toggleStrike().run()}>
                  <Strikethrough size={14} />
                </Btn>
                <Btn title="行内代码" on={ed.isActive('code')} onClick={() => ed.chain().focus().toggleCode().run()}>
                  <Code size={14} />
                </Btn>
                <Btn title="链接" on={ed.isActive('link')} onClick={() => linkRef.current()}>
                  <Link2 size={14} />
                </Btn>
              </div>
            </BubbleMenu>
          )}
        </div>

        {mode === 'source' && (
          <textarea
            className="ed-source"
            value={sourceText}
            autoFocus
            spellCheck={false}
            rows={Math.min(24, Math.max(6, sourceText.split('\n').length + 1))}
            onChange={(e) => {
              setSourceText(e.target.value);
              sourceRef.current = e.target.value;
              scheduleDraft();
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (!files.length) return;
              e.preventDefault();
              // 源码模式下上传完成后直接插入 Markdown
              const el = e.currentTarget;
              for (const file of files) {
                const { promise } = uploadFile(file);
                promise
                  .then((res) => {
                    const isImg = file.type.startsWith('image/');
                    const snippet = file.type.startsWith('video/')
                      ? `\n<video src="${res.url}" controls></video>\n`
                      : file.type.startsWith('audio/')
                        ? `\n<audio src="${res.url}" controls></audio>\n`
                        : `${isImg ? '!' : ''}[${isImg ? '' : '📎 '}${file.name}](${res.url})`;
                    const at = el.selectionStart ?? sourceRef.current.length;
                    setSourceText((t) => t.slice(0, at) + snippet + t.slice(at));
                  })
                  .catch(toastError);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              } else if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart: s, selectionEnd: t } = el;
                const next = `${sourceText.slice(0, s)}  ${sourceText.slice(t)}`;
                setSourceText(next);
                requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
              }
            }}
          />
        )}

        {linkUI && (
          <div className="ed-link">
            <Link2 size={14} />
            <input
              autoFocus
              value={linkUI.href}
              placeholder="输入链接地址，回车确认；留空则移除链接"
              onChange={(e) => setLinkUI({ href: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyLink(linkUI.href);
                }
              }}
            />
            <button className="btn sm primary" onMouseDown={(e) => e.preventDefault()} onClick={() => applyLink(linkUI.href)}>
              确定
            </button>
          </div>
        )}

        <div className="ed-foot">
          {uploadList.length > 0 ? (
            <span className="ed-uploading">
              <Loader2 size={13} className="spin" />
              正在上传 {uploadList.length} 个文件 · {Math.round(progress * 100)}%
            </span>
          ) : (
            <span className="ed-hint">Markdown · / 命令 · 粘贴/拖入图片视频 · Ctrl+Enter {submitLabel}</span>
          )}
          <span className="ed-grow" />
          {onCancel && (
            <button className="btn ghost sm" onClick={onCancel}>
              取消
            </button>
          )}
          <button className="btn primary sm" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            {submitLabel}
          </button>
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (!files.length) return;
          if (mode === 'source') toggleSource();
          filesRef.current(files);
        }}
      />

      {slash && (
        <SlashMenu
          state={slash}
          onHover={(i) => {
            slashCtl.current.active = i;
            setSlash((s) => (s ? { ...s, active: i } : s));
          }}
          onPick={(i) => {
            const st = slashCtl.current;
            const item = st.props?.items[i];
            if (item && st.props) st.props.command(item);
          }}
        />
      )}
    </div>
  );
}
