import { useEffect, useState } from 'react';

// Copy-to-clipboard with a short "Copied" confirmation.
// Returns [copiedId, copy]: call copy(id, text), and copiedId equals that id
// for a moment afterwards so the matching button can change its label.
export function useCopied() {
  const [copiedId, setCopiedId] = useState('');

  useEffect(() => {
    if (!copiedId) return;
    const reset = setTimeout(() => setCopiedId(''), 1600);
    return () => clearTimeout(reset);
  }, [copiedId]);

  const copy = (id, text) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(id);
  };

  return [copiedId, copy];
}
