/** Emoji icon of a note or folder, or the default glyph. */
export function RowGlyph({ icon, fallback }: { icon?: string | null; fallback: React.ReactNode }) {
  if (!icon) return <>{fallback}</>;

  return (
    <span
      aria-hidden="true"
      className="flex size-3.5 shrink-0 items-center justify-center text-[13px] leading-none"
    >
      {icon}
    </span>
  );
}
