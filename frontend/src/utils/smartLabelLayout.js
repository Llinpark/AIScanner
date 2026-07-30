/**
 * Smart, collision-aware chart signal label placement.
 *
 * Anchors (entry / SL / TP prices) never move — only the visual label
 * is shifted, with a leader line back to the true price coordinate.
 */

export const SMART_LABEL_LAYOUT_DEFAULTS = {
  minimumVerticalGap: 18,
  minimumHorizontalGap: 35,
  labelWidth: 100,
  labelHeight: 22,
  leaderStub: 14,
  maxColumns: 6,
  maxVerticalSteps: 48,
  preferredSide: 'right',
  paddingTop: 42,
  paddingBottom: 18,
  paddingLeft: 8,
  paddingRight: 8,
  animationMs: 200
};

const DEFAULT_PRIORITY = {
  entry: 0,
  buy: 0,
  sell: 0,
  stopLoss: 1,
  sl: 1,
  tp1: 2,
  tp2: 3,
  tp3: 4
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function kindPriority(kind, explicit) {
  if (Number.isFinite(explicit)) return explicit;
  const key = String(kind || '').trim();
  if (!key) return 99;
  return DEFAULT_PRIORITY[key] ?? DEFAULT_PRIORITY[key.toLowerCase()] ?? 99;
}

function buildYCandidates(anchorY, minY, maxY, gapY, steps) {
  const candidates = [clamp(anchorY, minY, maxY)];
  for (let step = 1; step <= steps; step += 1) {
    candidates.push(clamp(anchorY + step * gapY, minY, maxY));
    candidates.push(clamp(anchorY - step * gapY, minY, maxY));
  }
  return [...new Set(candidates.map(value => Math.round(value * 10) / 10))];
}

function labelBounds(x, y, side, width, height) {
  const left = side === 'right' ? x : x - width;
  const top = y - height / 2;
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height
  };
}

function boxesOverlap(a, b, gapX, gapY) {
  return !(
    a.right + gapX <= b.left ||
    b.right + gapX <= a.left ||
    a.bottom + gapY <= b.top ||
    b.bottom + gapY <= a.top
  );
}

function boundsInViewport(bounds, viewport) {
  return (
    bounds.left >= viewport.minX &&
    bounds.right <= viewport.maxX &&
    bounds.top >= viewport.minY &&
    bounds.bottom <= viewport.maxY
  );
}

/**
 * Lightweight spatial index for AABB queries.
 * Buckets by coarse Y so collision checks stay O(k) instead of O(n).
 */
class SpatialIndex {
  constructor(cellHeight) {
    this.cellHeight = Math.max(cellHeight, 1);
    this.buckets = new Map();
  }

  _keys(bounds) {
    const start = Math.floor(bounds.top / this.cellHeight);
    const end = Math.floor(bounds.bottom / this.cellHeight);
    const keys = [];
    for (let i = start; i <= end; i += 1) keys.push(i);
    return keys;
  }

  insert(item) {
    for (const key of this._keys(item.bounds)) {
      if (!this.buckets.has(key)) this.buckets.set(key, []);
      this.buckets.get(key).push(item);
    }
  }

  query(bounds, gapY) {
    const start = Math.floor((bounds.top - gapY) / this.cellHeight);
    const end = Math.floor((bounds.bottom + gapY) / this.cellHeight);
    const seen = new Set();
    const results = [];
    for (let i = start; i <= end; i += 1) {
      const bucket = this.buckets.get(i);
      if (!bucket) continue;
      for (const item of bucket) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        results.push(item);
      }
    }
    return results;
  }
}

function attachmentX(anchorX, side, column, options) {
  const step = options.labelWidth + options.minimumHorizontalGap;
  if (side === 'right') {
    return anchorX + options.leaderStub + column * step;
  }
  return anchorX - options.leaderStub - column * step;
}

function scoreSideCongestion(side, item, placed, gapY) {
  let congestion = 0;
  for (const label of placed) {
    if (label.side !== side) continue;
    if (Math.abs(label.y - item.anchorY) < gapY * 3) congestion += 1;
  }
  return congestion;
}

