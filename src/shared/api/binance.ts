import type { UTCTimestamp } from "lightweight-charts";

const BINANCE_BASE_URL = "https://api.binance.com";

export interface TradingPairOption {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

export interface CandlePoint {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface FetchKlineOptions {
  interval?: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
  signal?: AbortSignal;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

export const fetchTradingPairs = async (signal?: AbortSignal): Promise<TradingPairOption[]> => {
  const response = await fetch(`${BINANCE_BASE_URL}/api/v3/exchangeInfo`, {
    method: "GET",
    signal,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`ExchangeInfo request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.symbols)) {
    throw new Error("ExchangeInfo payload shape is invalid");
  }

  const symbols = payload.symbols
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => item.status === "TRADING" && item.quoteAsset === "USDT")
    .map((item) => {
      const symbol = typeof item.symbol === "string" ? item.symbol : "";
      const baseAsset = typeof item.baseAsset === "string" ? item.baseAsset : "";
      const quoteAsset = typeof item.quoteAsset === "string" ? item.quoteAsset : "";
      return { symbol, baseAsset, quoteAsset };
    })
    .filter((item) => item.symbol.length > 0)
    .sort((a, b) => a.symbol.localeCompare(b.symbol, "en"));

  return symbols;
};

export const fetchKlines = async (
  symbol: string,
  options: FetchKlineOptions = {}
): Promise<CandlePoint[]> => {
  const { interval = "1d", limit = 500, startTime, endTime, signal } = options;
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit)
  });

  if (typeof startTime === "number" && Number.isFinite(startTime)) {
    params.set("startTime", String(Math.floor(startTime)));
  }

  if (typeof endTime === "number" && Number.isFinite(endTime)) {
    params.set("endTime", String(Math.floor(endTime)));
  }

  const response = await fetch(`${BINANCE_BASE_URL}/api/v3/klines?${params.toString()}`, {
    method: "GET",
    signal,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Klines request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Klines payload shape is invalid");
  }

  const points: CandlePoint[] = [];

  for (const row of payload) {
    if (!Array.isArray(row) || row.length < 6) {
      continue;
    }

    const openTime = asNumber(row[0]);
    const open = asNumber(row[1]);
    const high = asNumber(row[2]);
    const low = asNumber(row[3]);
    const close = asNumber(row[4]);
    const volume = asNumber(row[5]);

    if (
      openTime === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      volume === null
    ) {
      continue;
    }

    points.push({
      time: Math.floor(openTime / 1000) as UTCTimestamp,
      open,
      high,
      low,
      close,
      volume
    });
  }

  return points;
};
