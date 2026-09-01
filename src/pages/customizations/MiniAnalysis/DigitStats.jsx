// FILE: src/components/DigitStats.jsx
import React, { useMemo } from 'react';
import '../styles/SignalTool.css';

export default function DigitStats({ ticks }) {
  const distribution = useMemo(() => {
    if (!ticks.length) return [];
    const freq = Array(10).fill(0);
    ticks.slice(-50).forEach(t => {
      const price = parseFloat(t.quote);
      const lastDigit = parseInt(price.toString().split('.').pop().slice(-1), 10);
      freq[lastDigit]++;
    });
    const total = freq.reduce((a, b) => a + b, 0);
    return freq.map((count, digit) => ({
      digit,
      pct: total > 0 ? ((count / total) * 100).toFixed(1) : 0,
    }));
  }, [ticks]);

  return (
    <div className="digit-stats">
      <h4 className="section-subtitle">Last 50 Tick Distribution (%)</h4>
      <div className="distribution">
        {distribution.map(({ digit, pct }) => (
          <div key={digit} className="dist-row">
            <div className="dist-digit">{digit}</div>
            <div className="bar" style={{ width: `${pct}%` }}></div>
            <div className="pct">{pct}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}
