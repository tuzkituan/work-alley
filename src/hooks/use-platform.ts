import { useQuery } from '@tanstack/react-query'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'

/**
 * Which OS the app is running on.
 *
 * Read from the bootstrap payload rather than sniffed from the user agent: under a
 * webview that string describes the renderer, not reliably the machine, and it is
 * WebKitGTK on Linux versus WebView2 on Windows — two entirely different strings for
 * the same question. The backend already knows, so it says.
 *
 * Only two things actually need this, and both are presentation: the window controls
 * (Windows draws its own shape of minimise/maximise/close) and path abbreviation
 * (`C:\\Users\\x` has no `~` and splits on a different separator). Everything else that
 * differs is decided in Rust, which is where it belongs — the frontend never builds a
 * command, so it never needs to know what a shell is.
 */
export type Platform = 'windows' | 'macos' | 'linux'

export function usePlatform(): Platform {
  const { data } = useQuery({
    queryKey: keys.bootstrap,
    queryFn: () => api.getBootstrap(),
    select: (b) => b.os,
  })
  return normalize(data)
}

/**
 * Rust's `std::env::consts::OS` mapped onto the three cases the UI handles.
 *
 * Defaults to `'linux'` rather than throwing: this is read during the first render,
 * before the bootstrap query resolves, and every use of it is cosmetic. Guessing wrong
 * for one frame costs nothing; a crash costs the whole window.
 */
export function normalize(os: string | undefined): Platform {
  if (os === 'windows') return 'windows'
  if (os === 'macos' || os === 'ios') return 'macos'
  return 'linux'
}
