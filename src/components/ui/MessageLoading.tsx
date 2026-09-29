/** Three pulsing dots, drawn in SVG so they inherit the surrounding text colour. */
export function MessageLoading({ className }: { className?: string }) {
  return (
    <svg
      role="status"
      aria-label="Loading"
      width="24"
      height="8"
      viewBox="0 0 24 8"
      fill="currentColor"
      className={className}
    >
      {[4, 12, 20].map((cx, i) => (
        <circle key={cx} cx={cx} cy="4" r="2">
          <animate
            attributeName="cy"
            values="4;1.5;4"
            dur="0.9s"
            begin={`${i * 0.15}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.35;1;0.35"
            dur="0.9s"
            begin={`${i * 0.15}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </svg>
  );
}
