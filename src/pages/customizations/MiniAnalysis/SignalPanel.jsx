// FILE: src/components/SignalPanel.jsx
import React, { useEffect, useState } from 'react';
import '../styles/SignalTool.css';

export default function SignalPanel({ analysis }) {
  const [activeSignal, setActiveSignal] = useState(null);

  useEffect(() => {
    if (analysis.signal) {
      setActiveSignal(analysis.signal);

      const timer = setTimeout(() => {
        setActiveSignal(null);
      }, 60000); // persist for 1 minute

      return () => clearTimeout(timer);
    }
  }, [analysis.signal]);

  return (
    <div className="signal-panel">
      <div className="sp-header">
        <h3 className="section-title">Signal</h3>
      </div>

      <div className="sp-body">
        {analysis.loading ? (
          <p className="loader-text">🔍 Scanning market data...</p>
        ) : activeSignal ? (
          <>
            <div className="sp-main">{activeSignal.message}</div>
            <div className="sp-confidence">
              Confidence: {(activeSignal.confidence * 100).toFixed(1)}%
            </div>
            <div className="sp-reason">{activeSignal.reason}</div>
          </>
        ) : (
          <p className="sp-none">No active signal</p>
        )}
      </div>
    </div>
  );
}
