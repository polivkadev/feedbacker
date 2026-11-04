// The Feedbacker mark: a comment bubble in the highlighter yellow, the colour
// the page uses for the reviewer's own marks. Same drawing as favicon.svg.
export function Logo({ size = 24 }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M9 4h14a6 6 0 0 1 6 6v8a6 6 0 0 1-6 6H13l-6 5v-5.3A6 6 0 0 1 3 18v-8a6 6 0 0 1 6-6z"
        fill="var(--marker)" stroke="var(--logo-ink)" strokeWidth="2" strokeLinejoin="round" />
      <rect x="9" y="10.5" width="14" height="2.8" rx="1.4" fill="var(--logo-ink)" />
      <rect x="9" y="15.5" width="8.5" height="2.8" rx="1.4" fill="var(--logo-ink)" />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <Logo />
      <span className="wordmark">Feedbacker</span>
    </span>
  );
}
