'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { embeddingMapSchema, type EmbeddingMap, type EmbeddingPoint } from '@hatko/shared';
import { useApi } from '../../../lib/use-api.ts';
import { ErrorCard, Eyebrow, LabelFrame, SkeletonLine } from '../../../components/ui.tsx';
import { DocumentDialog } from './document-dialog.tsx';

/**
 * The corpus as its vectors see it.
 *
 * This panel exists to settle an argument the rest of the system only asserts. Hybrid
 * retrieval is justified in three documents by the claim that much of the corpus is
 * near-identical, that those documents therefore sit almost on top of one another in the
 * embedding space, and that a vector arm alone consequently returns a wall of them for a
 * question none of them answer. Projected to three dimensions the claim stops being a
 * sentence: the crowded categories are a dense knot and everything else is scattered
 * around it, and the spread figures in the legend put a number on the difference.
 *
 * Drawn on a canvas with hand-written arithmetic rather than three.js: this is a few
 * hundred points, one wireframe box and two rotations, and a WebGL scene graph is a large
 * dependency to carry for that.
 */

/** How many series colours globals.css declares. Categories past this cycle. */
const SERIES_COUNT = 7;

const RADIANS_PER_PIXEL = 0.008;
/** Beyond this the plot is being viewed from directly above and rotation stops reading. */
const MAX_PITCH = 1.4;

interface Rotation {
  yaw: number;
  pitch: number;
}

/** Screen position of one point, kept from the last draw so hover can hit-test it. */
interface Projected {
  x: number;
  y: number;
  index: number;
}

export function EmbeddingPanel() {
  const map = useApi('/api/admin/embedding-map', embeddingMapSchema);

  if (map.error) {
    return (
      <ErrorCard
        title="Could not load the embedding view."
        detail={map.error}
        onRetry={map.reload}
      />
    );
  }

  /**
   * `h2`, not `h3`. Panels are normally cards inside a titled section — see §the heading
   * ranks note in dashboard/overview.tsx — but this one *is* its section: it has a tab of
   * its own and nothing else shares the space. Wrapped in a `Group` as well, the words
   * "Embedding space" appeared twice, once at each rank, which is the same duplication the
   * "Corpus" title had over the document list below.
   */
  return (
    <LabelFrame title={<Eyebrow as="h2">Embedding space</Eyebrow>}>
      {map.data ? <Plot map={map.data} /> : <Loading />}
    </LabelFrame>
  );
}

function Loading() {
  return (
    <>
      <SkeletonLine className="w-2/3" />
      <SkeletonLine className="mt-3 h-64 w-full" />
    </>
  );
}

// --- the plot ---------------------------------------------------------------

