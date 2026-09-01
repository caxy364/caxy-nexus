import React from 'react';


export default function HistoryLog({ history }) {
return (
<div className="history">
<h3>Signal History</h3>
<ul>
{history.slice().reverse().map((h, i) => (
<li key={i} className={`history-item ${h.result || ''}`}>
<div className="time">{new Date(h.time).toLocaleTimeString()}</div>
<div className="msg">{h.text}</div>
<div className="conf">{Math.round(h.confidence * 1000) / 10}%</div>
</li>
))}
</ul>
</div>
);
}