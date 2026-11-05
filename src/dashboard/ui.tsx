// Design-system building blocks (Button, Tabs, Badge, Input, StatTile) for Preact.
import type { ComponentChildren } from 'preact';
import type { CSSProperties } from 'preact';
type Style = CSSProperties;
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ServiceView } from '../shared/types.js';

// ------------------------------------------------------------------ icons
export const IC = {
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  alert: 'M12 3.5l9 16H3zM12 10v4M12 17v.5',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  box: 'M4 7l8-4 8 4v10l-8 4-8-4zM4 7l8 4 8-4M12 11v10',
  play: 'M8 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
  x: 'M7 7l10 10M17 7L7 17',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8v.5',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  dash: 'M7 12h10',
  copy: 'M9 9h11v11H9zM5 15V6a2 2 0 0 1 2-2h8',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  back: 'M15 6l-6 6 6 6',
  chevron: 'M6 9l6 6 6-6',
  restart: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  down: 'M12 5v14M6 13l6 6 6-6',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l3 2',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  task: 'M8 5v14l11-7zM3 5v14',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  sparkle: 'M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z',
};

export function Icon({ d, size = 16, stroke = 1.8, fill, style }: { d: string; size?: number; stroke?: number; fill?: boolean; style?: Style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={style}>
      <path d={d} />
    </svg>
  );
}

export function Spinner({ size = 14, color = 'var(--aurora-blue)' }: { size?: number; color?: string }) {
  return (
    <svg class="dp-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-9-9" />
    </svg>
  );
}

// ------------------------------------------------------------------ controls
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ variant = 'primary', size = 'md', disabled, onClick, children, title, style, type = 'button' }: { variant?: BtnVariant; size?: 'sm' | 'md'; disabled?: boolean; onClick?: (e: MouseEvent) => void; children: ComponentChildren; title?: string; style?: Style; type?: 'button' | 'submit' }) {
  return (
    <button type={type} class={`ds-btn ${variant}${size === 'sm' ? ' sm' : ''}`} disabled={disabled} onClick={onClick} title={title} style={style}>
      {children}
    </button>
  );
}

export interface TabItem {
  id: string;
  label: ComponentChildren;
}

