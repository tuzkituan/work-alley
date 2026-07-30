import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './styles/theme.css'
import { App } from './App'
import { WindowResizeEdges } from './features/topbar/WindowResizeEdges'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      // A desktop window regains focus constantly; refetching every repo on each
      // alt-tab would be a disaster.
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      {/* Window frame, not app UI: mounted here so it also covers the screens App
          returns early — the fatal error screen and the workspace picker, which are
          exactly the screens where being stuck at one size is least excusable. */}
      <WindowResizeEdges />
    </QueryClientProvider>
  </StrictMode>
)
