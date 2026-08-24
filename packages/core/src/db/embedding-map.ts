import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
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
 * Whichever of `XXᵀ` and `XᵀX` is smaller: they share their non-zero eigenvalues, so the
 * only question is which matrix has to be built. Below 1536 vectors that is the Gram
 * matrix and above it the covariance matrix, which is why both paths are here — the
 * fixture corpora the tests use are four documents and this corpus is 7539 chunks, and
 * the two land on opposite sides.
 *
 * The Gram side was written first, when the corpus was 142 documents and 142×142 was
 * obviously the cheaper matrix. It stayed cheapest right up until it wasn't: at 7539
 * chunks it is 455 MB and 33 seconds, against 18 MB and 8 seconds for a covariance
 * matrix whose size never changes at all.
 *
 * Returns coordinates and the share of total variance each axis carries, which is what
 * says whether the picture is worth believing. Three axes of a 1536-dimension space
 * always look like something; the percentage is what distinguishes structure from a
 * shadow.
 */
export async function pca3(vectors: readonly Float32Array[]): Promise<{
  coords: [number, number, number][];
  explained: [number, number, number];
}> {
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

  return n <= d ? viaGram(centred, n) : viaCovariance(centred, n, d);
}

/**
 * How many rows to fold into the covariance matrix before handing the event loop back.
 *
 * The projection is the only genuinely long computation in the process, and it used to
 * run to completion without yielding — which on this corpus meant `/health` measured at
 * 47.5 seconds, because a synchronous loop starves every other request regardless of how
 * cheap that request is. Node has one thread for this; sharing it is not optional.
 *
 * 256 rows is roughly 8 ms of work between yields, so the API stays responsive while the
 * projection runs, at a cost of about thirty scheduler round trips.
 */
const ROWS_PER_YIELD = 256;

/**
 * Vectors per read. Sized so one page is roughly the same 8 ms of blocked event loop
 * that `ROWS_PER_YIELD` buys on the arithmetic side, at 6 KB a row.
 */
const VECTOR_PAGE = 512;

/**
 * How much of the total variance an axis must carry to be treated as real.
 *
 * After three deflations of a corpus that genuinely spans fewer than three dimensions,
 * what is left is rounding error, and its eigenvector points in an arbitrary direction.
 * The Gram side survives that on its own — coordinates there are `u √λ`, so a zero
 * eigenvalue collapses the axis to zero. The covariance side projects onto the
 * eigenvector instead, and an arbitrary unit direction through real data yields
 * full-sized coordinates: a third axis that looks like structure and is noise.
 *
 * Relative to the trace rather than absolute, because the trace scales with the corpus.
 * Far below any axis worth drawing — the real third axis here carries 3.8% — and far
 * above float64 residue, which lands around 1e-13.
 */
const MIN_EXPLAINED = 1e-10;

/**
 * PCA through the n×n Gram matrix `XXᵀ`. Correct when there are fewer vectors than
 * dimensions, which is where it is cheaper — its eigenvectors are the projected
 * coordinates directly, scaled by √λ, so the d-dimension axes are never formed.
 */
async function viaGram(
  centred: readonly Float64Array[],
  n: number,
): Promise<{ coords: [number, number, number][]; explained: [number, number, number] }> {
  const d = centred[0]!.length;

  // Symmetric, so only the upper triangle is computed and mirrored.
  const gram = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % ROWS_PER_YIELD === 0) await yieldToEventLoop();
    for (let k = i; k < n; k++) {
      let sum = 0;
      const a = centred[i]!;
      const b = centred[k]!;
      for (let j = 0; j < d; j++) sum += a[j]! * b[j]!;
      gram[i]![k] = sum;
      gram[k]![i] = sum;
    }
  }

  let trace = 0;
  for (let i = 0; i < n; i++) trace += gram[i]![i]!;

  const coords: [number, number, number][] = Array.from({ length: n }, () => [0, 0, 0]);
  const explained: [number, number, number] = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    const { vector, value } = dominantEigen(gram, n);
    if (value <= trace * MIN_EXPLAINED) break;

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
 * PCA through the d×d covariance matrix `XᵀX`, for when there are more vectors than
 * dimensions.
 *
 * Same decomposition, opposite side. `XXᵀ` and `XᵀX` share their non-zero eigenvalues,
 * so which one to form is purely a question of which is smaller — and that flipped when
 * the corpus grew. At 142 chunks the Gram matrix is 142×142 and this one is 1536×1536,
 * which is why the Gram side was written first. At 7539 chunks the Gram matrix is 455 MB
 * and takes 33 seconds; this one is 18 MB whatever the corpus does, because its size is
 * set by the embedding width and not by how many documents there are.
 *
 * The eigenvectors here live in embedding space rather than being the coordinates
 * themselves, so each one has to be projected back — `X·v`, one pass per axis, which is
 * three cheap passes rather than anything the n² cost was buying.
 */
