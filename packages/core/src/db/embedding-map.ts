import type { EmbeddingMap, EmbeddingPoint } from '@hatko/shared';
import type { Db } from './client.ts';

/**
 * The stored vectors, projected to three dimensions so the corpus can be looked at.
 *
 * This exists to make one claim checkable rather than asserted. The whole retrieval
 * design rests on the observation that 78 of the 142 documents are near-identical
 * delivery reports, and that a vector arm alone therefore returns four of them for a
 * question none of them answer. Every statement of that so far has been a sentence in a
 * document. Projected, it is a dense blob with the rest of the corpus scattered around
 * it, and an operator can see for themselves why the keyword arm is not optional.
 *
 * PCA rather than t-SNE or UMAP, and hand-written rather than a library. PCA is a
 * rotation: the axes are the directions of greatest variance in the real embedding
 * space, so distance in the picture means something in the space it came from. t-SNE
 * would make prettier clusters and would also invent them — it optimises local
 * neighbourhoods and its global distances are not interpretable, which is exactly the
 * property being claimed here. It is also a dependency, where this is arithmetic.
 */

/**
 * Principal components by power iteration on the Gram matrix.
 *
 * The Gram matrix, not the covariance matrix, because the corpus is 142 vectors of 1536
 * dimensions: `XXᵀ` is 142×142 where `XᵀX` is 1536×1536, and their non-zero eigenvalues
 * are the same. The eigenvectors of the small one are the projected coordinates
 * directly — scaled by `√λ` — so the 1536-dimension axes never have to be formed at all.
 *
 * ponytail: O(n²d) to build the Gram matrix — about 31M multiply-adds at 142 documents,
 * roughly 50 ms, recomputed per request with no cache. At a few thousand chunks this
 * wants a cache keyed on the last ingestion run; past that, a randomised SVD.
 *
 * Returns coordinates and the share of total variance each axis carries, which is what
 * says whether the picture is worth believing. Three axes of a 1536-dimension space
 * always look like something; the percentage is what distinguishes structure from a
 * shadow.
 */
export function pca3(vectors: readonly Float32Array[]): {
  coords: [number, number, number][];
  explained: [number, number, number];
} {
  const n = vectors.length;
  const zero = {
    coords: [] as [number, number, number][],
    explained: [0, 0, 0] as [number, number, number],
  };
  if (n === 0) return zero;

  const d = vectors[0]!.length;

  // Centre first. PCA without it finds the mean as its own first component, which for a
  // corpus of unit-length embeddings is by far the largest direction and says nothing —
  // every document would sit in one spot with the interesting spread compressed away.
  const mean = new Float64Array(d);
  for (const v of vectors) for (let j = 0; j < d; j++) mean[j]! += v[j]!;
  for (let j = 0; j < d; j++) mean[j]! /= n;

  const centred: Float64Array[] = vectors.map((v) => {
    const row = new Float64Array(d);
    for (let j = 0; j < d; j++) row[j] = v[j]! - mean[j]!;
    return row;
  });

  // Symmetric, so only the upper triangle is computed and mirrored.
  const gram = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let k = i; k < n; k++) {
      let sum = 0;
      const a = centred[i]!;
      const b = centred[k]!;
      for (let j = 0; j < d; j++) sum += a[j]! * b[j]!;
      gram[i]![k] = sum;
      gram[k]![i] = sum;
    }
  }

  // Total variance, for the explained-variance shares below.
  let trace = 0;
  for (let i = 0; i < n; i++) trace += gram[i]![i]!;

  const coords: [number, number, number][] = Array.from({ length: n }, () => [0, 0, 0]);
  const explained: [number, number, number] = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    const { vector, value } = dominantEigen(gram, n);
    if (value <= 0) break;

    // Scores are `u √λ`: the eigenvector gives each document's position along the axis
    // as a direction, and the eigenvalue is how far the corpus actually spreads along it.
    const scale = Math.sqrt(value);
    for (let i = 0; i < n; i++) coords[i]![axis] = vector[i]! * scale;
    explained[axis] = trace > 0 ? value / trace : 0;

    // Deflate: subtract the component just found so the next iteration cannot return it
    // again. Symmetric matrices make this exact rather than an approximation.
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) gram[i]![k]! -= value * vector[i]! * vector[k]!;
    }
  }

  return { coords, explained };
}

