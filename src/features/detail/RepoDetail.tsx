import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { RepoId } from '@/domain/types'
import { useUiStore, type DetailTab } from '@/stores/ui-store'
import { RepoHeader } from './RepoHeader'
import { useDetailRepo } from './use-detail-repo'
import { BranchesPanel } from './panels/BranchesPanel'
import { ChangesPanel } from './panels/ChangesPanel'
import { CommitsPanel } from './panels/CommitsPanel'
import { PackagesPanel } from './panels/PackagesPanel'
import { GhActionsPanel } from './panels/GhActionsPanel'
import { PullRequestsPanel } from './panels/PullRequestsPanel'
import { RunsPanel } from './panels/RunsPanel'

/**
 * Everything about one repo, in place of the list.
 *
 * Three regions, and the middle one is the only thing that scrolls: a pinned
 * header, a tab strip, and a panel that owns its own scrollport. It used to be a
 * single page-level scroller, so a repo with 40 changed files pushed the name, the
 * branch, every button *and* the tab strip off the top of the panel — and the way
 * back was to scroll up through the whole list.
 *
 * `wa-detail` makes this a container query root. The panel it lives in is
 * user-resizable from 420px, so every column layout inside measures this element
 * rather than the window; see the note in wa-bridge.css.
 */
export function RepoDetail({ repoId: id }: { repoId: RepoId }) {
  const tab = useUiStore((s) => s.detailTab)
  const setTab = useUiStore((s) => s.setDetailTab)
  const ctx = useDetailRepo(id)

  return (
    // `min-h-0 flex-1`, not `h-full`: this replaces RepoGrid in the same flex slot
    // and has to size the same way it does.
    <div className="wa-detail wa-view-enter flex min-h-0 min-w-0 flex-1 flex-col gap-3.5 overflow-hidden px-4 py-3.5">
      <RepoHeader ctx={ctx} />

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as DetailTab)}
        className="min-h-0 flex-1"
      >
        {/* `line` rather than the default filled pill group: that variant is a 36px
            bar of muted background, which is too much weight directly under a
            header that already carries three rows. */}
        {/* Seven triggers now, against a panel that can be dragged to 420px. It
            scrolls rather than shortening labels — "PRs" and "Pkgs" save 60px and
            cost the two tabs nobody visits daily. */}
        <TabsList variant="line" className="wa-scroll flex-none overflow-x-auto">
          <TabsTrigger value="changes">Changes</TabsTrigger>
          <TabsTrigger value="commits">Commits</TabsTrigger>
          <TabsTrigger value="branches">Branches</TabsTrigger>
          <TabsTrigger value="packages">Packages</TabsTrigger>
          <TabsTrigger value="prs">Pull requests</TabsTrigger>
          {/* GitHub's Actions, not this app's — the Runs tab beside it is the
              local process log. */}
          <TabsTrigger value="actions">Actions</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>

        {/* Each TabsContent has to carry the flex chain itself — Radix renders only
            the active one, so a height set on the list would not reach the panel. */}
        <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col">
          <ChangesPanel repo={ctx.repo} id={id} />
        </TabsContent>
        <TabsContent value="commits" className="flex min-h-0 flex-1 flex-col">
          <CommitsPanel repo={ctx.repo} id={id} />
        </TabsContent>
        <TabsContent value="branches" className="flex min-h-0 flex-1 flex-col">
          <BranchesPanel repo={ctx.repo} id={id} />
        </TabsContent>
        <TabsContent value="packages" className="flex min-h-0 flex-1 flex-col">
          <PackagesPanel repo={ctx.repo} id={id} />
        </TabsContent>
        <TabsContent value="prs" className="flex min-h-0 flex-1 flex-col">
          <PullRequestsPanel repo={ctx.repo} id={id} />
        </TabsContent>
        <TabsContent value="actions" className="flex min-h-0 flex-1 flex-col">
          <GhActionsPanel repo={ctx.repo} id={id} />
        </TabsContent>
        <TabsContent value="runs" className="flex min-h-0 flex-1 flex-col">
          <RunsPanel id={id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