/** Capsule tabs with a sliding white thumb, like the DS Tabs. */
export function Tabs({ items, value, onChange, size = 'md' }: { items: TabItem[]; value: string; onChange: (id: string) => void; size?: 'sm' | 'md' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cap, setCap] = useState({ x: 0, w: 0, ok: false });
  // Labels carry live counts ("Running · 8"), so the thumb is measured on every
  // render — but state is only set when the geometry really changed; setting a
  // fresh object each time re-rendered forever and froze the page.
  const labels = items.map((i) => `${i.id}:${String(i.label)}`).join('|');
  useLayoutEffect(() => {
    const el = ref.current?.querySelector(`[data-tab="${CSS.escape(value)}"]`) as HTMLElement | null;
    if (!el) return;
    const x = el.offsetLeft;
    const w = el.offsetWidth;
    setCap((c) => (c.ok && c.x === x && c.w === w ? c : { x, w, ok: true }));
  }, [value, labels]);
  return (
    <div ref={ref} role="tablist" class={`ds-tabs${size === 'sm' ? ' sm' : ''}`}>
      <span class="cap" aria-hidden="true" style={{ width: `${cap.w}px`, transform: `translateX(${cap.x}px)`, opacity: cap.ok ? 1 : 0 }} />
      {items.map((it) => (
        <button key={it.id} data-tab={it.id} role="tab" aria-selected={it.id === value} class="ds-tab" onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function Badge({ tone = 'neutral', dot, children }: { tone?: Tone; dot?: boolean; children: ComponentChildren }) {
  return (
    <span class={`badge ${tone}`}>
      {dot && <span class="bd" />}
      {children}
    </span>
  );
}

export function Input({ value, onInput, placeholder, size = 'md', style, autoFocus, onKeyDown, invalid }: { value: string; onInput: (v: string) => void; placeholder?: string; size?: 'sm' | 'md'; style?: Style; autoFocus?: boolean; onKeyDown?: (e: KeyboardEvent) => void; invalid?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      class={`ds-input${size === 'sm' ? ' sm' : ''}`}
      style={{ ...(invalid ? { borderColor: 'var(--red-500)' } : {}), ...style }}
      value={value}
      placeholder={placeholder}
      onInput={(e) => onInput((e.target as HTMLInputElement).value)}
      onKeyDown={onKeyDown}
    />
  );
}

export function StatGrid({ columns, children }: { columns: number; children: ComponentChildren }) {
  return (
    <div class="stat-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {children}
    </div>
  );
}

export function Stat({ label, value, suffix, hint, valueColor }: { label: string; value: ComponentChildren; suffix?: string; hint?: ComponentChildren; valueColor?: string }) {
  return (
    <div class="stat">
      <span class="lbl">{label}</span>
      <div class="val" style={valueColor ? { color: valueColor } : undefined}>
        {value}
        {suffix && <small>{suffix}</small>}
      </div>
      {hint && <span class="hint">{hint}</span>}
    </div>
  );
}

export function Empty({ message, detail }: { message: string; detail?: string }) {
  return (
    <div class="empty">
      <div class="m">{message}</div>
      {detail && <div class="d">{detail}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ helpers
export const ago = (t?: number) => {
  if (!t) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
};
export const mb = (n?: number) => (n === undefined ? '—' : `${Math.round(n / 1048576)} MB`);
export const fmtCpu = (v: number) => `${v < 0.1 ? v.toFixed(2) : v.toFixed(1)}%`;

export const isLive = (s: ServiceView) => ['running', 'starting', 'unhealthy'].includes(s.status);
export const isFailing = (s: ServiceView) => ['crashed', 'backoff', 'unhealthy'].includes(s.status);
export const isBusy = (s: ServiceView) => s.status === 'starting' || s.status === 'stopping' || s.status === 'backoff' || !!s.queued || !!s.task;

/** Status label, badge tone and dot class for a service. */
export function statusMeta(s: ServiceView): { label: string; tone: Tone; dot: string } {
  if (s.task) return { label: s.task, tone: 'info', dot: 'busy' };
  if (s.queued) return { label: 'queued', tone: 'neutral', dot: 'busy' };
  switch (s.status) {
    case 'running':
      return { label: 'running', tone: 'success', dot: 'run' };
    case 'starting':
      return { label: 'starting', tone: 'info', dot: 'busy' };
    case 'stopping':
      return { label: 'stopping', tone: 'warning', dot: 'busy' };
    case 'unhealthy':
      return { label: 'unhealthy', tone: 'warning', dot: 'err' };
    case 'backoff':
      return { label: 'restarting', tone: 'info', dot: 'busy' };
    case 'crashed':
      return { label: 'crashed', tone: 'danger', dot: 'err' };
    case 'exited':
      return { label: 'exited', tone: 'neutral', dot: 'stop' };
    default:
      return { label: 'stopped', tone: 'neutral', dot: 'stop' };
  }
}

export function healthText(s: ServiceView): string {
  const h = s.health;
  if (h.kind === 'none' || h.state === 'none') return 'no check';
  if (h.state === 'ok') return `${h.kind} ok${h.latencyMs !== undefined ? ` · ${h.latencyMs}ms` : ''}`;
  if (h.state === 'failing') return `${h.kind} failing ×${h.consecutiveFailures}`;
  return isLive(s) ? `${h.kind} …` : `${h.kind} —`;
}

/** Line and area paths for a series scaled into w×h (top padding 10, bottom 2). */
export function seriesPaths(arr: number[], w: number, h: number, max: number): { line: string; area: string } {
  if (!arr.length) return { line: '', area: '' };
  const n = arr.length;
  const pts = arr.map((v, i) => [n === 1 ? w : (i / (n - 1)) * w, h - 2 - (Math.min(v, max) / max) * (h - 12)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  return { line, area: `${line}L${w},${h}L0,${h}Z` };
}

/** A round axis maximum: 1, 2, 2.5, 5 × 10^k, at least `floor`. */
export function niceMax(v: number, floor: number): number {
  const x = Math.max(v, floor);
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
