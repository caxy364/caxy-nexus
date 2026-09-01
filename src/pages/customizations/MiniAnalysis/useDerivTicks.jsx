import { useEffect, useRef, useState } from 'react';


// Helper: extract decimal places
function getDecimalPlaces(symbol) {
if (!symbol) return 2;
if (symbol.startsWith('1HZ')) return 2;
if (symbol === 'R_100') return 2;
if (symbol === 'R_75' || symbol === 'R_50') return 4;
if (symbol === 'R_25' || symbol === 'R_10') return 3;
return 2;
}


export default function useDerivTicks({ symbol, appId = 1089, windowSize = 50, demo = false }) {
const [ticks, setTicks] = useState([]);
const [lastTick, setLastTick] = useState(null);
const [status, setStatus] = useState('idle');
const wsRef = useRef(null);
const reconnectRef = useRef({ attempts: 0, timeout: null });


// Mock tick generator for demo mode
useEffect(() => {
if (!demo) return;
setStatus('demo');
const dp = getDecimalPlaces(symbol);
const iv = setInterval(() => {
const base = 100 + Math.random() * 10;
const quote = Number((base + Math.sin(Date.now()/10000) * 0.01).toFixed(dp));
const epoch = Math.floor(Date.now() / 1000);
const lastDigit = Math.floor((quote * Math.pow(10, dp)) % 10);
const t = { epoch, quote, lastDigit };
setLastTick(t);
setTicks(prev => {
const next = prev.concat(t).slice(-windowSize);
return next;
});
}, 250);
return () => clearInterval(iv);
}, [demo, symbol, windowSize]);


// Real WebSocket connection
useEffect(() => {
if (demo) return () => {};
const url = `wss://ws.binaryws.com/websockets/v3?app_id=${appId}`;
let mounted = true;


function connect() {
setStatus('connecting');
const ws = new WebSocket(url);
wsRef.current = ws;


ws.onopen = () => {
reconnectRef.current.attempts = 0;
setStatus('connected');
// request ticks history and subscribe to ticks
const req = { ticks_history: symbol, style: 'ticks', count: windowSize };
ws.send(JSON.stringify(req));
// subscribe
ws.send(JSON.stringify({ ticks: symbol }));
};

ws.onmessage = (evt) => {
try {
const msg = JSON.parse(evt.data);
if (msg.echo_req && msg.echo_req.ticks_history) {
const history = msg.history ? msg.history.prices || msg.history : msg.history;
// msg.history may be an array or object depending on api response; normalize
if (msg.history && Array.isArray(msg.history.prices)) {
const prices = msg.history.prices;
const times = msg.history.times || [];
const dp = getDecimalPlaces(symbol);
const arr = prices.map((p, i) => ({ epoch: times[i] || Math.floor(Date.now()/1000), quote: Number(Number(p).toFixed(dp)) }));
setTicks(arr.slice(-windowSize));
setLastTick(arr[arr.length - 1] || null);
}
}


if (msg.tick) {
const dp = getDecimalPlaces(symbol);
const quote = Number(Number(msg.tick.quote).toFixed(dp));
const epoch = msg.tick.epoch;
const lastDigit = Math.floor((quote * Math.pow(10, dp)) % 10);
const t = { epoch, quote, lastDigit };
setLastTick(t);
setTicks(prev => {
const next = prev.concat(t).slice(-windowSize);
return next;
});
}
} catch (e) {
console.error('ws parse error', e);
}
};

ws.onclose = () => {
setStatus('closed');
if (!mounted) return;
// reconnect with backoff
const attempts = reconnectRef.current.attempts = (reconnectRef.current.attempts || 0) + 1;
const delay = Math.min(30000, 1000 * Math.pow(1.5, attempts));
reconnectRef.current.timeout = setTimeout(connect, delay + Math.random() * 300);
setStatus('reconnecting');
};


ws.onerror = (err) => {
console.error('ws error', err);
ws.close();
};
}


connect();


return () => {
mounted = false;
setStatus('disposed');
if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.close();
if (reconnectRef.current.timeout) clearTimeout(reconnectRef.current.timeout);
};
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [symbol, appId, demo, windowSize]);


const start = () => {
// intentionally keep socket running — start toggles scanning in app
setStatus(s => s === 'connected' ? 'scanning' : s);
};
const stop = () => {
setStatus('stopped');
};


return { ticks, lastTick, status, start, stop };
}