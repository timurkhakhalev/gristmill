import { Skeleton } from "../ui/Skeleton";

// Mirrors ComingUp's day rows and RecentNotes' rows so the real content lands
// in the same place instead of pushing the page around.

const EVENT_TITLE_WIDTHS = ["w-48", "w-36", "w-56"];
const NOTE_TITLE_WIDTHS = ["w-40", "w-52", "w-32"];

export function ComingUpSkeleton() {
  return (
    <div className="divide-y divide-dashed divide-border overflow-clip rounded-2xl border border-border bg-surface-2">
      {EVENT_TITLE_WIDTHS.map((width) => (
        <div key={width} className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-start gap-4 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-7 w-8" />
            <div className="space-y-1.5">
              <Skeleton className="h-2.5 w-14" />
              <Skeleton className="h-2.5 w-8" />
            </div>
          </div>
          <div className="flex items-stretch gap-3 py-1.5">
            <span aria-hidden="true" className="w-0.5 shrink-0 rounded-full bg-border" />
            <div className="flex-1 space-y-2 py-0.5">
              <Skeleton className={`h-3 ${width} max-w-full`} />
              <Skeleton className="h-2.5 w-20" />
            </div>
            <Skeleton className="size-[18px] self-center rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function RecentNotesSkeleton() {
  return (
    <div>
      <Skeleton className="mb-3 h-2.5 w-12" />
      {NOTE_TITLE_WIDTHS.map((width) => (
        <div key={width} className="flex items-center gap-3 py-2">
          <Skeleton className="size-8 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className={`h-3 ${width} max-w-full`} />
            <Skeleton className="h-2.5 w-24" />
          </div>
          <Skeleton className="h-2.5 w-9" />
        </div>
      ))}
    </div>
  );
}

/** Stand-in for the lazily loaded Home chunk. */
export function HomeSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-6 pt-8 pb-6">
      <section>
        <Skeleton className="mb-4 h-6 w-32" />
        <ComingUpSkeleton />
      </section>
      <RecentNotesSkeleton />
    </div>
  );
}
