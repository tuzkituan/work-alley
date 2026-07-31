import { useCallback, useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Columns3,
  FolderOpen,
  GitBranch,
  LayoutGrid,
  RefreshCw,
  Rows3,
  Search,
} from "lucide-react";
import { CARD_HEIGHT, RepoCard } from "./RepoCard";
import { COLUMNS, fit, template } from './columns'
import { ColumnsContext } from './use-columns'
import { RepoListHeader, RepoListRow, ROW_HEIGHT } from "./RepoListRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { derive, searchAlias } from "@/domain/severity";
import { repoId, type Bootstrap } from "@/domain/types";
import { useScanStore } from "@/stores/scan-store";
import { useUiStore } from "@/stores/ui-store";
import { useRescanCategory } from "@/hooks/use-category-scan";
import { useReposInView } from "@/hooks/use-repos-in-view";
import { RepoDetail } from "@/features/detail/RepoDetail";
import { CheckoutAllDialog } from "@/features/actions/CheckoutAllDialog";
import { useRunAction } from "@/hooks/use-action";
import { shortPackageName, useTrackedPackage } from "@/hooks/use-tracked-package";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildSections, flattenSections, type ListItem } from "@/domain/sections";
import { cn } from "@/lib/utils";

const GAP = 12;
const CARD_ROW_HEIGHT = CARD_HEIGHT + GAP;
const HEADER_HEIGHT = 34;

