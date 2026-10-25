/**
 * Perspective for one flat plane, not a 3D scene camera. Values are authored
 * canvas pixels/degrees. The Player scales the entire canvas, including this
 * distance; never multiply by viewport or device-pixel ratios. Parent clip
 * transforms naturally scale a motion layer and its local perspective together.
 * Rotation uses the existing clip center or motion layer anchor. Perspective
 * precedes tilt in CSS, then the caller appends its legacy Z rotation/scale.
 */
export function planeTransform(plane: {
  rotateX?: number;
  rotateY?: number;
  perspective?: number;
}): string {
  const bounded = (
    value: number | undefined,
    min: number,
    max: number,
    fallback: number,
  ) =>
    Number.isFinite(value) ? Math.max(min, Math.min(max, value!)) : fallback;
  const x = bounded(plane.rotateX, -85, 85, 0);
  const y = bounded(plane.rotateY, -85, 85, 0);
  // Omit all new CSS for a neutral plane so legacy footage renders exactly
  // as before, without creating an extra perspective/compositing context.
  if (x === 0 && y === 0) return "";
  const distance = bounded(plane.perspective, 200, 8000, 1000);
  return `perspective(${distance}px) rotateX(${x}deg) rotateY(${y}deg)`;
}
