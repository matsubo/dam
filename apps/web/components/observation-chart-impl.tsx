'use client';

// All ECharts deps live in this single client-only module so Next dev
// compiles ONE chunk on demand instead of five separate barrels via
// Promise.all (which serialised in the dev-server compile queue and made
// first-paint take 5+ s on a fresh chart mount). Production builds tree-shake
// the same imports identically.
import EChartsBase from 'echarts-for-react/lib/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  LegendComponent,
  CanvasRenderer,
]);

export default function ObservationChartImpl({
  option,
  style,
}: {
  option: unknown;
  style?: React.CSSProperties;
}) {
  return <EChartsBase echarts={echarts} option={option} style={style} />;
}
