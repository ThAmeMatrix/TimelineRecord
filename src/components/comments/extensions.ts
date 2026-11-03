import { Extension, InputRule, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { common, createLowlight } from 'lowlight';
import { Markdown } from 'tiptap-markdown';

const lowlight = createLowlight(common);

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 视频 / 音频块：Markdown 中以 HTML 标签保存 */
function mediaNode(name: 'video' | 'audio') {
  return Node.create({
    name,
    group: 'block',
    atom: true,
    draggable: true,
    selectable: true,
    addAttributes() {
      return { src: { default: null } };
    },
    parseHTML() {
      return [
        { tag: `${name}[src]`, getAttrs: (el) => ({ src: (el as HTMLElement).getAttribute('src') }) },
        {
          tag: name,
          getAttrs: (el) => {
            const s = (el as HTMLElement).querySelector('source[src]');
            return s ? { src: s.getAttribute('src') } : false;
          },
        },
      ];
    },
    renderHTML({ HTMLAttributes }) {
      return [name, mergeAttributes({ controls: 'true', preload: 'metadata' }, HTMLAttributes)];
    },
    addStorage() {
      return {
        markdown: {
          serialize(state: { write: (s: string) => void; closeBlock: (n: unknown) => void }, node: { attrs: { src?: string } }) {
            state.write(`<${name} src="${escapeAttr(String(node.attrs.src ?? ''))}" controls></${name}>`);
            state.closeBlock(node);
          },
          parse: {},
        },
      };
    },
  });
}

export interface SlashItem {
  key: string;
  title: string;
  hint?: string;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

export const SlashCommand = Extension.create<{ suggestion: Partial<SuggestionOptions<SlashItem, SlashItem>> }>({
  name: 'slashCommand',
  addOptions() {
    return { suggestion: {} };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        command: ({ editor, range, props }) => props.run(editor, range),
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        ...this.options.suggestion,
      }),
    ];
  },
});

const EditorKeys = Extension.create<{ onSubmit: () => void; onLink: () => void }>({
  name: 'editorKeys',
  addOptions() {
    return { onSubmit: () => {}, onLink: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => {
        this.options.onSubmit();
        return true;
      },
      'Mod-k': () => {
        this.options.onLink();
        return true;
      },
    };
  },
});

/** 像 Typora 一样直接敲 Markdown：- [ ] 任务、[文字](链接)、![](图片) */
const MarkdownShortcuts = Extension.create({
  name: 'markdownShortcuts',
  addInputRules() {
    return [
      new InputRule({
        find: /^\[([ xX]?)\]\s$/,
        handler: ({ state, range, match, chain }) => {
          const $from = state.doc.resolve(range.from);
          const parent = $from.depth >= 2 ? $from.node(-1).type.name : '';
          const checked = /x/i.test(match[1] || '');
          if (parent === 'taskItem') {
            chain().deleteRange(range).updateAttributes('taskItem', { checked }).run();
            return;
          }
          if (parent !== 'listItem') return null;
          chain().deleteRange(range).toggleTaskList().updateAttributes('taskItem', { checked }).run();
        },
      }),
      new InputRule({
        find: /!\[([^\]]*)\]\(([^)\s]+)\)$/,
        handler: ({ state, range, match }) => {
          const image = state.schema.nodes.image;
          if (!image) return null;
          state.tr.replaceRangeWith(range.from, range.to, image.create({ src: match[2], alt: match[1] || null }));
        },
      }),
      new InputRule({
        find: /(?<!!)\[([^\]]+)\]\(([^)\s]+)\)$/,
        handler: ({ state, range, match }) => {
          const link = state.schema.marks.link;
          if (!link) return null;
          const { tr } = state;
          tr.replaceWith(range.from, range.to, state.schema.text(match[1], [link.create({ href: match[2] })]));
          tr.removeStoredMark(link);
        },
      }),
    ];
  },
});

export function buildExtensions(opts: {
  placeholder: string;
  onSubmit: () => void;
  onLink: () => void;
  suggestion: Partial<SuggestionOptions<SlashItem, SlashItem>>;
}) {
  return [
    StarterKit.configure({ codeBlock: false, heading: { levels: [1, 2, 3, 4] } }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
    }),
    Image.configure({ inline: false, allowBase64: false }),
    mediaNode('video'),
    mediaNode('audio'),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Placeholder.configure({ placeholder: opts.placeholder }),
    Markdown.configure({
      html: true,
      tightLists: true,
      bulletListMarker: '-',
      linkify: true,
      breaks: true,
      transformPastedText: true,
      transformCopiedText: false,
    }),
    SlashCommand.configure({ suggestion: opts.suggestion }),
    MarkdownShortcuts,
    EditorKeys.configure({ onSubmit: opts.onSubmit, onLink: opts.onLink }),
  ];
}

export function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as { markdown: { getMarkdown: () => string } }).markdown.getMarkdown();
}
