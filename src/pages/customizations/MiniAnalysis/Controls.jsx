// components/Controls.jsx
import React from 'react';

export default function Controls({
  selectedSymbol,
  setSelectedSymbol,
  tradeType,
  setTradeType,
  windowSize,
  setWindowSize,
  isScanning,
  setIsScanning,
  status,
}) {
  const handleStartStop = () => setIsScanning(!isScanning);

  return (
    <div className="controls">
      <h2>Controls</h2>

      {/* Volatility Dropdown */}
      <label>
        Volatility Index:
        <select
          value={selectedSymbol}
          onChange={(e) => setSelectedSymbol(e.target.value)}
        >
          <option value="1HZ10V">Volatility 10 1s</option>
          <option value="1HZ25V">Volatility 25 1s</option>
          <option value="1HZ50V">Volatility 50 1s</option>
          <option value="1HZ75V">Volatility 75 1s</option>
          <option value="1HZ100V">Volatility 100 1s</option>
          <option value="R_10">Volatility 10</option>
          <option value="R_25">Volatility 25</option>
          <option value="R_50">Volatility 50</option>
          <option value="R_75">Volatility 75</option>
          <option value="R_100">Volatility 100</option>
        </select>
      </label>

      {/* Trade Type Dropdown */}
      <label>
        Trade Type:
        <select
          value={tradeType}
          onChange={(e) => setTradeType(e.target.value)}
        >
          <option value="matches">Matches</option>
          <option value="differs">Differs</option>
          <option value="rise">Rise</option>
          <option value="fall">Fall</option>
          <option value="even">Even</option>
          <option value="odd">Odd</option>
          <option value="over">Over</option>
          <option value="under">Under</option>
        </select>
      </label>

      {/* Ticks Input */}
      <label>
        Ticks to Analyze:
        <input
          type="number"
          value={windowSize}
          min="10"
          max="200"
          onChange={(e) => setWindowSize(parseInt(e.target.value, 10))}
        />
      </label>

      {/* Start/Stop Button */}
      <button onClick={handleStartStop} className={isScanning ? 'stop' : 'scan'}>
        {isScanning ? 'Stop Scan' : 'Start Scan'}
      </button>

      {/* Connection Status */}
      <div className={`status ${status}`}>Status: {status}</div>
    </div>
  );
}
