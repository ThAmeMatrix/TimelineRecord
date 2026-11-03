import { MessageSquare, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { CommentWithNode } from '../local/db';
import { useStore } from '../store';
import { Modal } from './Modal';

export function CommentsModal() {
  const close = useStore((s) => s.closeModal);
  const [list, setList] = useState<CommentWithNode[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let live = true;
    void api.allComments().then((r) => {
      if (live) setList(r);
    });
    return () => {
      live = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const base = list ?? [];
    const kw = q.trim().toLowerCase();
    if (!kw) return base;
    return base.filter((c) => c.body.toLowerCase().includes(kw) || c.nodeTitle.toLowerCase().includes(kw));
  }, [list, q]);

  return (
    <Modal
      title={
        <span>
          全部评论 <span className="muted small">（{filtered.length} 条）</span>
        </span>
      }
      onClose={close}
      width={680}
      className="comments-modal"
    >
      <div className="cm-search">
        <Search size={15} />
        <input
          className="input"
          autoFocus
          placeholder="按内容或节点名称筛选…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {list == null ? (
        <div className="muted center">加载中…</div>
      ) : filtered.length === 0 ? (
        <div className="muted center">{list.length ? '没有匹配的评论' : '还没有任何评论'}</div>
      ) : (
        <ul className="cm-list">
          {filtered.slice(0, 400).map((c) => (
            <li key={c.id}>
              <button
                className="cm-item"
                onClick={() => {
                  close();
                  useStore.getState().selectNode(c.nodeId, { focus: 'center', zoom: true });
                }}
                title="点击跳转到该节点"
              >
                <span className="cm-tag" style={{ '--c': c.typeColor } as React.CSSProperties}>
                  {c.nodeType}
                </span>
                <span className="cm-title">{c.nodeTitle}</span>
                <MessageSquare size={13} className="cm-ico" />
                <span className="cm-body">{c.body}</span>
              </button>
            </li>
          ))}
          {filtered.length > 400 && <li className="muted center">仅显示前 400 条，用筛选缩小范围</li>}
        </ul>
      )}
    </Modal>
  );
}
