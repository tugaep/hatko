import type { ComponentProps, ReactNode } from 'react';

/**
 * The generic primitives. Everything here consumes semantic tokens only — no raw
 * scale colour appears in a component, which is what keeps the palette a token swap
 * rather than a per-component audit.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// --- Button -----------------------------------------------------------------

const BUTTON_VARIANTS = {
  primary:
    'bg-brand text-text-inverse hover:bg-brand-hover active:bg-brand-active border border-transparent',
  secondary:
    'bg-transparent text-text border border-border-interactive hover:bg-bg-sunken active:bg-rule-strong',
  ghost: 'bg-transparent text-text border border-transparent hover:bg-bg-sunken active:bg-rule',
  danger:
    'bg-danger text-text-inverse border border-transparent hover:brightness-115 active:brightness-90',
} as const;

const BUTTON_SIZES = {
  sm: 'h-8 px-3 text-caption',
  md: 'h-10 px-4 text-body-sm',
  lg: 'h-12 px-5 text-body-sm',
} as const;

interface ButtonProps extends Omit<ComponentProps<'button'>, 'className'> {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  loading?: boolean;
  className?: string;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      // Loading swaps the label for a spinner in place rather than replacing it, so the
      // button cannot change width under the pointer mid-interaction.
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'relative inline-flex items-center justify-center gap-2 rounded-sm font-medium whitespace-nowrap',
        'transition-[background-color,color,filter,opacity] duration-120 ease-brand',
        'disabled:cursor-not-allowed disabled:opacity-40',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      <span className={cx('inline-flex items-center gap-2', loading && 'invisible')}>
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner />
        </span>
      )}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cx('size-4 animate-spin', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="8" cy="8" r="6" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" strokeLinecap="round" />
    </svg>
  );
}

// --- Form controls ----------------------------------------------------------

const CONTROL = [
  'w-full min-h-10 rounded-sm border bg-bg-raised px-3 text-body-sm text-text',
  'placeholder:text-text-muted transition-colors duration-120 ease-brand',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ');

export function Input({
  invalid,
  className,
  ...rest
}: Omit<ComponentProps<'input'>, 'className'> & { invalid?: boolean; className?: string }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={cx(CONTROL, invalid ? 'border-danger' : 'border-border-interactive', className)}
    />
  );
}

export function Textarea({
  className,
  ...rest
}: Omit<ComponentProps<'textarea'>, 'className'> & { className?: string }) {
  return (
    <textarea
      {...rest}
      className={cx(
        CONTROL,
        'border-border-interactive resize-none py-2.5 leading-normal',
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <label htmlFor={htmlFor} className="text-caption font-medium text-text">
        {label}
      </label>
      {children}
      {/* Error text is never colour-only: it carries the icon and the words. */}
      {error ? (
        <p
          id={`${htmlFor}-error`}
          className="flex items-start gap-1.5 text-caption text-danger-text"
        >
          <AlertIcon className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-caption text-text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

// --- Containers -------------------------------------------------------------

/**
 * The label frame — the signature component. A square-cornered L1 card with a
 * catalog number in the top-right, the way a specimen plate is labelled.
 *
 * `notch` cuts the top-right corner like a tear-open packet. It applies to at most
 * one element per view, which is a judgement the caller makes.
 */
export function LabelFrame({
  title,
  catalog,
  notch = false,
  interactive = false,
  className,
  children,
  ...rest
}: Omit<ComponentProps<'div'>, 'className' | 'title'> & {
  title?: ReactNode;
  catalog?: string;
  notch?: boolean;
  interactive?: boolean;
  className?: string;
}) {
  return (
    <div
      {...rest}
      className={cx(
        'border border-rule bg-bg-raised p-4 transition-colors duration-120 ease-brand',
        interactive && 'hover:border-rule-strong',
        notch && '[clip-path:polygon(0_0,calc(100%-12px)_0,100%_12px,100%_100%,0_100%)]',
        className,
      )}
    >
      {(title || catalog) && (
        <div className="mb-3 flex items-start justify-between gap-4">
          {title ? <div className="min-w-0 flex-1">{title}</div> : <span />}
          {catalog && (
            <span className="text-mono-label shrink-0 pt-0.5 font-mono uppercase text-text-muted">
              {catalog}
            </span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('text-eyebrow uppercase text-text-muted', className)}>{children}</p>;
}

/** Status badge. Subtle fill, dark ink, and always the word — never colour alone. */
const BADGE_TONES = {
  neutral: 'bg-bg-sunken border-rule-strong',
  brand: 'bg-brand-subtle border-brand-subtle',
  attention: 'bg-attention-subtle border-attention-subtle',
  danger: 'bg-danger-subtle border-danger-subtle',
} as const;

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'text-mono-label inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono uppercase text-text',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

// --- States -----------------------------------------------------------------

/**
 * Error card. Plain-language cause first, the technical detail folded away — it is
 * there for a bug report, not to be shouted at the person who hit it.
 */
export function ErrorCard({
  title,
  detail,
  technical,
  onRetry,
}: {
  title: string;
  detail?: string;
  technical?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="fade border border-danger bg-bg-raised p-4">
      <div className="flex gap-3">
        <AlertIcon className="mt-0.5 size-5 shrink-0 text-danger-text" />
        <div className="min-w-0 flex-1">
          <h2 className="text-h4">{title}</h2>
          {detail && <p className="mt-1 text-body-sm text-text-muted">{detail}</p>}
          {technical && (
            <details className="mt-3">
              <summary className="cursor-pointer text-caption text-text-muted">
                Technical detail
              </summary>
              <pre className="text-mono mt-2 overflow-x-auto border border-rule bg-bg-sunken p-2 font-mono">
                {technical}
              </pre>
            </details>
          )}
          {onRetry && (
            <Button size="sm" variant="secondary" onClick={onRetry} className="mt-3">
              Try again
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Skeletons match the geometry of the real content, so nothing jumps when it lands. */
export function SkeletonLine({ className }: { className?: string }) {
  return <span className={cx('skeleton block h-3', className)} />;
}

export function AlertIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="currentColor">
      <path d="M8 1.5 15 14H1L8 1.5Zm0 4.25a.75.75 0 0 0-.75.75v2.75a.75.75 0 0 0 1.5 0V6.5A.75.75 0 0 0 8 5.75Zm0 5.25a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
    </svg>
  );
}