function countCollisions(bounds, nearby, gapX, gapY) {
  let count = 0;
  for (const existing of nearby) {
    if (boxesOverlap(bounds, existing.bounds, gapX, gapY)) count += 1;
  }
  return count;
}

function freeSpaceScore(side, item, placed, viewport, options) {
  const probeX = attachmentX(item.anchorX, side, 0, options);
  const probe = labelBounds(probeX, item.anchorY, side, options.labelWidth, options.labelHeight);

  let nearest = side === 'right'
    ? Math.max(0, viewport.maxX - probe.right)
    : Math.max(0, probe.left - viewport.minX);

  for (const label of placed) {
    if (!boxesOverlap(
      { ...probe, left: probe.left - options.minimumHorizontalGap, right: probe.right + options.minimumHorizontalGap },
      label.bounds,
      0,
      options.minimumVerticalGap * 2
    )) {
      continue;
    }
    if (side === 'right') {
      nearest = Math.min(nearest, Math.max(0, label.bounds.left - probe.right));
    } else {
      nearest = Math.min(nearest, Math.max(0, probe.left - label.bounds.right));
    }
  }

  // Prefer the preferred side when free space is similar.
  const preferredBonus = side === options.preferredSide ? options.minimumHorizontalGap * 0.5 : 0;
  return nearest + preferredBonus - scoreSideCongestion(side, item, placed, options.minimumVerticalGap) * 8;
}

function orderedSides(item, placed, viewport, options) {
  const rightScore = freeSpaceScore('right', item, placed, viewport, options);
  const leftScore = freeSpaceScore('left', item, placed, viewport, options);
  if (leftScore > rightScore) return ['left', 'right'];
  return ['right', 'left'];
}

function normalizeItem(item, options) {
  const kind = String(item.kind || item.id || 'label').trim() || 'label';
  return {
    ...item,
    id: item.id != null ? String(item.id) : kind,
    kind,
    priority: kindPriority(kind, item.priority),
    width: Number.isFinite(item.width) ? item.width : options.labelWidth,
    height: Number.isFinite(item.height) ? item.height : options.labelHeight,
    anchorX: Number(item.anchorX),
    anchorY: Number(item.anchorY)
  };
}

function findPlacement(item, placed, index, view, options, sides, steps, allowCollision) {
  const candidatesY = buildYCandidates(
    item.anchorY,
    view.minY,
    view.maxY,
    options.minimumVerticalGap,
    steps
  );
  let best = null;

  for (const side of sides) {
    for (let column = 0; column < options.maxColumns; column += 1) {
      for (const y of candidatesY) {
        const x = attachmentX(item.anchorX, side, column, options);
        const bounds = labelBounds(x, y, side, item.width, item.height);
        if (!boundsInViewport(bounds, view)) continue;

        const nearby = index.query(bounds, options.minimumVerticalGap);
        const collisions = countCollisions(
          bounds,
          nearby,
          options.minimumHorizontalGap,
          options.minimumVerticalGap
        );
        if (!allowCollision && collisions > 0) continue;

        const displacement = Math.abs(y - item.anchorY);
        const horizontalShift = Math.abs(x - item.anchorX);
        const sidePenalty = side === options.preferredSide ? 0 : options.minimumHorizontalGap * 0.35;
        const columnPenalty = column * (options.labelWidth * 0.15);
        const collisionPenalty = collisions * 1000;
        const score =
          displacement * 1.35 + horizontalShift * 0.25 + sidePenalty + columnPenalty + collisionPenalty;

        if (!best || score < best.score) {
          best = {
            ...item,
            side,
            column,
            x,
            y,
            bounds,
            displacement,
            score,
            collisions
          };
        }

        if (!allowCollision && displacement === 0 && column === 0 && side === sides[0] && collisions === 0) {
          return best;
        }
      }
    }
  }

  return best;
}

export class SmartLabelLayoutEngine {
  constructor(options = {}) {
    this.options = { ...SMART_LABEL_LAYOUT_DEFAULTS, ...options };
  }

  configure(options = {}) {
    this.options = { ...this.options, ...options };
    return this;
  }

