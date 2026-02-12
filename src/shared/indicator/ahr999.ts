import type { UTCTimestamp } from "lightweight-charts";
import type { CandlePoint } from "../api/binance";

export interface AhrPoint {
  time: UTCTimestamp;
  value: number;
}

interface PowerLawModel {
  slope: number;
  intercept: number;
}

const BITCOIN_GENESIS_UTC_MS = Date.UTC(2009, 0, 3, 0, 0, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPECTED_VALUE_SLOPE = 5.84;
const EXPECTED_VALUE_INTERCEPT = 17.01;

const getBitcoinAgeDays = (time: UTCTimestamp): number => {
  const timestampMs = Number(time) * 1000;
  const elapsedDays = Math.floor((timestampMs - BITCOIN_GENESIS_UTC_MS) / DAY_MS);
  return Math.max(1, elapsedDays + 1);
};

const getExpectedValuation = (bitcoinAgeDays: number): number => {
  const valuation = 10 ** (EXPECTED_VALUE_SLOPE * Math.log10(bitcoinAgeDays) - EXPECTED_VALUE_INTERCEPT);
  return Number.isFinite(valuation) && valuation > 0 ? valuation : 0;
};

const isBitcoinAsset = (asset: string): boolean => asset.trim().toUpperCase() === "BTC";

const fitPricePowerLawModel = (candles: CandlePoint[]): PowerLawModel | null => {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const close = candles[index].close;
    if (!Number.isFinite(close) || close <= 0) {
      continue;
    }

    const listingAgeDays = index + 1;
    const x = Math.log10(listingAgeDays);
    const y = Math.log10(close);

    count += 1;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }

  if (count < 2) {
    return null;
  }

  const denominator = count * sumXX - sumX * sumX;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
    return null;
  }

  const slope = (count * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / count;

  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    return null;
  }

  return { slope, intercept };
};

const getPowerLawExpectedValuation = (listingAgeDays: number, model: PowerLawModel | null): number => {
  if (!model || listingAgeDays < 1) {
    return 0;
  }

  const valuation = 10 ** (model.slope * Math.log10(listingAgeDays) + model.intercept);
  return Number.isFinite(valuation) && valuation > 0 ? valuation : 0;
};

export const calculateAhr999 = (candles: CandlePoint[], lookback = 200, asset = "BTC"): AhrPoint[] => {
  if (candles.length === 0) {
    return [];
  }

  const useBitcoinExpectedValuation = isBitcoinAsset(asset);
  const powerLawModel = useBitcoinExpectedValuation ? null : fitPricePowerLawModel(candles);

  let rollingSum = 0;
  const points: AhrPoint[] = [];

  for (let index = 0; index < candles.length; index += 1) {
    const current = candles[index];
    rollingSum += current.close;

    if (index >= lookback) {
      rollingSum -= candles[index - lookback].close;
    }

    const windowSize = Math.min(index + 1, lookback);
    const movingAverage = rollingSum / windowSize;
    const expectedValuation = useBitcoinExpectedValuation
      ? getExpectedValuation(getBitcoinAgeDays(current.time))
      : getPowerLawExpectedValuation(index + 1, powerLawModel) || current.close;
    const priceToDcaRatio = movingAverage > 0 ? current.close / movingAverage : 0;
    const priceToExpectedRatio = expectedValuation > 0 ? current.close / expectedValuation : 0;
    const rawValue = priceToDcaRatio * priceToExpectedRatio;
    const value = Number.isFinite(rawValue) ? rawValue : 0;

    points.push({
      time: current.time,
      value
    });
  }

  return points;
};
