import Chart from 'chart.js';

// Modify horizontalBar so that each dataset (fragments, timeRanges) draws on the same row (level, track or buffer)
Chart.controllers.horizontalBar.prototype.calculateBarValuePixels = function (datasetIndex, index, options) {
  const chart = this.chart;
  const scale = this._getValueScale();
  const datasets = chart.data.datasets;
  // const metasets = scale._getMatchingVisibleMetas(this._type);
  const value = scale._parseValue(datasets[datasetIndex].data[index]);
  const start = value.start === undefined ? 0 : value.max >= 0 && value.min >= 0 ? value.min : value.max;
  const length = value.start === undefined ? value.end : value.max >= 0 && value.min >= 0 ? value.max - value.min : value.min - value.max;
  const base = scale.getPixelForValue(start);
  const head = scale.getPixelForValue(start + length);
  const size = head - base;

  return {
    size: size,
    base: base,
    head: head,
    center: head + size / 2
  };
};

Chart.controllers.horizontalBar.prototype.calculateBarIndexPixels = function (datasetIndex, index, ruler, options) {
  const rowHeight = 35;
  const size = rowHeight * options.categoryPercentage;
  const center = datasetIndex * rowHeight + (rowHeight / 2);
  return {
    base: center - size / 2,
    head: center + size / 2,
    center,
    size
  };
};

Chart.controllers.horizontalBar.prototype.draw = function () {
  const chart = this.chart;
  const scale = this._getValueScale();
  scale._parseValue = scaleParseValue;
  const rects = this.getMeta().data;
  const dataset = this.getDataset();
  const len = rects.length;
  if (len !== dataset.data.length) {
    // View does not match dataset (wait for redraw)
    return;
  }
  const ctx: CanvasRenderingContext2D = chart.ctx;
  const chartArea: { left, top, right, bottom } = chart.chartArea;
  Chart.helpers.canvas.clipArea(ctx, chartArea);
  const lineHeight = Math.ceil(ctx.measureText('0').actualBoundingBoxAscent) + 2;
  for (let i = 0; i < len; ++i) {
    const rect = rects[i];
    const view = rect._view;
    if (!intersects(view.base, view.x, chartArea.left, chartArea.right)) {
      // Do not draw elements outside of the chart's viewport
      continue;
    }
    const obj = dataset.data[i];
    const val = scale._parseValue(obj);
    if (!isNaN(val.min) && !isNaN(val.max)) {
      const { stats } = obj;
      const isFragment = !!stats;
      const bounds = boundingRects(view);
      const drawText = bounds.w > lineHeight;
      if (isFragment) {
        if (drawText) {
          view.borderWidth = 1;
          if (i === 0) {
            view.borderSkipped = null;
          }
        } else {
          view.borderWidth = 0;
          view.backgroundColor = `rgba(0, 0, 0, ${0.1 + (i % 2) / 4})`;
        }
      }
      rect.draw();
      if (isFragment) {
        if (stats.aborted) {
          ctx.fillStyle = 'rgba(100, 0, 0, 0.3)';
          ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
        }
        if (stats.loaded && stats.total) {
          ctx.fillStyle = 'rgba(50, 20, 100, 0.3)';
          ctx.fillRect(bounds.x, bounds.y, bounds.w * stats.loaded / stats.total, bounds.h);
        }
      }
      if (drawText) {
        const start = val.start; // obj.start;
        ctx.fillStyle = 'rgb(0, 0, 0)';
        if (stats) {
          const snLabel = 'sn: ' + obj.sn;
          const textWidth = Math.min(ctx.measureText(snLabel).width + 2, bounds.w - 2);
          ctx.fillText(snLabel, bounds.x + bounds.w - textWidth, bounds.y + lineHeight, bounds.w - 4);
        }
        const float = start !== (start | 0);
        const fixedPoint = float ? Math.min(5, Math.max(1, Math.floor(bounds.w / 10 - 1))) : 0;
        const startString = fixedPoint ? start.toFixed(fixedPoint).replace(/\.0$/, '..') : start.toString();
        ctx.fillText(startString, bounds.x + 2, bounds.y + bounds.h - 3, bounds.w - 5);
      }
    }
  }

  Chart.helpers.canvas.unclipArea(chart.ctx);
};

export function applyChartInstanceOverrides (chart) {
  Object.keys(chart.scales).forEach((axis) => {
    const scale = chart.scales[axis];
    scale._parseValue = scaleParseValue;
  });
}

function scaleParseValue (value: number[] | any) {
  let start, end, min, max;

  if (value === undefined) {
    console.warn('Chart values undefined (update chart)');
    return {};
  }

  if (Array.isArray(value)) {
    start = +this.getRightValue(value[0]);
    end = +this.getRightValue(value[1]);
    min = Math.min(start, end);
    max = Math.max(start, end);
  } else {
    start = +this.getRightValue(value.start);
    if ('end' in value) {
      end = +this.getRightValue(value.end);
    } else {
      end = +this.getRightValue(value.start + value.duration);
    }
    min = Math.min(start, end);
    max = Math.max(start, end);
  }

  return {
    min,
    max,
    start,
    end
  };
}

function intersects (x1, x2, x3, x4) {
  return x2 > x3 && x1 < x4;
}

function boundingRects (vm) {
  const half = vm.height / 2;
  const left = Math.min(vm.x, vm.base);
  const right = Math.max(vm.x, vm.base);
  const top = vm.y - half;
  const bottom = vm.y + half;
  return {
    x: left,
    y: top,
    w: right - left,
    h: bottom - top
  };
}