export function RepoGrid({ boot }: { boot: Bootstrap | undefined }) {
  // The scroll element in *state*, not a ref, and `VirtualBody` is not rendered
  // until it exists. React attaches an element's ref during the commit that
  // follows its children's layout effects, so a virtualizer living in a child
  // asked a ref that was still null, observed nothing, and rendered zero rows —
  // until some unrelated re-render happened to re-run its `_willUpdate`. Which is
  // exactly what pressing Rescan did.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const detailRepoId = useUiStore((s) => s.detailRepoId);
  const filterText = useUiStore((s) => s.filterText);
  const filterChip = useUiStore((s) => s.filterChip);
  const setFilterText = useUiStore((s) => s.setFilterText);
  const clearFilters = useUiStore((s) => s.clearFilters);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  const statuses = useScanStore((s) => s.repos);
  const trackedLatest = useScanStore((s) => s.trackedLatest);
  const durationMs = useScanStore((s) => s.durationMs);
  const rescan = useRescanCategory();
  const run = useRunAction();
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  // Whichever set is in view: one folder, or every repo in the workspace. The
  // branch lives in the hook so this and the Needs-you strip cannot disagree about
  // what they are describing.
  const inView = useReposInView(boot);
  const inFolder = inView.repos;

  const visible = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    return inFolder.filter((r) => {
      if (needle) {
        const hay =
          `${r.category}/${r.name} ${searchAlias(r.name)}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (filterChip) {
        const st = statuses.get(repoId(r));
        // Not yet scanned — cannot claim it matches.
        if (!st) return false;
        if (!derive(st, trackedLatest).kinds.includes(filterChip)) return false;
      }
      return true;
    });
    // Order is stable (name, as discovered) and deliberately NOT re-sorted while a
    // scan streams in — reordering a virtualized list under the cursor makes it
    // jump.
  }, [inFolder, statuses, trackedLatest, filterText, filterChip]);

  const perRow = view === "cards" ? 2 : 1;
  const items = useMemo(
    () => flattenSections(buildSections(visible, statuses), perRow),
    [visible, statuses, perRow],
  );

  const filtered = Boolean(filterText || filterChip);

  // The detail page takes over the centre panel; rail and output stay put, which
  // matters because the output pane is already scoped to this repo.
  //
  // Keyed by the repo, so opening a *different* repo from inside one animates too
  // rather than swapping its contents in place.
  if (detailRepoId)
    return <RepoDetail key={detailRepoId} repoId={detailRepoId} />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Outside the scrollport rather than sticky inside it. Sticky would work,
          but the table's own column header is already `sticky top-0` in the same
          container — two sticky layers in one scroller means hand-maintained top
          offsets, and the strip is chrome for the panel, not content in it. */}
      {inView.scope && (
        // Wraps rather than overflows. The panel is user-resizable down to a few
        // hundred pixels and this row holds a filter field plus seven controls, so
        // at any narrow width something had to give — and what gave was whatever
        // sat furthest right, silently cut off by the panel edge. A second line is
        // 30px; a Checkout-all button you cannot reach is a missing feature.
        <div className="flex flex-none flex-wrap items-center gap-2 border-b border-adaptive-200 px-4 py-2.5 text-xs text-adaptive-500">
              <span className="font-mono text-[11px] font-semibold text-primary-600">
                {inView.label}
              </span>
              <span className="wa-num whitespace-nowrap">
                {filtered
                  ? `${visible.length} of ${inFolder.length}`
                  : `${inFolder.length}`}{" "}
                repos
              </span>
              {inView.scanning && (
                <span className="text-adaptive-400">scanning…</span>
              )}
              {inView.scanned && (
                <span className="wa-num font-mono text-[11px] text-adaptive-400">
                  {durationMs}ms
                </span>
              )}
          <div className="flex-1" />

          {/* The list has had a `filterText` for as long as it has had a "Clear
              filters" button, and nothing to type it into — only the palette could
              set it, and only to clear it. */}
          <div className="relative w-[15rem] min-w-[8rem] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-adaptive-400" />
            <Input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              // Escape clears rather than blurs: getting back to the whole folder
              // is the useful escape, and the field is the only state here.
              onKeyDown={(e) => {
                if (e.key === 'Escape') clearFilters()
              }}
              placeholder={`Filter ${inView.label}…`}
              aria-label="Filter repos"
              className="h-[26px] pl-7 text-xs"
            />
          </div>
          {filtered && (
            <Button variant="waGhost" size="waXs" onClick={clearFilters}>
              Clear
            </Button>
          )}
              {/* A segmented control that is exactly as tall as the buttons beside
                  it. The border and 2px padding used to sit *outside* two 26px
                  buttons, making the group 32px next to a 26px Rescan — so the
                  height is pinned here and the buttons fill it instead. */}
              <div className="flex h-[26px] items-center overflow-hidden rounded-md border border-adaptive-200">
                {/* aria-pressed as well as the variant swap: toggled-ness lived
                    only in `variant`, which CSS cannot distinguish from any other
                    primary button, so the skin had no way to press these in. */}
                <Button
                  variant={view === "list" ? "waPrimary" : "waGhost"}
                  size="waIcon"
                  className="h-full w-[26px] rounded-none border-0"
                  aria-pressed={view === "list"}
                  title="List view — dense rows"
                  onClick={() => setView("list")}
                >
                  <Rows3 className="size-3.5" />
                </Button>
                <Button
                  variant={view === "cards" ? "waPrimary" : "waGhost"}
                  size="waIcon"
                  className="h-full w-[26px] rounded-none border-0"
                  aria-pressed={view === "cards"}
                  title="Card view"
                  onClick={() => setView("cards")}
                >
                  <LayoutGrid className="size-3.5" />
                </Button>
              </div>
              {view === "list" && <ColumnMenu />}
              {/* Icon + label, matching the Toolbox's Re-check: this was the only
                  action in the strip with no icon, sitting beside two icon-only
                  view toggles. */}
              <Button
                variant="waOutline"
                size="waXs"
                disabled={inView.scanning}
                title={`Re-scan every repo in ${inView.label}`}
                // null means "every folder", which is what all-repos mode needs.
                onClick={() => rescan(inView.scope === "all" ? null : inView.scope)}
              >
                <RefreshCw
                  className={cn(
                    "size-3",
                    inView.scanning && "animate-spin",
                  )}
                />
                Rescan
              </Button>

              {/* The bulk actions live here rather than in the title bar: all three
                  act on exactly the folder this header names, and the label was the
                  only thing that said so from up there. */}
              <span className="mx-0.5 h-4 w-px bg-adaptive-200" />
              <Button
                variant="waOutline"
                size="waXs"
                disabled={inFolder.length === 0}
                title={`Fetch every repo in ${inView.label}`}
                onClick={() => run({ kind: "fetchMany", refs: inFolder })}
              >
                Fetch all
              </Button>
              <Button
                variant="waPrimary"
                size="waXs"
                disabled={inFolder.length === 0}
                title={`Pull every repo in ${inView.label}`}
                onClick={() => run({ kind: "pullMany", refs: inFolder })}
              >
                Pull all
              </Button>
              <Button
                variant="waOutline"
                size="waXs"
                disabled={inFolder.length === 0}
                title={`Check out a branch across every repo in ${inView.label}`}
                onClick={() => setCheckoutOpen(true)}
              >
                <GitBranch className="size-3" />
                Checkout all
              </Button>
        </div>
      )}

      <CheckoutAllDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        repos={inFolder}
        scopeLabel={inView.label}
      />

      {/* The scroll container the virtualizer measures must be this plain div.
          Radix ScrollArea nests the real scrollport two levels deep, so
          getScrollElement would return the wrong node. */}
      <div
        ref={setScrollEl}
        className="wa-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3.5"
      >
        <div className="wa-view-enter flex flex-col gap-3.5">
          {!inView.scope ? (
            <NoFolderOpen boot={boot} />
          ) : items.length === 0 ? (
            <div className="rounded-lg border border-adaptive-200 bg-card p-6 text-center text-sm text-adaptive-500">
              {inFolder.length === 0
                ? `Nothing is cloned in ${inView.label} yet.`
                : "No repositories match the current filters."}
            </div>
          ) : (
            // `key={view}` is load-bearing. The virtualizer caches a measured
            // size per item *index*, and only clears that cache on unmount — so
            // one shared instance carried the 180px card heights back into 40px
            // list rows, on indices that meant a different item anyway once
            // `perRow` went 2 -> 1. Remounting hands each view an empty cache
            // before its first paint, which `virtualizer.measure()` in an effect
            // cannot do.
            scrollEl && (
              <VirtualBody
                key={view}
                scrollEl={scrollEl}
                items={items}
                cardsView={view === "cards"}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The virtualized list, in whichever shape the current view asks for.
 *
 * Its own component so the `useVirtualizer` instance can be remounted per view —
 * see the `key` at the call site. The scroll element stays the parent's, because
 * that is the element that actually scrolls.
 */
function VirtualBody({
  scrollEl,
  items,
  cardsView,
}: {
  /** The already-mounted scroll container. Never null — see the note at its state. */
  scrollEl: HTMLDivElement;
  items: ListItem[];
  cardsView: boolean;
}) {
  // Keyed by the item, not by its index.
  //
  // The size cache is keyed by whatever this returns, and the default is the
  // index — so when a scan streamed in and the sections regrouped, slot 5 kept the
  // 40px it had while it was a repo row even though it was now a 34px section
  // header. That is the mismatched padding and the dividers landing mid-row: the
  // slot and its contents disagreed about how tall they were.
  //
  // Memoised on `items` because it is part of the measurement options: a fresh
  // closure each render would rebuild every measurement on every scan frame.
  const getItemKey = useCallback((i: number) => items[i]?.key ?? i, [items]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getItemKey,
    getScrollElement: () => scrollEl,
    estimateSize: (i) =>
      items[i]?.kind === "header"
        ? HEADER_HEIGHT
        : cardsView
          ? CARD_ROW_HEIGHT
          : ROW_HEIGHT,
    overscan: cardsView ? 2 : 6,
    // Cards are measured because their content can grow (a hard-coded height once
    // clipped the action row out of the card). List rows are a known fixed height,
    // so measuring them would mean a ResizeObserver per visible row and a forced
    // layout per render, for a number we already know.
    ...(cardsView
      ? { measureElement: (el: Element) => el.getBoundingClientRect().height }
      : {}),
  });

  const body = (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const item = items[vi.index]!;
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={cardsView ? virtualizer.measureElement : undefined}
            className="absolute inset-x-0"
            style={{ top: vi.start, height: cardsView ? undefined : vi.size }}
          >
            {item.kind === "header" ? (
              <SectionHeader
                label={item.label}
                count={item.count}
                boxed={cardsView}
              />
            ) : cardsView ? (
              // items-stretch keeps both cards in a row the same height as the
              // taller of the two; paddingBottom carries the grid gap into the
              // measurement.
              <div
                className="grid grid-cols-2 items-stretch gap-3"
                style={{ paddingBottom: GAP }}
              >
                {item.repos.map((r) => (
                  <RepoCard key={repoId(r)} repo={r} />
                ))}
              </div>
            ) : (
              <RepoListRow repo={item.repos[0]!} />
            )}
          </div>
        );
      })}
    </div>
  );

  if (cardsView) return body;

  return <RepoTable>{body}</RepoTable>;
}

/**
 * Which columns the table shows.
 *
 * Only in list view: the cards do not have columns, and a control that greys out on
 * half the screens it appears on is worse than one that is not there.
 *
 * The menu offers what the *user* wants, not what currently fits — a column the
 * table has dropped for width is still ticked here, and reads as "yes, when there
 * is room". Ticking one that does not fit and watching nothing happen would be the
 * alternative, and it would look broken.
 */
function ColumnMenu() {
  const chosen = useUiStore((s) => s.columns);
  const setColumn = useUiStore((s) => s.setColumn);
  const resetColumns = useUiStore((s) => s.resetColumns);
  const trackedPackage = useTrackedPackage();
  const count = COLUMNS.filter((c) => chosen[c.id]).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="waOutline"
          size="waXs"
          title={`${count} of ${COLUMNS.length} optional columns shown`}
        >
          <Columns3 className="size-3" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-[10px] tracking-[0.05em] text-adaptive-400 uppercase">
          Columns
        </DropdownMenuLabel>
        {COLUMNS.map((c) => (
          <DropdownMenuCheckboxItem
            key={c.id}
            checked={chosen[c.id]}
            onCheckedChange={(on) => setColumn(c.id, on)}
            // Kept open: turning three columns off is one gesture, not three trips
            // back to the trigger.
            onSelect={(e) => e.preventDefault()}
            title={c.hint}
          >
            {/* The tracked column is named after whatever this workspace tracks —
                "blazeup-ui" says what it holds, "Tracked package" says what it is,
                and which one is useful depends on whether there is one. */}
            {c.id === "tracked" && trackedPackage
              ? shortPackageName(trackedPackage)
              : c.label}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => resetColumns()}>Reset to defaults</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The list's frame, and the one place that decides how wide its columns are.
 *
 * Measured rather than queried in CSS. The columns are now the user's choice as
 * well as a function of width, so the set of tracks is not knowable at stylesheet
 * time — and the container queries that used to do this declared their breakpoints
 * and their track widths in two different places, which is how the widest template
 * came to apply at widths it could not fit in. `fit` derives one from the other.
 *
 * The template goes out as a CSS variable on this element, so all 113 rows follow
 * one declaration instead of carrying an inline style each.
 */
function RepoTable({ children }: { children: React.ReactNode }) {
  const chosen = useUiStore((s) => s.columns);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!el) return;
    // The panel is resizable, so this fires on every drag frame — but `setWidth`
    // with an unchanged number is a no-op in React, and `fit` only produces a new
    // array when a column actually enters or leaves.
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  const on = useMemo(() => fit(chosen, width), [chosen, width]);
  const set = useMemo(() => new Set(on), [on]);

  return (
    <div
      ref={setEl}
      // `wa-table` is a skin handle only now — the container-type it used to
      // carry went with the container queries.
      className="wa-table overflow-hidden rounded-lg border border-adaptive-200 bg-card"
      style={{ ["--wa-cols" as string]: template(on) }}
    >
      <ColumnsContext value={set}>
        <RepoListHeader />
        {children}
      </ColumnsContext>
    </div>
  );
}

/** Section divider. Rendered only when a folder has more than one section. */
function SectionHeader({
  label,
  count,
  boxed = false,
}: {
  label: string;
  count: number;
  boxed?: boolean;
}) {
  return (
    <div
      className={
        boxed
          ? "flex items-center gap-2 pt-1 pb-2"
          : "flex items-center gap-2 border-b border-adaptive-200 bg-adaptive-50 px-3"
      }
      style={{ height: boxed ? undefined : 34 }}
    >
      <span className="text-[10px] font-bold tracking-[0.06em] text-adaptive-500 uppercase">
        {label}
      </span>
      <span className="wa-num font-mono text-[10px] text-adaptive-400">
        {count}
      </span>
      <span className="h-px flex-1 bg-adaptive-200" />
    </div>
  );
}

/**
 * The launch state. Nothing has been scanned, so rather than an empty grid this
 * offers the folders as the thing to pick.
 */
function NoFolderOpen({ boot }: { boot: Bootstrap | undefined }) {
  const setCategory = useUiStore((s) => s.setCategory);
  const scanned = useScanStore((s) => s.scanned);

  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-adaptive-200 bg-card p-8">
      <FolderOpen className="size-6 text-adaptive-400" />
      <div className="text-center">
        <p className="text-sm font-semibold">Pick a folder</p>
        <p className="mt-0.5 text-xs text-adaptive-500">
          Only the folder you open is scanned, so nothing runs against your
          repos until you ask.
        </p>
      </div>

      <div className="grid w-full max-w-lg grid-cols-2 gap-2">
        {(boot?.categories ?? []).map((info) => (
          <button
            key={info.category}
            type="button"
            onClick={() => setCategory(info.category)}
            className="flex items-center gap-2.5 rounded-md border border-adaptive-200 bg-background px-3 py-2.5 text-left transition-shadow hover:border-adaptive-950 hover:shadow-focus-ring"
          >
            <span className="font-mono text-xs font-semibold text-primary-600">
              {info.label}
            </span>
            <span className="wa-num flex-1 text-xs text-adaptive-600">
              {info.repoCount === 0 && info.declaredCount > 0
                ? `0 of ${info.declaredCount} cloned`
                : `${info.repoCount} repo${info.repoCount === 1 ? "" : "s"}`}
            </span>
            {scanned.has(info.category) && (
              <span className="font-mono text-[10px] text-adaptive-400">
                scanned
              </span>
            )}
          </button>
        ))}
        {(boot?.categories ?? []).length === 0 && (
          <div className="col-span-2 text-center text-xs text-adaptive-500">
            No git repos found in this folder.
          </div>
        )}
      </div>
    </div>
  );
}
