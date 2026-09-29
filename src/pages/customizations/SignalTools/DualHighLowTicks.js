import React, { useCallback, useEffect, useRef, useState } from 'react';
import Swal from 'sweetalert2';
import { FaPlay, FaStop } from 'react-icons/fa';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import './DualHighLowTicks.css';

const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');
const SYMBOL_OPTIONS = ['1HZ10V', 'R_10', '1HZ25V', 'R_25', '1HZ50V', 'R_50', '1HZ75V', 'R_75', '1HZ100V', 'R_100'];
const TICK_DURATION = 5;

// --- MATHEMATICAL SIGNAL ENGINE ---
class AutonomousSignalEngine {
    constructor(volatilityThreshold, momentumThreshold) {
        this.volatilityThreshold = volatilityThreshold;
        this.momentumThreshold = momentumThreshold;
    }

    analyze(prices) {
        if (prices.length < 20) return { phase: 'WAIT', tick: null, confidence: 0 };

        const volatility = this.calculateVolatility(prices);
        const momentum = this.calculateMomentum(prices);
        const rsi = this.calculateRSI(prices, 14);

        // PHASE 1: TREND/BREAKOUT (Targeting Tick 1 or 5)
        // High momentum + Volatility spike = Trend continuation
        if (Math.abs(momentum) > this.momentumThreshold * 1.5 && volatility > this.volatilityThreshold) {
            return { phase: 'BREAKOUT', tick: momentum > 0 ? 1 : 5, confidence: 0.8 };
        }

        // PHASE 2: REVERSAL/EXHAUSTION (Targeting Tick 3)
        // RSI Extreme + Momentum slowing down = Price Peak/Trough
        if (rsi > 70 || rsi < 30) {
            if (Math.abs(momentum) < this.momentumThreshold) {
                return { phase: 'REVERSAL', tick: 3, confidence: 0.75 };
            }
        }

        // PHASE 3: IMPULSE/ACCELERATION (Targeting Tick 2 or 4)
        // Rapid volatility expansion without extreme RSI
        if (volatility > this.volatilityThreshold * 1.8) {
            return { phase: 'IMPULSE', tick: 2, confidence: 0.65 };
        }

        return { phase: 'WAIT', tick: null, confidence: 0 };
    }

    calculateVolatility(prices) {
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        return Math.sqrt(prices.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / prices.length);
    }

    calculateMomentum(prices) {
        return prices[prices.length - 1] - prices[prices.length - 2];
    }

