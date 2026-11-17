/** Public SVG geometry in world units; command spelling and portal DOM order are not geometry. */
export function readFlowCurves(dom = document) {
  return [...dom.querySelectorAll(".react-flow__edge")].map((element) => {
    const path = element.querySelector(".react-flow__edge-path"), length = path.getTotalLength();
    return { id: element.getAttribute("data-id"), length,
      points: Array.from({ length: 65 }, (_, index) => {
        const point = path.getPointAtLength(length * index / 64);
        return [point.x, point.y];
      }) };
  });
}
