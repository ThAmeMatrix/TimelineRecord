import type { Relation, Scope, TLNode, TLType, Region } from '../types';
import { titleKey } from './text';

export const NO_REGION = '_';

export function inScope(n: TLNode, scope: Scope): boolean {
  if (scope.kind === 'none') return true;
  if (scope.kind === 'title') return titleKey(n.title) === scope.key;
  const regs = scope.sel[n.typeId];
  if (regs === undefined) return false;
  if (regs === null) return true;
  return regs.includes(n.regionId ?? NO_REGION);
}

export function relationScope(n: TLNode, rel: Relation): Scope {
  if (rel === 'title') return { kind: 'title', key: titleKey(n.title), title: n.title };
  if (rel === 'type') return { kind: 'filter', sel: { [n.typeId]: null }, origin: 'click' };
  return { kind: 'filter', sel: { [n.typeId]: [n.regionId ?? NO_REGION] }, origin: 'click' };
}

export function describeScope(scope: Scope, types: Map<string, TLType>, regions: Map<string, Region>): string {
  if (scope.kind === 'none') return '';
  if (scope.kind === 'title') return `同名「${scope.title}」`;
  const parts = Object.entries(scope.sel).map(([typeId, regs]) => {
    const t = types.get(typeId)?.name ?? '未知类型';
    if (regs === null) return t;
    const names = regs.map((r) => (r === NO_REGION ? '未设国籍' : regions.get(r)?.name ?? '未知'));
    return `${t}·${names.join('/')}`;
  });
  return parts.join(' + ');
}

export function scopeColor(scope: Scope, types: Map<string, TLType>): string {
  if (scope.kind === 'filter') {
    const ids = Object.keys(scope.sel);
    if (ids.length === 1) return types.get(ids[0])?.color ?? 'var(--accent)';
  }
  if (scope.kind === 'title') return 'var(--gold)';
  return 'var(--accent)';
}
