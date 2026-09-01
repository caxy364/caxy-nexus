import React, { useState, useEffect, useRef } from "react";
import "./SignalTool.css";
import { FaPlay, FaStop } from "react-icons/fa";

const APP_ID = 1089;
const WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=" + APP_ID;

// --- Volatility indices for dropdown
const indices = [
  { value: "R_10", label: "Volatility 10" },
  { value: "R_25", label: "Volatility 25" },
  { value: "R_50", label: "Volatility 50" },
  { value: "R_75", label: "Volatility 75" },
  { value: "R_100", label: "Volatility 100" },
  { value: "1HZ10V", label: "Volatility 10 (1s)" },
  { value: "1HZ15V", label: "Volatility 15 (1s)" },
  { value: "1HZ25V", label: "Volatility 25 (1s)" },
  { value: "1HZ30V", label: "Volatility 30 (1s)" },
  { value: "1HZ50V", label: "Volatility 50 (1s)" },
  { value: "1HZ75V", label: "Volatility 75 (1s)" },
  { value: "1HZ90V", label: "Volatility 90 (1s)" },
  { value: "1HZ100V", label: "Volatility 100 (1s)" },
];

// --- Utility to get decimal places
const getDecimalPlaces = (symbol) => {
  if (["1HZ15V", "1HZ30V", "1HZ90V"].includes(symbol)) return 3;
  if (symbol.startsWith("1HZ")) return 2;
  if (symbol === "R_100") return 2;
  if (symbol === "R_75" || symbol === "R_50") return 4;
  if (symbol === "R_25" || symbol === "R_10") return 3;
  return 3;
};

// --- Extract last digit correctly
const extractLastDigit = (price, symbol) => {
  const decimals = getDecimalPlaces(symbol);
  const factor = Math.pow(10, decimals);
  const num = Math.round(price * factor);
  return num % 10;
};

