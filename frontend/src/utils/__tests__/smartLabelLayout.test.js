import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SMART_LABEL_LAYOUT_DEFAULTS,
  SmartLabelLayoutEngine,
  layoutSmartLabels
} from '../smartLabelLayout.js';

function boxesOverlap(a, b, gapX = 0, gapY = 0) {
  return !(
    a.right + gapX <= b.left ||
    b.right + gapX <= a.left ||
    a.bottom + gapY <= b.top ||
    b.bottom + gapY <= a.top
  );
}

describe('SmartLabelLayoutEngine', () => {
  it('exports configurable spacing defaults', () => {
    assert.equal(SMART_LABEL_LAYOUT_DEFAULTS.minimumVerticalGap, 18);
    assert.equal(SMART_LABEL_LAYOUT_DEFAULTS.minimumHorizontalGap, 35);
    assert.ok(SMART_LABEL_LAYOUT_DEFAULTS.animationMs >= 150);
    assert.ok(SMART_LABEL_LAYOUT_DEFAULTS.animationMs <= 250);
  });

  it('keeps price anchors fixed while moving label boxes', () => {
    const engine = new SmartLabelLayoutEngine();
    const items = [
      { id: 'buy', kind: 'buy', anchorX: 400, anchorY: 200 },
      { id: 'tp1', kind: 'tp1', anchorX: 400, anchorY: 205 },
      { id: 'tp2', kind: 'tp2', anchorX: 400, anchorY: 210 },
      { id: 'tp3', kind: 'tp3', anchorX: 400, anchorY: 215 }
    ];

    const placed = engine.withLeaders(engine.layout(items, { width: 800, height: 500 }));
    assert.equal(placed.length, 4);

    for (const label of placed) {
      assert.equal(label.leaderStartX, label.anchorX);
      assert.equal(label.leaderStartY, label.anchorY);
      assert.notEqual(label.boxX, undefined);
      assert.notEqual(label.boxY, undefined);
    }

    const pairs = [];
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        pairs.push([placed[i], placed[j]]);
      }
    }

    for (const [left, right] of pairs) {
      assert.equal(
        boxesOverlap(
          left.bounds,
          right.bounds,
          SMART_LABEL_LAYOUT_DEFAULTS.minimumHorizontalGap,
          SMART_LABEL_LAYOUT_DEFAULTS.minimumVerticalGap
        ),
        false,
        `${left.id} overlaps ${right.id}`
      );
    }
  });

  it('moves lower-priority labels before Buy/Sell', () => {
    const engine = new SmartLabelLayoutEngine();
    const items = [
      { id: 'buy', kind: 'buy', anchorX: 420, anchorY: 220 },
      { id: 'sl', kind: 'sl', anchorX: 420, anchorY: 220 },
      { id: 'tp1', kind: 'tp1', anchorX: 420, anchorY: 220 }
    ];
    const placed = engine.layout(items, { width: 900, height: 520 });
    const buy = placed.find(item => item.id === 'buy');
    const tp1 = placed.find(item => item.id === 'tp1');
    assert.ok(buy);
    assert.ok(tp1);
    assert.ok(buy.displacement <= tp1.displacement);
  });

  it('switches side when the preferred side is congested', () => {
    const engine = new SmartLabelLayoutEngine({
      preferredSide: 'right',
      maxColumns: 1,
      labelWidth: 100,
      minimumHorizontalGap: 35
    });

    // Pack many labels near the right edge so free-space prefers left.
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: `lbl-${index}`,
      kind: index === 0 ? 'buy' : `tp${(index % 3) + 1}`,
      priority: index,
      anchorX: 760,
      anchorY: 180 + index * 4
    }));

    const placed = engine.layout(items, { width: 820, height: 480 });
    assert.ok(placed.some(label => label.side === 'left'));
  });

  it('scales to dozens of historical trade labels without overlaps', () => {
    const engine = new SmartLabelLayoutEngine({ maxColumns: 8, maxVerticalSteps: 64 });
    const items = [];
    for (let trade = 0; trade < 16; trade += 1) {
      const anchorX = 120 + trade * 55;
      const baseY = 160 + (trade % 4) * 70;
      items.push(
        { id: `${trade}:buy`, kind: 'buy', anchorX, anchorY: baseY },
        { id: `${trade}:sl`, kind: 'sl', anchorX, anchorY: baseY + 40 },
        { id: `${trade}:tp1`, kind: 'tp1', anchorX, anchorY: baseY - 28 },
        { id: `${trade}:tp2`, kind: 'tp2', anchorX, anchorY: baseY - 48 },
        { id: `${trade}:tp3`, kind: 'tp3', anchorX, anchorY: baseY - 68 }
      );
    }

    const placed = engine.layout(items, { width: 1400, height: 900 });
    assert.equal(placed.length, 80);

    let overlaps = 0;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        if (
          boxesOverlap(
            placed[i].bounds,
            placed[j].bounds,
            SMART_LABEL_LAYOUT_DEFAULTS.minimumHorizontalGap,
            SMART_LABEL_LAYOUT_DEFAULTS.minimumVerticalGap
          )
        ) {
          overlaps += 1;
        }
      }
    }
    assert.equal(overlaps, 0, `expected 0 overlaps, got ${overlaps}`);
  });

  it('layoutSmartLabels convenience wrapper returns leader paths', () => {
    const labels = layoutSmartLabels(
      [
        { id: 'buy', kind: 'buy', anchorX: 300, anchorY: 200 },
        { id: 'tp1', kind: 'tp1', anchorX: 300, anchorY: 210 }
      ],
      { width: 700, height: 400, minVerticalGap: 18, minHorizontalGap: 35 }
    );
    assert.equal(labels.length, 2);
    assert.match(labels[0].leaderPath, /^M /);
    assert.ok(Number.isFinite(labels[0].boxX));
    assert.ok(Number.isFinite(labels[0].boxY));
  });
});
