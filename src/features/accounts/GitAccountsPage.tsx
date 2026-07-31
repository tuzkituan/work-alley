import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, KeyRound, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionLabel } from '@/components/wa/primitives'
import { api } from '@/ipc/commands'
import { keys } from '@/queries/keys'
import { cn } from '@/lib/utils'
import { useRunAction } from '@/hooks/use-action'
import { toast } from 'sonner'
import { useUiStore } from '@/stores/ui-store'
import type { AccountsView, GitAccount, SshHostEntry } from '@/domain/types'

/** A new account's blank record. The id is generated in Rust from the label. */
const BLANK: GitAccount = {
  id: '',
  label: '',
  name: '',
  email: '',
  sshKey: null,
  signingKey: null,
  ghUser: null,
  sshHost: null,
  sshHostname: null,
}

/**
 * Several git identities on one machine, and which one is in force.
 *
 * The state this page exists to fix is not exotic: a work laptop with one personal
 * repo on it commits as the wrong person, pushes with the wrong key and opens the
 * pull request from the wrong GitHub login — and the three commands that fix it are
 * only ever remembered after the fact.
 *
 * The list is stored by the app; **who is active is read from the machine**, every
 * time. Someone can always run `git config` themselves, and a page that reported
 * its own last write instead of what `~/.gitconfig` actually says would be lying in
 * exactly the situation it was built for.
 *
 * Applying an account goes through the action gate like everything else that runs a
 * command, so the dialog names the config keys before they are written.
 */
