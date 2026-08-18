/**
 * What more than one dashboard tab draws.
 *
 * Here rather than in whichever tab happened to use it first, because an import reaching
 * sideways between two sibling tabs is how a split like this quietly grows back into one
 * file.
 *
 * It held `CategoryPanel` and `Figure` as well. The category breakdown was dropped from
 * the Documents tab — its counts are a column of the document list — which left it with no
 * caller, and `Figure` with one, so both went where a single consumer belongs rather than
 * staying here as sharing nobody does.
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
