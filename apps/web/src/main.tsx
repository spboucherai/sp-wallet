import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './theme';
import './styles.css';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5000, gcTime: 0 } } });
// Development only: `?mock=1` simulates the derivatives API in the browser (recorded fixtures, no backend). `import.meta.env.DEV`
// is the constant `false` in a production build, so this block and the mock module are removed from the bundle.
if (import.meta.env.DEV) {
  const q = new URLSearchParams(location.search);
  if (q.get('mock') === '1') sessionStorage.setItem('spw-mock', q.get('empty') === '1' ? 'empty' : '1');
  else if (q.get('mock') === '0') sessionStorage.removeItem('spw-mock');
  if (sessionStorage.getItem('spw-mock') !== null) (await import('./derivatives/mock')).installMock();
}
applyTheme(localStorage.getItem('spw-theme') === 'dark' ? 'dark' : 'light'); // light by default
// Development only: /__icons shows every logo of the set on one page (src/IconWall.tsx); removed from the production bundle.
if (import.meta.env.DEV && location.pathname === '/__icons') {
  const { IconWall } = await import('./IconWall');
  createRoot(document.getElementById('root')!).render(<IconWall />);
} else
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={qc}><App /></QueryClientProvider></StrictMode>);
