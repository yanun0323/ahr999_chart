import type { UTCTimestamp } from "lightweight-charts";
import type { CandlePoint } from "../api/binance";

export interface AhrPoint {
  time: UTCTimestamp;
  value: number;
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

export const calculateAhr999 = (candles: CandlePoint[], lookback = 200): AhrPoint[] => {
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
    const movingAverage = rollingSum / windowSize;
    const bitcoinAgeDays = getBitcoinAgeDays(current.time);
    const expectedValuation = getExpectedValuation(bitcoinAgeDays);
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
