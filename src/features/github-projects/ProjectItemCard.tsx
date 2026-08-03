import { memo } from 'react'
import { ExternalLink, FileEdit, GitPullRequest, LayoutDashboard } from 'lucide-react'
import { openUrl } from '@/lib/open-url'
import type { ProjectItem } from '@/domain/types'

const CONTENT_ICON = {
  issue: LayoutDashboard,
  pullRequest: GitPullRequest,
  draftIssue: FileEdit,
  unknown: LayoutDashboard,
} as const

export const ProjectItemCard = memo(function ProjectItemCard({ item }: { item: ProjectItem }) {
  const Icon = CONTENT_ICON[item.contentType]

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-adaptive-200 bg-card p-2.5">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 flex-none text-adaptive-400" />
        {item.url ? (
          <button
            type="button"
            onClick={() => openUrl(item.url!)}
            className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium hover:text-primary-600 hover:underline"
            title={`${item.title} — open on GitHub`}
          >
            {item.title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{item.title}</span>
        )}
        {item.url && (
          <button
            type="button"
            onClick={() => openUrl(item.url!)}
            title="Open on GitHub"
            className="flex-none text-adaptive-400 hover:text-primary-600"
          >
            <ExternalLink className="size-3" />
          </button>
        )}
      </div>

      {(item.repository || item.number != null) && (
        <span className="font-mono text-[10.5px] text-adaptive-500">
          {item.repository ?? 'draft'}
          {item.number != null && ` #${item.number}`}
        </span>
      )}

      {(item.assignees.length > 0 || item.labels.length > 0) && (
        <div className="flex flex-wrap items-center gap-1">
          {item.assignees.map((a) => (
            <span
              key={a}
              className="rounded-sm border border-adaptive-200 px-1 text-[10px] text-adaptive-600"
            >
              @{a}
            </span>
          ))}
          {item.labels.map((l) => (
            <span
              key={l}
              className="rounded-sm border border-adaptive-200 px-1 text-[10px] text-adaptive-500"
            >
              {l}
            </span>
          ))}
        </div>
      )}
    </div>
  )
})