/**
 * Largest eigenvalue and its unit eigenvector, by power iteration.
 *
 * The starting vector is derived from `sin(i)` rather than `Math.random()`, and not for
 * style: a random start makes the projection come out mirrored or rotated differently on
 * every page load, so an operator comparing two screenshots of the same unchanged corpus
 * would see two different pictures. Deterministic input, deterministic image.
 *
 * `sin` also has the property a constant vector lacks — it is not orthogonal to anything
 * in particular, so it has a component along the dominant eigenvector to grow from.
 */
function dominantEigen(matrix: Float64Array[], n: number): { vector: Float64Array; value: number } {
  let v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.sin(i + 1);
  normalise(v);

  let value = 0;

  // Converges geometrically at the ratio between the top two eigenvalues. 300 is a
  // ceiling for the pathological case where those are nearly equal; on this corpus the
  // tolerance below is reached in well under fifty.
  for (let step = 0; step < 300; step++) {
    const next = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const row = matrix[i]!;
      let sum = 0;
      for (let k = 0; k < n; k++) sum += row[k]! * v[k]!;
      next[i] = sum;
    }

    // A Gram matrix is positive semi-definite, so ‖Av‖ for a unit v converges to the
    // largest eigenvalue and no separate Rayleigh quotient is needed. Deflation
    // subtracts exactly one component of a symmetric matrix, which keeps that true.
    const norm = normalise(next);
    if (norm === 0) return { vector: v, value: 0 };

    const converged = Math.abs(norm - value) <= 1e-10 * norm;
    v = next;
    value = norm;
    if (converged) break;
  }

  return { vector: v, value };
}

/** Scale to unit length in place, returning the original norm. */
function normalise(v: Float64Array): number {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return 0;
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return norm;
}

// --- reading the store ------------------------------------------------------

interface VectorRow {
  id: number;
  embedding: Uint8Array;
}

interface MetaRow {
  id: number;
  document_id: number;
  title: string;
  category: string;
  heading: string | null;
  is_deprecated: number;
}

/**
 * Every stored vector with the document it belongs to, projected.
 *
 * Chunks with no vector are skipped rather than plotted at the origin. That divergence
 * is real — the dashboard's index-health panel exists because chunks and chunks_vec are
 * maintained by different mechanisms and can come apart — but a point at (0,0,0) would
 * read as a document that is genuinely unlike everything else, which is a different and
 * much more interesting claim than "this row is missing".
 */
export function getEmbeddingMap(db: Db): EmbeddingMap {
  const meta = new Map(
    (
      db
        .prepare(
          `SELECT c.id, c.document_id, c.heading, d.title, d.category, d.is_deprecated
           FROM chunks c JOIN documents d ON d.id = c.document_id`,
        )
        .all() as unknown as MetaRow[]
    ).map((row) => [row.id, row]),
  );

  const rows = (
    db
      .prepare('SELECT rowid AS id, embedding FROM chunks_vec ORDER BY rowid')
      .all() as unknown as VectorRow[]
  ).filter((row) => meta.has(row.id));

  const vectors = rows.map(
    (row) =>
      // A view over the stored bytes, not a copy: vec0 holds little-endian float32,
      // which is what `toVectorBlob` wrote and what this platform reads natively.
      new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ),
  );

  const { coords, explained } = pca3(vectors);

  // One scale for all three axes. Normalising each axis to its own range would stretch
  // the third component — which carries a few percent of the variance — to the same
  // visual width as the first, turning a flat corpus into a convincing-looking cloud.
  let extent = 0;
  for (const point of coords) for (const value of point) extent = Math.max(extent, Math.abs(value));
  const scale = extent > 0 ? 1 / extent : 0;

  const points: EmbeddingPoint[] = rows.map((row, i) => {
    const info = meta.get(row.id)!;
    const [x, y, z] = coords[i]!;
    return {
      chunkId: row.id,
      documentId: info.document_id,
      title: info.title,
      heading: info.heading,
      category: info.category,
      isDeprecated: info.is_deprecated === 1,
      x: x * scale,
      y: y * scale,
      z: z * scale,
    };
  });

  return {
    points,
    explained,
    dimensions: vectors[0]?.length ?? 0,
  };
}
