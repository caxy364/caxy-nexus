
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaPlay, FaStop } from 'react-icons/fa';
import Swal from 'sweetalert2';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { contract_stages } from '@/constants/contract-stage';
import { observer } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import './DualHighLowTicks.css';

const SYMBOL_OPTIONS = [
    '1HZ10V', 'R_10',
    '1HZ25V', 'R_25',
    '1HZ50V', 'R_50',
    '1HZ75V', 'R_75',
    '1HZ100V', 'R_100',
];

const formatSymbolDisplay = (symbol) => {
    if (!symbol) return '';
    if (symbol.startsWith('1HZ')) {
        return `${symbol.replace('1HZ', '').replace('V', '')}(1s)`;
    }
    if (symbol.startsWith('R_')) {
        return `V${symbol.replace('R_', '')}`;
    }
    return symbol;
};

const DualHighLowTicks = () => {
    const store = useStore();
    const { transactions, journal, summary_card, run_panel } = store || {};

    // Settings
    const [isRunning, setIsRunning] = useState(false);
    const [selectedSymbol, setSelectedSymbol] = useState('R_10');
    const [duration, setDuration] = useState('5');
    const [stake, setStake] = useState('1');
    const [targetProfit, setTargetProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [martingaleMode, setMartingaleMode] = useState('net');
    const [mFactor, setMFactor] = useState('2.1');

    // Simulation display
    const [lastTickQuote, setLastTickQuote] = useState('-');
    const [entryQuote, setEntryQuote] = useState('-');
    const [tickCount, setTickCount] = useState(0);
    const [totalProfit, setTotalProfit] = useState(0);
    const [tradeCount, setTradeCount] = useState(0);
    const [status, setStatus] = useState('Stopped');
    const [error, setError] = useState('');
    const [history, setHistory] = useState([]);

    const intervalRef = useRef(null);
    const isRunningRef = useRef(false);
    const tickCountRef = useRef(0);
    const entryQuoteRef = useRef(null);
    const currentQuoteRef = useRef(1000);
    const totalProfitRef = useRef(0);
    const nextStakeRef = useRef({ HIGH: 1, LOW: 1 });
    const tradeNumberRef = useRef(0);
    const pairRef = useRef(null);

    const publishNativeError = useCallback((message) => {
        if (journal?.onError) {
            journal.onError(message);
        }
    }, [journal]);

    const publishResult = useCallback((result) => {
        if (journal?.onLogSuccess) {
            journal.onLogSuccess({
                log_type: result.profit >= 0 ? 'profit' : 'lost',
                extra: {
                    currency: 'USD',
                    profit: result.profit,
                },
            });
        }
    }, [journal]);

    const publishContract = useCallback((contract) => {
        if (transactions?.onBotContractEvent) {
            transactions.onBotContractEvent(contract);
        }
        if (summary_card?.onBotContractEvent) {
            summary_card.onBotContractEvent(contract);
        }
    }, [transactions, summary_card]);

    const stopBot = useCallback((reason = 'Bot stopped.') => {
        isRunningRef.current = false;
        setIsRunning(false);
        setStatus('Stopped');

        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }

        run_panel?.setIsRunning?.(false);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        run_panel?.toggleDrawer?.(true);
        run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

        if (reason !== 'Bot stopped.') {
            setError(reason);
        }
    }, [run_panel]);

    const addHistory = useCallback((item) => {
        setHistory((previous) => [item, ...previous].slice(0, 50));
    }, []);

    const executePair = useCallback(() => {
        if (!isRunningRef.current || pairRef.current) return;

        const currentStake = Number.parseFloat(stake || '1');
        const highStake = Number(
            nextStakeRef.current.HIGH.toFixed(2)
        );
        const lowStake = Number(
            nextStakeRef.current.LOW.toFixed(2)
        );

        const entry = currentQuoteRef.current;
        entryQuoteRef.current = entry;
        tickCountRef.current = 0;

        const pairId = `paper-pair-${Date.now()}`;
        pairRef.current = {
            id: pairId,
            entry,
            highStake,
            lowStake,
            symbol: selectedSymbol,
            tickDuration: 5,
        };

        setEntryQuote(entry.toFixed(5));
        setTickCount(0);
        setStatus('Pair running');

        addHistory({
            id: pairId,
            type: 'PAIR STARTED',
            entry: entry.toFixed(5),
            symbol: selectedSymbol,
            time: new Date().toLocaleTimeString(),
        });

        run_panel?.setHasOpenContract?.(true);
        run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);
    }, [stake, selectedSymbol, addHistory, run_panel]);

    const settlePair = useCallback((exitQuote) => {
        const pair = pairRef.current;
        if (!pair) return;

        // Educational simulation only.
        // The outcome is based on the simulated final quote.
        const highWon = exitQuote > pair.entry;
        const lowWon = exitQuote < pair.entry;

        const highProfit = highWon
            ? pair.highStake
            : -pair.highStake;

        const lowProfit = lowWon
            ? pair.lowStake
            : -pair.lowStake;

        const pairProfit = highProfit + lowProfit;

        totalProfitRef.current += pairProfit;
        tradeNumberRef.current += 1;

        const result = {
            id: pair.id,
            type: 'PAIR COMPLETED',
            symbol: pair.symbol,
            entry: pair.entry.toFixed(5),
            exit: exitQuote.toFixed(5),
            highResult: highWon ? 'Won' : 'Lost',
            lowResult: lowWon ? 'Won' : 'Lost',
            highProfit,
            lowProfit,
            profit: pairProfit,
            time: new Date().toLocaleTimeString(),
        };

        setTotalProfit(totalProfitRef.current);
        setTradeCount(tradeNumberRef.current);
        addHistory(result);

        publishResult(result);

        publishContract({
            id: pair.id,
            contract_id: pair.id,
            underlying: pair.symbol,
            underlying_symbol: pair.symbol,
            display_name: formatSymbolDisplay(pair.symbol),
            contract_type: 'PAPER_HIGH_LOW_TICKS',
            buy_price: pair.highStake + pair.lowStake,
            currency: 'USD',
            status: pairProfit >= 0 ? 'won' : 'lost',
            result: pairProfit >= 0 ? 'won' : 'lost',
            profit: pairProfit,
            entry_spot: pair.entry,
            exit_spot: exitQuote,
            is_sold: true,
            date_start: Math.floor(Date.now() / 1000),
        });

        // Apply the selected paper martingale mode.
        if (martingaleMode === 'split') {
            nextStakeRef.current.HIGH = highWon
                ? Number.parseFloat(stake || '1')
                : Number((pair.highStake * Number(mFactor || 1)).toFixed(2));

            nextStakeRef.current.LOW = lowWon
                ? Number.parseFloat(stake || '1')
                : Number((pair.lowStake * Number(mFactor || 1)).toFixed(2));
        } else {
            if (pairProfit < 0) {
                nextStakeRef.current.HIGH = Number(
                    (pair.highStake * Number(mFactor || 1)).toFixed(2)
                );
                nextStakeRef.current.LOW = Number(
                    (pair.lowStake * Number(mFactor || 1)).toFixed(2)
                );
            } else {
                nextStakeRef.current = {
                    HIGH: Number.parseFloat(stake || '1'),
                    LOW: Number.parseFloat(stake || '1'),
                };
            }
        }

        pairRef.current = null;
        entryQuoteRef.current = null;
        tickCountRef.current = 0;
        setTickCount(0);
        setStatus('Waiting for next pair');

        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.CONTRACT_CLOSED);

        const profitLimit = Number.parseFloat(targetProfit || '0');
        const lossLimit = Number.parseFloat(stopLoss || '0');

        if (
            totalProfitRef.current >= profitLimit ||
            totalProfitRef.current <= -lossLimit
        ) {
            stopBot('Paper session ended at the configured profit/loss limit.');
        }
    }, [
        addHistory,
        martingaleMode,
        mFactor,
        publishContract,
        publishResult,
        run_panel,
        stake,
        stopBot,
        stopLoss,
        targetProfit,
    ]);

    const simulateTick = useCallback(() => {
        if (!isRunningRef.current) return;

        // Generate a simulated quote movement.
        // This is not a live Deriv market price.
        const movement = (Math.random() - 0.5) * 0.8;
        currentQuoteRef.current = Math.max(
            0.01,
            currentQuoteRef.current + movement
        );

        const quote = currentQuoteRef.current;
        setLastTickQuote(quote.toFixed(5));

        if (!pairRef.current) {
            executePair();
            return;
        }

        tickCountRef.current += 1;
        setTickCount(tickCountRef.current);

        if (tickCountRef.current >= 5) {
            settlePair(quote);
        }
    }, [executePair, settlePair]);

    const startBot = useCallback(() => {
        if (isRunningRef.current) {
            stopBot();
            return;
        }

        const stakeValue = Number.parseFloat(stake);
        const targetValue = Number.parseFloat(targetProfit);
        const lossValue = Number.parseFloat(stopLoss);
        const multiplier = Number.parseFloat(mFactor);

        if (!Number.isFinite(stakeValue) || stakeValue <= 0) {
            setError('Enter a valid positive stake.');
            return;
        }

        if (!Number.isFinite(targetValue) || targetValue <= 0) {
            setError('Enter a valid positive target profit.');
            return;
        }

        if (!Number.isFinite(lossValue) || lossValue <= 0) {
            setError('Enter a valid positive stop loss.');
            return;
        }

        if (!Number.isFinite(multiplier) || multiplier < 1) {
            setError('Enter a multiplier of at least 1.');
            return;
        }

        // The simulator uses a fixed five-tick duration.
        setDuration('5');
        setError('');
        setHistory([]);
        setTradeCount(0);
        setTotalProfit(0);
        setLastTickQuote('-');
        setEntryQuote('-');
        setTickCount(0);
        setStatus('Starting simulation');

        totalProfitRef.current = 0;
        tickCountRef.current = 0;
        tradeNumberRef.current = 0;
        pairRef.current = null;
        entryQuoteRef.current = null;

        nextStakeRef.current = {
            HIGH: stakeValue,
            LOW: stakeValue,
        };

        isRunningRef.current = true;
        setIsRunning(true);
        setStatus('Running paper simulation');

        if (transactions?.clear) transactions.clear();
        if (summary_card?.clear) summary_card.clear();

        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        if (run_panel) {
            run_panel.run_id = `paper-high-low-${Date.now()}`;
        }
        run_panel?.toggleDrawer?.(true);
        run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

        // Simulated tick interval. No trading API is connected.
        intervalRef.current = setInterval(simulateTick, 1000);
    }, [
        mFactor,
        simulateTick,
        stake,
        stopBot,
        stopLoss,
        summary_card,
        targetProfit,
        transactions,
        run_panel,
    ]);

    useEffect(() => {
        observer.register('dualhighlowticks.start', startBot);
        observer.register('dualhighlowticks.stop', stopBot);

        return () => {
            if (observer.isRegistered('dualhighlowticks.start')) {
                observer.unregister('dualhighlowticks.start', startBot);
            }
            if (observer.isRegistered('dualhighlowticks.stop')) {
                observer.unregister('dualhighlowticks.stop', stopBot);
            }
        };
    }, [startBot, stopBot]);

    useEffect(() => {
        const handleExternalStop = () => {
            if (isRunningRef.current) {
                stopBot('Simulation stopped from the run panel.');
            }
        };

        observer.register('bot.click_stop', handleExternalStop);

        return () => {
            if (observer.isRegistered('bot.click_stop')) {
                observer.unregister('bot.click_stop', handleExternalStop);
            }
        };
    }, [stopBot]);

    useEffect(() => {
        return () => {
            isRunningRef.current = false;
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, []);

    return (
        <div className="dhl-tool">
            <header>
                <h1>Dual High / Low Ticks</h1>
                <p>
                    Paper-trading simulator for paired High and Low
                    tick predictions, using a fixed five-tick duration.
                </p>
                <p className="dhl-warning">
                    Simulation only. Quotes and results are not live
                    Deriv market data or real contracts.
                </p>
            </header>

            <div className="dhl-settings">
                <label>
                    Volatility
                    <select
                        value={selectedSymbol}
                        onChange={(e) => setSelectedSymbol(e.target.value)}
                        disabled={isRunning}
                    >
                        {SYMBOL_OPTIONS.map((symbol) => (
                            <option key={symbol} value={symbol}>
                                {formatSymbolDisplay(symbol)}
                            </option>
                        ))}
                    </select>
                </label>

                <label>
                    Duration
                    <input
                        type="number"
                        value="5"
                        disabled
                        readOnly
                    />
                </label>

                <label>
                    Duration Unit
                    <select value="t" disabled>
                        <option value="t">Ticks</option>
                    </select>
                </label>

                <label>
                    Stake per side (USD)
                    <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={stake}
                        onChange={(e) => setStake(e.target.value)}
                        disabled={isRunning}
                    />
                </label>

                <label>
                    Target Profit (USD)
                    <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={targetProfit}
                        onChange={(e) => setTargetProfit(e.target.value)}
                        disabled={isRunning}
                    />
                </label>

                <label>
                    Stop Loss (USD)
                    <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={stopLoss}
                        onChange={(e) => setStopLoss(e.target.value)}
                        disabled={isRunning}
                    />
                </label>

                <label>
                    Martingale Mode
                    <select
                        value={martingaleMode}
                        onChange={(e) => setMartingaleMode(e.target.value)}
                        disabled={isRunning}
                    >
                        <option value="net">When both sides lose</option>
                        <option value="split">Manage each side separately</option>
                    </select>
                </label>

                <label>
                    Multiplier
                    <input
                        type="number"
                        min="1"
                        step="0.1"
                        value={mFactor}
                        onChange={(e) => setMFactor(e.target.value)}
                        disabled={isRunning}
                    />
                </label>
            </div>

            <div className="dhl-contract-pair">
                <div className="dhl-side-card">
                    <h3>HIGH TICK</h3>
                    <p>Simulated final quote above entry</p>
                    <strong>
                        ${nextStakeRef.current.HIGH.toFixed(2)}
                    </strong>
                </div>

                <div className="dhl-side-card">
                    <h3>LOW TICK</h3>
                    <p>Simulated final quote below entry</p>
                    <strong>
                        ${nextStakeRef.current.LOW.toFixed(2)}
                    </strong>
                </div>
            </div>

            <button
                type="button"
                className={isRunning ? 'stop' : ''}
                onClick={startBot}
            >
                {isRunning ? <FaStop /> : <FaPlay />}
                {isRunning ? ' STOP SIMULATION' : ' START SIMULATION'}
            </button>

            <div className="dhl-live-box">
                <div>
                    <span>Market</span>
                    <strong>{formatSymbolDisplay(selectedSymbol)}</strong>
                </div>

                <div>
                    <span>Duration</span>
                    <strong>5 ticks</strong>
                </div>

                <div>
                    <span>Entry Quote</span>
                    <strong>{entryQuote}</strong>
                </div>

                <div>
                    <span>Latest Simulated Quote</span>
                    <strong>{lastTickQuote}</strong>
                </div>

                <div>
                    <span>Tick Progress</span>
                    <strong>{tickCount} / 5</strong>
                </div>

                <div>
                    <span>Completed Pairs</span>
                    <strong>{tradeCount}</strong>
                </div>

                <div>
                    <span>Session P/L</span>
                    <strong className={totalProfit >= 0 ? 'profit' : 'loss'}>
                        {totalProfit.toFixed(2)} USD
                    </strong>
                </div>

                <div>
                    <span>Status</span>
                    <strong>{status}</strong>
                </div>
            </div>

            {error && <p className="dhl-error">{error}</p>}

            <section className="dhl-history">
                <h2>Simulation History</h2>

                {history.length === 0 ? (
                    <p>No simulated pairs yet.</p>
                ) : (
                    <div className="dhl-history-table-wrap">
                        <table className="dhl-history-table">
                            <thead>
                                <tr>
                                    <th>Time</th>
                                    <th>Event</th>
                                    <th>Entry</th>
                                    <th>Exit</th>
                                    <th>High</th>
                                    <th>Low</th>
                                    <th>Pair P/L</th>
                                </tr>
                            </thead>
                            <tbody>
                                {history.map((item) => (
                                    <tr key={item.id}>
                                        <td>{item.time}</td>
                                        <td>{item.type}</td>
                                        <td>{item.entry || '-'}</td>
                                        <td>{item.exit || '-'}</td>
                                        <td>{item.highResult || '-'}</td>
                                        <td>{item.lowResult || '-'}</td>
                                        <td>
                                            {item.profit !== undefined
                                                ? `${item.profit.toFixed(2)} USD`
                                                : '-'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    );
};

export default DualHighLowTicks;
