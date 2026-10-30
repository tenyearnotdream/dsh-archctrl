/** The panel's glyph: a small node tree, in currentColor so it follows the theme. */

export function TreeIcon({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="10" width="7" height="5" rx="1" />
      <rect x="14" y="17" width="7" height="4" rx="1" />
      <path d="M10 5.5h2v11.5h2" />
    </svg>
  );
}