export default function SignalTool({ isRunning, useBulk, handleToggleBot }) {
  const [symbol, setSymbol] = useState("1HZ10V");
  const [ticks, setTicks] = useState([]);
  const [stats, setStats] = useState(null);
  const [isScanning] = useState(false);
  const [tickCount, setTickCount] = useState(100);
  const [currentPrice, setCurrentPrice] = useState(null);
  const [loading, setLoading] = useState(false);

  const ws = useRef(null);
  const fullHistory = useRef([]);

  // --- Calculate distribution ---
  const calculateStats = (tickArr) => {
    if (tickArr.length < 2) return null;

    let countOver = 0,
      countUnder = 0,
      countEven = 0,
      countOdd = 0;
    let countRise = 0,
      countFall = 0,
      countEqual = 0;
    let countMatches = 0,
      countDiffers = 0;
    let digitCounts = Array(10).fill(0);

    for (let i = 1; i < tickArr.length; i++) {
      const curr = tickArr[i];
      const prev = tickArr[i - 1];

      if (curr % 2 === 0) countEven++;
      else countOdd++;

      if (curr > prev) countRise++;
      else if (curr < prev) countFall++;
      else countEqual++;

      if (curr >= 5) countOver++;
      else countUnder++;

      if (curr === prev) countMatches++;
      else countDiffers++;

      digitCounts[curr]++;
    }

    const totalRiseFall = countRise + countFall + countEqual;
    const percent = (val) => (val / (tickArr.length - 1)).toFixed(2);
    const digitPercentages = digitCounts.map((c) =>
      (c / (tickArr.length - 1)).toFixed(2)
    );

    return {
      over: percent(countOver),
      under: percent(countUnder),
      even: percent(countEven),
      odd: percent(countOdd),
      rise: totalRiseFall ? (countRise / totalRiseFall).toFixed(2) : "0",
      fall: totalRiseFall ? (countFall / totalRiseFall).toFixed(2) : "0",
      equal: totalRiseFall ? (countEqual / totalRiseFall).toFixed(2) : "0",
      matches: percent(countMatches),
      differs: percent(countDiffers),
      digits: digitPercentages,
    };
  };

  // --- WebSocket feed ---
  const startFeed = () => {
    if (ws.current) ws.current.close();
    setLoading(true);

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      ws.current.send(
        JSON.stringify({
          ticks_history: symbol,
          count: tickCount,
          end: "latest",
          style: "ticks",
        })
      );
    };

    ws.current.onmessage = (msg) => {
      const data = JSON.parse(msg.data);

      if (data.history?.prices) {
        fullHistory.current = data.history.prices.map((p) =>
          extractLastDigit(Number(p), symbol)
        );
        setTicks(fullHistory.current.slice(-20));
        setStats(calculateStats(fullHistory.current));
        ws.current.send(JSON.stringify({ ticks: symbol }));
        setLoading(false);
      }

      if (data.tick?.quote) {
        const quote = parseFloat(data.tick.quote);
        setCurrentPrice(quote.toFixed(getDecimalPlaces(symbol)));

        const digit = extractLastDigit(quote, symbol);
        fullHistory.current = [
          ...fullHistory.current.slice(-tickCount + 1),
          digit,
        ];

        setTicks(fullHistory.current.slice(-20));
        setStats(calculateStats(fullHistory.current));
      }
    };

    ws.current.onerror = (err) => {
      console.error("WebSocket Error:", err);
      setLoading(false);
    };

    ws.current.onclose = () => console.log("WebSocket closed");
  };

  const stopFeed = () => {
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
  };

  // --- Start feed on mount ---
  useEffect(() => {
    startFeed();
    return () => stopFeed();
  }, []);

  // --- Update feed on symbol/tickCount change ---
  useEffect(() => {
    if (!symbol) return;

    fullHistory.current = [];
    setTicks([]);
    setStats(null);
    setCurrentPrice(null);
    setLoading(true);

    if (ws.current) ws.current.close();
    startFeed();

    return () => stopFeed();
  }, [symbol, tickCount]);

  // --- Signal logic ---
  useEffect(() => {
    if (!isScanning || !stats || fullHistory.current.length < 2) return;
  }, [stats, isScanning]);

 return (
    <div className="deriv-compact-app-scope">
      <div className="dt-shell">
        <div className="dt-accent-line"></div>

        <header className="dt-top-bar">
          <div className="dt-brand-group">
            <div className="dt-logo-icon">D</div>
            <div>
              <h1 className="dt-logo">Market Stats</h1>
              <div className="dt-status-indicator">
                <span className={`dt-dot ${loading ? 'is-loading' : 'is-live'}`}></span>
                {loading ? "SYNCHRONIZING" : "LIVE FEED"}
              </div>
            </div>
          </div>

          <div className="dt-quick-controls">
            <div className="dt-input-stack">
              <label>Market</label>
              <select className="dt-mini-select" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                {indices.map((idx) => (
                  <option key={idx.value} value={idx.value}>{idx.label}</option>
                ))}
              </select>
            </div>
            <div className="dt-input-stack">
              <label>Ticks to Analyze</label>
              <div className="dt-input-row">
                <input
                  className="dt-mini-input"
                  type="number"
                  value={tickCount}
                  onChange={(e) => setTickCount(Number(e.target.value))}
                />
              </div>
            </div>
          </div>
        </header>

        {currentPrice && (
          <div className="dt-price-banner">
            <span className="dt-label">LIVE PRICE</span>
            <strong className="dt-price-val">{currentPrice}</strong>
          </div>
        )}
        
        {loading ? (
          <div className="universal-loader-container">
            <div className="universal-loader"></div>
            <p>Loading stats...</p>
          </div>
        ) : (
          <main className="dt-content-grid">
            <div className="dt-stats-row">
              {stats ? (
                <>
                  <div className="dt-panel dt-flex-3">
                    <div className="dt-panel-header">Digit Distribution</div>
                    <div className="dt-dist-grid">
                      {(() => {
                        // Pre-calculate Min/Max for the current set of digits
                        const digitNums = stats.digits.map(Number);
                        const maxVal = Math.max(...digitNums);
                        const minVal = Math.min(...digitNums);

                        return stats.digits.map((val, idx) => {
                          const isLatest = ticks[ticks.length - 1] === idx;
                          const isMax = Number(val) === maxVal;
                          const isMin = Number(val) === minVal;

                          return (
                            <div 
                              key={idx} 
                              className={`dt-dist-square ${isLatest ? "is-hit" : ""} ${isMax ? "is-highest" : ""} ${isMin ? "is-lowest" : ""}`}
                            >
                              <div className="dt-square-fill" style={{ height: `${val * 100 * 2}%` }}></div>
                              <div className="dt-square-content">
                                <span className="dt-d-num">{idx}</span>
                                <span className="dt-d-pct">{(val * 100).toFixed(0)}%</span>
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>

                  <div className="dt-panel dt-flex-2 border-right">
                    <div className="dt-panel-header">CONTRACT TYPE ANALYSIS</div>
                    <div className="dt-metrics-inline">
                      {Object.entries(stats)
                        .filter(([key]) => key !== "digits")
                        .map(([key, val]) => {
                          const percentage = (val * 100).toFixed(0);
                          const colorClass = percentage > 55 ? 'txt-green' : percentage < 40 ? 'txt-red' : '';
                          return (
                            <div key={key} className="dt-metric-tiny">
                              <span className="dt-label">{key}</span>
                              <span className={`dt-val ${colorClass}`}>{percentage}%</span>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                </>
              ) : (
                <div className="stats-loader-container">
                  <div className="universal-loader"></div>
                  <p>Loading stats...</p>
                </div>
              )}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}