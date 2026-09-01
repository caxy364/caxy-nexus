// FILE: src/components/LiveStream.jsx
import React from 'react';
import '../styles/SignalTool.css';
import DigitStats from './DigitStats';

export default function LiveStream({ ticks }) {
  const last20Digits = ticks.slice(-20).map(t => {
    const price = parseFloat(t.quote);
    const lastDigit = price.toString().split('.').pop().slice(-1);
    return lastDigit;
  });

  return (
    <div className="live-stream">
      <h3 className="section-title">Live Last Digits</h3>

      <div className="digit-strip">
        {last20Digits.length > 0 ? (
          last20Digits.map((digit, idx) => (
            <div key={idx} className="digit-tile">
              {digit}
            </div>
          ))
        ) : (
          <div className="muted">Waiting for ticks...</div>
        )}
      </div>

      {/* Distribution below live ticks */}
      <DigitStats ticks={ticks} />
    </div>
  );
}
