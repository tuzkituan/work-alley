import { openUrl as openExternal } from '@tauri-apps/plugin-opener'

/**
 * Opens a URL in the system browser.
 *
 * A wrapper because every call site had grown the same `void openUrl(x).catch(()
 * => {})` by hand, and the `catch` is not incidental: the opener capability
 * (`src-tauri/capabilities/default.json`) allows localhost, github.com,
 * gitlab.com and bitbucket.org and *rejects* everything else. A refusal is a
 * rejected promise, so an unhandled one would surface as an unhandled rejection
 * for a link the app deliberately declined to open.
 *
 * The right way to avoid a silent refusal is not to render the link: the backend
 * only builds a `remoteWebBase` for hosts on that list.
 */
export function openUrl(url: string): void {
  void openExternal(url).catch(() => {})
}