function Plot({ map }: { map: EmbeddingMap }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const projectedRef = useRef<Projected[]>([]);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  // A three-quarter view to start. Head-on, the first two components are the whole
  // picture and the plot is indistinguishable from a flat scatter — the reason for
  // drawing it in three dimensions is not visible until it is turned slightly.
  const [rotation, setRotation] = useState<Rotation>({ yaw: 0.6, pitch: 0.35 });
  const [hovered, setHovered] = useState<number | null>(null);
  /**
   * Whether this reader has turned it yet.
   *
   * The plot read as a static image, which is the worst possible misreading: face-on the
   * projection is a flat scatter and the reason for drawing three dimensions is invisible
   * until it moves. The instruction was in the paragraph above, at the end of a sentence
   * about variance axes — where nobody looking at a picture reads it. So it is on the
   * picture instead, and it retires the moment it has been acted on rather than sitting
   * there permanently telling someone something they now know.
   */
  const [turned, setTurned] = useState(false);
  /** The document a click opened, or null. */
  const [opened, setOpened] = useState<{ id: number; title: string } | null>(null);
  /**
   * How far the pointer travelled since it went down.
   *
   * A rotation and a selection are the same gesture until the pointer moves, so the two
   * are told apart at pointer-up by distance rather than by mode. Without it, every drag
   * that happened to start on a point would also open that document — and on a cloud
   * where 78 points sit in one cluster, that is most drags.
   */
  const pressRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  /**
   * Categories largest first, each with its colour and how tightly it clusters.
   *
   * The spread is a root-mean-square distance from the category's own centre, in the
   * same units as the plot, so the numbers are comparable down the column and against
   * the corpus row. It is arithmetic over points already fetched — computing it on the
   * server would be a second endpoint for a sum the client is holding anyway.
   */
  const categories = useMemo(() => summarise(map.points), [map.points]);
  const colourOf = useMemo(
    () => new Map(categories.map((entry, i) => [entry.category, seriesVar(i)])),
    [categories],
  );

  // Canvas bitmaps do not resize with their CSS box, so the drawing surface is sized
  // from the observed box and the device pixel ratio. Without the ratio the plot is
  // soft on every laptop screen made in the last decade.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    projectedRef.current = draw(context, {
      points: map.points,
      rotation,
      width: size.width,
      height: size.height,
      hovered,
      colours: new Map([...colourOf].map(([category, name]) => [category, cssValue(name)])),
      rule: cssValue('--rule-strong'),
      background: cssValue('--bg-raised'),
    });
  }, [map.points, rotation, size, hovered, colourOf]);

  const rotate = useCallback((dx: number, dy: number) => {
    setRotation((current) => ({
      yaw: current.yaw + dx * RADIANS_PER_PIXEL,
      pitch: clamp(current.pitch + dy * RADIANS_PER_PIXEL, -MAX_PITCH, MAX_PITCH),
    }));
  }, []);

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;

    const press = pressRef.current;
    // 4px, so a click with an unsteady hand still selects rather than rotating by a pixel.
    if (press && Math.hypot(x - press.x, y - press.y) > 4) press.moved = true;

    const drag = dragRef.current;
    if (drag) {
      rotate(x - drag.x, y - drag.y);
      dragRef.current = { x, y };
      // Dragging through the cloud would otherwise strobe the tooltip.
      setHovered(null);
      return;
    }

    setHovered(nearest(projectedRef.current, x, y));
  }

  const point = hovered === null ? null : map.points[hovered];
  const spot = hovered === null ? null : projectedRef.current.find((p) => p.index === hovered);

  return (
    <>
      <p className="max-w-[68ch] text-body-sm text-text-muted">
        Every indexed passage, placed by its {map.dimensions}-dimension embedding and projected onto
        its three strongest axes of variation. Distance here is distance in the space retrieval
        actually searches.
      </p>

      <div
        ref={frameRef}
        /*
         * Square, and as large as the viewport allows. The plot has its own page now, so
         * the old 640×440 cap — sized for a card competing with eight other panels on one
         * scrolling dashboard — was leaving most of the screen empty for the one view where
         * space is the feature: this is a cloud you inspect by turning it.
         *
         * Square because the fit scales per axis and a wide box is spent on whichever axis
         * the rotation is currently narrow along. Bounded by height as well as width so the
         * whole cube stays on screen without scrolling the page to follow it.
         *
         * The `max(28rem, …)` is a floor, and it is load-bearing. Sizing a width from `vh`
         * means a short viewport produces a small plot however much width is going spare —
         * a laptop window at 1440×600 would have drawn the cloud at 468px with a thousand
         * pixels unused either side. Below the floor the page scrolls, which is the right
         * trade: this is a picture you inspect, and it has a size below which it stops being
         * one. `min(100%, …)` still keeps it inside its container on a phone.
         */
        className="relative mx-auto mt-4 aspect-square w-full max-w-[min(100%,max(28rem,78vh))] border border-rule bg-bg-raised"
      >
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="img"
          aria-label={describe(map, categories)}
          style={{ width: '100%', height: '100%' }}
          className="cursor-grab touch-none outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-focus"
          onPointerDown={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const at = { x: event.clientX - box.left, y: event.clientY - box.top };
            dragRef.current = at;
            pressRef.current = { ...at, moved: false };
            setTurned(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            dragRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);

            const press = pressRef.current;
            pressRef.current = null;
            if (!press || press.moved) return;

            // The point under the release, not the one under the last hover: on a touch
            // screen there is no hover, so `hovered` is null on the first tap.
            const box = event.currentTarget.getBoundingClientRect();
            const index = nearest(
              projectedRef.current,
              event.clientX - box.left,
              event.clientY - box.top,
            );
            const hit = index === null ? null : map.points[index];
            if (hit) setOpened({ id: hit.documentId, title: hit.title });
          }}
          onPointerLeave={() => {
            dragRef.current = null;
            setHovered(null);
          }}
          onPointerMove={onPointerMove}
          // Drag-only rotation would put this control out of reach of anyone not using a
          // pointer. The arrow keys turn it by the same amount a short drag does.
          onKeyDown={(event) => {
            const step = 12;
            const moves: Record<string, [number, number]> = {
              ArrowLeft: [-step, 0],
              ArrowRight: [step, 0],
              ArrowUp: [0, -step],
              ArrowDown: [0, step],
            };
            if (event.key === 'Enter' || event.key === ' ') {
              // Keyboard parity: rotation already had arrow keys, so selection needs a key
              // too or the document behind a passage is reachable by pointer only.
              const focused = hovered === null ? null : map.points[hovered];
              if (focused) {
                event.preventDefault();
                setOpened({ id: focused.documentId, title: focused.title });
              }
              return;
            }

            const move = moves[event.key];
            if (!move) return;
            event.preventDefault();
            setTurned(true);
            rotate(move[0], move[1]);
          }}
        />

        {point && spot && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 max-w-[24ch] border border-rule-strong bg-bg px-2 py-1.5"
            // Positioned at the point rather than at the cursor, so it does not jitter
            // while the pointer moves within a point's hit radius.
            style={{
              left: Math.min(spot.x + 12, Math.max(0, size.width - 200)),
              top: Math.max(0, spot.y - 12),
            }}
          >
            <p className="text-caption text-text">{point.title}</p>
            <p className="mt-0.5 text-caption text-text-muted">
              {point.category}
              {point.isDeprecated && ' · deprecated'}
            </p>
          </div>
        )}

        {/*
         * The affordance, on the thing it describes.
         *
         * `pointer-events-none` so it cannot swallow the very drag it is asking for — the
         * first version sat over the middle of the plot and ate the gesture. Bottom-centred
         * rather than centred, so it never covers the cluster it is inviting you to inspect.
         */}
        {!turned && map.points.length > 0 && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
            <span className="border border-rule-strong bg-bg px-2 py-1 text-caption text-text">
              Drag to rotate
            </span>
          </p>
        )}

        {map.points.length === 0 && (
          <p className="absolute inset-0 grid place-items-center p-6 text-center text-body-sm text-text-muted">
            Nothing is indexed yet. Run an ingest and the corpus appears here.
          </p>
        )}
      </div>

      {opened && (
        <DocumentDialog
          documentId={opened.id}
          title={opened.title}
          onClose={() => setOpened(null)}
        />
      )}

      {/*
       * Stated once, under the plot, and permanently — the badge above retires after the
       * first drag, but the keyboard route and the hover behaviour are not discoverable by
       * trying to drag. Keyboard first of the two, because it is the one someone may need
       * rather than merely enjoy.
       */}
      {map.points.length > 0 && (
        <p className="mx-auto mt-2 max-w-[min(100%,max(28rem,78vh))] text-caption text-text-muted">
          Drag to rotate, or focus the plot and use the arrow keys. Hover a point for its document
          and category.
        </p>
      )}

      <p className="mt-3 text-caption text-text-muted">
        These three axes carry{' '}
        <span className="font-mono">
          {map.explained.map((share) => `${(share * 100).toFixed(1)}%`).join(' · ')}
        </span>{' '}
        of the corpus&rsquo;s total variance, {(sum(map.explained) * 100).toFixed(0)}% between them.
        The rest is in the {Math.max(0, map.dimensions - 3)} directions this view cannot show, so
        read the plot for which passages group together, not for exact distances.
      </p>

      {categories.length > 0 && <Legend categories={categories} colourOf={colourOf} map={map} />}
    </>
  );
}

