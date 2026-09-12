import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/global.css';

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {App} from './App.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {retry: false, refetchOnWindowFocus: false, staleTime: 30_000},
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
