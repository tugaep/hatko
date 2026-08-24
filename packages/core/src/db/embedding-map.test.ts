import test from 'node:test';
import assert from 'node:assert/strict';
import { pca3 } from './embedding-map.ts';

/**
 * The projection is a picture, and a wrong picture is still a picture.
 *
 * That is what makes this worth a test where most rendering is not. Every failure mode
 * here is silent: a missing centring step, a deflation that lets the same component come
 * back twice, an eigenvector that has not converged — each of them produces a plausible
 * scatter of dots that an operator would read as a fact about the corpus. Nothing throws,
 * nothing looks broken, and the conclusion drawn from it is wrong.
 */

/** Three well-separated groups in a high-dimensional space, with a little jitter. */
function plantedClusters(): { vectors: Float32Array[]; group: number[] } {
  const dimensions = 40;
  const vectors: Float32Array[] = [];
  const group: number[] = [];

  for (let g = 0; g < 3; g++) {
    for (let i = 0; i < 12; i++) {
      const v = new Float32Array(dimensions);
      // Each group sits on its own axis, ten units out. Deterministic jitter — a random
      // fixture that fails one run in fifty is worse than no fixture.
      v[g] = 10;
      for (let j = 0; j < dimensions; j++) v[j]! += 0.1 * Math.sin(g * 100 + i * 7 + j);
      vectors.push(v);
      group.push(g);
    }
  }

  return { vectors, group };
}

const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

test('documents that are close in the embedding space stay close in the projection', async () => {
  const { vectors, group } = plantedClusters();
  const { coords } = await pca3(vectors);

  let within = 0;
  let withinCount = 0;
  let between = 0;
  let betweenCount = 0;

  for (let i = 0; i < coords.length; i++) {
    for (let k = i + 1; k < coords.length; k++) {
      const d = distance(coords[i]!, coords[k]!);
      if (group[i] === group[k]) {
        within += d;
        withinCount++;
      } else {
        between += d;
        betweenCount++;
      }
    }
  }

  // The whole claim the dashboard panel makes is that a tight group in the vector space
  // looks tight on screen. If deflation or centring breaks, this ratio collapses towards
  // 1 while every point still lands somewhere plausible.
  assert.ok(
    between / betweenCount > 10 * (within / withinCount),
    `clusters did not separate: mean within ${within / withinCount}, between ${between / betweenCount}`,
  );
});

test('the three axes are ordered by variance, and say how much they carry', async () => {
  const { vectors } = plantedClusters();
  const { explained } = await pca3(vectors);

  assert.ok(explained[0] >= explained[1], 'first axis carries at least as much as the second');
  assert.ok(explained[1] >= explained[2], 'second axis carries at least as much as the third');
  // Three planted groups span a two-dimensional simplex, so two components hold nearly
  // all of it. A third axis reported as substantial would mean the deflation is leaking.
  assert.ok(
    explained[0] + explained[1] > 0.95,
    `two components should hold the planted structure, got ${explained[0] + explained[1]}`,
  );
  assert.ok(explained[2] < 0.02, `third axis should be near-empty, got ${explained[2]}`);
});

test('an empty corpus projects to nothing rather than throwing', async () => {
  // The dashboard loads before the first ingest, and a panel that throws takes the page
  // with it.
  assert.deepEqual(await pca3([]), { coords: [], explained: [0, 0, 0] });
});

test('identical vectors collapse to one point instead of being spread apart', async () => {
  // Degenerate input: every eigenvalue is zero, and power iteration on a zero matrix has
  // no direction to find. Reporting no variance is the honest answer; scattering the
  // points would draw structure that is not there.
  const same = Array.from({ length: 5 }, () => Float32Array.from([1, 2, 3, 4]));
  const { coords, explained } = await pca3(same);

  assert.equal(coords.length, 5);
  for (const point of coords) assert.deepEqual(point, [0, 0, 0]);
  assert.deepEqual(explained, [0, 0, 0]);
});

/**
 * The two decompositions have to agree, because which one runs is decided by corpus size
 * and nobody choosing a corpus is thinking about that.
 *
 * `XXᵀ` and `XᵀX` share their non-zero eigenvalues, so the same points must project the
 * same way whichever side is formed — and the switch happens silently at 1536 vectors,
 * which is the kind of boundary that produces a bug report saying "the plot changed and
 * we didn't touch anything".
 *
 * The four points are a rectangle, twice as wide as it is tall, so the answer is known
 * without running anything: variance 16 along the wide axis and 4 along the narrow one,
 * so 80% and 20%. Padding the same rectangle with unused dimensions moves it across the
 * threshold without moving a single point.
 */
test('both decompositions agree, and on a rectangle whose answer is known', async () => {
  const rectangle = (dimensions: number): Float32Array[] =>
    [
      [2, 1],
      [2, -1],
      [-2, 1],
      [-2, -1],
    ].map(([x, y]) => {
      const v = new Float32Array(dimensions);
      v[0] = x!;
      v[1] = y!;
      return v;
    });

  // Four points in two dimensions: more vectors than dimensions, so the covariance side.
  const wide = await pca3(rectangle(2));
  // The same four points padded out to eight dimensions: fewer vectors, so the Gram side.
  const tall = await pca3(rectangle(8));

  for (const [label, result] of [
    ['covariance', wide],
    ['gram', tall],
  ] as const) {
    assert.ok(
      Math.abs(result.explained[0] - 0.8) < 1e-9,
      `${label}: wide axis carries 80% of the variance, got ${result.explained[0]}`,
    );
    assert.ok(
      Math.abs(result.explained[1] - 0.2) < 1e-9,
      `${label}: narrow axis carries 20%, got ${result.explained[1]}`,
    );

    // Coordinates are ±2 along the first axis and ±1 along the second. An axis may come
    // out with either sign — a principal axis has no preferred direction — so the
    // magnitudes are what is asserted.
    //
    // Looser than the variance shares above, and not arbitrarily: power iteration
    // converges the eigen*value* quadratically and the eigen*vector* linearly, so the
    // coordinates land around 1e-7 while the shares are exact to 1e-13.
    for (const point of result.coords) {
      assert.ok(Math.abs(Math.abs(point[0]) - 2) < 1e-5, `${label}: first axis spread`);
      assert.ok(Math.abs(Math.abs(point[1]) - 1) < 1e-5, `${label}: second axis spread`);
      assert.ok(Math.abs(point[2]) < 1e-5, `${label}: no third axis in two-dimensional data`);
    }
  }
});
