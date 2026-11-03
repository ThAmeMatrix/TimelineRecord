import { Loader2, Sparkles, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { fitAllNodes } from '../lib/view';
import { toastError, useStore, type ModalState } from '../store';
import { Modal } from './Modal';
import { CoverImg } from './Media';

export function ConfirmDialog({ modal }: { modal: Extract<ModalState, { kind: 'confirm' }> }) {
  const close = useStore((s) => s.closeModal);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await modal.onConfirm();
      if (useStore.getState().modal === modal) close();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={modal.title}
      onClose={close}
      width={420}
      footer={
        <>
          <button className="btn ghost" onClick={close}>
            取消
          </button>
          <button className={`btn ${modal.danger ? 'danger' : 'primary'}`} onClick={() => void run()} disabled={busy} autoFocus>
            {busy && <Loader2 size={14} className="spin" />}
            {modal.confirmText ?? '确定'}
          </button>
        </>
      }
    >
      <p className="confirm-msg">{modal.message}</p>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ['滚轮', '沿时间轴滚动（进度条随之移动）'],
  ['Ctrl + 滚轮 / 触控板捏合', '以鼠标位置为中心缩放'],
  ['Shift + 滚轮', '沿列（泳道）方向滚动'],
  ['拖动空白处', '平移（松手有惯性）'],
  ['单击节点', '选中并按当前方式点亮（同名 / 同类型 / 同子类）'],
  ['双击节点', '定位并放大到该节点'],
  ['双击空白处', '在该日期添加节点'],
  ['← → 或 A D', '在点亮的节点间跳转上一个 / 下一个'],
  ['1 / 2 / 3', '点亮方式：同名 / 同类型 / 同子类'],
  ['/ 或 Ctrl + F', '搜索（在点亮范围内）'],
  ['Enter / Shift + Enter（搜索框）', '跳到下一个 / 上一个搜索结果'],
  ['H', '仅显示点亮的节点'],
  ['G', '按类型分轨'],
  ['V', '切换横向 / 纵向时间轴'],
  ['F', '适配：铺满全部或点亮的节点'],
  ['T', '回到今天'],
  ['+ / -', '放大 / 缩小'],
  ['N', '添加节点'],
  ['E', '编辑选中的节点'],
  ['Delete', '删除选中的节点'],
  ['Ctrl + S / Ctrl + Shift + S', '保存为 JSON 文件 / 另存为'],
  ['Esc', '逐层退出：弹窗 → 搜索 → 点亮 → 选中'],
  ['Ctrl + Enter（编辑器）', '发表评论 / 保存'],
  ['/（编辑器）', '命令菜单：标题、列表、表格、图片、视频…'],
];

export function ShortcutsDialog() {
  const close = useStore((s) => s.closeModal);
  return (
    <Modal title="快捷键与操作" onClose={close} width={560}>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

export function Lightbox() {
  const src = useStore((s) => s.lightbox);
  if (!src) return null;
  return createPortal(
    <div className="lightbox" onClick={() => useStore.getState().openLightbox(null)}>
      <CoverImg src={src} alt="" />
    </div>,
    document.body,
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return createPortal(
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => useStore.getState().dismissToast(t.id)}>
          {t.message}
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function EmptyState() {
  const [busy, setBusy] = useState(false);
  const open = useStore((s) => s.openModal);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShow(true), 120);
    return () => window.clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div className="empty-state tl-noadd">
      <div className="empty-card">
        <div className="empty-art" aria-hidden>
          <span style={{ background: '#ff6b8b' }} />
          <span style={{ background: '#4dabf7' }} />
          <span style={{ background: '#69db7c' }} />
          <span style={{ background: '#ffa94d' }} />
        </div>
        <h2>把看过的、读过的、经历过的，放到同一条时间轴上</h2>
        <p className="muted">
          动画、漫画、小说、电影、电视剧和日常事件都可以加进来。作品的封面与简介会自动从网络获取；同名的作品会被串起来一起点亮。
        </p>
        <div className="empty-actions">
          <button className="btn primary" onClick={() => open({ kind: 'node-form' })}>
            <Plus size={16} /> 添加第一个节点
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.demo();
                await useStore.getState().load();
                fitAllNodes();
                useStore.getState().toast(`已添加 ${r.count} 个示例节点，封面正在获取`, 'success');
              } catch (err) {
                toastError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />} 导入示例数据
          </button>
        </div>
        <p className="muted small">也可以在时间轴任意位置双击，直接在该日期添加。</p>
      </div>
    </div>
  );
}
