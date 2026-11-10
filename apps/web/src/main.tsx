import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './theme';
import './styles.css';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5000, gcTime: 0 } } });
applyTheme(localStorage.getItem('spw-theme') === 'dark' ? 'dark' : 'light'); // light by default
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={qc}><App /></QueryClientProvider></StrictMode>);
