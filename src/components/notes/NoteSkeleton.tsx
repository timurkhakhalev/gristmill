import { Skeleton } from "../ui/Skeleton";

const BODY_LINE_WIDTHS = ["w-11/12", "w-4/5", "w-9/12", "w-2/3"];

/** Mirrors NoteEditor's header and first lines while the note loads. */
export default function NoteSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[880px] px-[clamp(20px,5vw,54px)] pt-5 max-[720px]:px-5">
      <Skeleton className="mb-6 h-3 w-24" />
      <Skeleton className="h-8 w-2/3 max-w-md" />
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-7 w-24 rounded-full" />
        <Skeleton className="h-7 w-28 rounded-full" />
      </div>
      <div className="mt-10 space-y-3">
        {BODY_LINE_WIDTHS.map((width) => (
          <Skeleton key={width} className={`h-3 ${width}`} />
        ))}
      </div>
    </div>
  );
}
