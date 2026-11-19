// Use a capture size close to our 2048px attachment limit, rather than decoding
// a full sensor-resolution image just to show the review screen.
export function cameraPictureSize(sizes: string[]): string | undefined {
  const valid = sizes
    .map((size) => ({ size, dimensions: size.split("x").map(Number) }))
    .filter(
      ({ dimensions }) =>
        dimensions.length === 2 &&
        dimensions.every((value) => Number.isFinite(value) && value > 0),
    )
    .map((item) => ({ ...item, edge: Math.max(...item.dimensions) }));
  const sufficient = valid
    .filter((item) => item.edge >= 2048)
    .sort((a, b) => a.edge - b.edge);
  return (sufficient[0] ?? valid.sort((a, b) => b.edge - a.edge)[0])?.size;
}
export function shouldDismissPhoto(
  distance: number,
  velocity: number,
  height: number,
) {
  return (
    distance > Math.min(150, height * 0.18) || (distance > 35 && velocity > 1)
  );
}
export const PHOTO_PAN_SPEED = 1.4;
