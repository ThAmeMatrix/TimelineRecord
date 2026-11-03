import { formatDate, parseDateInput, parseParts, toDateString } from '../lib/dates';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
}

/** 宽松日期输入：支持 2013 / 2013-4 / 2013.4.7 / 2013年4月7日；↑↓ 调整光标所在的年/月/日 */
export function DateInput({ value, onChange, placeholder, autoFocus, id }: Props) {
  const parsed = value.trim() ? parseDateInput(value) : null;
  const invalid = !!value.trim() && !parsed;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !parsed) return;
    e.preventDefault();
    const el = e.currentTarget;
    const caret = parsed === value ? (el.selectionStart ?? value.length) : parsed.length;
    const p = parseParts(parsed);
    if (!p) return;
    const delta = e.key === 'ArrowUp' ? 1 : -1;
    let part: 'y' | 'm' | 'd' = caret <= 4 ? 'y' : caret <= 7 ? 'm' : 'd';
    if (part === 'd' && !p.d) part = p.m ? 'm' : 'y';
    if (part === 'm' && !p.m) part = 'y';
    let { y, m, d } = p;
    if (part === 'y') {
      y += delta;
    } else if (part === 'm') {
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
    <div className={`date-input ${invalid ? 'invalid' : ''}`}>
      <input
        id={id}
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
      />
      <span className="date-hint">{invalid ? '无法识别的日期' : parsed ? formatDate(parsed) : '可只填年或年月'}</span>
    </div>
  );
}
