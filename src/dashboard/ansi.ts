// Minimal ANSI SGR -> HTML (colours, bold, dim, underline). Everything else is dropped.
const COLORS = ['#4b5563', '#ef4444', '#22c55e', '#eab308', '#3b82f6', '#d946ef', '#06b6d4', '#d1d5db'];
const BRIGHT = ['#6b7280', '#f87171', '#4ade80', '#facc15', '#60a5fa', '#e879f9', '#22d3ee', '#f9fafb'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function color256(n: number): string {
  if (n < 8) return COLORS[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

export function ansiToHtml(input: string): string {
  let out = '';
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  let underline = false;
  let open = false;
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
  let last = 0;
  const flush = (text: string) => {
    if (!text) return;
    const style = [fg && `color:${fg}`, bg && `background:${bg}`, bold && 'font-weight:600', dim && 'opacity:.6', underline && 'text-decoration:underline'].filter(Boolean).join(';');
    out += style ? `<span style="${style}">${esc(text)}</span>` : esc(text);
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    flush(input.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) (fg = bg = undefined), (bold = dim = underline = false);
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 4) underline = true;
      else if (c === 22) bold = dim = false;
      else if (c === 24) underline = false;
      else if (c >= 30 && c <= 37) fg = COLORS[c - 30];
      else if (c >= 90 && c <= 97) fg = BRIGHT[c - 90];
      else if (c === 39) fg = undefined;
      else if (c >= 40 && c <= 47) bg = COLORS[c - 40];
      else if (c === 49) bg = undefined;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const col = color256(codes[i + 2]);
        if (c === 38) fg = col;
        else bg = col;
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const col = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        if (c === 38) fg = col;
        else bg = col;
        i += 4;
      }
    }
    open = true;
  }
  void open;
  flush(input.slice(last));
  return out;
}