// --- legend -----------------------------------------------------------------

interface CategorySummary {
  category: string;
  count: number;
  /** RMS distance from the category's own centre, in plot units. */
  spread: number;
}

function Legend({
  categories,
  colourOf,
  map,
}: {
  categories: CategorySummary[];
  colourOf: Map<string, string>;
  map: EmbeddingMap;
}) {
  const corpus = spreadOf(map.points);

  return (
    <div className="mt-4 border-t border-rule pt-4">
      <table className="w-full text-body-sm">
        <thead>
          <tr className="text-left text-mono-label uppercase text-text-muted">
            <th className="pb-1 font-medium">Category</th>
            <th className="pb-1 text-right font-medium">Docs</th>
            {/* The column that makes this a measurement rather than a picture: a group
                whose spread is a fraction of the corpus's is a group the vector arm
                cannot tell apart. */}
            <th className="pb-1 text-right font-medium">Spread</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((entry) => (
            <tr key={entry.category} className="border-t border-rule">
              <td className="py-1">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: `var(${colourOf.get(entry.category)})` }}
                  />
                  <span className="font-mono text-mono">{entry.category}</span>
                </span>
              </td>
              <td className="py-1 text-right tabular-nums text-text-muted">{entry.count}</td>
              <td className="py-1 text-right font-mono text-mono tabular-nums text-text-muted">
                {entry.spread.toFixed(2)}
              </td>
            </tr>
          ))}
          <tr className="border-t border-rule-strong">
            <td className="py-1 text-text-muted">whole corpus</td>
            <td className="py-1 text-right tabular-nums text-text-muted">{map.points.length}</td>
            <td className="py-1 text-right font-mono text-mono tabular-nums text-text-muted">
              {corpus.toFixed(2)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// --- geometry ---------------------------------------------------------------

/**
 * Draw the box and the points, returning where each landed.
 *
 * Orthographic, not perspective. A perspective divide would make points nearer the camera
 * larger for a reason unrelated to the data, and the one thing this plot has to be
 * trusted about is that two dots close together mean two documents close together. Depth
 * is carried by size and opacity instead, which are read as depth and not as magnitude.
 */
function draw(
  context: CanvasRenderingContext2D,
  options: {
    points: readonly EmbeddingPoint[];
    rotation: Rotation;
    width: number;
    height: number;
    hovered: number | null;
    colours: Map<string, string>;
    rule: string;
    background: string;
  },
): Projected[] {
  const { points, rotation, width, height, hovered, colours } = options;

  context.fillStyle = options.background;
  context.fillRect(0, 0, width, height);

  const cosYaw = Math.cos(rotation.yaw);
  const sinYaw = Math.sin(rotation.yaw);
  const cosPitch = Math.cos(rotation.pitch);
  const sinPitch = Math.sin(rotation.pitch);

  /** Rotate into view space. Unscaled, so the fit below can measure the result. */
  const rotate = (x: number, y: number, z: number) => {
    const x1 = x * cosYaw - z * sinYaw;
    const z1 = x * sinYaw + z * cosYaw;
    return { x: x1, y: y * cosPitch - z1 * sinPitch, depth: y * sinPitch + z1 * cosPitch };
  };

  /**
   * Fit the box to the frame at this rotation, rather than scaling by a fixed fraction.
   *
   * A constant `min(width, height) / 2 * 0.82` fits the cube face-on and clips it at every
   * other angle: a corner of the unit cube sits √3 from the centre, so turning the plot
   * pushed the far corners — and the points near them — outside the canvas. The cube was
   * only ever whole in the orientation it happened to load in, which is the one orientation
   * nobody needs to rotate to see.
   *
   * Measuring the eight corners each frame is exact and costs eight multiplies. It also
   * uses the frame better: the projection is widest along one axis at a time, so fitting
   * per axis draws the cloud larger than a single conservative constant ever could.
   */
  const rotatedCorners = BOX_CORNERS.map(([x, y, z]) => rotate(x, y, z));
  const halfX = Math.max(...rotatedCorners.map((corner) => Math.abs(corner.x)));
  const halfY = Math.max(...rotatedCorners.map((corner) => Math.abs(corner.y)));
  // 0.94 leaves room for the dot radius and the hover ring, which are drawn in pixels
  // around a point and would otherwise clip against the edge even when its centre fits.
  const scale = 0.94 * Math.min(width / 2 / halfX, height / 2 / halfY);

  const project = (x: number, y: number, z: number) => {
    const { x: x1, y: y2, depth } = rotate(x, y, z);
    return { x: width / 2 + x1 * scale, y: height / 2 - y2 * scale, depth };
  };

  // The unit box. Without it a rotation reads as the cloud deforming rather than turning,
  // because a scatter of dots has no edges to follow.
  context.strokeStyle = options.rule;
  context.lineWidth = 1;
  for (const [a, b] of BOX_EDGES) {
    const from = project(...a);
    const to = project(...b);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
  }

  const projected = points.map((point, index) => ({
    ...project(point.x, point.y, point.z),
    index,
  }));

  // Painter's algorithm: furthest first, so nearer points overlap further ones rather
  // than the other way round.
  const order = [...projected].sort((a, b) => a.depth - b.depth);

  for (const item of order) {
    const point = points[item.index]!;
    const isHovered = item.index === hovered;
    // Depth runs over roughly [-√3, √3] for a unit box; this maps it to [0, 1].
    const nearness = clamp((item.depth + 1.8) / 3.6, 0, 1);

    context.globalAlpha = isHovered ? 1 : 0.35 + 0.5 * nearness;
    context.fillStyle = colours.get(point.category) ?? options.rule;
    context.beginPath();
    context.arc(item.x, item.y, isHovered ? 5 : 2 + 1.6 * nearness, 0, Math.PI * 2);
    context.fill();

    if (isHovered) {
      context.globalAlpha = 1;
      context.strokeStyle = options.background;
      context.lineWidth = 1.5;
      context.stroke();
    }
  }

  context.globalAlpha = 1;
  return projected.map(({ x, y, index }) => ({ x, y, index }));
}

/** The twelve edges of the unit box, as pairs of corners. */
/** The eight corners of the unit box, shared by the wireframe and the fit-to-frame scale. */
const BOX_CORNERS: [number, number, number][] = (() => {
  const corners: [number, number, number][] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
  return corners;
})();

const BOX_EDGES: [[number, number, number], [number, number, number]][] = (() => {
  const corners = BOX_CORNERS;
  const edges: [[number, number, number], [number, number, number]][] = [];
  for (let i = 0; i < corners.length; i++) {
    for (let k = i + 1; k < corners.length; k++) {
      // Two corners share an edge when they differ on exactly one axis.
      const differences = corners[i]!.filter((value, axis) => value !== corners[k]![axis]).length;
      if (differences === 1) edges.push([corners[i]!, corners[k]!]);
    }
  }
  return edges;
})();

/** Index of the closest drawn point within the hit radius, or null. */
function nearest(projected: readonly Projected[], x: number, y: number): number | null {
  const HIT_RADIUS = 10;
  let best: number | null = null;
  let bestDistance = HIT_RADIUS;

  for (const item of projected) {
    const distance = Math.hypot(item.x - x, item.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item.index;
    }
  }

  return best;
}

// --- summaries --------------------------------------------------------------

function summarise(points: readonly EmbeddingPoint[]): CategorySummary[] {
  const groups = new Map<string, EmbeddingPoint[]>();
  for (const point of points) {
    const group = groups.get(point.category);
    if (group) group.push(point);
    else groups.set(point.category, [point]);
  }

  return [...groups.entries()]
    .map(([category, group]) => ({
      category,
      count: group.length,
      spread: spreadOf(group),
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Root-mean-square distance from the group's own centre. */
function spreadOf(points: readonly EmbeddingPoint[]): number {
  if (points.length === 0) return 0;
  const cx = sum(points.map((p) => p.x)) / points.length;
  const cy = sum(points.map((p) => p.y)) / points.length;
  const cz = sum(points.map((p) => p.z)) / points.length;
  const squares = points.map((p) => (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2);
  return Math.sqrt(sum(squares) / points.length);
}

/**
 * What a screen reader is told.
 *
 * A canvas is opaque to assistive technology, and the finding this panel exists to show
 * is a sentence — so it is said, rather than left to be inferred from a picture nobody
 * outside a pointer-and-sight session can reach.
 */
function describe(map: EmbeddingMap, categories: CategorySummary[]): string {
  if (map.points.length === 0) return 'Embedding scatter plot. Nothing is indexed yet.';

  const largest = categories[0]!;
  const corpus = spreadOf(map.points);
  const ratio = corpus > 0 ? (largest.spread / corpus).toFixed(2) : '0';

  return (
    `Three-dimensional scatter plot of ${map.points.length} indexed passages across ` +
    `${categories.length} categories. The largest category, ${largest.category}, holds ` +
    `${largest.count} documents clustered within ${ratio} of the whole corpus's spread. ` +
    'Rotate with the arrow keys.'
  );
}

// --- helpers ----------------------------------------------------------------

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const seriesVar = (index: number) => `--series-${(index % SERIES_COUNT) + 1}`;

/** Resolve a custom property to the value a canvas can paint with. */
const cssValue = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
