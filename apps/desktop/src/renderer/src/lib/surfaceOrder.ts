function layerPath(element: HTMLElement): number[] {
  const path: number[] = [];
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const value = Number.parseInt(
      element.ownerDocument.defaultView?.getComputedStyle(parent).zIndex ?? '',
      10,
    );
    if (Number.isFinite(value)) path.push(value);
  }
  return path.reverse();
}

export function compareSurfaceLayers(left: HTMLElement, right: HTMLElement): number {
  const leftPath = layerPath(left);
  const rightPath = layerPath(right);
  for (let index = 0; index < Math.max(leftPath.length, rightPath.length); index++) {
    const difference = (leftPath[index] ?? 0) - (rightPath[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
