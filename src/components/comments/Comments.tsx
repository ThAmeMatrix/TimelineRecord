import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { renderMarkdown } from '../../lib/markdown';
import { timeAgo } from '../../lib/text';
import { toastError, useStore } from '../../store';
import type { TLComment } from '../../types';
import { hydrateMedia } from '../../local/media';
import { CommentEditor } from './CommentEditor';

function CommentView({ c, onEdit, onDelete }: { c: TLComment; onEdit: () => void; onDelete: () => void }) {
  const html = useMemo(() => renderMarkdown(c.body), [c.body]);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (bodyRef.current) hydrateMedia(bodyRef.current);
  }, [html]);
  return (
    <article className="comment">
      <div className="comment-head">
        <span className="time" title={new Date(c.createdAt).toLocaleString()}>
          {timeAgo(c.createdAt)}
        </span>
        {c.updatedAt - c.createdAt > 2000 && <span className="edited">已编辑</span>}
        <span className="grow" />
        <button className="icon-btn sm" title="编辑" onClick={onEdit}>
          <Pencil size={14} />
        </button>
        <button className="icon-btn sm danger" title="删除" onClick={onDelete}>
          <Trash2 size={14} />
        </button>
      </div>
      <div
        ref={bodyRef}
        className="md-body"
        onClick={(e) => {
          const img = (e.target as HTMLElement).closest('img');
          const src = img?.getAttribute('src');
          if (src && !src.startsWith('blob:')) useStore.getState().openLightbox(src);
        }}
        onDoubleClick={onEdit}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  );
}

export function Comments({ nodeId }: { nodeId: string }) {
  const version = useStore((s) => s.commentsVersion[nodeId] ?? 0);
  const [list, setList] = useState<TLComment[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    setEditing(null);
    setList(null);
  }, [nodeId]);

  useEffect(() => {
    let alive = true;
    api
      .comments(nodeId)
      .then((l) => alive && setList(l))
      .catch((err) => alive && toastError(err));
    return () => {
      alive = false;
    };
  }, [nodeId, version]);

  const sorted = useMemo(() => (list ? [...list].sort((a, b) => b.createdAt - a.createdAt) : null), [list]);

  const add = async (body: string) => {
    const c = await api.createComment(nodeId, body);
    setList((l) => [...(l ?? []).filter((x) => x.id !== c.id), c]);
  };

  const save = async (id: string, body: string) => {
    const c = await api.updateComment(id, body);
    setList((l) => (l ? l.map((x) => (x.id === id ? c : x)) : l));
    setEditing(null);
  };

  const remove = (c: TLComment) => {
    useStore.getState().openModal({
      kind: 'confirm',
      title: '删除评论',
      message: '确定删除这条评论吗？此操作无法撤销。',
      confirmText: '删除',
      danger: true,
      onConfirm: async () => {
        await api.deleteComment(c.id);
        setList((l) => (l ? l.filter((x) => x.id !== c.id) : l));
      },
    });
  };

  return (
    <section className="comments">
      <div className="sec-head">
        <MessageSquare size={15} />
        评论
        {list && list.length > 0 && <span className="n">{list.length}</span>}
      </div>
      <CommentEditor key={nodeId} draftKey={`tl-draft:${nodeId}`} onSubmit={add} submitLabel="发表" />
      <div className="comment-list">
        {sorted === null ? (
          <div className="muted small">加载中…</div>
        ) : sorted.length === 0 ? (
          <div className="muted small empty-note">还没有评论。写下看完的感受、摘抄或截图吧。</div>
        ) : (
          sorted.map((c) =>
            editing === c.id ? (
              <div key={c.id} className="comment editing">
                <CommentEditor initial={c.body} autoFocus submitLabel="保存" onSubmit={(b) => save(c.id, b)} onCancel={() => setEditing(null)} />
              </div>
            ) : (
              <CommentView key={c.id} c={c} onEdit={() => setEditing(c.id)} onDelete={() => remove(c)} />
            ),
          )
        )}
      </div>
    </section>
  );
}
