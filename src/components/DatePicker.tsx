import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDate, parseDateInput, parseParts, toDateString } from '../lib/dates';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/** 日历取景范围随精度变化：只有年份时整年可选，有月时整月可选，有日时才精确到天 */
function viewOf(value: string): { y: number; m: number; mode: 'year' | 'month' | 'day' } {
  const p = parseParts(value);
  const y = p?.y ?? new Date().getFullYear();
  const m = p?.m ?? 1;
  const mode = p?.d ? 'day' : p?.m ? 'month' : 'year';
  return { y, m, mode };
}

export function DatePicker({ value, onChange, placeholder, autoFocus, id }: Props) {
  const parsed = value.trim() ? parseDateInput(value) : null;
  const invalid = !!value.trim() && !parsed;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => viewOf(value));
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const calRef = useRef<HTMLDivElement>(null);

  useEffect(() => setView(viewOf(value)), [value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const commit = (y: number, m = 0, d = 0) => {
    onChange(toDateString(y, m, d));
    if (d) setOpen(false);
  };

  const stepYear = (delta: number) => setView((v) => ({ ...v, y: Math.min(2999, Math.max(1000, v.y + delta)) }));
  const stepMonth = (delta: number) =>
    setView((v) => {
      let y = v.y;
      let m = v.m + delta;
      if (m < 1) {
        m = 12;
        y--;
      } else if (m > 12) {
        m = 1;
        y++;
      }
      return { ...v, y: Math.min(2999, Math.max(1000, y)), m };
    });

  // 当前选中的年/月/日（用于高亮）
  const sp = parseParts(parsed ?? '');
  const selY = sp?.y;
  const selM = sp?.m;
  const selD = sp?.d;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !parsed) return;
    e.preventDefault();
    const el = e.currentTarget;
    const caret = parsed === value ? el.selectionStart ?? value.length : parsed.length;
    const p = parseParts(parsed)!;
    const delta = e.key === 'ArrowUp' ? 1 : -1;
    let part: 'y' | 'm' | 'd' = caret <= 4 ? 'y' : caret <= 7 ? 'm' : 'd';
    if (part === 'd' && !p.d) part = p.m ? 'm' : 'y';
    if (part === 'm' && !p.m) part = 'y';
    let { y, m, d } = p;
    if (part === 'y') y += delta;
    else if (part === 'm') {
      m += delta;
      if (m > 12) {
        m = 1;
        y++;
      } else if (m < 1) {
        m = 12;
        y--;
      }
    } else {
      const t = new Date(Date.UTC(y, m - 1, d + delta));
      y = t.getUTCFullYear();
      m = t.getUTCMonth() + 1;
      d = t.getUTCDate();
    }
    if (d) d = Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate());
    y = Math.min(2999, Math.max(1000, y));
    const next = toDateString(y, m, d);
    onChange(next);
    requestAnimationFrame(() => el.setSelectionRange(caret, caret));
  };

  return (
    <div className="date-picker" ref={wrapRef}>
      <div className={`date-input ${invalid ? 'invalid' : ''}`}>
        <input
          id={id}
          ref={inputRef}
          className="input"
          value={value}
          placeholder={placeholder ?? '如 2013、2013-04、2013-04-07'}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            if (parsed && parsed !== value) onChange(parsed);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
        />
        <button type="button" className="date-cal-btn" onClick={() => setOpen((o) => !o)} title="选择日期" tabIndex={-1}>
          <CalendarDays size={15} />
        </button>
        <span className="date-hint">{invalid ? '无法识别的日期' : parsed ? formatDate(parsed) : '可只填年或年月'}</span>
      </div>

      {open && (
        <div className="date-pop" ref={calRef} onMouseDown={(e) => e.stopPropagation()}>
          <div className="date-nav">
            {view.mode === 'day' ? (
              <>
                <button className="icon-btn" onClick={() => stepYear(-1)} title="上一年">
                  <ChevronLeft size={15} />
                </button>
                <button className="icon-btn" onClick={() => stepMonth(-1)} title="上个月">
                  <ChevronLeft size={13} />
                </button>
                <button className="date-title" onClick={() => setView((v) => ({ ...v, mode: 'month' }))}>
                  {view.y}年 {view.m}月
                </button>
                <button className="icon-btn" onClick={() => stepMonth(1)} title="下个月">
                  <ChevronRight size={13} />
                </button>
                <button className="icon-btn" onClick={() => stepYear(1)} title="下一年">
                  <ChevronRight size={15} />
                </button>
              </>
            ) : view.mode === 'month' ? (
              <>
                <button className="icon-btn" onClick={() => stepYear(-1)} title="上一年">
                  <ChevronLeft size={15} />
                </button>
                <button className="date-title" onClick={() => setView((v) => ({ ...v, mode: 'year' }))}>
                  {view.y}年
                </button>
                <button className="icon-btn" onClick={() => stepYear(1)} title="下一年">
                  <ChevronRight size={15} />
                </button>
              </>
            ) : (
              <>
                <button className="icon-btn" onClick={() => stepYear(-12)} title="上一页">
                  <ChevronLeft size={15} />
                </button>
                <button className="date-title" onClick={() => setView((v) => ({ ...v, mode: 'day' }))}>
                  {view.y - 6} – {view.y + 5}
                </button>
                <button className="icon-btn" onClick={() => stepYear(12)} title="下一页">
                  <ChevronRight size={15} />
                </button>
              </>
            )}
          </div>

          {view.mode === 'day' && <CalendarGrid view={view} selY={selY} selM={selM} selD={selD} onPick={(y, m, d) => commit(y, m, d)} />}
          {view.mode === 'month' && (
            <div className="date-months">
              {MONTHS.map((name, i) => (
                <button
                  key={name}
                  className={`date-cell ${selY === view.y && selM === i + 1 ? 'on' : ''}`}
                  onClick={() => setView((v) => ({ ...v, m: i + 1, mode: 'day' }))}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          {view.mode === 'year' && (
            <div className="date-years">
              {Array.from({ length: 12 }, (_, i) => view.y - 6 + i).map((y) => (
                <button key={y} className={`date-cell ${selY === y ? 'on' : ''}`} onClick={() => setView((v) => ({ ...v, y, mode: 'month' }))}>
                  {y}
                </button>
              ))}
            </div>
          )}

          <div className="date-foot">
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                const t = new Date();
                commit(t.getFullYear(), t.getMonth() + 1, t.getDate());
              }}
            >
              今天
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CalendarGrid({
  view,
  selY,
  selM,
  selD,
  onPick,
}: {
  view: { y: number; m: number };
  selY?: number;
  selM?: number;
  selD?: number;
  onPick: (y: number, m: number, d: number) => void;
}) {
  const first = new Date(Date.UTC(view.y, view.m - 1, 1));
  const startDow = (first.getUTCDay() + 6) % 7; // 周一为 0
  const days = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const today = new Date();
  const isToday = (d: number) => view.y === today.getFullYear() && view.m === today.getMonth() + 1 && d === today.getDate();
  return (
    <div className="date-grid">
      <div className="date-week">
        {WEEK.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="date-days">
        {cells.map((d, i) => (
          <button
            key={i}
            disabled={d == null}
            className={`date-cell ${d != null && selY === view.y && selM === view.m && selD === d ? 'on' : ''} ${d != null && isToday(d) ? 'today' : ''}`}
            onClick={() => d != null && onPick(view.y, view.m, d)}
          >
            {d ?? ''}
          </button>
        ))}
      </div>
    </div>
  );
}
