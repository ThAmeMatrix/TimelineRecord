import { ArrowDown, ArrowUp, Download, Eraser, FolderOpen, Loader2, Plus, Save, Sparkles, Trash2, Upload, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useDerived } from '../lib/derived';
import { exportMediaPref, saveNow, setExportMediaPref } from '../lib/persist';
import { formatBytes } from '../lib/text';
import { fitAllNodes } from '../lib/view';
import { builtinProxyAvailable, customProxy, describeError, hasProxy, setCustomProxy, testProxy } from '../local/http';
import {
  boundFileName,
  canBindFile,
  cleanupMedia,
  clearAll,
  importJson,
  mediaStats,
  pickOpenFile,
  unbindFile,
} from '../local/transfer';
import { toastError, useStore, type SettingsTab } from '../store';
import type { Profile, TLType } from '../types';
import { Modal } from './Modal';

const PROFILE_OPTIONS: { key: Profile; label: string }[] = [
  { key: 'anime', label: '按动画匹配' },
  { key: 'manga', label: '按漫画匹配' },
  { key: 'novel', label: '按小说匹配' },
  { key: 'movie', label: '按电影匹配' },
  { key: 'tv', label: '按电视剧匹配' },
  { key: 'generic', label: '通用（百科）' },
  { key: 'none', label: '不自动获取' },
];