    calculateRSI(prices, period) {
        const changes = [];
        for (let i = 1; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
        const gains = changes.filter(c => c > 0).reduce((a, b) => a + b, 0);
        const losses = Math.abs(changes.filter(c => c < 0).reduce((a, b) => a + b, 0));
        if (losses === 0) return 50;
        const rs = gains / losses;
        return 100 - (100 / (1 + rs));
    }
}

// --- COMPONENT START ---

const DualHighLowTicksComponent = () => {
    const store = useStore() || {};
    const { transactions, journal, summary_card, run_panel, client } = store;

    const [isRunning, setIsRunning] = useState(false);
    const [selectedSymbol, setSelectedSymbol] = useState('R_50');
    const [stake, setStake] = useState('1');
    const [targetProfit, setTargetProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [martingaleMode, setMartingaleMode] = useState('net');
    const [mFactor, setMFactor] = useState('2.1');
    const [error, setError] = useState('');
    const [lastTickQuote, setLastTickQuote] = useState('-');
    const [detectedPhase, setDetectedPhase] = useState('WAIT');

    const wsRef = useRef(null);
    const isRunningRef = useRef(false);
    const isAuthorizedRef = useRef(false);
    const isConnectingRef = useRef(false);
    const shouldReconnectRef = useRef(true);
    const skipReconnectRef = useRef(false);
    const reconnectTimeoutRef = useRef(null);
    const isProcessingRef = useRef(false);
    const totalProfitRef = useRef(0);
    const activeContractsRef = useRef(new Set());
    const completedContractsRef = useRef(new Set());
    const contractMetaRef = useRef({});
    const pendingTradeContextsRef = useRef([]);
    const pendingProposalContextsRef = useRef(new Map());
    const nextStakeRef = useRef({ TICKHIGH: 1, TICKLOW: 1 });
    const transactionRecoveryTimeoutsRef = useRef(new Map());
    
    // NEW: Price Buffer and Signal Engine
    const priceBufferRef = useRef([]);
    const signalEngineRef = useRef(new AutonomousSignalEngine(0.00005, 0.0001));

    // ... (Keep existing publishNativeContract, publishNativeError, publishNativeResult, stopTradingBot, getAuthenticatedUrl)
    // [Omitted for brevity in this view, but must be kept in your code]

    const executeTradePair = useCallback((autoTick) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const tickSelected = autoTick; // Use the tick provided by the signal
        const highStake = Number((nextStakeRef.current.TICKHIGH || 1).toFixed(2));
        const lowStake = Number((nextStakeRef.current.TICKLOW || 1).toFixed(2));
        const groupId = `auto-hedge-${selectedSymbol}-${Date.now()}`;

        const common = {
            proposal: 1,
            basis: 'stake',
            currency: client?.currency || 'USD',
            underlying_symbol: selectedSymbol,
            duration: TICK_DURATION,
            duration_unit: 't',
            selected_tick: tickSelected,
        };

        // Send TICKHIGH Leg
        wsRef.current.send(JSON.stringify({
            ...common,
            amount: highStake,
            contract_type: 'TICKHIGH',
            passthrough: {
                symbol: selectedSymbol,
                custom_type: 'TICKHIGH',
                sent_stake: highStake,
                selected_tick: tickSelected,
                group_id: groupId,
            },
        }));

        // Send TICKLOW Leg
        wsRef.current.send(JSON.stringify({
            ...common,
            amount: lowStake,
            contract_type: 'TICKLOW',
            passthrough: {
                symbol: selectedSymbol,
                custom_type: 'TICKLOW',
                sent_stake: lowStake,
                selected_tick: tickSelected,
                group_id: groupId,
            },
        }));
    }, [client?.currency, selectedSymbol]);

    // ... (Keep existing handleProposal, handleBuy, handleContractCompletion)
    // [Omitted for brevity, ensure they remain to handle the API response]

    const handleSocketMessage = useCallback((event) => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }

        if (data.error) {
            // ... (Existing error handling)
            return;
        }

        if (data.msg_type === 'tick') {
            const quote = Number(data.tick?.quote);
            if (Number.isFinite(quote)) {
                setLastTickQuote(quote.toString());
                
                // 1. Update Price Buffer
                priceBufferRef.current.push(quote);
                if (priceBufferRef.current.length > 30) priceBufferRef.current.shift();

                // 2. Check if we are allowed to trade
                if (!isRunningRef.current || activeContractsRef.current.size > 0 || isProcessingRef.current) return;

                // 3. Analyze Signal (The "Brain" Step)
                const signal = signalEngineRef.current.analyze(priceBufferRef.current);
                
                if (signal.phase !== 'WAIT') {
                    setDetectedPhase(signal.phase); // Update UI
                    isProcessingRef.current = true;
                    
                    // 4. Execute based on the AUTO-SELECTED tick
                    executeTradePair(signal.tick);
                } else {
                    setDetectedPhase('SCANNING');
                }
                return;
            }
        }

        // ... (Keep existing msg_type handlers: proposal, buy, transaction, proposal_open_contract)
        // [Crucial: ensure handleContractCompletion is called to reset isProcessingRef]
    }, [client?.currency, executeTradePair]);

    // ... (Keep existing connectTradingSocket, startBot, useEffects)
    // [Omitted for brevity, ensure they remain for connectivity and lifecycle]

    return (
        <div className='dhl-tool'>
            <header>
                <h1>Autonomous Dual Hedge</h1>
                <p>AI-driven volatility straddle. Automatically detects Trend, Impulse, or Reversal phases.</p>
            </header>

            <div className='dhl-settings'>
                <label>
                    Volatility Market
                    <select value={selectedSymbol} onChange={(e) => setSelectedSymbol(e.target.value)} disabled={isRunning}>
                        {SYMBOL_OPTIONS.map((symbol) => (
                            <option key={symbol} value={symbol}>{formatSymbolDisplay(symbol)}</option>
                        ))}
                    </select>
                </label>

                <label>
                    Mode
                    <select value={martingaleMode} onChange={(e) => setMartingaleMode(e.target.value)} disabled={isRunning}>
                        <option value='net'>When BOTH lose</option>
                        <option value='split'>On every loss</option>
                    </select>
                </label>

                <label>
                    Stake (USD)
                    <input type='number' step='0.01' value={stake} onChange={(e) => setStake(e.target.value)} disabled={isRunning} />
                </label>

                <label>
                    Target Profit
                    <input type='number' value={targetProfit} onChange={(e) => setTargetProfit(e.target.value)} disabled={isRunning} />
                </label>

                <label>
                    Stop Loss
                    <input type='number' value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} disabled={isRunning} />
                </label>

                <label>
                    Multiplier
                    <input type='number' step='0.1' value={mFactor} onChange={(e) => setMFactor(e.target.value)} disabled={isRunning} />
                </label>
            </div >

            <button type='button' className={isRunning ? 'stop' : ''} onClick={startBot}>
                {isRunning ? <FaStop /> : <FaPlay />} {isRunning ? ' STOP BOT' : ' START AUTONOMOUS BOT'}
            </button>

            <div className='dhl-live-box'>
                <div>
                    <span>Market Status</span>
                    <strong style={{ color: isRunning ? '#4caf50' : '#f44336' }}>{isRunning ? 'RUNNING' : 'IDLE'}</strong>
                </div >
                <div>
                    <span>Detected Phase</span>
                    <strong style={{ color: '#ff9800' }}>{detectedPhase}</strong>
                </div >
                <div>
                    <span>Last Quote</span>
                    <strong>{lastTickQuote}</strong>
                </div >
                <div>
                    <span>Total P/L</span>
                    <strong className={totalProfitRef.current >= 0 ? 'profit' : 'loss'}>
                        {totalProfitRef.current.toFixed(2)} USD
                    </strong>
                </div >
            </div >

            {error && <p className='dhl-error'>{error}</p>}
        </div >
    );
};

export default DualHighLowTicksComponent;
