export const colors = {
  background: '#0B0E13',
  card: '#151A22',
  cardRaised: '#1B2130',
  border: '#232A35',
  text: '#E7EAF0',
  muted: '#8A93A3',
  faint: '#5B6474',
  record: '#FF5A36',
  play: '#3DDC84',
  upload: '#4C8DFF',
  warn: '#FFB84C',
  danger: '#FF4C4C',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}
