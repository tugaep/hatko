import { cx } from './ui.tsx';

/**
 * The mark and the specimen plates.
 *
 * Illustration is the one place the raw colour scale is allowed — these are flats on
 * a plate, not interface surfaces, and a semantic token has nothing to say about the
 * third green in a botanical drawing. Everything is solid fill and flat geometry: no
 * gradient, no outline on a filled shape, no texture.
 */

/**
 * A hatko leaf reduced to three solid shapes and a centre vein, on a 24 grid.
 * At 16px and below the two blades stop reading and the vein alone reads as a text
 * caret — leaf at large sizes, search cursor at small. One shape, two readings.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cx('size-6 shrink-0', className)}
      fill="currentColor"
    >
      {/* Two blades tapering to a shared apex, and a midrib between them. The negative
          space between blade and midrib is 1.5 units wide so it survives to 16px; at 1
          unit the three shapes fused into a striped oval. */}
      <path d="M11.6 2.2C9 5.4 5 9.6 5 14.4C5 18.8 7.6 21.9 10.4 23.6L10.4 5.6Z" />
      <path d="M12.4 2.2C15 5.4 19 9.6 19 14.4C19 18.8 16.4 21.9 13.6 23.6L13.6 5.6Z" />
      <path d="M11.3 3.2H12.7L12.35 22.8H11.65Z" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'font-display text-h3 leading-none tracking-[-0.02em] font-medium text-text',
        className,
      )}
    >
      hatko
    </span>
  );
}

/** Every specimen shares the same plate size and palette so the surfaces read as a set. */
function Plate({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className={cx('size-24', className)}>
      {children}
    </svg>
  );
}

/**
 * Empty search — nothing asked yet. A fiddlehead: the frond before it opens.
 *
 * A spiral rather than an open frond because the open version kept reading as a conifer
 * at 96px — a vertical stem with symmetrical side leaflets is a fir tree, whatever the
 * leaflets are shaped like. The coil is unmistakable at any size, and "not yet unfurled"
 * is the state this plate is labelling.
 *
 * Generated from an Archimedean spiral rather than hand-authored, so the curvature is
 * uniform; a hand-drawn spiral wobbles and reads as a mistake.
 */
function fiddleheadPath(): string {
  const turns = 2.15;
  const steps = 96;
  const centre = { x: 54, y: 33 };
  const points: string[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * turns * Math.PI * 2;
    const radius = 2.5 + angle * 3.2;
    points.push(
      `${(centre.x - Math.cos(angle) * radius).toFixed(2)} ${(centre.y - Math.sin(angle) * radius).toFixed(2)}`,
    );
  }

  // The spiral's outer end sits low-left; the stem carries on from there to the base.
  return `M${points.join('L')}`;
}

const FIDDLEHEAD = fiddleheadPath();

export function FernSpecimen({ className }: { className?: string }) {
  return (
    <Plate className={className}>
      <path
        d={FIDDLEHEAD}
        fill="none"
        stroke="var(--color-green-300)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <path
        d="M32 40C30 58 34 72 40 84"
        fill="none"
        stroke="var(--color-green-500)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <rect x="28" y="88" width="30" height="3" fill="var(--color-ochre-500)" />
    </Plate>
  );
}

/** Empty corpus — nothing indexed yet. */
export function SeedSpecimen({ className }: { className?: string }) {
  return (
    <Plate className={className}>
      <path
        d="M48 88C33 88 25 76 25 62C25 46 36 34 48 28C60 34 71 46 71 62C71 76 63 88 48 88Z"
        fill="var(--color-green-300)"
      />
      <path d="M48 88C40 80 37 70 39 58C42 46 45 38 48 28Z" fill="var(--color-green-400)" />
      <path d="M46.5 30V14H49.5V30Z" fill="var(--color-green-400)" />
      <path d="M48 20C48 20 58 18 62 8C52 8 48 14 48 20Z" fill="var(--color-ochre-500)" />
    </Plate>
  );
}

/** No results, and the abstain state. A mounted herbarium sheet, not a warning. */
export function PressedLeafSpecimen({ className }: { className?: string }) {
  return (
    <Plate className={className}>
      {/* Mounting tape — the archival cue that this is a filed specimen. */}
      <rect x="30" y="10" width="18" height="6" fill="var(--color-ochre-200)" />
      <rect x="52" y="80" width="18" height="6" fill="var(--color-ochre-200)" />
      <path d="M48 14C66 28 70 52 48 82C26 52 30 28 48 14Z" fill="var(--color-green-300)" />
      <path d="M46.8 20H49.2L48.6 78H47.4Z" fill="var(--color-green-500)" />
      {[32, 42, 52, 62].map((y, i) => (
        <g key={y} fill="none" stroke="var(--color-green-500)" strokeWidth="1.5">
          <path d={`M48 ${y} L${48 - (20 - i * 4)} ${y + 8}`} />
          <path d={`M48 ${y} L${48 + (20 - i * 4)} ${y + 8}`} />
        </g>
      ))}
    </Plate>
  );
}
