// Candle history for a chart state bag: the latest bars refresh every 15s and older history
// is paged in (HISTORY_PAGE bars at a time) whenever the chart reports that its left edge is
// close to the oldest bar we hold. Shared by the main chart and the split-screen chart.

import { useEffect } from "react";
import type { ChartState } from "./Chart";
import { fetchCandleRange, fetchCandles, MARKETS, mergeCandles, TF_INTERVAL_MS, type MarketKey, type Timeframe } from "./feed";

export const HISTORY_PAGE = 500; // candles fetched per "load older" request

export function useCandleHistory(cs: ChartState, market: MarketKey, timeframe: Timeframe) {
  useEffect(() => {
    cs.timeframe = timeframe;
    cs.candles = [];
    cs.historyExhausted = false;
    cs.onNeedHistory = undefined;
    if (timeframe === "Tick") return;
    const tf = timeframe;
    const coin = MARKETS[market].hlCoin;
    const stepMs = TF_INTERVAL_MS[tf];
    let dead = false;
    let loadingOlder = false;
    const refresh = async () => {
      try {
        const latest = await fetchCandles(coin, tf, 240);
        if (!dead) cs.candles = mergeCandles(cs.candles, latest);
      } catch {
        /* retry on next interval */
      }
    };
    cs.onNeedHistory = async (beforeT) => {
      if (loadingOlder || cs.historyExhausted) return;
      loadingOlder = true;
      try {
        const older = await fetchCandleRange(coin, tf, beforeT - HISTORY_PAGE * stepMs, beforeT - 1);
        if (dead) return;
        const fresh = older.filter((c) => c.t < beforeT);
        if (!fresh.length) cs.historyExhausted = true;
        else cs.candles = mergeCandles(fresh, cs.candles);
      } catch {
        /* the chart will ask again */
      } finally {
        loadingOlder = false;
      }
    };
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [cs, timeframe, market]);
}
