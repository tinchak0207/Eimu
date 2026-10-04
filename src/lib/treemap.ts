// 通用矩形树状图布局（squarified treemap，Bruls/Huizing/van Wijk 1999）。
// 纯几何计算，不含任何渲染逻辑——输出的每个 rect 面积严格等于其 value 占比 ×
// 容器面积，因此可信地代表比例，不是视觉近似。

export interface TreemapDatum {
  id: string;
  value: number;
}

export interface TreemapRect extends TreemapDatum {
  x: number;
  y: number;
  w: number;
  h: number;
}

function worstRatio(rowValues: number[], length: number): number {
  const sum = rowValues.reduce((total, value) => total + value, 0);
  const max = Math.max(...rowValues);
  const min = Math.min(...rowValues);
  const sumSquared = sum * sum;
  const lengthSquared = length * length;
  return Math.max((lengthSquared * max) / sumSquared, sumSquared / (lengthSquared * min));
}

/**
 * 布局 [x, y, x+w, y+h] 内的矩形。value<=0 的项目会被丢弃（面积为零没有意义）。
 * 内部把 value 正规化到面积刻度（sum(value) == w*h），因此回传的每个 rect
 * 的 w*h 就是它在输入资料里的真实占比面积，可以直接拿来核对百分比。
 */
export function squarify(data: TreemapDatum[], x: number, y: number, w: number, h: number): TreemapRect[] {
  const items = data.filter((item) => item.value > 0);
  if (items.length === 0 || w <= 0 || h <= 0) return [];

  const total = items.reduce((sum, item) => sum + item.value, 0);
  const scale = (w * h) / total;
  let remaining = [...items]
    .sort((a, b) => b.value - a.value)
    .map((item) => ({ id: item.id, value: item.value * scale }));

  const rects: TreemapRect[] = [];
  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;

  while (remaining.length > 0) {
    const horizontal = rw >= rh;
    const length = horizontal ? rh : rw;

    let row = [remaining[0]];
    let rowValues = [remaining[0].value];
    let bestWorst = worstRatio(rowValues, length);

    for (let i = 1; i < remaining.length; i++) {
      const testValues = [...rowValues, remaining[i].value];
      const testWorst = worstRatio(testValues, length);
      if (testWorst <= bestWorst) {
        row = [...row, remaining[i]];
        rowValues = testValues;
        bestWorst = testWorst;
      } else {
        break;
      }
    }

    const rowSum = rowValues.reduce((sum, value) => sum + value, 0);
    const rowThickness = rowSum / length;
    let offset = 0;

    for (const item of row) {
      const itemLength = item.value / rowThickness;
      if (horizontal) {
        rects.push({ id: item.id, value: item.value / scale, x: rx, y: ry + offset, w: rowThickness, h: itemLength });
      } else {
        rects.push({ id: item.id, value: item.value / scale, x: rx + offset, y: ry, w: itemLength, h: rowThickness });
      }
      offset += itemLength;
    }

    if (horizontal) {
      rx += rowThickness;
      rw -= rowThickness;
    } else {
      ry += rowThickness;
      rh -= rowThickness;
    }

    remaining = remaining.slice(row.length);
  }

  return rects;
}