  /**
   * @param {Array} items - labels with { id, kind, anchorX, anchorY, priority? }
   * @param {object} viewport - { width, height } or { minX, maxX, minY, maxY }
   * @returns {Array} placements with x, y, side, column, bounds, displacement
   */
  layout(items = [], viewport = {}) {
    const options = this.options;
    const minX = Number.isFinite(viewport.minX) ? viewport.minX : options.paddingLeft;
    const maxX = Number.isFinite(viewport.maxX)
      ? viewport.maxX
      : Math.max(minX, (viewport.width || 0) - options.paddingRight);
    const minY = Number.isFinite(viewport.minY) ? viewport.minY : options.paddingTop;
    const maxY = Number.isFinite(viewport.maxY)
      ? viewport.maxY
      : Math.max(minY, (viewport.height || 0) - options.paddingBottom);

    const view = { minX, maxX, minY, maxY };
    if (maxX <= minX || maxY <= minY) return [];

    const normalized = items
      .map(item => normalizeItem(item, options))
      .filter(item => Number.isFinite(item.anchorX) && Number.isFinite(item.anchorY));

    // Highest priority first so Buy/Sell/SL keep preferred slots; lower-priority move first.
    const sorted = [...normalized].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.anchorX !== b.anchorX) return a.anchorX - b.anchorX;
      return a.anchorY - b.anchorY;
    });

    const placed = [];
    const index = new SpatialIndex(options.labelHeight + options.minimumVerticalGap);
    const baseSteps = Math.min(
      options.maxVerticalSteps,
      Math.max(8, sorted.length * 2)
    );

    for (const item of sorted) {
      const sides = orderedSides(item, placed, view, options);

      let placement =
        findPlacement(item, placed, index, view, options, sides, baseSteps, false) ||
        findPlacement(item, placed, index, view, options, sides, baseSteps * 2, false);

      // Last resort: least-colliding slot (should be rare; dense historical packs).
      if (!placement) {
        placement = findPlacement(item, placed, index, view, options, sides, baseSteps * 3, true);
      }

      if (!placement) {
        const side = sides[0];
        const x = clamp(
          attachmentX(item.anchorX, side, 0, options),
          minX + (side === 'left' ? item.width : 0),
          maxX - (side === 'right' ? item.width : 0)
        );
        const y = clamp(item.anchorY, minY + item.height / 2, maxY - item.height / 2);
        placement = {
          ...item,
          side,
          column: 0,
          x,
          y,
          bounds: labelBounds(x, y, side, item.width, item.height),
          displacement: Math.abs(y - item.anchorY),
          score: Number.POSITIVE_INFINITY,
          collisions: 0
        };
      }

      placed.push(placement);
      index.insert(placement);
    }

    return placed.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.anchorX !== b.anchorX) return a.anchorX - b.anchorX;
      return a.anchorY - b.anchorY;
    });
  }

  /**
   * Attach leader geometry for rendering. Price anchors stay fixed.
   */
  withLeaders(placements = []) {
    return placements.map(label => {
      const boxX = label.side === 'right' ? label.x : label.x - label.width;
      const boxY = label.y - label.height / 2;
      const leaderEndX = label.side === 'right' ? boxX : boxX + label.width;
      const leaderEndY = label.y;
      return {
        ...label,
        boxX,
        boxY,
        leaderStartX: label.anchorX,
        leaderStartY: label.anchorY,
        leaderEndX,
        leaderEndY,
        leaderPath: `M ${label.anchorX} ${label.anchorY} L ${leaderEndX} ${leaderEndY}`
      };
    });
  }
}

/** Convenience wrapper used by chart components. */
export function layoutSmartLabels(items = [], options = {}) {
  const {
    width,
    height,
    minX,
    maxX,
    minY,
    maxY,
    minVerticalGap,
    minHorizontalGap,
    ...rest
  } = options;

  const engine = new SmartLabelLayoutEngine({
    ...rest,
    ...(Number.isFinite(minVerticalGap) ? { minimumVerticalGap: minVerticalGap } : {}),
    ...(Number.isFinite(minHorizontalGap) ? { minimumHorizontalGap: minHorizontalGap } : {})
  });

  const placements = engine.layout(items, { width, height, minX, maxX, minY, maxY });
  return engine.withLeaders(placements);
}
