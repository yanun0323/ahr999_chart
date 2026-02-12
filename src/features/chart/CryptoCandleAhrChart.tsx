import {
    AreaSeries,
    CandlestickSeries,
    ColorType,
    CrosshairMode,
    LineSeries,
    LineStyle,
    PriceScaleMode,
    createChart,
    type AutoscaleInfo,
    type UTCTimestamp
} from "lightweight-charts";
import {
    Match,
    Show,
    Switch,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    onMount
} from "solid-js";
import { SearchableComboboxField, type ComboboxOptionItem } from "../../components/ui/SearchableComboboxField";
import { StateCard } from "../../components/ui/StateCard";
import { fetchKlines, fetchTradingPairs, type CandlePoint, type TradingPairOption } from "../../shared/api/binance";
import { copy } from "../../shared/copy";
import { calculateAhr999, type AhrPoint } from "../../shared/indicator/ahr999";
import { formatPrice, formatRatio } from "../../shared/utils/formatters";

type ViewMode = "loadingPairs" | "loadingData" | "error" | "empty" | "chart";
type KlineInterval = "1h" | "4h" | "1d" | "1w" | "1M";

interface LogicalRangeLike {
  from: number;
  to: number;
}

interface FloatingTooltip {
  left: number;
  top: number;
  date: string;
  dcaCost: number;
  price: number;
  ahr: number;
}

const FIXED_INTERVAL: KlineInterval = "1d";
const KLINE_BATCH_SIZE = 500;
const LOAD_MORE_THRESHOLD = 35;
const LIVE_REFRESH_LIMIT = 10;
const LIVE_REFRESH_INTERVAL_MS = 1000;
const FULL_HISTORY_REQUEST_INTERVAL_MS = 300;
const AHR_BOTTOM_VALUE = 0.45;
const AHR_DCA_VALUE = 1.2;
const AHR_OVERHEAT_VALUE = 5;
const AHR_MIN_VALUE = 0.1;
const AHR_MAX_PADDING_RATIO = 0.08;
const PRICE_SCALE_TOP_MARGIN = 0;
const PRICE_SCALE_BOTTOM_MARGIN = 0.2;
const AHR_SCALE_TOP_MARGIN = 0.5;
const AHR_SCALE_BOTTOM_MARGIN = 0;
const SELECTED_SYMBOL_STORAGE_KEY = "ahr999-chart.selected-symbol";
const STARRED_SYMBOLS_STORAGE_KEY = "ahr999-chart.starred-symbols";

type StarredSymbols = Record<string, number>;

const isAbortError = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === "AbortError";
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const formatCompactValue = (value: number): string => {
  const absValue = Math.abs(value);

  if (absValue >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }

  if (absValue >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }

  if (absValue >= 1) {
    return value.toFixed(2);
  }

  return value.toFixed(4);
};

const formatUsdAxis = (value: number): string => `$${formatCompactValue(value)}`;

const normalizeTime = (time: unknown): UTCTimestamp | null => {
  if (typeof time === "number" && Number.isFinite(time)) {
    return Math.floor(time) as UTCTimestamp;
  }

  if (typeof time === "object" && time !== null) {
    const maybeBusinessDay = time as { year?: unknown; month?: unknown; day?: unknown };
    if (
      typeof maybeBusinessDay.year === "number" &&
      typeof maybeBusinessDay.month === "number" &&
      typeof maybeBusinessDay.day === "number"
    ) {
      return Math.floor(
        Date.UTC(maybeBusinessDay.year, maybeBusinessDay.month - 1, maybeBusinessDay.day) / 1000
      ) as UTCTimestamp;
    }
  }

  return null;
};

