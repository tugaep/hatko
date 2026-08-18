'use client';

import type { DashboardStats } from '@hatko/shared';
import { LabelFrame, Eyebrow } from '../../../components/ui.tsx';

/**
 * The two pieces more than one dashboard tab needs.
 *
 * Here rather than in whichever tab happened to use them first, because an import
 * reaching sideways between two sibling tabs is how a split like this quietly grows back
 * into one file. `Group` is the section heading every tab draws, and `CategoryPanel`
 * describes the corpus, which the Documents tab owns but the overview's own totals are
 * derived from.
 */

export function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const id = `group-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="grid gap-4">
      <div>
        <h2 id={id} className="font-display text-h2 text-text">
          {title}
        </h2>
        {description && <p className="mt-1 text-body-sm text-text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** A small labelled number. Shared because both the index health card and the category
 * breakdown draw the same figure at the same rank. */
export function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-1.5">
      <dt>{label}</dt>
      <dd className="tabular text-text">{children}</dd>
    </div>
  );
}

export function CategoryPanel({ byCategory }: { byCategory: DashboardStats['byCategory'] | null }) {
  if (!byCategory || byCategory.length === 0) return null;
  const most = Math.max(...byCategory.map((row) => row.documents));

  return (
    <LabelFrame title={<Eyebrow as="h3">Documents by category</Eyebrow>}>
      <ul className="grid gap-3">
        {byCategory.map((row) => (
          <li key={row.category} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-body-sm text-text">{row.category}</span>
              <dl className="text-mono-label tabular flex shrink-0 gap-x-4 font-mono text-text-muted">
                <Figure label="docs">{row.documents}</Figure>
                <Figure label="passages">{row.chunks}</Figure>
              </dl>
            </div>
            {/*
             * 6px, not 3px. At 3px in a system whose primary structural device is the 1px
             * rule, a bar at or near 100% is indistinguishable from a divider — the
             * largest category read as a horizontal line under its own label.
             */}
            <span aria-hidden="true" className="block h-1.5 bg-bg-sunken">
              <span
                className="block h-full bg-brand"
                style={{ width: `${Math.round((row.documents / most) * 100)}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </LabelFrame>
  );
}