export function GitAccountsPage() {
  const setPage = useUiStore((s) => s.setPage)
  const qc = useQueryClient()
  const [editing, setEditing] = useState<GitAccount | null>(null)

  const { data, isPending } = useQuery({
    queryKey: keys.gitAccounts,
    queryFn: () => api.listGitAccounts(),
    // Cheap — two `git config --get` and one `gh auth status` — and the answer moves
    // whenever anything else on the machine writes a git config.
    staleTime: 5_000,
  })

  const save = useMutation({
    mutationFn: (account: GitAccount) => api.saveGitAccount(account),
    onSuccess: (view) => {
      qc.setQueryData(keys.gitAccounts, view)
      // The block is generated from the accounts, so saving one changes what the
      // ssh card would write — including whether there is anything to write.
      void qc.invalidateQueries({ queryKey: keys.sshConfig })
      setEditing(null)
    },
    onError: (e: Error) => toast.error('Could not save the account', { description: e.message }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteGitAccount(id),
    onSuccess: (view) => {
      qc.setQueryData(keys.gitAccounts, view)
      void qc.invalidateQueries({ queryKey: keys.sshConfig })
    },
    onError: (e: Error) => toast.error('Could not delete the account', { description: e.message }),
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Outside the scroller, like the setup page's: a sticky row inside it leaves
          a gap either side, since the column is narrower than the page. */}
      <div className="flex-none border-b border-adaptive-200 bg-background px-4 py-3">
        <div className="mx-auto flex w-full max-w-[56rem] items-center gap-2">
          <Button
            variant="waGhost"
            size="waIcon"
            onClick={() => setPage('repos')}
            title="Back to the workspace"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <h1 className="text-base font-semibold tracking-[-0.01em]">Git accounts</h1>
          {data && (
            <span className="wa-num font-mono text-[11px] text-adaptive-400">
              {data.accounts.length}
            </span>
          )}
          <div className="flex-1" />
          <Button
            variant="waPrimary"
            size="waXs"
            disabled={!!editing}
            onClick={() => setEditing(BLANK)}
          >
            <Plus className="size-3" />
            Add account
          </Button>
        </div>
      </div>

      <div className="wa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-3.5">
          <Current view={data} pending={isPending} />

          {editing && (
            <AccountForm
              account={editing}
              busy={save.isPending}
              onCancel={() => setEditing(null)}
              onSave={(a) => save.mutate(a)}
            />
          )}

          {data && data.accounts.length === 0 && !editing && (
            <div className="rounded-lg border border-dashed border-adaptive-300 p-5 text-center">
              <p className="text-[13px] text-adaptive-700">No accounts yet.</p>
              <p className="mx-auto mt-1 max-w-md text-[11.5px] text-adaptive-500">
                An account is a name, an email, and optionally an ssh key and a GitHub
                login. Switching one applies all of them at once — to this machine, or
                to a single repo from its own menu.
              </p>
            </div>
          )}

          {/* Always, not only once an account exists: on a machine that already has
              hand-written aliases — which is most of them — this is where they are
              found, and hiding it behind "add an account first" meant the app could
              not see the config it claims to manage. */}
          <SshConfigCard onImport={(a) => setEditing(a)} />

          {data?.accounts.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              active={a.id === data.activeId}
              ghActive={data.ghAccounts.find((g) => g.active)?.login ?? null}
              onEdit={() => setEditing(a)}
              onDelete={() => remove.mutate(a.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** What the machine says right now — not what this app last wrote. */
function Current({ view, pending }: { view: AccountsView | undefined; pending: boolean }) {
  const gh = view?.ghAccounts.find((g) => g.active)

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-adaptive-200 bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>In force now</SectionLabel>
        {pending ? (
          <span className="text-[12px] text-adaptive-400">reading git config…</span>
        ) : view?.globalEmail ? (
          <span className="font-mono text-[12px] text-adaptive-800">
            {view.globalName ?? '(no name)'} &lt;{view.globalEmail}&gt;
          </span>
        ) : (
          <span className="text-[12px] text-sev-warn">
            No global git identity — commits will be refused.
          </span>
        )}
      </div>
      <p className="text-[11.5px] text-adaptive-500">
        {/* Named explicitly, because the two disagreeing is the failure this page is
            for: gh decides who opens the pull request, git decides who wrote it. */}
        Read from <code className="font-mono">~/.gitconfig</code>. The GitHub CLI is{' '}
        {view?.ghPresent ? (
          gh ? (
            <>
              signed in as <span className="font-mono text-adaptive-700">{gh.login}</span>
              {view.ghAccounts.length > 1 && ` (of ${view.ghAccounts.length} accounts)`}
            </>
          ) : (
            'installed but not signed in'
          )
        ) : (
          'not installed'
        )}
        .
      </p>
    </div>
  )
}

/**
 * The `~/.ssh/config` half, previewed before it is written.
 *
 * This is the only thing in the app that edits a file the user also edits by hand,
 * and the file decides whether the machine can reach anything at all — so it shows
 * exactly what would be written, writes only between its own markers, keeps a
 * backup, and refuses outright when the markers are damaged rather than guessing
 * where the managed region ends.
 */
function SshConfigCard({ onImport }: { onImport: (account: GitAccount) => void }) {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: keys.sshConfig,
    queryFn: () => api.previewSshConfig(),
    staleTime: 5_000,
  })

  const apply = useMutation({
    mutationFn: () => api.applySshConfig(),
    onSuccess: (path) => {
      void qc.invalidateQueries({ queryKey: keys.sshConfig })
      toast.success('ssh config updated', { description: path })
    },
    onError: (e: Error) => toast.error('Could not write ssh config', { description: e.message }),
  })

  // Read from the same cache the page header uses, so "is this alias already an
  // account" costs nothing.
  const view = useQuery({ queryKey: keys.gitAccounts, enabled: false }).data as
    | AccountsView
    | undefined
  const claimedHosts = new Set(
    (view?.accounts ?? []).map((a) => a.sshHost).filter((h): h is string => !!h)
  )
  const unmanaged = (data?.entries ?? []).filter((e) => !e.managed)

  // Nothing to manage and nothing to adopt: no file, no aliases in it, and no
  // account that wants one. A card whose only content is a path is furniture.
  if (!data || (!data.exists && unmanaged.length === 0 && !data.managed)) return null

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-adaptive-200 bg-card p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>ssh config</SectionLabel>
        <span className="truncate font-mono text-[11px] text-adaptive-500">{data.path}</span>
        <div className="flex-1" />
        <Button
          variant={data.changed ? 'waPrimary' : 'waOutline'}
          size="waXs"
          disabled={!data.changed || !!data.error || apply.isPending}
          title={
            data.error
              ? 'The managed block in this file is damaged'
              : data.changed
                ? 'Rewrites only the block between the app’s markers'
                : 'The file already says this'
          }
          onClick={() => apply.mutate()}
        >
          {apply.isPending ? 'Writing…' : data.changed ? 'Write block' : 'Up to date'}
        </Button>
      </div>

      {data.error ? (
        <p className="text-[11.5px] text-sev-err">{data.error}</p>
      ) : (
        <p className="text-[11.5px] text-adaptive-500">
          Only the lines between the app’s markers are touched; everything else in the
          file is kept, and the previous version is saved beside it as{' '}
          <code className="font-mono">config.work-alley.bak</code>. Clone with{' '}
          <code className="font-mono">git@&lt;alias&gt;:owner/repo.git</code> to use a
          key per remote.
        </p>
      )}

      {data.managed ? (
        <pre className="wa-scroll max-h-56 overflow-auto rounded-md border border-adaptive-200 bg-adaptive-50 p-2.5 font-mono text-[11px] leading-[1.5] text-adaptive-700">
          {data.managed}
        </pre>
      ) : (
        <p className="text-[11.5px] text-adaptive-500">
          No account defines a host alias, so there is no block to write.
        </p>
      )}

      {/* What is already in the file, and not ours. Offered for import rather than
          rewritten: these are somebody's working aliases, and the app has no
          business taking ownership of one without being asked. */}
      {unmanaged.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold tracking-[0.06em] text-adaptive-500 uppercase">
            Already in this file
          </span>
          <div className="overflow-hidden rounded-md border border-adaptive-200">
            {unmanaged.map((e) => {
              const claimed = claimedHosts.has(e.host)
              return (
                <div
                  key={e.host}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-adaptive-200 px-2.5 py-1.5 last:border-b-0"
                >
                  <span className="font-mono text-[11.5px] text-adaptive-800">{e.host}</span>
                  {e.hostname && (
                    <span className="font-mono text-[11px] text-adaptive-400">
                      → {e.hostname}
                    </span>
                  )}
                  {e.identityFile && (
                    <span className="truncate font-mono text-[11px] text-adaptive-500">
                      {e.identityFile}
                    </span>
                  )}
                  {/* The line that decides whether the right key is actually used.
                      Without it ssh offers the agent's keys first, so an alias that
                      looks correct can still authenticate as somebody else. */}
                  {e.identityFile && !e.identitiesOnly && (
                    <span className="text-[10.5px] text-sev-warn">no IdentitiesOnly</span>
                  )}
                  <div className="flex-1" />
                  <Button
                    variant="waGhost"
                    size="waXs"
                    disabled={claimed}
                    title={
                      claimed
                        ? 'An account already uses this alias'
                        : 'Fill a new account from this block — you add the name and email'
                    }
                    onClick={() => onImport(accountFromEntry(e))}
                  >
                    {claimed ? 'Linked' : 'Import'}
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The account an existing `Host` block implies.
 *
 * Mirrors `accounts::account_from_entry` in Rust, which is the one that matters —
 * this is here so the form can be prefilled without a round trip. Name and email
 * are deliberately blank: ssh knows which key to offer, and nothing at all about
 * who is committing.
 */
function accountFromEntry(e: SshHostEntry): GitAccount {
  const fromAlias = e.hostname && e.host.startsWith(e.hostname)
    ? e.host.slice(e.hostname.length).replace(/^[-_.]+/, '')
    : ''
  return {
    ...BLANK,
    label: e.comment ?? (fromAlias || e.host),
    sshKey: e.identityFile,
    sshHost: e.host,
    sshHostname: e.hostname,
  }
}

function AccountCard({
  account,
  active,
  ghActive,
  onEdit,
  onDelete,
}: {
  account: GitAccount
  active: boolean
  ghActive: string | null
  onEdit: () => void
  onDelete: () => void
}) {
  const run = useRunAction()
  const [confirming, setConfirming] = useState(false)

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-card p-3.5',
        active ? 'border-primary-600' : 'border-adaptive-200'
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold">{account.label}</span>
        {active && (
          <span className="flex items-center gap-1 rounded-sm bg-sev-ok/[0.14] px-1.5 py-0.5 text-[10px] font-semibold text-sev-ok uppercase">
            <Check className="size-2.5" />
            In use
          </span>
        )}
        <div className="flex-1" />
        <Button
          variant={active ? 'waOutline' : 'waPrimary'}
          size="waXs"
          disabled={active}
          title={
            active
              ? 'This is already the machine default'
              : 'Writes user.name, user.email and any key to ~/.gitconfig'
          }
          onClick={() => run({ kind: 'useGitAccount', id: account.id })}
        >
          {active ? 'In use' : 'Use on this machine'}
        </Button>
        <Button variant="waOutline" size="waXs" onClick={onEdit}>
          Edit
        </Button>
        {/* Two-step, inline. A dialog for "forget a row in a JSON file" is heavier
            than the action, and this deletes nothing on the machine — see the title. */}
        <Button
          variant={confirming ? 'waDanger' : 'waGhost'}
          size="waIcon"
          aria-label={confirming ? `Confirm deleting ${account.label}` : `Delete ${account.label}`}
          title={
            confirming
              ? 'Click again to forget it'
              : 'Forget this account. Your git config keeps whatever it already has.'
          }
          onClick={() => (confirming ? onDelete() : setConfirming(true))}
          onBlur={() => setConfirming(false)}
        >
          <Trash2 className="size-3" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11.5px] text-adaptive-600">
        <span>
          {account.name} &lt;{account.email}&gt;
        </span>
        {account.sshKey && (
          <span className="flex items-center gap-1 text-adaptive-500">
            <KeyRound className="size-3" />
            {account.sshKey}
          </span>
        )}
        {account.signingKey && (
          <span className="text-adaptive-500">signs with {account.signingKey}</span>
        )}
        {account.ghUser && (
          <span
            className={cn(
              'text-adaptive-500',
              // The disagreement worth seeing: this account is the git identity in
              // force, but gh is answering as somebody else.
              active && ghActive && ghActive !== account.ghUser && 'text-sev-warn'
            )}
          >
            gh {account.ghUser}
            {active && ghActive && ghActive !== account.ghUser && ` — gh is on ${ghActive}`}
          </span>
        )}
      </div>
    </div>
  )
}

function AccountForm({
  account,
  busy,
  onSave,
  onCancel,
}: {
  account: GitAccount
  busy: boolean
  onSave: (a: GitAccount) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState(account)
  const set = (patch: Partial<GitAccount>) => setForm((f) => ({ ...f, ...patch }))
  // The same two fields git itself insists on. Everything else is optional, and the
  // backend validates all of it again before it is stored.
  const valid = form.label.trim() !== '' && form.name.trim() !== '' && form.email.includes('@')

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary-600 bg-card p-3.5">
      <SectionLabel>{account.id ? `Edit ${account.label}` : 'New account'}</SectionLabel>

      <div className="flex flex-wrap gap-2">
        <Field label="Label" hint="What you call it — Work, Personal" className="min-w-[10rem]">
          <Input
            value={form.label}
            onChange={(e) => set({ label: e.target.value })}
            placeholder="Work"
            className="h-[30px] text-xs"
          />
        </Field>
        <Field label="Name" hint="Recorded on every commit" className="min-w-[12rem]">
          <Input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Ada Lovelace"
            className="h-[30px] text-xs"
          />
        </Field>
        <Field label="Email" hint="What commits are attributed by" className="min-w-[14rem]">
          <Input
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
            placeholder="ada@corp.com"
            className="h-[30px] text-xs"
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-2">
        <Field
          label="SSH key"
          hint="Absolute path. Used with IdentitiesOnly, so the agent's other keys cannot win."
          className="min-w-[16rem]"
        >
          <Input
            value={form.sshKey ?? ''}
            onChange={(e) => set({ sshKey: e.target.value })}
            placeholder="~/.ssh/id_corp"
            className="h-[30px] font-mono text-xs"
          />
        </Field>
        <Field label="Signing key" hint="Sets user.signingkey. Does not turn signing on.">
          <Input
            value={form.signingKey ?? ''}
            onChange={(e) => set({ signingKey: e.target.value })}
            placeholder="4A2B…"
            className="h-[30px] font-mono text-xs"
          />
        </Field>
        <Field label="GitHub login" hint="gh switches to it — machine-wide only.">
          <Input
            value={form.ghUser ?? ''}
            onChange={(e) => set({ ghUser: e.target.value })}
            placeholder="ada"
            className="h-[30px] font-mono text-xs"
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-2">
        <Field
          label="SSH host alias"
          hint="Clone as git@<alias>:owner/repo.git to pick this key per remote."
          className="min-w-[14rem]"
        >
          <Input
            value={form.sshHost ?? ''}
            onChange={(e) => set({ sshHost: e.target.value })}
            placeholder="github.com-work"
            className="h-[30px] font-mono text-xs"
          />
        </Field>
        <Field label="Real host" hint="What the alias points at. Blank means github.com.">
          <Input
            value={form.sshHostname ?? ''}
            onChange={(e) => set({ sshHostname: e.target.value })}
            placeholder="github.com"
            className="h-[30px] font-mono text-xs"
          />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="waPrimary" size="wa" disabled={!valid || busy} onClick={() => onSave(form)}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="waOutline" size="wa" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-[11px] text-adaptive-500">
          Saving stores the account. Nothing on this machine changes until you use it.
        </span>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string
  hint: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={cn('flex flex-1 flex-col gap-1', className)}>
      <span className="text-[10px] font-semibold tracking-[0.06em] text-adaptive-500 uppercase">
        {label}
      </span>
      {children}
      <span className="text-[10.5px] text-adaptive-400">{hint}</span>
    </label>
  )
}
