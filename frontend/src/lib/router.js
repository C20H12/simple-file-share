import { useSyncExternalStore } from 'react';

// A minimal History API router: the app has only a home page and share links.
//   /            home
//   /482913      receive an uploaded share
//   /p/715046    receive a peer share

const subscribe = (onChange) => {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
};

export const usePath = () => useSyncExternalStore(subscribe, () => window.location.pathname);

export function navigate(path, { replace = false } = {}) {
  if (path === window.location.pathname) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function matchRoute(path) {
  if (path === '/') return { name: 'home' };
  const share = /^\/(p\/)?(\d{6})\/?$/.exec(path);
  if (share) return { name: 'receive', kind: share[1] ? 'peer' : 'uploaded', code: share[2] };
  return { name: 'unknown' };
}

export const sharePath = (code, kind = 'uploaded') => (kind === 'peer' ? `/p/${code}` : `/${code}`);