async function viaCovariance(
  centred: readonly Float64Array[],
  n: number,
  d: number,
): Promise<{ coords: [number, number, number][]; explained: [number, number, number] }> {
  // Symmetric, so only the upper triangle is accumulated and mirrored.
  const cov = Array.from({ length: d }, () => new Float64Array(d));
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % ROWS_PER_YIELD === 0) await yieldToEventLoop();
    const row = centred[i]!;
    for (let j = 0; j < d; j++) {
      const xj = row[j]!;
      if (xj === 0) continue;
      const target = cov[j]!;
      for (let k = j; k < d; k++) target[k]! += xj * row[k]!;
    }
  }
  for (let j = 0; j < d; j++) {
    for (let k = j + 1; k < d; k++) cov[k]![j] = cov[j]![k]!;
  }

  // The same total variance the Gram trace carries — both sum the squared centred
  // values — so the explained shares mean the same thing on either path.
  let trace = 0;
  for (let j = 0; j < d; j++) trace += cov[j]![j]!;

  const coords: [number, number, number][] = Array.from({ length: n }, () => [0, 0, 0]);
  const explained: [number, number, number] = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    await yieldToEventLoop();
    const { vector, value } = dominantEigen(cov, d);
    if (value <= trace * MIN_EXPLAINED) break;

    // Project each vector onto the axis. This is `u √λ` again, arrived at from the other
    // side, so the two paths produce the same coordinates up to the sign of an axis.
    for (let i = 0; i < n; i++) {
      const row = centred[i]!;
      let sum = 0;
      for (let j = 0; j < d; j++) sum += row[j]! * vector[j]!;
      coords[i]![axis] = sum;
    }
    explained[axis] = trace > 0 ? value / trace : 0;

    for (let j = 0; j < d; j++) {
      for (let k = 0; k < d; k++) cov[j]![k]! -= value * vector[j]! * vector[k]!;
    }
  }

  return { coords, explained };
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
/**
 * The last projection computed, and the state of the index it was computed from.
 *
 * The vectors only change when an ingestion run writes them, so the run id plus the row
 * count identifies the input exactly — the count catches a `--force` re-embed that
 * rewrites vectors without the id telling you anything, and a corrupted store losing
 * rows outside a run.
 *
 * Process-local and unbounded on purpose: it holds one projection, and a restart is a
 * correct way to clear it.
 */
let cache: { key: string; map: EmbeddingMap } | null = null;

export async function getEmbeddingMap(db: Db): Promise<EmbeddingMap> {
  const { runId, vectors: vectorCount } = db
    .prepare(
      `SELECT (SELECT max(id) FROM ingestion_runs)  AS runId,
              (SELECT count(*) FROM chunks_vec)     AS vectors`,
    )
    .get() as { runId: number | null; vectors: number };

  const key = `${runId ?? 'none'}:${vectorCount}`;
  if (cache?.key === key) return cache.map;

  const map = await computeEmbeddingMap(db);
  cache = { key, map };
  return map;
}

async function computeEmbeddingMap(db: Db): Promise<EmbeddingMap> {
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

  // Read in pages rather than in one statement.
  //
  // `node:sqlite` is synchronous, so a single `.all()` over every vector is one
  // uninterruptible call — measured at 1954 ms for 7539 rows, because it decodes 46 MB
  // of blobs before returning. Nothing can yield inside it, so the only way to keep the
  // event loop free is to ask for less at a time.
  const rows: VectorRow[] = [];
  const page = db.prepare(
    'SELECT rowid AS id, embedding FROM chunks_vec WHERE rowid > ? ORDER BY rowid LIMIT ?',
  );
  let after = 0;
  for (;;) {
    const batch = page.all(after, VECTOR_PAGE) as unknown as VectorRow[];
    if (batch.length === 0) break;
    for (const row of batch) if (meta.has(row.id)) rows.push(row);
    after = batch[batch.length - 1]!.id;
    if (batch.length < VECTOR_PAGE) break;
    await yieldToEventLoop();
  }

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

  const { coords, explained } = await pca3(vectors);

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
