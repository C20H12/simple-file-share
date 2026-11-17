export const formatSize = (bytes) =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

export const totalSize = (files) => files.reduce((sum, f) => sum + f.size, 0);

export const countLabel = (n) => `${n} ${n === 1 ? 'file' : 'files'}`;

export const summary = (files) => `${countLabel(files.length)} · ${formatSize(totalSize(files))}`;

export const extOf = (name) => name.split('.').pop() || '';

export const isImage = (name) => /^(jpe?g|png|gif|webp|heic)$/i.test(extOf(name));
export const isPdf = (name) => /^pdf$/i.test(extOf(name));
export const canPreview = (name) => isImage(name) || isPdf(name);

// "482913" -> "482 913"
export const formatCode = (code) => (code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

export function formatCountdown(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const pad = (v) => String(v).padStart(2, '0');
  return `${Math.floor(t / 86400)}d ${pad(Math.floor(t / 3600) % 24)}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
}