const toSlashDate = (time: unknown): string => {
  if (typeof time === "number") {
    const date = new Date(time * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}/${month}/${day}`;
  }

  if (typeof time === "object" && time !== null) {
    const maybeBusinessDay = time as { year?: unknown; month?: unknown; day?: unknown };
    if (
      typeof maybeBusinessDay.year === "number" &&
      typeof maybeBusinessDay.month === "number" &&
      typeof maybeBusinessDay.day === "number"
    ) {
      const month = String(maybeBusinessDay.month).padStart(2, "0");
      const day = String(maybeBusinessDay.day).padStart(2, "0");
      return `${maybeBusinessDay.year}/${month}/${day}`;
    }
  }

  return "--/--/--";
};

const mergeCandles = (base: CandlePoint[], updates: CandlePoint[]): CandlePoint[] => {
  const byTime = new Map<number, CandlePoint>();

  for (const candle of base) {
    byTime.set(Number(candle.time), candle);
  }

  for (const candle of updates) {
    byTime.set(Number(candle.time), candle);
  }

  return [...byTime.values()].sort((a, b) => Number(a.time) - Number(b.time));
};

const delayWithAbort = (ms: number, signal?: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);

    const handleAbort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
};

const fetchAllHistoryKlines = async (
  symbol: string,
  interval: KlineInterval,
  signal?: AbortSignal
): Promise<CandlePoint[]> => {
  const chunks: CandlePoint[][] = [];
  let nextEndTime: number | undefined;
  let earliestLoadedTime: number | null = null;

  while (true) {
    const batch = await fetchKlines(symbol, {
      interval,
      limit: KLINE_BATCH_SIZE,
      endTime: nextEndTime,
      signal
    });

    if (batch.length === 0) {
      break;
    }

    const previousEarliest = earliestLoadedTime;
    const filteredBatch: CandlePoint[] =
      previousEarliest === null ? batch : batch.filter((item) => Number(item.time) < previousEarliest);

    if (filteredBatch.length === 0) {
      break;
    }

    chunks.unshift(filteredBatch);
    earliestLoadedTime = Number(filteredBatch[0].time);

    if (batch.length < KLINE_BATCH_SIZE) {
      break;
    }

    const next = earliestLoadedTime * 1000 - 1;
    if (!Number.isFinite(next) || next <= 0) {
      break;
    }

    nextEndTime = Math.floor(next);
    await delayWithAbort(FULL_HISTORY_REQUEST_INTERVAL_MS, signal);
  }

  return chunks.flat();
};

const calculateDcaCostSeries = (candles: CandlePoint[], lookback = 200): AhrPoint[] => {
  if (candles.length === 0) {
    return [];
  }

  let rollingSum = 0;
  const points: AhrPoint[] = [];

  for (let index = 0; index < candles.length; index += 1) {
    const current = candles[index];
    rollingSum += current.close;

    if (index >= lookback) {
      rollingSum -= candles[index - lookback].close;
    }

    const windowSize = Math.min(index + 1, lookback);
    points.push({
      time: current.time,
      value: rollingSum / windowSize
    });
  }

  return points;
};

const extractValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const maybeLineData = value as { value?: unknown; close?: unknown };
    if (typeof maybeLineData.value === "number" && Number.isFinite(maybeLineData.value)) {
      return maybeLineData.value;
    }

    if (typeof maybeLineData.close === "number" && Number.isFinite(maybeLineData.close)) {
      return maybeLineData.close;
    }
  }

  return null;
};

const extractTime = (value: unknown): UTCTimestamp | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const maybeData = value as { time?: unknown };
  return normalizeTime(maybeData.time);
};

const readStoredSymbol = (): string => {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    const stored = window.localStorage.getItem(SELECTED_SYMBOL_STORAGE_KEY);
    return typeof stored === "string" ? stored.trim().toUpperCase() : "";
  } catch {
    return "";
  }
};

const writeStoredSymbol = (symbol: string): void => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(SELECTED_SYMBOL_STORAGE_KEY, symbol);
  } catch {
    // Ignore localStorage write failures (private mode / quota).
  }
};

const readStoredStarredSymbols = (): StarredSymbols => {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const rawValue = window.localStorage.getItem(STARRED_SYMBOLS_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }

    const result: StarredSymbols = {};
    for (const [symbol, starredAt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof symbol !== "string" || !symbol) {
        continue;
      }

      if (typeof starredAt === "number" && Number.isFinite(starredAt) && starredAt > 0) {
        result[symbol.toUpperCase()] = starredAt;
      }
    }

    return result;
  } catch {
    return {};
  }
};

const writeStoredStarredSymbols = (starredSymbols: StarredSymbols): void => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STARRED_SYMBOLS_STORAGE_KEY, JSON.stringify(starredSymbols));
  } catch {
    // Ignore localStorage write failures (private mode / quota).
  }
};

export const CryptoCandleAhrChart = () => {
  const [pairs, setPairs] = createSignal<TradingPairOption[]>([]);
  const [selectedSymbol, setSelectedSymbol] = createSignal("");
  const [starredSymbols, setStarredSymbols] = createSignal<StarredSymbols>(readStoredStarredSymbols());
  const [candles, setCandles] = createSignal<CandlePoint[]>([]);
  const [ahrPoints, setAhrPoints] = createSignal<AhrPoint[]>([]);
  const [dcaCostPoints, setDcaCostPoints] = createSignal<AhrPoint[]>([]);
  const [isPairsLoading, setIsPairsLoading] = createSignal(true);
  const [isDataLoading, setIsDataLoading] = createSignal(true);
  const [isRefreshing, setIsRefreshing] = createSignal(false);
  const [isLoadingMore, setIsLoadingMore] = createSignal(false);
  const [errorKind, setErrorKind] = createSignal<"error" | "empty" | null>(null);
  const [floatingTooltip, setFloatingTooltip] = createSignal<FloatingTooltip | null>(null);

  const pairOptions = createMemo<ComboboxOptionItem[]>(() => {
    const starredMap = starredSymbols();
    const orderedPairs = [...pairs()].sort((left, right) => {
      const leftStarredAt = starredMap[left.symbol];
      const rightStarredAt = starredMap[right.symbol];
      const leftIsStarred = typeof leftStarredAt === "number";
      const rightIsStarred = typeof rightStarredAt === "number";

      if (leftIsStarred && rightIsStarred) {
        if (leftStarredAt !== rightStarredAt) {
          return leftStarredAt - rightStarredAt;
        }

        return left.symbol.localeCompare(right.symbol, "en");
      }

      if (leftIsStarred) {
        return -1;
      }

      if (rightIsStarred) {
        return 1;
      }

      return left.symbol.localeCompare(right.symbol, "en");
    });

    return orderedPairs.map((pair) => ({
      value: pair.symbol,
      label: pair.symbol,
      isStarred: typeof starredMap[pair.symbol] === "number"
    }));
  });

  const dynamicAhrMax = createMemo(() => {
    let maxValue = Math.max(AHR_DCA_VALUE, AHR_OVERHEAT_VALUE);

    for (const point of ahrPoints()) {
      if (Number.isFinite(point.value) && point.value > maxValue) {
        maxValue = point.value;
      }
    }

    const paddedMax = maxValue * (1 + AHR_MAX_PADDING_RATIO);
    return Math.max(AHR_DCA_VALUE, AHR_OVERHEAT_VALUE, paddedMax);
  });

  const selectedAsset = createMemo(() => {
    const symbol = selectedSymbol();
    const matchedPair = pairs().find((pair) => pair.symbol === symbol);

    if (matchedPair?.baseAsset) {
      return matchedPair.baseAsset.toUpperCase();
    }

    if (symbol.endsWith("USDT")) {
      return symbol.slice(0, -4).toUpperCase();
    }

    return symbol ? symbol.toUpperCase() : "BTC";
  });

  const appTitle = createMemo(() => copy.appTitleByAsset(selectedAsset()));
  const loadingDataDescription = createMemo(() => copy.loadingDataDescriptionByAsset(selectedAsset()));
  const legendPriceLabel = createMemo(() => copy.legendPriceByAsset(selectedAsset()));
  const legendAhrLabel = createMemo(() => copy.legendAhrIndexByAsset(selectedAsset()));
  const valuationModeLabel = createMemo(() =>
    selectedAsset() === "BTC"
      ? copy.valuationModeBitcoin
      : copy.valuationModePowerLawByAsset(selectedAsset())
  );

  const hasChartData = createMemo(
    () => candles().length > 0 && ahrPoints().length > 0 && dcaCostPoints().length > 0
  );

  const viewMode = createMemo<ViewMode>(() => {
    if (isPairsLoading()) {
      return "loadingPairs";
    }

    if (errorKind() === "error") {
      return "error";
    }

    if (isDataLoading() && !hasChartData()) {
      return "loadingData";
    }

    if (errorKind() === "empty" || !hasChartData()) {
      return "empty";
    }

    return "chart";
  });

  let chartHostRef: HTMLDivElement | undefined;
  let chartApi: ReturnType<typeof createChart> | null = null;
  let priceSeries: any = null;
  let dcaCostSeries: any = null;
  let ahrSeries: any = null;
  let dangerZoneSeries: any = null;
  let currentPriceLine: any = null;
  let currentAhrLine: any = null;
  let bottomLine: any = null;
  let dcaLine: any = null;
  let overheatLine: any = null;
  let pairRequestController: AbortController | null = null;
  let dataRequestController: AbortController | null = null;
  let liveRequestController: AbortController | null = null;
  let requestCounter = 0;
  let resizeListenerBound = false;
  let hasMoreHistory = true;
  let shouldFitContentOnNextRender = false;
  let pendingPreserveRange: LogicalRangeLike | null = null;
  let pendingRangeShift = 0;
  let logicalRangeHandler: ((range: unknown) => void) | null = null;
  let crosshairHandler: ((param: any) => void) | null = null;
  let lastRequestedSymbol = "";

  const onResize = () => {
    if (!chartApi || !chartHostRef) {
      return;
    }

    chartApi.applyOptions({
      width: chartHostRef.clientWidth,
      height: chartHostRef.clientHeight
    });
  };

  const clearHover = () => {
    setFloatingTooltip(null);
  };

  const clearChartData = () => {
    setCandles([]);
    setAhrPoints([]);
    setDcaCostPoints([]);
    clearHover();
    clearReferenceLines();
  };

  const abortInFlightRequests = (includePairRequest = false) => {
    if (includePairRequest) {
      pairRequestController?.abort();
      pairRequestController = null;
    }

    dataRequestController?.abort();
    dataRequestController = null;

    liveRequestController?.abort();
    liveRequestController = null;
  };

  const stopAndClearData = (includePairRequest = false) => {
    // Invalidate stale async responses before starting a new symbol load.
    requestCounter += 1;
    abortInFlightRequests(includePairRequest);
    setIsDataLoading(false);
    setIsRefreshing(false);
    setIsLoadingMore(false);
    setErrorKind(null);
    hasMoreHistory = false;
    pendingPreserveRange = null;
    pendingRangeShift = 0;
    shouldFitContentOnNextRender = true;
    clearChartData();
  };

  const removeLine = (series: any, line: any): null => {
    if (series && line) {
      series.removePriceLine(line);
    }

    return null;
  };

  const clearReferenceLines = () => {
    currentPriceLine = removeLine(priceSeries, currentPriceLine);
    currentAhrLine = removeLine(ahrSeries, currentAhrLine);
    bottomLine = removeLine(ahrSeries, bottomLine);
    dcaLine = removeLine(ahrSeries, dcaLine);
    overheatLine = removeLine(ahrSeries, overheatLine);
  };

  const updateReferenceLines = () => {
    if (!priceSeries || !ahrSeries) {
      return;
    }

    clearReferenceLines();

    const lastCandle = candles().at(-1);
    const lastAhr = ahrPoints().at(-1);

    if (lastCandle) {
      currentPriceLine = priceSeries.createPriceLine({
        price: lastCandle.close,
        color: "rgba(220, 228, 241, 0.78)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: copy.currentPriceLine
      });
    }

    if (lastAhr) {
      currentAhrLine = ahrSeries.createPriceLine({
        price: lastAhr.value,
        color: "rgba(91, 135, 255, 0.9)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: copy.currentAhrLine
      });
    }

    bottomLine = ahrSeries.createPriceLine({
      price: AHR_BOTTOM_VALUE,
      color: "#ff3d77",
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `${copy.legendBottomLine}`
    });

    dcaLine = ahrSeries.createPriceLine({
      price: AHR_DCA_VALUE,
      color: "#6dcf6d",
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `${copy.legendDcaLine}`
    });

    overheatLine = ahrSeries.createPriceLine({
      price: AHR_OVERHEAT_VALUE,
      color: "#f6b44f",
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `${copy.legendOverheatLine}`
    });
  };

  const renderChartData = () => {
    if (!chartApi || !priceSeries || !dcaCostSeries || !ahrSeries || !dangerZoneSeries) {
      return;
    }

    const candlePoints = candles();
    const indicatorPoints = ahrPoints();
    const dcaPoints = dcaCostPoints();

    if (candlePoints.length === 0 || indicatorPoints.length === 0 || dcaPoints.length === 0) {
      priceSeries.setData([]);
      dcaCostSeries.setData([]);
      ahrSeries.setData([]);
      dangerZoneSeries.setData([]);
      clearReferenceLines();
      clearHover();
      return;
    }

    priceSeries.setData(
      candlePoints.map((point) => ({
        time: point.time,
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close
      }))
    );

    dcaCostSeries.setData(
      dcaPoints.map((point) => ({
        time: point.time,
        value: point.value
      }))
    );

    ahrSeries.setData(
      indicatorPoints.map((point) => ({
        time: point.time,
        value: point.value
      }))
    );

    dangerZoneSeries.setData(
      candlePoints.map((point) => ({
        time: point.time,
        value: AHR_BOTTOM_VALUE
      }))
    );

    updateReferenceLines();

    const timeScaleApi = chartApi.timeScale() as any;
    if (
      pendingPreserveRange &&
      pendingRangeShift > 0 &&
      typeof timeScaleApi.setVisibleLogicalRange === "function"
    ) {
      timeScaleApi.setVisibleLogicalRange({
        from: pendingPreserveRange.from + pendingRangeShift,
        to: pendingPreserveRange.to + pendingRangeShift
      });
      pendingPreserveRange = null;
      pendingRangeShift = 0;
    } else if (shouldFitContentOnNextRender) {
      timeScaleApi.fitContent();
      shouldFitContentOnNextRender = false;
    }
  };

  const initializeChart = () => {
    if (!chartHostRef || chartApi) {
      return;
    }

    chartApi = createChart(chartHostRef, {
      autoSize: true,
      layout: {
        background: {
          type: ColorType.Solid,
          color: "#040c1b"
        },
        textColor: "#dce2ef",
        fontFamily: '"Noto Sans TC", "Avenir Next", "Trebuchet MS", sans-serif'
      },
      grid: {
        vertLines: {
          color: "rgba(127, 145, 176, 0.08)",
          style: LineStyle.Dashed
        },
        horzLines: {
          color: "rgba(127, 145, 176, 0.18)",
          style: LineStyle.Dashed
        }
      },
      leftPriceScale: {
        visible: true,
        borderVisible: false,
        mode: PriceScaleMode.Logarithmic,
        scaleMargins: {
          top: AHR_SCALE_TOP_MARGIN,
          bottom: AHR_SCALE_BOTTOM_MARGIN
        }
      },
      rightPriceScale: {
        visible: true,
        borderVisible: false,
        mode: PriceScaleMode.Logarithmic,
        scaleMargins: {
          top: PRICE_SCALE_TOP_MARGIN,
          bottom: PRICE_SCALE_BOTTOM_MARGIN
        }
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        rightOffset: 4
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: {
          color: "rgba(224, 233, 248, 0.52)",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "rgba(3, 9, 20, 0.95)"
        },
        horzLine: {
          color: "rgba(224, 233, 248, 0.52)",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "rgba(3, 9, 20, 0.95)"
        }
      }
    });

    dangerZoneSeries = chartApi.addSeries(
      AreaSeries,
      {
        lineColor: "rgba(0, 0, 0, 0)",
        topColor: "rgba(255, 77, 132, 0.02)",
        bottomColor: "rgba(255, 77, 132, 0.14)",
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        priceScaleId: "left",
        priceFormat: {
          type: "custom",
          minMove: 0.0001,
          formatter: formatCompactValue
        }
      }
    );

    priceSeries = chartApi.addSeries(
      CandlestickSeries,
      {
        upColor: "#5cbf87",
        downColor: "#e57b7b",
        wickUpColor: "#5cbf87",
        wickDownColor: "#e57b7b",
        borderUpColor: "#5cbf87",
        borderDownColor: "#e57b7b",
        priceLineVisible: false,
        lastValueVisible: true,
        priceScaleId: "right",
        priceFormat: {
          type: "custom",
          minMove: 0.0001,
          formatter: formatUsdAxis
        }
      }
    );

    dcaCostSeries = chartApi.addSeries(
      LineSeries,
      {
        color: "#d2d9e2",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 5,
        crosshairMarkerBorderColor: "#f0f5ff",
        crosshairMarkerBackgroundColor: "#d2d9e2",
        priceScaleId: "right",
        priceFormat: {
          type: "custom",
          minMove: 0.0001,
          formatter: formatUsdAxis
        }
      }
    );

    ahrSeries = chartApi.addSeries(
      LineSeries,
      {
        color: "#5b87ff",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 5,
        crosshairMarkerBorderColor: "#e4ecff",
        crosshairMarkerBackgroundColor: "#5b87ff",
        priceScaleId: "left",
        priceFormat: {
          type: "custom",
          minMove: 0.0001,
          formatter: formatCompactValue
        }
      }
    );

    ahrSeries.applyOptions({
      autoscaleInfoProvider: (baseImplementation: () => AutoscaleInfo | null) => {
        const baseInfo = baseImplementation();
        const computedMax = dynamicAhrMax();

        if (!baseInfo?.priceRange) {
          return {
            priceRange: {
              minValue: AHR_MIN_VALUE,
              maxValue: computedMax
            }
          };
        }

        return {
          ...baseInfo,
          priceRange: {
            minValue: AHR_MIN_VALUE,
            maxValue: Math.max(baseInfo.priceRange.maxValue, computedMax)
          }
        };
      }
    } as any);

    chartApi.priceScale("right").applyOptions({
      visible: true,
      borderVisible: false,
      mode: PriceScaleMode.Logarithmic,
      scaleMargins: {
        top: PRICE_SCALE_TOP_MARGIN,
        bottom: PRICE_SCALE_BOTTOM_MARGIN
      }
    });

    chartApi.priceScale("left").applyOptions({
      visible: true,
      borderVisible: false,
      mode: PriceScaleMode.Logarithmic,
      scaleMargins: {
        top: AHR_SCALE_TOP_MARGIN,
        bottom: AHR_SCALE_BOTTOM_MARGIN
      }
    });

    crosshairHandler = (param) => {
      if (!chartHostRef || !priceSeries || !dcaCostSeries || !ahrSeries) {
        clearHover();
        return;
      }

      if (!param.point || param.point.x < 0 || param.point.y < 0) {
        clearHover();
        return;
      }

      const priceEntry = param.seriesData.get(priceSeries);
      const dcaEntry = param.seriesData.get(dcaCostSeries);
      const ahrEntry = param.seriesData.get(ahrSeries);
      const priceData = extractValue(priceEntry);
      const dcaData = extractValue(dcaEntry);
      const ahrData = extractValue(ahrEntry);
      const hoveredTime = extractTime(priceEntry) ?? normalizeTime(param.time);

      if (priceData === null || dcaData === null || ahrData === null || hoveredTime === null) {
        clearHover();
        return;
      }

      const hostHeight = chartHostRef.clientHeight;
      const hostWidth = chartHostRef.clientWidth;
      const tooltipWidth = 360;
      const tooltipHeight = 248;
      const left = clamp(param.point.x + 18, 14, Math.max(14, hostWidth - tooltipWidth - 14));
      const tipTop = clamp(param.point.y + 18, 14, Math.max(14, hostHeight - tooltipHeight - 14));

      setFloatingTooltip({
        left,
        top: tipTop,
        date: toSlashDate(hoveredTime),
        dcaCost: dcaData,
        price: priceData,
        ahr: ahrData
      });
    };

    chartApi.subscribeCrosshairMove(crosshairHandler);

    logicalRangeHandler = (range) => {
      if (!range || !priceSeries || isDataLoading() || isLoadingMore() || !hasMoreHistory) {
        return;
      }

      const barsInfo = priceSeries.barsInLogicalRange(range as any);
      if (!barsInfo) {
        return;
      }

      if (barsInfo.barsBefore < LOAD_MORE_THRESHOLD) {
        const symbol = selectedSymbol();
        if (symbol) {
          void loadOlderHistory(symbol, FIXED_INTERVAL);
        }
      }
    };

    (chartApi.timeScale() as any).subscribeVisibleLogicalRangeChange(logicalRangeHandler);
    renderChartData();

    if (!resizeListenerBound) {
      window.addEventListener("resize", onResize);
      resizeListenerBound = true;
    }
  };

  const loadTradingPairs = async () => {
    setIsPairsLoading(true);
    setErrorKind(null);

    const controller = new AbortController();
    pairRequestController?.abort();
    pairRequestController = controller;

    try {
      const result = await fetchTradingPairs(controller.signal);
      setPairs(result);

      const validSymbols = new Set(result.map((item) => item.symbol));
      setStarredSymbols((current) => {
        const next: StarredSymbols = {};

        for (const [symbol, starredAt] of Object.entries(current)) {
          if (validSymbols.has(symbol)) {
            next[symbol] = starredAt;
          }
        }

        return Object.keys(next).length === Object.keys(current).length ? current : next;
      });

      if (result.length === 0) {
        setSelectedSymbol("");
        setErrorKind("empty");
        return;
      }

      const current = selectedSymbol();
      const stored = readStoredSymbol();
      const storedSymbol = result.some((item) => item.symbol === stored) ? stored : "";
      const keptSymbol = result.some((item) => item.symbol === current) ? current : "";
      const defaultSymbol = result.find((item) => item.symbol === "BTCUSDT")?.symbol ?? result[0].symbol;
      setSelectedSymbol(storedSymbol || keptSymbol || defaultSymbol);
    } catch (error) {
      if (!isAbortError(error)) {
        setPairs([]);
        setSelectedSymbol("");
        setErrorKind("error");
      }
    } finally {
      if (pairRequestController === controller) {
        setIsPairsLoading(false);
        pairRequestController = null;
      }
    }
  };

  const loadMarketData = async (symbol: string, interval: KlineInterval) => {
    if (!symbol) {
      setCandles([]);
      setAhrPoints([]);
      setDcaCostPoints([]);
      setErrorKind("empty");
      hasMoreHistory = false;
      return;
    }

    const nextRequestId = requestCounter + 1;
    requestCounter = nextRequestId;

    const controller = new AbortController();
    dataRequestController?.abort();
    dataRequestController = controller;

    const keepVisibleChart = hasChartData();
    setErrorKind(null);
    hasMoreHistory = true;
    pendingPreserveRange = null;
    pendingRangeShift = 0;
    shouldFitContentOnNextRender = true;

    if (keepVisibleChart) {
      setIsRefreshing(true);
    } else {
      setIsDataLoading(true);
    }

    try {
      const candlePoints = await fetchAllHistoryKlines(symbol, interval, controller.signal);

      if (nextRequestId !== requestCounter) {
        return;
      }

      if (candlePoints.length === 0) {
        setCandles([]);
        setAhrPoints([]);
        setDcaCostPoints([]);
        setErrorKind("empty");
        hasMoreHistory = false;
        return;
      }

      const indicator = calculateAhr999(candlePoints, 200, selectedAsset());
      const dcaCosts = calculateDcaCostSeries(candlePoints);

      if (indicator.length === 0 || dcaCosts.length === 0) {
        setCandles([]);
        setAhrPoints([]);
        setDcaCostPoints([]);
        setErrorKind("empty");
        hasMoreHistory = false;
        return;
      }

      setCandles(candlePoints);
      setAhrPoints(indicator);
      setDcaCostPoints(dcaCosts);
      setErrorKind(null);
      hasMoreHistory = false;
    } catch (error) {
      if (!isAbortError(error)) {
        setCandles([]);
        setAhrPoints([]);
        setDcaCostPoints([]);
        setErrorKind("error");
        hasMoreHistory = false;
      }
    } finally {
      if (nextRequestId === requestCounter && dataRequestController === controller) {
        setIsDataLoading(false);
        setIsRefreshing(false);
        dataRequestController = null;
      }
    }
  };

  const loadOlderHistory = async (symbol: string, interval: KlineInterval) => {
    if (!chartApi || isLoadingMore() || isDataLoading() || !hasMoreHistory) {
      return;
    }

    const existing = candles();
    if (existing.length === 0) {
      return;
    }

    const earliestTime = existing[0].time;
    const requestEndTime = Number(earliestTime) * 1000 - 1;

    if (requestEndTime <= 0) {
      hasMoreHistory = false;
      return;
    }

    setIsLoadingMore(true);

    try {
      const olderCandles = await fetchKlines(symbol, {
        interval,
        limit: KLINE_BATCH_SIZE,
        endTime: requestEndTime
      });

      if (symbol !== selectedSymbol() || interval !== FIXED_INTERVAL) {
        return;
      }

      const prepend = olderCandles.filter((item) => item.time < earliestTime);
      if (prepend.length === 0) {
        hasMoreHistory = false;
        return;
      }

      const currentRange = (chartApi.timeScale() as any).getVisibleLogicalRange?.() as
        | LogicalRangeLike
        | null
        | undefined;

      if (currentRange) {
        pendingPreserveRange = currentRange;
        pendingRangeShift = prepend.length;
      } else {
        pendingPreserveRange = null;
        pendingRangeShift = 0;
      }

      shouldFitContentOnNextRender = false;

      const mergedCandles = [...prepend, ...existing];
      setCandles(mergedCandles);
      setAhrPoints(calculateAhr999(mergedCandles, 200, selectedAsset()));
      setDcaCostPoints(calculateDcaCostSeries(mergedCandles));
      hasMoreHistory = prepend.length >= KLINE_BATCH_SIZE;
    } catch (error) {
      if (!isAbortError(error)) {
        hasMoreHistory = false;
      }
    } finally {
      setIsLoadingMore(false);
    }
  };

  const refreshLatestCandles = async (symbol: string, interval: KlineInterval) => {
    if (isDataLoading() || isRefreshing() || isLoadingMore() || !hasChartData()) {
      return;
    }

    const controller = new AbortController();
    liveRequestController?.abort();
    liveRequestController = controller;

    try {
      const latestCandles = await fetchKlines(symbol, {
        interval,
        limit: LIVE_REFRESH_LIMIT,
        signal: controller.signal
      });

      if (liveRequestController !== controller) {
        return;
      }

      if (symbol !== selectedSymbol() || interval !== FIXED_INTERVAL) {
        return;
      }

      if (latestCandles.length === 0) {
        return;
      }

      const mergedCandles = mergeCandles(candles(), latestCandles);
      setCandles(mergedCandles);
      setAhrPoints(calculateAhr999(mergedCandles, 200, selectedAsset()));
      setDcaCostPoints(calculateDcaCostSeries(mergedCandles));
    } catch (error) {
      if (!isAbortError(error)) {
        // Keep last successful chart state for transient polling failures.
      }
    } finally {
      if (liveRequestController === controller) {
        liveRequestController = null;
      }
    }
  };

  const retryRequest = () => {
    if (pairs().length === 0) {
      void loadTradingPairs();
      return;
    }

    const symbol = selectedSymbol();
    if (!symbol) {
      return;
    }

    void loadMarketData(symbol, FIXED_INTERVAL);
  };

  const toggleStarredSymbol = (symbol: string) => {
    if (!symbol) {
      return;
    }

    setStarredSymbols((current) => {
      const normalizedSymbol = symbol.trim().toUpperCase();
      const next: StarredSymbols = { ...current };

      if (typeof next[normalizedSymbol] === "number") {
        delete next[normalizedSymbol];
      } else {
        next[normalizedSymbol] = Date.now();
      }

      return next;
    });
  };

  createEffect(() => {
    const symbol = selectedSymbol();
    if (!symbol) {
      return;
    }

    writeStoredSymbol(symbol);
  });

  createEffect(() => {
    writeStoredStarredSymbols(starredSymbols());
  });

  createEffect(() => {
    const symbol = selectedSymbol();
    if (!symbol || isPairsLoading()) {
      return;
    }

    const isSwitchingSymbol = lastRequestedSymbol !== "" && lastRequestedSymbol !== symbol;
    lastRequestedSymbol = symbol;

    if (isSwitchingSymbol) {
      stopAndClearData(false);
    }

    void loadMarketData(symbol, FIXED_INTERVAL);
  });

  createEffect(() => {
    const symbol = selectedSymbol();
    if (!symbol || isPairsLoading()) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshLatestCandles(symbol, FIXED_INTERVAL);
    }, LIVE_REFRESH_INTERVAL_MS);

    onCleanup(() => window.clearInterval(timer));
  });

  createEffect(() => {
    candles();
    ahrPoints();
    dcaCostPoints();
    renderChartData();
  });

  onCleanup(() => {
    stopAndClearData(true);

    if (chartApi && crosshairHandler) {
      chartApi.unsubscribeCrosshairMove(crosshairHandler);
      crosshairHandler = null;
    }

    if (chartApi && logicalRangeHandler) {
      (chartApi.timeScale() as any).unsubscribeVisibleLogicalRangeChange(logicalRangeHandler);
      logicalRangeHandler = null;
    }

    chartApi?.remove();
    chartApi = null;

    if (resizeListenerBound) {
      window.removeEventListener("resize", onResize);
      resizeListenerBound = false;
    }
  });

  onMount(() => {
    void loadTradingPairs();
  });

  return (
    <section class="dashboard-card chart-reference-card">
      <header class="dashboard-header chart-reference-header">
        <div class="headline chart-title-group">
          <h1>{appTitle()}</h1>
          <p>{copy.appSubtitle}</p>
        </div>
        <SearchableComboboxField
          label={copy.symbolLabel}
          options={pairOptions()}
          value={selectedSymbol()}
          disabled={isPairsLoading() || pairs().length === 0}
          placeholder={copy.symbolSearchPlaceholder}
          triggerAriaLabel={copy.openSymbolSelector}
          onToggleOptionStar={toggleStarredSymbol}
          optionStarButtonAriaLabel={(option) =>
            option.isStarred ? copy.unstarPairBySymbol(option.label) : copy.starPairBySymbol(option.label)
          }
          onChange={(value) => setSelectedSymbol(value)}
        />
      </header>

      <div class="series-legend">
        <span class="legend-item">
          <i class="legend-swatch legend-swatch-dca" />
          {copy.legendDcaCost}
        </span>
        <span class="legend-item">
          <i class="legend-swatch legend-swatch-price" />
          {legendPriceLabel()}
        </span>
        <span class="legend-item">
          <i class="legend-swatch legend-swatch-ahr" />
          {legendAhrLabel()}
        </span>
        <span class="legend-item">
          <i class="legend-swatch legend-swatch-bottom" />
          {copy.legendBottomLine}
        </span>
        <span class="legend-item">
          <i class="legend-swatch legend-swatch-dca-line" />
          {copy.legendDcaLine}
        </span>
        <span class="legend-item">
          <i class="legend-swatch legend-swatch-overheat" />
          {copy.legendOverheatLine}
        </span>
      </div>

      <div class="chart-shell chart-reference-shell">
        <div
          class="chart-host chart-reference-host"
          ref={(element) => {
            chartHostRef = element;
            initializeChart();
          }}
        />

        <Show when={floatingTooltip()}>
          {(tooltip) => (
            <article class="chart-tooltip" style={{ left: `${tooltip().left}px`, top: `${tooltip().top}px` }}>
              <h4>{tooltip().date}</h4>
              <p>
                <span>
                  <i class="dot dot-dca" />
                  {copy.legendDcaCost}
                </span>
                <strong>{formatPrice(tooltip().dcaCost)}</strong>
              </p>
              <p>
                <span>
                  <i class="dot dot-price" />
                  {legendPriceLabel()}
                </span>
                <strong>{formatPrice(tooltip().price)}</strong>
              </p>
              <p>
                <span>
                  <i class="dot dot-ahr" />
                  {legendAhrLabel()}
                </span>
                <strong>{formatRatio(tooltip().ahr)}</strong>
              </p>
              <p>
                <span>
                  <i class="dot dot-bottom" />
                  {copy.legendBottomLine}
                </span>
                <strong>{formatRatio(AHR_BOTTOM_VALUE)}</strong>
              </p>
              <p>
                <span>
                  <i class="dot dot-dca-line" />
                  {copy.legendDcaLine}
                </span>
                <strong>{formatRatio(AHR_DCA_VALUE)}</strong>
              </p>
              <p>
                <span>
                  <i class="dot dot-overheat" />
                  {copy.legendOverheatLine}
                </span>
                <strong>{formatRatio(AHR_OVERHEAT_VALUE)}</strong>
              </p>
            </article>
          )}
        </Show>

        <Show when={viewMode() !== "chart"}>
          <div class="chart-overlay">
            <Switch>
              <Match when={viewMode() === "loadingPairs"}>
                <StateCard title={copy.loadingPairsTitle} description={copy.loadingPairsDescription} />
              </Match>
              <Match when={viewMode() === "loadingData"}>
                <StateCard title={copy.loadingDataTitle} description={loadingDataDescription()} />
              </Match>
              <Match when={viewMode() === "error"}>
                <StateCard
                  title={copy.errorTitle}
                  description={copy.errorDescription}
                  actionLabel={copy.retryButton}
                  onAction={retryRequest}
                />
              </Match>
              <Match when={viewMode() === "empty"}>
                <StateCard
                  title={copy.emptyTitle}
                  description={copy.emptyDescription}
                  actionLabel={copy.retryButton}
                  onAction={retryRequest}
                />
              </Match>
            </Switch>
          </div>
        </Show>

        
      </div>

    <div style="margin-top: 8px">
        <div class="toolbar chart-reference-toolbar">
            <span class="formula-mode-badge">{valuationModeLabel()}</span>
            <Show when={isRefreshing()}>
            <span class="refresh-badge">{copy.refreshingData}</span>
            </Show>
        </div>
      </div>
      
    </section>
  );
};