function TypeRow({ t, index, total, count }: { t: TLType; index: number; total: number; count: number }) {
  const types = useStore((s) => s.types);
  const [name, setName] = useState(t.name);
  const [icon, setIcon] = useState(t.icon);
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState(types.find((x) => x.id !== t.id)?.id ?? '');

  const patch = async (p: Partial<TLType>) => {
    try {
      const updated = await api.updateType(t.id, p);
      useStore.setState((s) => ({ types: s.types.map((x) => (x.id === t.id ? updated : x)) }));
    } catch (err) {
      toastError(err);
      setName(t.name);
      setIcon(t.icon);
    }
  };

  const move = async (dir: -1 | 1) => {
    const ids = types.map((x) => x.id);
    const j = index + dir;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    try {
      const r = await api.reorderTypes(ids);
      useStore.getState().setTaxonomy(r);
    } catch (err) {
      toastError(err);
    }
  };

  const remove = async () => {
    try {
      await api.deleteType(t.id, count ? moveTo : undefined);
      useStore.setState((s) => ({ types: s.types.filter((x) => x.id !== t.id) }));
      if (count) await useStore.getState().load();
      useStore.getState().toast(`已删除类型「${t.name}」`, 'success');
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className="set-row">
      <input type="color" className="color" value={t.color} onChange={(e) => void patch({ color: e.target.value })} title="颜色" />
      <input
        className="input icon-input"
        value={icon}
        maxLength={4}
        placeholder="图标"
        title="图标（可填 emoji）"
        onChange={(e) => setIcon(e.target.value)}
        onBlur={() => icon !== t.icon && void patch({ icon })}
      />
      <input
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== t.name && void patch({ name: name.trim() })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <select className="select" value={t.profile} onChange={(e) => void patch({ profile: e.target.value as Profile })} title="新节点如何自动获取封面与简介">
        {PROFILE_OPTIONS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
      <span className="set-count">{count}</span>
      <button className="icon-btn sm" disabled={index === 0} onClick={() => void move(-1)} title="上移">
        <ArrowUp size={14} />
      </button>
      <button className="icon-btn sm" disabled={index === total - 1} onClick={() => void move(1)} title="下移">
        <ArrowDown size={14} />
      </button>
      {deleting ? (
        <span className="set-confirm">
          {count > 0 && (
            <>
              {count} 个节点迁移到
              <select className="select sm" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                {types
                  .filter((x) => x.id !== t.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </select>
            </>
          )}
          <button className="btn danger sm" onClick={() => void remove()}>
            确认删除
          </button>
          <button className="btn ghost sm" onClick={() => setDeleting(false)}>
            取消
          </button>
        </span>
      ) : (
        <button className="icon-btn sm danger" disabled={total <= 1} onClick={() => setDeleting(true)} title="删除类型">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}

function TypesTab() {
  const types = useStore((s) => s.types);
  const d = useDerived();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#38d9a9');
  const [profile, setProfile] = useState<Profile>('generic');

  const add = async () => {
    if (!name.trim()) return;
    try {
      const t = await api.createType({ name: name.trim(), color, icon: '', profile });
      useStore.setState((s) => ({ types: s.types.some((x) => x.id === t.id) ? s.types : [...s.types, t] }));
      setName('');
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className="set-tab">
      <p className="muted small">
        主类型决定节点的颜色、图标，以及自动获取封面/简介时去哪些网站查找。「不自动获取」适合日常事件。
      </p>
      <div className="set-head">
        <span>颜色</span>
        <span>图标</span>
        <span>名称</span>
        <span>自动获取方式</span>
        <span>节点</span>
      </div>
      {types.map((t, i) => (
        <TypeRow key={`${t.id}-${t.name}-${t.icon}`} t={t} index={i} total={types.length} count={d.countByType.get(t.id) ?? 0} />
      ))}
      <div className="set-row add">
        <input type="color" className="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <input
          className="input"
          value={name}
          placeholder="新类型名称，如：游戏、纪录片、播客"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <select className="select" value={profile} onChange={(e) => setProfile(e.target.value as Profile)}>
          {PROFILE_OPTIONS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <button className="btn primary sm" onClick={() => void add()} disabled={!name.trim()}>
          <Plus size={14} /> 添加类型
        </button>
      </div>
    </div>
  );
}

function RegionsTab() {
  const regions = useStore((s) => s.regions);
  const d = useDerived();
  const [name, setName] = useState('');
  const counts = new Map<string, number>();
  for (const [k, v] of d.countByTypeRegion) {
    const r = k.split('|')[1];
    counts.set(r, (counts.get(r) ?? 0) + v);
  }

  const add = async () => {
    if (!name.trim()) return;
    try {
      const r = await api.createRegion(name.trim());
      useStore.setState((s) => ({ regions: s.regions.some((x) => x.id === r.id) ? s.regions : [...s.regions, r] }));
      setName('');
    } catch (err) {
      toastError(err);
    }
  };

  const rename = async (id: string, value: string) => {
    try {
      const r = await api.updateRegion(id, value);
      useStore.setState((s) => ({ regions: s.regions.map((x) => (x.id === id ? r : x)) }));
    } catch (err) {
      toastError(err);
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    const ids = regions.map((x) => x.id);
    const j = index + dir;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    try {
      useStore.getState().setTaxonomy(await api.reorderRegions(ids));
    } catch (err) {
      toastError(err);
    }
  };

  const remove = (id: string, label: string) => {
    const n = counts.get(id) ?? 0;
    useStore.getState().openModal({
      kind: 'confirm',
      title: '删除国籍/地区',
      message: n ? `「${label}」下有 ${n} 个节点，删除后它们会变为未设置国籍。确定删除吗？` : `确定删除「${label}」吗？`,
      confirmText: '删除',
      danger: true,
      onConfirm: async () => {
        await api.deleteRegion(id);
        await useStore.getState().load();
        useStore.getState().openModal({ kind: 'settings', tab: 'regions' });
      },
    });
  };

  return (
    <div className="set-tab">
      <p className="muted small">国籍是作品的子类型（可选）。筛选时可以精确到「动画 · 日本」这样的子类型。</p>
      {regions.map((r, i) => (
        <div className="set-row" key={`${r.id}-${r.name}`}>
          <input
            className="input"
            defaultValue={r.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== r.name && void rename(r.id, e.target.value.trim())}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <span className="set-count">{counts.get(r.id) ?? 0}</span>
          <button className="icon-btn sm" disabled={i === 0} onClick={() => void move(i, -1)} title="上移">
            <ArrowUp size={14} />
          </button>
          <button className="icon-btn sm" disabled={i === regions.length - 1} onClick={() => void move(i, 1)} title="下移">
            <ArrowDown size={14} />
          </button>
          <button className="icon-btn sm danger" onClick={() => remove(r.id, r.name)} title="删除">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="set-row add">
        <input className="input" value={name} placeholder="新国籍/地区，如：英国、法国、中国台湾" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <button className="btn primary sm" onClick={() => void add()} disabled={!name.trim()}>
          <Plus size={14} /> 添加
        </button>
      </div>
    </div>
  );
}

function ProxyCard() {
  const [value, setValue] = useState(customProxy());
  const [state, setState] = useState<{ busy?: boolean; msg?: string; ok?: boolean }>({});
  const builtin = builtinProxyAvailable();
  const active = hasProxy();

  const save = async () => {
    const v = value.trim();
    if (v) {
      setState({ busy: true });
      try {
        await testProxy(v);
      } catch (err) {
        setState({ msg: `测试失败：${describeError(err)}`, ok: false });
        return;
      }
    }
    setCustomProxy(v);
    setState({ msg: v ? '代理可用，已保存' : '已清除自定义代理', ok: true });
  };

  return (
    <div className="data-card">
      <div>
        <div className="t">
          跨域代理{' '}
          <span className={`small ${active ? 'tag-ok' : 'tag-warn'}`}>
            {customProxy() ? '· 使用自定义代理' : builtin ? '· 使用开发服务器自带代理' : '· 未启用'}
          </span>
        </div>
        <div className="muted small">
          豆瓣、必应图片、百度图片不允许浏览器直接跨域访问，需要代理才能使用；AniList、维基百科、Bangumi、百度百科无需代理。
          通过 npm run dev / npm run preview 打开时会自动使用自带代理；部署为静态网站时可填写自己的代理地址，
          用 {'{url}'} 表示目标地址（省略时追加在末尾），例如 https://your-worker.example.dev/?url={'{url}'}
        </div>
        <div className="proxy-row">
          <input className="input sm" value={value} placeholder="自定义代理地址（可选）" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
          <button className="btn sm" disabled={state.busy || value.trim() === customProxy()} onClick={() => void save()}>
            {state.busy && <Loader2 size={14} className="spin" />}
            {value.trim() ? '测试并保存' : '清除'}
          </button>
        </div>
        {state.msg && <div className={`small ${state.ok ? 'tag-ok' : 'tag-warn'}`} style={{ marginTop: 6 }}>{state.msg}</div>}
      </div>
    </div>
  );
}

/** 用临时的文件输入框选择 JSON（不依赖组件是否仍然挂载） */
function chooseJsonFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function DataTab() {
  const [busy, setBusy] = useState<string | null>(null);
  const [withMedia, setWithMedia] = useState(exportMediaPref());
  const [stats, setStats] = useState<Awaited<ReturnType<typeof mediaStats>> | null>(null);
  const [bound, setBound] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const dirty = useStore((s) => s.dirty);
  const toast = useStore((s) => s.toast);
  const counts = useStore((s) => Object.keys(s.nodes).length);

  const refresh = async () => {
    setStats(await mediaStats().catch(() => null));
    setBound(await boundFileName().catch(() => null));
    const est = await navigator.storage?.estimate?.().catch(() => null);
    if (est?.usage != null && est.quota) setUsage({ used: est.usage, quota: est.quota });
  };

  useEffect(() => {
    void refresh();
  }, [dirty, counts]);

  const doImport = async (file: File, mode: 'merge' | 'replace') => {
    setBusy(mode);
    try {
      const r = await importJson(await file.text(), mode);
      await useStore.getState().load();
      fitAllNodes();
      toast(
        `${mode === 'replace' ? '已打开' : '已合并'}：${r.nodes} 个节点、${r.comments} 条评论${r.media ? `、${r.media} 个媒体文件` : ''}`,
        'success',
      );
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  const pick = async (mode: 'merge' | 'replace') => {
    try {
      const f = mode === 'replace' && canBindFile() ? await pickOpenFile() : await chooseJsonFile();
      if (f) await doImport(f, mode);
    } catch (err) {
      toastError(err);
    }
  };

  const confirmOpen = () => {
    if (!counts) {
      void pick('replace');
      return;
    }
    useStore.getState().openModal({
      kind: 'confirm',
      title: '打开 JSON 文件',
      message: `打开文件会用文件中的数据替换当前浏览器中的全部数据（${counts} 个节点）。${dirty ? '当前有未保存到文件的修改，建议先保存。' : ''}确定继续吗？`,
      confirmText: '选择文件',
      danger: true,
      onConfirm: async () => {
        useStore.getState().openModal({ kind: 'settings', tab: 'data' });
        await pick('replace');
      },
    });
  };

  const save = async (saveAs: boolean) => {
    setBusy(saveAs ? 'saveas' : 'save');
    try {
      await saveNow(saveAs);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="set-tab data-tab">
      <div className="data-section">保存与导入</div>
      <div className="data-card">
        <div>
          <div className="t">
            保存为 JSON <span className={`small ${dirty ? 'tag-warn' : 'tag-ok'}`}>{dirty ? '· 有未保存的修改' : '· 已保存'}</span>
          </div>
          <div className="muted small">
            数据实时保存在当前浏览器中；保存为 JSON 文件用于备份，或在其他浏览器、设备上打开。
            {canBindFile() ? ' 首次保存选择位置后，Ctrl+S 会直接覆盖该文件。' : ' 每次保存都会下载一个新文件。'}
          </div>
          <div className="opts">
            <label className="check">
              <input
                type="checkbox"
                checked={withMedia}
                onChange={(e) => {
                  setWithMedia(e.target.checked);
                  setExportMediaPref(e.target.checked);
                }}
              />
              包含封面与评论中的图片/视频
              {stats ? `（${stats.count - stats.unused} 个，约 ${formatBytes(Math.max(0, stats.bytes - stats.unusedBytes))}）` : ''}
            </label>
            {bound && (
              <span>
                当前文件：{bound}{' '}
                <button
                  className="link-btn"
                  onClick={async () => {
                    await unbindFile();
                    await refresh();
                  }}
                >
                  取消关联
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" disabled={!!busy} onClick={() => void save(false)} title="Ctrl+S">
            {busy === 'save' ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void save(true)} title="Ctrl+Shift+S">
            <Download size={15} /> 另存为
          </button>
        </div>
      </div>
      <div className="data-card">
        <div>
          <div className="t">打开 JSON 文件</div>
          <div className="muted small">用文件中的数据替换当前全部数据（类型、国籍、节点、评论与媒体）。也支持旧版服务端导出的文件。</div>
        </div>
        <button className="btn" disabled={!!busy} onClick={confirmOpen}>
          {busy === 'replace' ? <Loader2 size={15} className="spin" /> : <FolderOpen size={15} />} 打开
        </button>
      </div>
      <div className="data-card">
        <div>
          <div className="t">导入并合并</div>
          <div className="muted small">按 id 合并：文件中同 id 的记录会覆盖当前记录，不会删除现有数据。</div>
        </div>
        <button className="btn" disabled={!!busy} onClick={() => void pick('merge')}>
          {busy === 'merge' ? <Loader2 size={15} className="spin" /> : <Upload size={15} />} 选择文件
        </button>
      </div>

      <div className="data-section">联网获取</div>
      <ProxyCard />
      <div className="data-card">
        <div>
          <div className="t">补全缺失的封面与简介</div>
          <div className="muted small">对所有缺少封面或简介的作品节点重新自动获取（后台进行，完成后自动刷新）。</div>
        </div>
        <button
          className="btn"
          onClick={async () => {
            try {
              const r = await api.autoMissing();
              toast(r.count ? `已为 ${r.count} 个节点排队获取` : '没有需要补全的节点', 'success');
            } catch (err) {
              toastError(err);
            }
          }}
        >
          <Wand2 size={15} /> 开始补全
        </button>
      </div>
      <div className="data-card">
        <div>
          <div className="t">导入示例数据</div>
          <div className="muted small">约 27 个示例节点（含同名多类型作品与日常事件），会自动联网获取封面。</div>
        </div>
        <button
          className="btn"
          onClick={async () => {
            try {
              const r = await api.demo();
              await useStore.getState().load();
              fitAllNodes();
              toast(`已添加 ${r.count} 个示例节点，封面正在获取`, 'success');
            } catch (err) {
              toastError(err);
            }
          }}
        >
          <Sparkles size={15} /> 导入示例
        </button>
      </div>

      <div className="data-section">存储</div>
      <div className="data-card">
        <div>
          <div className="t">清理未使用的媒体</div>
          <div className="muted small">
            删除已不被任何节点、评论或草稿引用的图片与视频。
            {stats && ` 共 ${stats.count} 个文件（${formatBytes(stats.bytes)}），其中未使用 ${stats.unused} 个（${formatBytes(stats.unusedBytes)}）。`}
            {usage && ` 浏览器存储已用 ${formatBytes(usage.used)} / ${formatBytes(usage.quota)}。`}
          </div>
        </div>
        <button
          className="btn"
          disabled={!!busy || !stats?.unused}
          onClick={async () => {
            try {
              const r = await cleanupMedia();
              toast(`已清理 ${r.count} 个文件，释放 ${formatBytes(r.bytes)}`, 'success');
              await refresh();
            } catch (err) {
              toastError(err);
            }
          }}
        >
          <Eraser size={15} /> 清理
        </button>
      </div>
      <div className="data-card danger-zone">
        <div>
          <div className="t">清空全部数据</div>
          <div className="muted small">删除浏览器中保存的全部节点、评论、媒体与自定义类型，恢复初始状态。建议先保存 JSON 备份。</div>
        </div>
        <button
          className="btn danger"
          disabled={!!busy}
          onClick={() =>
            useStore.getState().openModal({
              kind: 'confirm',
              title: '清空全部数据',
              message: `将删除浏览器中的全部数据（${counts} 个节点及其评论、媒体）。${dirty ? '当前有未保存到文件的修改，' : ''}此操作无法撤销，确定继续吗？`,
              confirmText: '清空',
              danger: true,
              onConfirm: async () => {
                await clearAll();
                await useStore.getState().load();
                useStore.getState().toast('已清空', 'success');
              },
            })
          }
        >
          <Trash2 size={15} /> 清空
        </button>
      </div>
    </div>
  );
}

export function Settings({ tab: initial }: { tab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initial ?? 'types');
  const close = useStore((s) => s.closeModal);
  return (
    <Modal title="设置" onClose={close} width={760} className="settings">
      <div className="seg tabs">
        <button className={tab === 'types' ? 'on' : ''} onClick={() => setTab('types')}>
          主类型
        </button>
        <button className={tab === 'regions' ? 'on' : ''} onClick={() => setTab('regions')}>
          国籍（子类型）
        </button>
        <button className={tab === 'data' ? 'on' : ''} onClick={() => setTab('data')}>
          数据
        </button>
      </div>
      {tab === 'types' ? <TypesTab /> : tab === 'regions' ? <RegionsTab /> : <DataTab />}
    </Modal>
  );
}
