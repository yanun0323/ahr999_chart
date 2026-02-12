import {
    CandlestickSeries,
    ColorType,
    CrosshairMode,
    LineSeries,
    LineStyle,
    createChart
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
import { SearchableComboboxField } from "../../components/ui/SearchableComboboxField";
import { StateCard } from "../../components/ui/StateCard";
import { fetchKlines, fetchTradingPairs, type CandlePoint, type TradingPairOption } from "../../shared/api/binance";
import { copy } from "../../shared/copy";
import { calculateAhr999, type AhrPoint } from "../../shared/indicator/ahr999";
import { formatPrice, formatRatio } from "../../shared/utils/formatters";

type ViewMode = "loadingPairs" | "loadingData" | "error" | "empty" | "chart";
interface LogicalRangeLike {
  from: number;
  to: number;
}

interface HoverChip {
  text: string;
  top: number;
}

type KlineInterval = "1h" | "4h" | "1d" | "1w" | "1M";

const isAbortError = (error: unknown): boolean => {
  return error instanceof DOMException && error.name === "AbortError";
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const FIXED_INTERVAL: KlineInterval = "1d";
const KLINE_BATCH_SIZE = 500;
const LOAD_MORE_THRESHOLD = 35;
const LIVE_REFRESH_LIMIT = 10;
const LIVE_REFRESH_INTERVAL_MS = 1000;

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

export const CryptoCandleAhrChart = () => {
  const [pairs, setPairs] = createSignal<TradingPairOption[]>([]);
  const [selectedSymbol, setSelectedSymbol] = createSignal("");
  const [candles, setCandles] = createSignal<CandlePoint[]>([]);
  const [ahrPoints, setAhrPoints] = createSignal<AhrPoint[]>([]);
  const [isPairsLoading, setIsPairsLoading] = createSignal(true);
  const [isDataLoading, setIsDataLoading] = createSignal(true);
  const [isRefreshing, setIsRefreshing] = createSignal(false);
  const [isLoadingMore, setIsLoadingMore] = createSignal(false);
  const [errorKind, setErrorKind] = createSignal<"error" | "empty" | null>(null);
  const [hoverPriceChip, setHoverPriceChip] = createSignal<HoverChip | null>(null);
  const [hoverAhrChip, setHoverAhrChip] = createSignal<HoverChip | null>(null);

  const pairOptions = createMemo(() =>
    pairs().map((pair) => ({
      value: pair.symbol,
      label: pair.symbol
    }))
  );
  const latestClose = createMemo(() => candles().at(-1)?.close ?? null);
  const latestAhr = createMemo(() => ahrPoints().at(-1)?.value ?? null);
  const hasChartData = createMemo(() => candles().length > 0 && ahrPoints().length > 0);
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
  let candleSeries: any = null;
  let ahrSeries: any = null;
  let currentPriceLine: any = null;
  let currentAhrLine: any = null;
  let bottomLine: any = null;
  let dcaLine: any = null;
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

  const onResize = () => applyPaneHeights();

  const clearHover = () => {
    setHoverPriceChip(null);
    setHoverAhrChip(null);
  };

  const applyPaneHeights = () => {
    if (!chartApi || !chartHostRef) {
      return;
    }

    const panes = chartApi.panes();
    if (panes.length < 2) {
      return;
    }

    const hostHeight = chartHostRef.clientHeight;
    const upperHeight = Math.max(260, Math.round(hostHeight * 0.68));
    const lowerHeight = Math.max(150, Math.round(hostHeight * 0.32));

    panes[0].setHeight(upperHeight);
    panes[1].setHeight(lowerHeight);
  };

  const removeLine = (series: any, line: any): null => {
    if (series && line) {
      series.removePriceLine(line);
    }

    return null;
  };

  const clearReferenceLines = () => {
    currentPriceLine = removeLine(candleSeries, currentPriceLine);
    currentAhrLine = removeLine(ahrSeries, currentAhrLine);
    bottomLine = removeLine(ahrSeries, bottomLine);
    dcaLine = removeLine(ahrSeries, dcaLine);
  };

  const updateReferenceLines = () => {
    if (!candleSeries || !ahrSeries) {
      return;
    }

    clearReferenceLines();

    const lastCandle = candles().at(-1);
    const lastAhr = ahrPoints().at(-1);

    if (lastCandle) {
      currentPriceLine = candleSeries.createPriceLine({
        price: lastCandle.close,
        color: "rgba(248, 113, 113, 0.88)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: copy.currentPriceLine
      });
    }

    if (lastAhr) {
      currentAhrLine = ahrSeries.createPriceLine({
        price: lastAhr.value,
        color: "rgba(251, 191, 36, 0.95)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: copy.currentAhrLine
      });
    }

    bottomLine = ahrSeries.createPriceLine({
      price: 0.45,
      color: "rgba(56, 189, 248, 0.9)",
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: copy.ahrBottomLine
    });

    dcaLine = ahrSeries.createPriceLine({
      price: 1.2,
      color: "rgba(163, 230, 53, 0.9)",
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: copy.ahrDcaLine
    });
  };

  const renderChartData = () => {
    if (!candleSeries || !ahrSeries || !chartApi) {
      return;
    }

    const candlePoints = candles();
    const indicatorPoints = ahrPoints();

    if (candlePoints.length === 0 || indicatorPoints.length === 0) {
      candleSeries.setData([]);
      ahrSeries.setData([]);
      clearReferenceLines();
      clearHover();
      return;
    }

    candleSeries.setData(
      candlePoints.map((point) => ({
        time: point.time,
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close
      }))
    );

    ahrSeries.setData(
      indicatorPoints.map((point) => ({
        time: point.time,
        value: point.value
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

    applyPaneHeights();
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
          color: "rgba(10, 20, 30, 0.9)"
        },
        textColor: "rgba(235, 244, 251, 0.9)",
        fontFamily: "\"Avenir Next\", \"Trebuchet MS\", \"Segoe UI\", sans-serif"
      },
      grid: {
        vertLines: {
          color: "rgba(106, 125, 147, 0.16)"
        },
        horzLines: {
          color: "rgba(106, 125, 147, 0.2)"
        }
      },
      rightPriceScale: {
        borderVisible: false
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        rightOffset: 8
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(148, 163, 184, 0.52)",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "rgba(30, 41, 59, 0.92)"
        },
        horzLine: {
          color: "rgba(148, 163, 184, 0.52)",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "rgba(30, 41, 59, 0.92)"
        }
      }
    });

    candleSeries = chartApi.addSeries(
      CandlestickSeries,
      {
        upColor: "#2dd4bf",
        downColor: "#f87171",
        borderVisible: false,
        wickUpColor: "#2dd4bf",
        wickDownColor: "#f87171",
        priceLineVisible: false,
        lastValueVisible: true
      },
      0
    );

    ahrSeries = chartApi.addSeries(
      LineSeries,
      {
        color: "#fbbf24",
        lineWidth: 2,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 3,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: {
          type: "price",
          precision: 3,
          minMove: 0.001
        }
      },
      1
    );

    ahrSeries.applyOptions({
      autoscaleInfoProvider: () => ({
        priceRange: {
          minValue: 0,
          maxValue: 2
        }
      })
    } as any);

    chartApi.subscribeCrosshairMove((param) => {
      if (!chartHostRef || !candleSeries || !ahrSeries) {
        clearHover();
        return;
      }

      if (!param.point || param.point.x < 0 || param.point.y < 0) {
        clearHover();
        return;
      }

      const candleData = param.seriesData.get(candleSeries) as
        | { open: number; high: number; low: number; close: number }
        | undefined;
      const ahrData = param.seriesData.get(ahrSeries) as { value: number } | undefined;

      if (!candleData || !ahrData) {
        clearHover();
        return;
      }

      const chartHeight = chartHostRef.clientHeight;
      const candleCoordinate = candleSeries.priceToCoordinate(candleData.close);
      const ahrCoordinate = ahrSeries.priceToCoordinate(ahrData.value);

      if (candleCoordinate !== null) {
        setHoverPriceChip({
          top: clamp(candleCoordinate - 14, 6, chartHeight - 30),
          text: `${copy.metricOpen} ${formatPrice(candleData.open)} · ${copy.metricHigh} ${formatPrice(candleData.high)} · ${copy.metricLow} ${formatPrice(candleData.low)} · ${copy.metricClose} ${formatPrice(candleData.close)}`
        });
      } else {
        setHoverPriceChip(null);
      }

      if (ahrCoordinate !== null) {
        setHoverAhrChip({
          top: clamp(ahrCoordinate - 14, 6, chartHeight - 30),
          text: `${copy.hoverAhrLabel} ${formatRatio(ahrData.value)}`
        });
      } else {
        setHoverAhrChip(null);
      }
    });

    logicalRangeHandler = (range) => {
      if (!range || !candleSeries || isDataLoading() || isLoadingMore() || !hasMoreHistory) {
        return;
      }

      const barsInfo = candleSeries.barsInLogicalRange(range as any);
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

    applyPaneHeights();
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

      if (result.length === 0) {
        setSelectedSymbol("");
        setErrorKind("empty");
        return;
      }

      const current = selectedSymbol();
      const keptSymbol = result.some((item) => item.symbol === current) ? current : "";
      const defaultSymbol = result.find((item) => item.symbol === "BTCUSDT")?.symbol ?? result[0].symbol;
      setSelectedSymbol(keptSymbol || defaultSymbol);
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
      const candlePoints = await fetchKlines(symbol, {
        interval,
        limit: KLINE_BATCH_SIZE,
        signal: controller.signal
      });

      if (nextRequestId !== requestCounter) {
        return;
      }

      if (candlePoints.length === 0) {
        setCandles([]);
        setAhrPoints([]);
        setErrorKind("empty");
        hasMoreHistory = false;
        return;
      }

      const indicator = calculateAhr999(candlePoints);
      if (indicator.length === 0) {
        setCandles([]);
        setAhrPoints([]);
        setErrorKind("empty");
        hasMoreHistory = false;
        return;
      }

      setCandles(candlePoints);
      setAhrPoints(indicator);
      setErrorKind(null);
      hasMoreHistory = candlePoints.length >= KLINE_BATCH_SIZE;
    } catch (error) {
      if (!isAbortError(error)) {
        setCandles([]);
        setAhrPoints([]);
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
      setAhrPoints(calculateAhr999(mergedCandles));
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
      setAhrPoints(calculateAhr999(mergedCandles));
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

  createEffect(() => {
    const symbol = selectedSymbol();
    if (!symbol || isPairsLoading()) {
      return;
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
    renderChartData();
  });

  onCleanup(() => {
    pairRequestController?.abort();
    dataRequestController?.abort();
    liveRequestController?.abort();
    clearReferenceLines();
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
    <section class="dashboard-card">
      <header class="dashboard-header">
        <div class="headline">
          <h1>{copy.appTitle}</h1>
        </div>
        <div class="formula-badge">{copy.ahrFormulaNotice}</div>
      </header>

      <div class="toolbar">
        <SearchableComboboxField
          label={copy.symbolLabel}
          options={pairOptions()}
          value={selectedSymbol()}
          disabled={isPairsLoading() || pairs().length === 0}
          placeholder={copy.symbolSearchPlaceholder}
          triggerAriaLabel={copy.openSymbolSelector}
          onChange={(value) => setSelectedSymbol(value)}
        />
        <span class="history-hint">{copy.fixedIntervalLabel}</span>
        <Show when={isRefreshing()}>
          <span class="refresh-badge">{copy.refreshingData}</span>
        </Show>
      </div>

      <div class="metric-ribbon">
        <article>
          <h3>{copy.latestClose}</h3>
          <p>{latestClose() === null ? "--" : formatPrice(latestClose()!)}</p>
        </article>
        <article>
          <h3>{copy.latestAhr}</h3>
          <p>{latestAhr() === null ? "--" : formatRatio(latestAhr()!)}</p>
        </article>
      </div>

      <div class="chart-shell">
        <div
          class="chart-host"
          ref={(element) => {
            chartHostRef = element;
            initializeChart();
          }}
        />

        <Show when={hoverPriceChip()}>
          {(chip) => (
            <div class="floating-chip floating-chip-price" style={{ top: `${chip().top}px` }}>
              {chip().text}
            </div>
          )}
        </Show>

        <Show when={hoverAhrChip()}>
          {(chip) => (
            <div class="floating-chip floating-chip-ahr" style={{ top: `${chip().top}px` }}>
              {chip().text}
            </div>
          )}
        </Show>

        <Show when={viewMode() !== "chart"}>
          <div class="chart-overlay">
            <Switch>
              <Match when={viewMode() === "loadingPairs"}>
                <StateCard
                  title={copy.loadingPairsTitle}
                  description={copy.loadingPairsDescription}
                  actionLabel={copy.retryButton}
                  onAction={retryRequest}
                />
              </Match>
              <Match when={viewMode() === "loadingData"}>
                <StateCard title={copy.loadingDataTitle} description={copy.loadingDataDescription} />
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
    </section>
  );
};
