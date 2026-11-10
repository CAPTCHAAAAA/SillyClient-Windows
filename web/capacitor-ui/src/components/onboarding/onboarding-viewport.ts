export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ViewportMetrics {
  offsetLeft?: number | null;
  offsetTop?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface ClipAncestor {
  bounds: Bounds;
  scrollable: boolean;
}

export interface Scrollport {
  bounds: Bounds;
  ancestorIndex: number;
}

export interface TargetClipping {
  visibleClip: Bounds | null;
  scrollports: Scrollport[];
}

export interface ScrollAxisRange {
  position: number;
  min: number;
  max: number;
}

export function getViewportBounds(
  viewport: ViewportMetrics | null | undefined,
  layoutWidth: number,
  layoutHeight: number,
): Bounds {
  const metrics = viewport ?? {};
  const left = Number.isFinite(metrics.offsetLeft) ? metrics.offsetLeft! : 0;
  const top = Number.isFinite(metrics.offsetTop) ? metrics.offsetTop! : 0;
  const width = Number.isFinite(metrics.width) && metrics.width! > 0
    ? metrics.width!
    : Math.max(0, layoutWidth);
  const height = Number.isFinite(metrics.height) && metrics.height! > 0
    ? metrics.height!
    : Math.max(0, layoutHeight);
  return { left, top, right: left + width, bottom: top + height };
}

export function sameBounds(first: Bounds | null, second: Bounds | null) {
  if (first === second) return true;
  if (!first || !second) return false;
  return Math.abs(first.left - second.left) < 0.5
    && Math.abs(first.top - second.top) < 0.5
    && Math.abs(first.right - second.right) < 0.5
    && Math.abs(first.bottom - second.bottom) < 0.5;
}

export function intersectBounds(first: Bounds, second: Bounds): Bounds | null {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function intersectAll(bounds: readonly Bounds[]) {
  let result: Bounds | null = bounds[0] ?? null;
  for (let index = 1; result && index < bounds.length; index++) {
    result = intersectBounds(result, bounds[index]);
  }
  return result;
}

export function resolveTargetClipping(
  viewport: Bounds,
  ancestors: readonly ClipAncestor[],
): TargetClipping {
  const visibleClip = intersectAll([viewport, ...ancestors.map(({ bounds }) => bounds)]);
  const scrollports = ancestors.flatMap((ancestor, index) => {
    if (!ancestor.scrollable) return [];
    const visibleScrollport = intersectAll([
      viewport,
      ...ancestors.slice(index).map(({ bounds }) => bounds),
    ]);
    return visibleScrollport ? [{ bounds: visibleScrollport, ancestorIndex: index }] : [];
  });
  return { visibleClip, scrollports };
}

function axisRevealDelta(
  targetStart: number,
  targetEnd: number,
  clipStart: number,
  clipEnd: number,
  margin: number,
  range: ScrollAxisRange | null,
) {
  if (!range) return 0;
  const start = clipStart + margin;
  const end = clipEnd - margin;
  const targetSize = targetEnd - targetStart;
  if (end <= start) return 0;
  let desired = 0;
  if (targetSize > end - start) {
    desired = targetStart - start;
  } else if (targetStart < start - 1) {
    desired = targetStart - start;
  } else if (targetEnd > end + 1) {
    desired = targetEnd - end;
  }
  const available = Math.max(range.min - range.position, Math.min(desired, range.max - range.position));
  return Math.abs(available) > 1 ? available : 0;
}

export function getRevealDelta(
  target: Bounds,
  clip: Bounds,
  horizontal: ScrollAxisRange | null,
  vertical: ScrollAxisRange | null,
  margin = 8,
 ) {
  return {
    left: axisRevealDelta(target.left, target.right, clip.left, clip.right, margin, horizontal),
    top: axisRevealDelta(target.top, target.bottom, clip.top, clip.bottom, margin, vertical),
  };
}

export function getCalloutPosition(
  target: Bounds,
  preferredWidth: number,
  height: number,
  viewport: Bounds,
  gap = 18,
  margin = 16,
) {
  const viewportWidth = Math.max(0, viewport.right - viewport.left);
  const viewportHeight = Math.max(0, viewport.bottom - viewport.top);
  const horizontalMargin = Math.min(margin, viewportWidth / 2);
  const verticalMargin = Math.min(margin, viewportHeight / 2);
  const width = Math.min(preferredWidth, Math.max(0, viewportWidth - horizontalMargin * 2));
  const minLeft = viewport.left + horizontalMargin;
  const maxLeft = Math.max(minLeft, viewport.right - horizontalMargin - width);
  const left = Math.max(minLeft, Math.min(target.left, maxLeft));
  const belowTop = target.bottom + gap;
  const preferredTop = belowTop + height <= viewport.bottom - verticalMargin
    ? belowTop
    : target.top - height - gap;
  const minTop = viewport.top + verticalMargin;
  const maxTop = Math.max(minTop, viewport.bottom - verticalMargin - height);
  const top = Math.max(minTop, Math.min(preferredTop, maxTop));
  return { left, top, width };
}
