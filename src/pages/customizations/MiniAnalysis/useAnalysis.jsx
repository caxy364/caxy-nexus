import { useMemo, useState } from 'react';


function calcDistribution(ticks) {
const counts = {};
for (let d = 0; d <= 9; d++) counts[d] = 0;
ticks.forEach(t => { if (t.lastDigit !== undefined) counts[t.lastDigit]++; });
const total = Math.max(1, ticks.length);
const dist = {};
for (let d = 0; d <= 9; d++) dist[d] = counts[d] / total;
return dist;
}


export default function useAnalysis({ ticks = [], tradeType = 'over', referenceDigit = 5, windowSize = 50, threshold = 0.6, requireConsensus = false }) {
const [history, setHistory] = useState([]);


const { signal, confidence, reason, distribution } = useMemo(() => {
const tail = ticks.slice(-windowSize);
const distribution = calcDistribution(tail);
const total = Math.max(1, tail.length);

// rise / fall
let riseCount = 0, fallCount = 0;
for (let i = 1; i < tail.length; i++) {
if (tail[i].quote > tail[i-1].quote) riseCount++;
if (tail[i].quote < tail[i-1].quote) fallCount++;
}
const riseProb = tail.length > 1 ? riseCount / (tail.length - 1) : 0;
const fallProb = tail.length > 1 ? fallCount / (tail.length - 1) : 0;


// even / odd
const evenCount = Object.keys(distribution).reduce((acc, d) => acc + (d % 2 === 0 ? distribution[d] : 0), 0);
const oddCount = 1 - evenCount;


// matches / differs / over / under
const ref = Math.min(9, Math.max(0, parseInt(referenceDigit || 0, 10)));
const matchesProb = distribution[ref] || 0;
const differsProb = 1 - matchesProb;


const overCount = Object.keys(distribution).reduce((acc, d) => acc + ((Number(d) > ref ? distribution[d] : 0)), 0);
const underCount = 1 - overCount;



// choose probability for tradeType
let prob = 0;
let textReason = '';
switch (tradeType) {
case 'matches': prob = matchesProb; textReason = `Digit ${ref} occurred ${(matchesProb*100).toFixed(1)}% in last ${tail.length} ticks`; break;
case 'differs': prob = differsProb; textReason = `Digit ${ref} absent ${(differsProb*100).toFixed(1)}% in last ${tail.length} ticks`; break;
case 'even': prob = evenCount; textReason = `Even digits ${(evenCount*100).toFixed(1)}%`; break;
case 'odd': prob = oddCount; textReason = `Odd digits ${(oddCount*100).toFixed(1)}%`; break;
case 'rise': prob = riseProb; textReason = `Rise ticks ${(riseProb*100).toFixed(1)}% over ${Math.max(1, tail.length-1)} comparisons`; break;
case 'fall': prob = fallProb; textReason = `Fall ticks ${(fallProb*100).toFixed(1)}% over ${Math.max(1, tail.length-1)} comparisons`; break;
case 'over': prob = overCount; textReason = `Digits > ${ref} occurred ${(overCount*100).toFixed(1)}%`; break;
case 'under': prob = underCount; textReason = `Digits <= ${ref} occurred ${(underCount*100).toFixed(1)}%`; break;
default: prob = 0; textReason = 'No analysis';
}


// optional consensus: basic example — for matches/differs also require even/odd agreement
let passed = prob >= threshold;
if (requireConsensus && passed) {
// example: require that even/odd majority agrees with matches/differs for > threshold
if (tradeType === 'matches') {
const digitParity = ref % 2 === 0 ? 'even' : 'odd';
const parityProb = digitParity === 'even' ? evenCount : oddCount;
passed = parityProb >= threshold && prob >= threshold;
if (!passed) textReason += `; parity ${digitParity} only ${(parityProb*100).toFixed(1)}%`;
}
}


const signalText = passed ? `Trade ${tradeType.charAt(0).toUpperCase() + tradeType.slice(1)} on selected symbol` : null;


return { signal: signalText, confidence: prob, reason: textReason, distribution };


}, [ticks, tradeType, referenceDigit, windowSize, threshold, requireConsensus]);

// maintain history when a new signal is fired
useMemo(() => {
if (signal && confidence >= threshold) {
setHistory(h => h.concat([{ text: signal + ' — ' + reason, confidence, time: Date.now() }]).slice(-200));
}
}, [signal, confidence, threshold, reason]);


return { signal, confidence, reason, distribution, history };
}