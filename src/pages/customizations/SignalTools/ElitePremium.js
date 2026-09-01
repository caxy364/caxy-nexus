import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Swal from 'sweetalert2';
import { FaPlay, FaStop } from 'react-icons/fa';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { useStore } from '@/hooks/useStore';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';

import './ElitePremium.css';

const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');
const JOURNAL_SLOT_ID = 'db-journal-custom-slot';
const MAX_STRATEGIES = 5;
const MONITOR_WINDOW = 5;
const CONDITION_TYPES = ['EVEN', 'ODD', 'OVER', 'UNDER', 'RISE', 'FALL'];
const ALL_SYMBOLS = ['1HZ10V', 'R_10', '1HZ25V', 'R_25', '1HZ50V', 'R_50', '1HZ75V', 'R_75', '1HZ100V', 'R_100'];

const CONTRACT_TYPE_MAP = {
    EVEN: 'DIGITEVEN',
    ODD: 'DIGITODD',
    OVER: 'DIGITOVER',
    UNDER: 'DIGITUNDER',
    RISE: 'CALL',
    FALL: 'PUT',
};

const createStrategyId = () => `elite-premium-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const isDigitCondition = type => ['EVEN', 'ODD', 'OVER', 'UNDER'].includes(type);
const isMoveCondition = type => ['RISE', 'FALL'].includes(type);
const requiresBarrier = type => type === 'OVER' || type === 'UNDER';

const getDefaultBarrier = tradeType => {
    if (tradeType === 'OVER') return '4';
    if (tradeType === 'UNDER') return '5';
    return '';
};

const createStrategy = (overrides = {}) => ({
    id: createStrategyId(),
    lookback: '5',
    condition: 'ODD',
    trade: 'EVEN',
    barrier: '',
    ...overrides,
});

const normalizeLookback = value => {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isInteger(parsed)) return 1;
    return Math.min(10, Math.max(1, parsed));
};

const normalizeMoney = (value, fallback = 1) => {
    const parsed = Number.parseFloat(value);

    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Number(parsed.toFixed(2));
};

const clampBarrierValue = (tradeType, rawValue) => {
    const parsed = Number.parseInt(String(rawValue).replace(/[^\d]/g, ''), 10);

    if (!Number.isInteger(parsed)) return '';
    if (tradeType === 'OVER') return String(Math.min(8, Math.max(0, parsed)));
    if (tradeType === 'UNDER') return String(Math.min(9, Math.max(1, parsed)));
    return '';
};

const matchesDigitCondition = (digit, condition) => {
    if (condition === 'EVEN') return digit % 2 === 0;
    if (condition === 'ODD') return digit % 2 !== 0;
    if (condition === 'OVER') return digit > 4;
    if (condition === 'UNDER') return digit < 5;
    return false;
};

const getRecentMoves = (prices, limit = MONITOR_WINDOW) => {
    const relevantPrices = prices.slice(-(limit + 1));
    const moves = [];

    for (let index = 1; index < relevantPrices.length; index += 1) {
        const currentPrice = Number(relevantPrices[index]);
        const previousPrice = Number(relevantPrices[index - 1]);

        if (currentPrice > previousPrice) moves.push('RISE');
        else if (currentPrice < previousPrice) moves.push('FALL');
        else moves.push('FLAT');
    }

    return moves;
};

const getMaxDigitHistory = strategies => {
    const digitWindows = strategies
        .filter(strategy => isDigitCondition(strategy.condition))
        .map(strategy => normalizeLookback(strategy.lookback));

    return Math.max(MONITOR_WINDOW, ...digitWindows, 1);
};

const getMaxPriceHistory = strategies => {
    const moveWindows = strategies
        .filter(strategy => isMoveCondition(strategy.condition))
        .map(strategy => normalizeLookback(strategy.lookback) + 1);

    return Math.max(MONITOR_WINDOW + 1, ...moveWindows, 2);
};

const formatTradeLabel = (tradeType, barrier) => {
    if (!requiresBarrier(tradeType)) return tradeType;
    return `${tradeType} ${barrier}`;
};

const formatStrategySummary = strategy => {
    const lookback = normalizeLookback(strategy.lookback);
    const subject = isMoveCondition(strategy.condition) ? 'market moves' : 'digits';
    return `If the last ${lookback} ${subject} are ${strategy.condition}, trade ${formatTradeLabel(strategy.trade, strategy.barrier)}.`;
};

const formatTokenMove = move => {
    if (move === 'RISE') return 'R';
    if (move === 'FALL') return 'F';
    return '-';
};

const formatSymbolDisplay = symbol => {
    if (!symbol) return '';
    if (symbol.startsWith('1HZ')) return `${symbol.replace('1HZ', '').replace('V', '')}(1s)`;
    if (symbol.startsWith('R_')) return symbol.replace('R_', 'V');
    return symbol;
};

const getTradeBarrier = (tradeType, barrier) => {
    if (!requiresBarrier(tradeType)) return null;
    return clampBarrierValue(tradeType, barrier);
};

const ElitePremium = () => {
    const store = useStore();
    const { transactions, journal, summary_card, run_panel, client } = store || {};

    const [isRunning, setIsRunning] = useState(false);
    const [results, setResults] = useState([]);
    const [wins, setWins] = useState(0);
    const [losses, setLosses] = useState(0);
    const [totalRuns, setTotalRuns] = useState(0);
    const [totalProfit, setTotalProfit] = useState(0);
    const [liveDigits, setLiveDigits] = useState({});
    const [liveMoves, setLiveMoves] = useState({});
    const [lastTriggeredSymbol, setLastTriggeredSymbol] = useState(null);
    const [journalMonitorTarget, setJournalMonitorTarget] = useState(null);
    const [statusMessage, setStatusMessage] = useState('Set your strategies, then start the scanner.');
    const [lastSignalLabel, setLastSignalLabel] = useState(transactions?.last_signal_label || 'No signal yet');
    const [nextStakeDisplay, setNextStakeDisplay] = useState(1);
    const [strategies, setStrategies] = useState([
        createStrategy({
            condition: 'ODD',
            trade: 'EVEN',
        }),
    ]);

    const [stake, setStake] = useState('1');
    const [targetProfit, setTargetProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [mFactor, setMFactor] = useState('2.1');

    const stakeRef = useRef('1');
    const targetProfitRef = useRef('100');
    const stopLossRef = useRef('100');
    const mFactorRef = useRef('2.1');
    const strategiesRef = useRef(strategies);
    const wsRef = useRef(null);
    const totalProfitRef = useRef(0);
    const isRunningRef = useRef(false);
    const pendingProposalRef = useRef(false);
    const pendingTradeContextRef = useRef(null);
    const isAuthorizedRef = useRef(false);
    const isConnectingRef = useRef(false);
    const shouldReconnectRef = useRef(true);
    const skipReconnectRef = useRef(false);
    const socketRequiresAuthRef = useRef(false);
    const activeContractsRef = useRef(new Set());
    const isProcessingRef = useRef(false);
    const digitHistoryRef = useRef({});
    const priceHistoryRef = useRef({});
    const contractMetaRef = useRef({});
    const reconnectTimeoutRef = useRef(null);
    const highlightTimeoutRef = useRef(null);
    const nextStakeRef = useRef(1);

    useEffect(() => {
        stakeRef.current = stake;
    }, [stake]);

    useEffect(() => {
        targetProfitRef.current = targetProfit;
    }, [targetProfit]);

    useEffect(() => {
        stopLossRef.current = stopLoss;
    }, [stopLoss]);

    useEffect(() => {
        mFactorRef.current = mFactor;
    }, [mFactor]);

    useEffect(() => {
        isRunningRef.current = isRunning;
    }, [isRunning]);

    useEffect(() => {
        run_panel?.setIsRunning?.(isRunning);
        if (!isRunning && activeContractsRef.current.size === 0) {
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [isRunning, run_panel]);

    useEffect(() => {
        strategiesRef.current = strategies;

        const digitLimit = getMaxDigitHistory(strategies);
        const priceLimit = getMaxPriceHistory(strategies);
        const trimmedDigits = {};
        const trimmedMoves = {};

        Object.keys(digitHistoryRef.current).forEach(symbol => {
            digitHistoryRef.current[symbol] = (digitHistoryRef.current[symbol] || []).slice(-digitLimit);
            trimmedDigits[symbol] = digitHistoryRef.current[symbol].slice(-MONITOR_WINDOW);
        });

        Object.keys(priceHistoryRef.current).forEach(symbol => {
            priceHistoryRef.current[symbol] = (priceHistoryRef.current[symbol] || []).slice(-priceLimit);
            trimmedMoves[symbol] = getRecentMoves(priceHistoryRef.current[symbol], MONITOR_WINDOW);
        });

        setLiveDigits(previous => ({ ...previous, ...trimmedDigits }));
        setLiveMoves(previous => ({ ...previous, ...trimmedMoves }));
    }, [strategies]);

    useEffect(() => {
        if (!isRunning) {
            const baseStake = normalizeMoney(stakeRef.current);
            nextStakeRef.current = baseStake;
            setNextStakeDisplay(baseStake);
        }
    }, [stake, isRunning]);

    const updateLastSignalLabel = useCallback(
        label => {
            setLastSignalLabel(label);
            transactions?.setLastSignalLabel?.(label);
        },
        [transactions]
    );

    const getStoredAuthContext = useCallback(() => {
        try {
            const authRaw = sessionStorage.getItem('auth_info');
            const accountsRaw = sessionStorage.getItem('deriv_accounts');

            if (!authRaw || !accountsRaw) return null;

            const { access_token } = JSON.parse(authRaw);
            const accounts = JSON.parse(accountsRaw);

            if (!access_token || !Array.isArray(accounts) || accounts.length === 0) {
                return null;
            }

            const activeLoginId = localStorage.getItem('active_loginid');
            const activeAccount =
                accounts.find(account => account.account_id === activeLoginId) ||
                accounts.find(account => account.account_id?.startsWith('DOT')) ||
                accounts[0];

            if (!activeAccount?.account_id) return null;

            return {
                accessToken: access_token,
                activeAccount,
            };
        } catch (error) {
            console.error('[ElitePremium] Failed to parse Deriv session:', error);
            return null;
        }
    }, []);

    const getAuthenticatedUrl = useCallback(async () => {
        try {
            const authContext = getStoredAuthContext();
            if (!authContext) throw new Error('Session Missing');

            const { accessToken, activeAccount } = authContext;
            const response = await fetch(`${DERIV_OPTIONS_API_URL}accounts/${activeAccount.account_id}/otp`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            });

            if (!response.ok) throw new Error('OTP Request Failed');

            const json = await response.json();
            const authenticatedUrl = json?.data?.url;

            if (!authenticatedUrl) throw new Error('Authenticated URL Missing');

            return authenticatedUrl;
        } catch (error) {
            setStatusMessage(`Authorization failed: ${error.message}`);
            return null;
        }
    }, [getStoredAuthContext]);

    const publishNativeContract = useCallback(
        contractData => {
            if (!transactions || !summary_card) return;
            transactions.onBotContractEvent(contractData);
            summary_card.onBotContractEvent(contractData);
        },
        [summary_card, transactions]
    );

    const publishNativeError = useCallback(
        message => {
            if (journal?.onError) {
                journal.onError(message);
            }
        },
        [journal]
    );

    const publishNativeResult = useCallback(
        contractData => {
            const isWon = contractData.result ? contractData.result === 'won' : Number(contractData.profit) > 0;
            const normalizedCurrency = contractData?.currency || client?.currency || 'USD';
            const normalizedProfit = Number.isFinite(Number(contractData?.profit)) ? Number(contractData.profit) : 0;

            if (journal?.onLogSuccess) {
                journal.onLogSuccess({
                    log_type: isWon ? 'profit' : 'lost',
                    extra: {
                        currency: normalizedCurrency,
                        profit: normalizedProfit,
                    },
                });
            }
        },
        [client?.currency, journal]
    );

    const stopTradingBot = useCallback(
        (reason = 'Bot stopped.', options = {}) => {
            const { preserveOpenContract = activeContractsRef.current.size > 0 } = options;

            setIsRunning(false);
            isRunningRef.current = false;
            isProcessingRef.current = false;
            pendingProposalRef.current = false;
            pendingTradeContextRef.current = null;
            setStatusMessage(reason);

            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ forget_all: 'proposal' }));
                if (!preserveOpenContract) {
                    wsRef.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
                }
            }

            run_panel?.setIsRunning?.(false);
            run_panel?.toggleDrawer?.(true);
            run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

            if (preserveOpenContract) {
                run_panel?.setContractStage?.(contract_stages.IS_STOPPING);
            } else {
                activeContractsRef.current.clear();
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            }
        },
        [run_panel]
    );

    const handleStop = useCallback(() => {
        stopTradingBot('Bot stopped.');
    }, [stopTradingBot]);

    const handleProposal = useCallback(
        data => {
            if (!isRunningRef.current || !pendingProposalRef.current || activeContractsRef.current.size > 0) {
                return;
            }

            const proposalId = data?.proposal?.id;
            const askPrice = data?.proposal?.ask_price;
            if (!proposalId || typeof askPrice === 'undefined') {
                pendingProposalRef.current = false;
                isProcessingRef.current = false;
                setStatusMessage('Proposal response was incomplete. Waiting for next trade signal.');
                return;
            }

            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
            wsRef.current?.send(
                JSON.stringify({
                    buy: proposalId,
                    price: askPrice,
                    passthrough: data.echo_req?.passthrough || pendingTradeContextRef.current,
                })
            );
        },
        [run_panel]
    );

    const handleBuy = useCallback(
        data => {
            if (data.error) {
                isProcessingRef.current = false;
                pendingProposalRef.current = false;
                pendingTradeContextRef.current = null;
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(
                    isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING
                );
                publishNativeError(data.error.message);
                setStatusMessage(data.error.message);
                return;
            }

            const { contract_id, transaction_id, buy_price, longcode } = data.buy || {};
            const contractKey = String(contract_id ?? '');
            const passthrough = data.echo_req?.passthrough || pendingTradeContextRef.current || {};
            const { symbol, custom_type, sent_stake, strategy_id, strategy_label, trigger_type, lookback, barrier } =
                passthrough;
            const normalizedSymbol = symbol || '';
            const normalizedStake = Number(
                Number.isFinite(Number(sent_stake)) ? Number(sent_stake) : Number(nextStakeRef.current)
            );

            if (!contractKey) {
                pendingProposalRef.current = false;
                pendingTradeContextRef.current = null;
                isProcessingRef.current = false;
                return;
            }

            activeContractsRef.current.add(contractKey);
            pendingProposalRef.current = false;
            pendingTradeContextRef.current = null;

            const transactionPayload = {
                id: contractKey,
                contract_id: contractKey,
                transaction_ids: { buy: transaction_id },
                buy_price: buy_price ?? normalizedStake,
                currency: client?.currency || 'USD',
                display_name: formatSymbolDisplay(normalizedSymbol) || 'Contract',
                underlying: normalizedSymbol,
                contract_type: custom_type,
                longcode,
                date_start: Math.floor(Date.now() / 1000),
                strategy_id,
                strategy_label,
                trigger_type,
                lookback,
                barrier,
            };

            contractMetaRef.current[contractKey] = transactionPayload;
            publishNativeContract(transactionPayload);

            run_panel?.setHasOpenContract?.(true);
            run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);
            setStatusMessage(
                `Trade is live on ${formatSymbolDisplay(normalizedSymbol) || 'selected market'} using ${strategy_label || 'active strategy'}.`
            );

            setResults(previous =>
                [
                    {
                        id: contractKey,
                        contract_id: contractKey,
                        symbol: normalizedSymbol,
                        contract_type: custom_type,
                        strategy_label,
                        trigger_type,
                        lookback,
                        barrier,
                        entry_spot: '-',
                        exit_spot: '-',
                        profit: 0,
                        stake: normalizedStake.toFixed(2),
                        status: 'RUNNING',
                    },
                    ...previous,
                ].slice(0, 14)
            );

            wsRef.current?.send(JSON.stringify({ proposal_open_contract: 1, contract_id: contractKey, subscribe: 1 }));
        },
        [client?.currency, publishNativeContract, publishNativeError, run_panel]
    );

    const handleContractCompletion = useCallback(
        contract => {
            const profit = Number.parseFloat(contract.profit);
            const contractId = String(contract.contract_id ?? '');
            if (!contractId) return;
            const factor = normalizeMoney(mFactorRef.current, 1);
            const baseStake = normalizeMoney(stakeRef.current);
            const meta = contractMetaRef.current[contractId] || {};

            totalProfitRef.current += Number.isFinite(profit) ? profit : 0;
            activeContractsRef.current.delete(contractId);

            if (profit < 0) {
                nextStakeRef.current = Number((nextStakeRef.current * factor).toFixed(2));
            } else {
                nextStakeRef.current = baseStake;
            }

            setNextStakeDisplay(nextStakeRef.current);

            const nativeContract = {
                ...meta,
                ...contract,
                id: contractId,
                contract_id: contractId,
                buy_price: contract.buy_price ?? meta.buy_price ?? 0,
                currency: contract.currency || client?.currency || 'USD',
                display_name: contract.display_name || formatSymbolDisplay(meta.underlying || contract.underlying),
                underlying: contract.underlying || meta.underlying,
                transaction_ids: meta.transaction_ids || contract.transaction_ids,
                result: profit > 0 ? 'won' : 'lost',
                status: profit > 0 ? 'won' : 'lost',
            };

            publishNativeContract(nativeContract);
            publishNativeResult(nativeContract);

            setResults(previous =>
                previous.map(item =>
                    String(item.contract_id) === contractId
                        ? {
                              ...item,
                              entry_spot: contract.entry_spot_display_value ?? '-',
                              exit_spot: contract.exit_tick_display_value ?? '-',
                              profit: Number.isFinite(profit) ? profit : 0,
                              status: profit > 0 ? 'WIN' : 'LOSS',
                          }
                        : item
                )
            );

            setTotalProfit(Number(totalProfitRef.current.toFixed(2)));
            if (profit > 0) setWins(previous => previous + 1);
            else setLosses(previous => previous + 1);
            setTotalRuns(previous => previous + 1);

            if (activeContractsRef.current.size === 0) {
                isProcessingRef.current = false;

                const limitHit =
                    totalProfitRef.current >= normalizeMoney(targetProfitRef.current, 100) ||
                    totalProfitRef.current <= -normalizeMoney(stopLossRef.current, 100);

                if (limitHit) {
                    stopTradingBot('Session ended by target/stop loss.', { preserveOpenContract: false });
                    Swal.fire(
                        'Session Ended',
                        `Final P/L: ${totalProfitRef.current.toFixed(2)} ${client?.currency || 'USD'}`,
                        'info'
                    );
                } else {
                    run_panel?.setHasOpenContract?.(false);
                    run_panel?.setContractStage?.(
                        isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING
                    );
                    setStatusMessage(
                        profit > 0
                            ? `Trade won on ${nativeContract.display_name}. Scanner is waiting for the next strategy match.`
                            : `Trade lost on ${nativeContract.display_name}. Scanner is waiting for the next strategy match.`
                    );
                }
            }
        },
        [client?.currency, publishNativeContract, publishNativeResult, run_panel, stopTradingBot]
    );

    const findMatchedStrategy = useCallback(symbol => {
        const digitHistory = digitHistoryRef.current[symbol] || [];
        const priceHistory = priceHistoryRef.current[symbol] || [];

        for (let index = 0; index < strategiesRef.current.length; index += 1) {
            const strategy = strategiesRef.current[index];
            const lookback = normalizeLookback(strategy.lookback);

            if (isDigitCondition(strategy.condition)) {
                const relevantDigits = digitHistory.slice(-lookback);

                if (
                    relevantDigits.length === lookback &&
                    relevantDigits.every(digit => matchesDigitCondition(digit, strategy.condition))
                ) {
                    return { strategy, index, sample: relevantDigits };
                }
            } else {
                const recentMoves = getRecentMoves(priceHistory, lookback);

                if (recentMoves.length === lookback && recentMoves.every(move => move === strategy.condition)) {
                    return { strategy, index, sample: recentMoves };
                }
            }
        }

        return null;
    }, []);

    const executeStrategyTrade = useCallback(
        (symbol, matchedStrategy) => {
            const ws = wsRef.current;

            if (!ws || ws.readyState !== WebSocket.OPEN) {
                isProcessingRef.current = false;
                setStatusMessage('WebSocket is not ready yet. Waiting to reconnect.');
                return;
            }

            if (!isAuthorizedRef.current) {
                isProcessingRef.current = false;
                setStatusMessage('Trading session is not authorized yet. Waiting for secure connection.');
                return;
            }

            if (pendingProposalRef.current || activeContractsRef.current.size > 0) {
                return;
            }

            const { strategy, index } = matchedStrategy;
            const tradeBarrier = getTradeBarrier(strategy.trade, strategy.barrier);
            const currentStake = Number(nextStakeRef.current.toFixed(2));
            const strategyLabel = `Strategy ${index + 1}`;
            const conditionLabel = isMoveCondition(strategy.condition) ? 'market moves' : 'digits';
            const summaryLabel = formatStrategySummary(strategy);
            const payload = {
                proposal: 1,
                basis: 'stake',
                currency: client?.currency || 'USD',
                underlying_symbol: symbol,
                duration: 1,
                duration_unit: 't',
                amount: currentStake,
                contract_type: CONTRACT_TYPE_MAP[strategy.trade],
                passthrough: {
                    symbol,
                    custom_type: strategy.trade,
                    sent_stake: currentStake,
                    strategy_id: strategy.id,
                    strategy_label: strategyLabel,
                    trigger_type: strategy.condition,
                    lookback: normalizeLookback(strategy.lookback),
                    barrier: tradeBarrier,
                    summary_label: summaryLabel,
                },
            };

            if (tradeBarrier !== null) {
                payload.barrier = tradeBarrier;
            }

            pendingTradeContextRef.current = payload.passthrough;
            pendingProposalRef.current = true;
            ws.send(JSON.stringify(payload));
            updateLastSignalLabel(
                `${strategyLabel} on ${formatSymbolDisplay(symbol)}: last ${normalizeLookback(strategy.lookback)} ${conditionLabel} were ${strategy.condition}.`
            );
            setStatusMessage(
                `Matched ${strategyLabel} on ${formatSymbolDisplay(symbol)}. Sending ${formatTradeLabel(strategy.trade, tradeBarrier)} proposal.`
            );
        },
        [client?.currency, updateLastSignalLabel]
    );

    const handleTick = useCallback(
        tick => {
            const { symbol, quote } = tick || {};

            if (!symbol || typeof quote === 'undefined') return;

            const currentDigit = Number.parseInt(String(quote).slice(-1), 10);
            const digitLimit = getMaxDigitHistory(strategiesRef.current);
            const priceLimit = getMaxPriceHistory(strategiesRef.current);

            if (!digitHistoryRef.current[symbol]) digitHistoryRef.current[symbol] = [];
            digitHistoryRef.current[symbol].push(currentDigit);
            if (digitHistoryRef.current[symbol].length > digitLimit) {
                digitHistoryRef.current[symbol].shift();
            }

            if (!priceHistoryRef.current[symbol]) priceHistoryRef.current[symbol] = [];
            priceHistoryRef.current[symbol].push(Number(quote));
            if (priceHistoryRef.current[symbol].length > priceLimit) {
                priceHistoryRef.current[symbol].shift();
            }

            setLiveDigits(previous => ({
                ...previous,
                [symbol]: [...digitHistoryRef.current[symbol]].slice(-MONITOR_WINDOW),
            }));
            setLiveMoves(previous => ({
                ...previous,
                [symbol]: getRecentMoves(priceHistoryRef.current[symbol], MONITOR_WINDOW),
            }));

            if (!isRunningRef.current || activeContractsRef.current.size > 0 || isProcessingRef.current) return;

            const matchedStrategy = findMatchedStrategy(symbol);
            if (!matchedStrategy) return;

            isProcessingRef.current = true;
            setLastTriggeredSymbol(symbol);

            if (highlightTimeoutRef.current) {
                window.clearTimeout(highlightTimeoutRef.current);
            }

            highlightTimeoutRef.current = window.setTimeout(() => {
                setLastTriggeredSymbol(null);
            }, 1800);

            executeStrategyTrade(symbol, matchedStrategy);
        },
        [executeStrategyTrade, findMatchedStrategy]
    );

    const subscribeToTicks = useCallback(socket => {
        ALL_SYMBOLS.forEach(symbol => socket.send(JSON.stringify({ ticks: symbol, subscribe: 1 })));
    }, []);

    const handleSocketMessage = useCallback(
        event => {
            const data = JSON.parse(event.data);

            if (data.msg_type === 'authorize') {
                if (!isAuthorizedRef.current) {
                    isAuthorizedRef.current = true;
                    setStatusMessage(previous =>
                        previous.startsWith('Matched') || previous.startsWith('Trade')
                            ? previous
                            : 'Authorized trading session ready.'
                    );
                }
                return;
            }

            if (data.error) {
                const errorCode = data.error.code;
                const errorMessage = data.error.message;
                const openPositionLimitReached =
                    /(cannot hold more than \d+ contracts|open positions of this asset and trade type|open position limit)/i.test(
                        errorMessage || ''
                    );
                const sessionTradingLimitReached =
                    [
                        'CompanyWideLimitExceeded',
                        'DailyProfitLimitExceeded',
                        'ProductSpecificTurnoverLimitExceeded',
                        'MaxAggregateOpenStakeExceeded',
                    ].includes(errorCode) ||
                    /(no further trading is allowed|maximum daily stake|growth rate and instrument)/i.test(
                        errorMessage || ''
                    );

                publishNativeError(errorMessage);
                setStatusMessage(errorMessage);
                pendingProposalRef.current = false;
                pendingTradeContextRef.current = null;

                if (openPositionLimitReached) {
                    stopTradingBot('Open position limit reached. Bot stopped until current contracts settle.', {
                        preserveOpenContract: false,
                    });
                    return;
                }

                if (sessionTradingLimitReached) {
                    stopTradingBot('Trading is blocked for this contract type in the current session. Bot stopped.', {
                        preserveOpenContract: false,
                    });
                    return;
                }

                if (activeContractsRef.current.size === 0) {
                    isProcessingRef.current = false;
                    run_panel?.setHasOpenContract?.(false);
                    run_panel?.setContractStage?.(
                        isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING
                    );
                }
                return;
            }

            if (data.msg_type === 'tick') handleTick(data.tick);

            if (data.msg_type === 'proposal_open_contract') {
                const openContract = data.proposal_open_contract;
                const contractKey = String(openContract?.contract_id ?? '');
                const normalizedStatus = String(openContract?.status || '').toLowerCase();
                const hasClosedStatus = Boolean(normalizedStatus) && normalizedStatus !== 'open';
                const isExpired =
                    openContract?.is_expired === 1 ||
                    openContract?.is_expired === true ||
                    openContract?.is_expired === '1';
                const isSettleable =
                    openContract?.is_settleable === 1 ||
                    openContract?.is_settleable === true ||
                    openContract?.is_settleable === '1';
                const isSold =
                    openContract?.is_sold === 1 ||
                    openContract?.is_sold === true ||
                    openContract?.is_sold === '1' ||
                    hasClosedStatus ||
                    isExpired ||
                    isSettleable;

                if (isSold && contractKey && activeContractsRef.current.has(contractKey)) {
                    handleContractCompletion(openContract);
                }
            }

            if (isRunningRef.current) {
                if (data.msg_type === 'proposal' && data.proposal) handleProposal(data);
                if (data.msg_type === 'buy') handleBuy(data);
            }
        },
        [handleBuy, handleContractCompletion, handleProposal, handleTick, publishNativeError, run_panel, stopTradingBot]
    );

    const connectTradingSocket = useCallback(
        async (options = {}) => {
            const { requireAuth = false, forceReconnect = false } = options;
            const wsReady = wsRef.current?.readyState;

            if (
                !forceReconnect &&
                (wsReady === WebSocket.OPEN || wsReady === WebSocket.CONNECTING || isConnectingRef.current)
            ) {
                return true;
            }

            if (forceReconnect && wsRef.current) {
                skipReconnectRef.current = true;
                const existingSocket = wsRef.current;
                wsRef.current = null;
                isAuthorizedRef.current = false;

                try {
                    existingSocket.close();
                } catch (error) {
                    console.error('[ElitePremium] Failed to close existing socket:', error);
                }
            }

            isConnectingRef.current = true;
            socketRequiresAuthRef.current = requireAuth;

            try {
                const authenticatedUrl = requireAuth ? await getAuthenticatedUrl() : null;

                if (requireAuth && !authenticatedUrl) {
                    setStatusMessage('Unable to create an authenticated Deriv session.');
                    return false;
                }

                const socketUrl = authenticatedUrl || DERIV_PUBLIC_WS_URL;
                const isAuthenticatedSocket = Boolean(authenticatedUrl);

                const socket = new WebSocket(socketUrl);
                wsRef.current = socket;

                socket.onopen = () => {
                    if (wsRef.current !== socket) return;

                    subscribeToTicks(socket);
                    isAuthorizedRef.current = isAuthenticatedSocket;

                    if (!isAuthenticatedSocket) {
                        setStatusMessage(previous =>
                            previous.startsWith('Matched') || previous.startsWith('Trade')
                                ? previous
                                : 'Scanner connected. Waiting for authenticated trading session.'
                        );
                    }
                };

                socket.onmessage = handleSocketMessage;

                socket.onerror = () => {
                    setStatusMessage('Connection error. Attempting to reconnect...');
                };

                socket.onclose = () => {
                    if (wsRef.current === socket) {
                        wsRef.current = null;
                    }
                    isAuthorizedRef.current = false;

                    const shouldReconnect = shouldReconnectRef.current && !skipReconnectRef.current;
                    skipReconnectRef.current = false;

                    if (shouldReconnect) {
                        reconnectTimeoutRef.current = window.setTimeout(() => {
                            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current });
                        }, 700);
                    }
                };

                return true;
            } catch (error) {
                setStatusMessage(`Trading connection failed: ${error.message}`);
                return false;
            } finally {
                isConnectingRef.current = false;
            }
        },
        [getAuthenticatedUrl, handleSocketMessage, subscribeToTicks]
    );

    useEffect(() => {
        shouldReconnectRef.current = true;
        const shouldRequireAuth = Boolean(getStoredAuthContext());
        connectTradingSocket({ requireAuth: shouldRequireAuth });

        const watchdogId = window.setInterval(() => {
            if (!shouldReconnectRef.current) return;
            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current });
        }, 1500);

        return () => {
            shouldReconnectRef.current = false;
            window.clearInterval(watchdogId);

            if (reconnectTimeoutRef.current) {
                window.clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }

            if (highlightTimeoutRef.current) {
                window.clearTimeout(highlightTimeoutRef.current);
                highlightTimeoutRef.current = null;
            }

            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [connectTradingSocket, getStoredAuthContext]);

    const validateBeforeStart = useCallback(() => {
        if (normalizeMoney(stakeRef.current, 0) <= 0) return 'Enter a valid stake.';
        if (normalizeMoney(targetProfitRef.current, 0) <= 0) return 'Enter a valid target profit.';
        if (normalizeMoney(stopLossRef.current, 0) <= 0) return 'Enter a valid stop loss.';

        for (let index = 0; index < strategiesRef.current.length; index += 1) {
            const strategy = strategiesRef.current[index];
            const strategyNumber = index + 1;
            const lookbackValue = Number.parseInt(strategy.lookback, 10);

            if (!Number.isInteger(lookbackValue) || lookbackValue < 1 || lookbackValue > 10) {
                return `Strategy ${strategyNumber} needs a lookback between 1 and 10.`;
            }

            if (requiresBarrier(strategy.trade)) {
                const barrier = Number.parseInt(strategy.barrier, 10);
                const minBarrier = strategy.trade === 'OVER' ? 0 : 1;
                const maxBarrier = strategy.trade === 'OVER' ? 8 : 9;

                if (!Number.isInteger(barrier) || barrier < minBarrier || barrier > maxBarrier) {
                    return `Strategy ${strategyNumber} needs a valid ${strategy.trade} barrier between ${minBarrier} and ${maxBarrier}.`;
                }
            }
        }

        return '';
    }, []);

    const handleStart = useCallback(async () => {
        if (!getStoredAuthContext()) {
            Swal.fire('Error', 'Login Required', 'error');
            return;
        }

        if (isRunning) {
            handleStop();
            return;
        }

        const validationMessage = validateBeforeStart();
        if (validationMessage) {
            Swal.fire('Check Settings', validationMessage, 'warning');
            return;
        }

        const baseStake = normalizeMoney(stakeRef.current);

        totalProfitRef.current = 0;
        nextStakeRef.current = baseStake;
        contractMetaRef.current = {};
        activeContractsRef.current.clear();
        isProcessingRef.current = false;
        pendingProposalRef.current = false;
        pendingTradeContextRef.current = null;
        setResults([]);
        setWins(0);
        setLosses(0);
        setTotalRuns(0);
        setTotalProfit(0);
        setNextStakeDisplay(baseStake);

        if (transactions?.clear) transactions.clear();
        if (summary_card?.clear) summary_card.clear();

        updateLastSignalLabel('Scanning ...');
        setStatusMessage(`Scanning ${strategiesRef.current.length} strategies across all volatility markets.`);

        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        if (run_panel) {
            run_panel.run_id = `elite-premium-${Date.now()}`;
        }
        run_panel?.toggleDrawer?.(true);
        run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

        setIsRunning(true);
        isRunningRef.current = true;

        const wsReady = wsRef.current?.readyState;
        if (wsRef.current && wsReady === WebSocket.OPEN && isAuthorizedRef.current) {
            return;
        }

        const didStartConnection = await connectTradingSocket({
            requireAuth: true,
            forceReconnect: Boolean(wsRef.current && !isAuthorizedRef.current),
        });

        if (!didStartConnection) {
            setIsRunning(false);
            isRunningRef.current = false;
            run_panel?.setIsRunning?.(false);
            run_panel?.setHasOpenContract?.(false);
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [
        connectTradingSocket,
        getStoredAuthContext,
        handleStop,
        isRunning,
        run_panel,
        summary_card,
        transactions,
        updateLastSignalLabel,
        validateBeforeStart,
    ]);

    useEffect(() => {
        const handleExternalStop = () => {
            if (!isRunningRef.current && activeContractsRef.current.size === 0) return;

            stopTradingBot('Bot stopped from the Deriv run panel.', {
                preserveOpenContract: activeContractsRef.current.size > 0,
            });
        };

        observer.register('bot.click_stop', handleExternalStop);

        return () => {
            if (observer.isRegistered('bot.click_stop')) {
                observer.unregister('bot.click_stop', handleExternalStop);
            }
        };
    }, [stopTradingBot]);

    useEffect(() => {
        observer.register('signalhub.start', handleStart);
        observer.register('signalhub.stop', handleStop);
        observer.register('elitepremium.start', handleStart);
        observer.register('elitepremium.stop', handleStop);

        return () => {
            if (observer.isRegistered('signalhub.start')) {
                observer.unregister('signalhub.start', handleStart);
            }
            if (observer.isRegistered('signalhub.stop')) {
                observer.unregister('signalhub.stop', handleStop);
            }
            if (observer.isRegistered('elitepremium.start')) {
                observer.unregister('elitepremium.start', handleStart);
            }
            if (observer.isRegistered('elitepremium.stop')) {
                observer.unregister('elitepremium.stop', handleStop);
            }
        };
    }, [handleStart, handleStop]);

    useEffect(() => {
        if (typeof document === 'undefined') return;

        if (run_panel?.active_index !== run_panel_tabs.JOURNAL) {
            setJournalMonitorTarget(null);
            return;
        }

        const frameId = window.requestAnimationFrame(() => {
            const target = document.getElementById(JOURNAL_SLOT_ID);
            setJournalMonitorTarget(target || null);
        });

        return () => {
            window.cancelAnimationFrame(frameId);
        };
    }, [run_panel?.active_index]);

    const addStrategy = () => {
        if (strategies.length >= MAX_STRATEGIES) return;
        setStrategies(previous => [...previous, createStrategy()]);
    };

    const removeStrategy = strategyId => {
        setStrategies(previous => {
            if (previous.length === 1) return previous;
            return previous.filter(strategy => strategy.id !== strategyId);
        });
    };

    const updateStrategy = (strategyId, field, value) => {
        setStrategies(previous =>
            previous.map(strategy => {
                if (strategy.id !== strategyId) return strategy;

                if (field === 'trade') {
                    return {
                        ...strategy,
                        trade: value,
                        barrier: requiresBarrier(value)
                            ? clampBarrierValue(value, strategy.barrier || getDefaultBarrier(value)) ||
                              getDefaultBarrier(value)
                            : '',
                    };
                }

                if (field === 'barrier') {
                    return {
                        ...strategy,
                        barrier: value === '' ? '' : clampBarrierValue(strategy.trade, value),
                    };
                }

                return {
                    ...strategy,
                    [field]: value,
                };
            })
        );
    };

    const renderCompactMonitor = (variant = 'main') => (
        <div className={`epf-monitor-grid epf-monitor-grid--${variant}`}>
            {ALL_SYMBOLS.map(symbol => {
                const digits = Array.isArray(liveDigits[symbol]) ? liveDigits[symbol] : [];
                const moves = Array.isArray(liveMoves[symbol]) ? liveMoves[symbol] : [];

                return (
                    <div
                        key={symbol}
                        className={`epf-monitor-card epf-monitor-card--${variant} ${
                            lastTriggeredSymbol === symbol ? 'epf-monitor-card--active' : ''
                        }`}
                    >
                        <div className='epf-monitor-card__top'>
                            <span className='epf-monitor-card__symbol'>{formatSymbolDisplay(symbol)}</span>
                            <span className='epf-monitor-card__tag'>
                                {lastTriggeredSymbol === symbol ? 'LIVE' : 'SCAN'}
                            </span>
                        </div>

                        <div className='epf-monitor-card__row'>
                            <span className='epf-monitor-card__label'>Digits</span>
                            <div className='epf-token-stream'>
                                {digits.length ? (
                                    digits.map((digit, index) => (
                                        <span
                                            key={`${symbol}-digit-${index}`}
                                            className={`epf-token ${digit > 4 ? 'epf-token--digit-high' : 'epf-token--digit-low'}`}
                                        >
                                            {digit}
                                        </span>
                                    ))
                                ) : (
                                    <span className='epf-token epf-token--empty'>--</span>
                                )}
                            </div>
                        </div>

                        <div className='epf-monitor-card__row'>
                            <span className='epf-monitor-card__label'>Moves</span>
                            <div className='epf-token-stream'>
                                {moves.length ? (
                                    moves.map((move, index) => (
                                        <span
                                            key={`${symbol}-move-${index}`}
                                            className={`epf-token ${
                                                move === 'RISE'
                                                    ? 'epf-token--rise'
                                                    : move === 'FALL'
                                                      ? 'epf-token--fall'
                                                      : 'epf-token--flat'
                                            }`}
                                        >
                                            {formatTokenMove(move)}
                                        </span>
                                    ))
                                ) : (
                                    <span className='epf-token epf-token--empty'>--</span>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );

    return (
        <div className='epf-shell'>
            {journalMonitorTarget ? createPortal(renderCompactMonitor('journal'), journalMonitorTarget) : null}

            <div className='epf-hero'>
                <h1 className='epf-hero__title'>
                    ELITE PRIME <span className='epf-hero__accent'>AI</span>
                </h1>
                <p className='epf-hero__description'>
                    A Multi-Strategy Trading Bot that allows you to execute upto 5 Strategies at Once. Example:{' '}
                    <strong>If the last 4 digits are ODD, trade EVEN</strong>. Rise/Fall uses market moves, while other
                    contracts uses Last Digits Analysis.
                </p>
            </div>

            <div className='epf-settings-grid'>
                <div className='epf-field'>
                    <label className='epf-field__label'>Stake ({client?.currency || 'USD'})</label>
                    <input
                        className='epf-field__control'
                        type='number'
                        step='0.01'
                        value={stake}
                        onChange={event => setStake(event.target.value)}
                        disabled={isRunning}
                    />
                </div>

                <div className='epf-field'>
                    <label className='epf-field__label'>Target Profit</label>
                    <input
                        className='epf-field__control'
                        type='number'
                        value={targetProfit}
                        onChange={event => setTargetProfit(event.target.value)}
                        disabled={isRunning}
                    />
                </div>

                <div className='epf-field'>
                    <label className='epf-field__label'>Stop Loss</label>
                    <input
                        className='epf-field__control'
                        type='number'
                        value={stopLoss}
                        onChange={event => setStopLoss(event.target.value)}
                        disabled={isRunning}
                    />
                </div>

                <div className='epf-field'>
                    <label className='epf-field__label'>Martingale</label>
                    <input
                        className='epf-field__control'
                        type='number'
                        step='0.1'
                        value={mFactor}
                        onChange={event => setMFactor(event.target.value)}
                        disabled={isRunning}
                    />
                </div>
            </div>

            <div className='epf-panel'>
                <div className='epf-panel__header'>
                    <h2 className='epf-panel__title'>
                        Strategy <span>Builder</span>
                    </h2>
                    <button
                        type='button'
                        className='epf-button epf-button--secondary'
                        onClick={addStrategy}
                        disabled={isRunning || strategies.length >= MAX_STRATEGIES}
                    >
                        ADD STRATEGY
                    </button>
                </div>

                <div className='epf-strategy-list'>
                    {strategies.map((strategy, index) => (
                        <div key={strategy.id} className='epf-strategy-card'>
                            <div className='epf-strategy-card__head'>
                                <div className='epf-strategy-card__meta'>
                                    <strong className='epf-strategy-card__name'>Strategy {index + 1}</strong>
                                    <span
                                        className={`epf-strategy-card__type ${isMoveCondition(strategy.condition) ? 'type--market' : 'type--digit'}`}
                                    >
                                        {isMoveCondition(strategy.condition) ? 'Uses Chart Move' : 'Checks Last Digits'}
                                    </span>
                                </div>

                                <button
                                    type='button'
                                    className='epf-button epf-button--danger'
                                    onClick={() => removeStrategy(strategy.id)}
                                    disabled={isRunning || strategies.length === 1}
                                >
                                    REMOVE
                                </button>
                            </div>

                            <div className='epf-strategy-rule'>
                                <span className='epf-strategy-rule__text'>If the last</span>
                                <input
                                    aria-label={`Strategy ${index + 1} lookback`}
                                    className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--lookback'
                                    type='number'
                                    min='1'
                                    max='10'
                                    value={strategy.lookback}
                                    onChange={event => updateStrategy(strategy.id, 'lookback', event.target.value)}
                                    disabled={isRunning}
                                />
                                <span className='epf-strategy-rule__text'>digits / moves are</span>
                                <select
                                    aria-label={`Strategy ${index + 1} condition`}
                                    className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--condition'
                                    value={strategy.condition}
                                    onChange={event => updateStrategy(strategy.id, 'condition', event.target.value)}
                                    disabled={isRunning}
                                >
                                    {CONDITION_TYPES.map(type => (
                                        <option key={type} value={type}>
                                            {type}
                                        </option>
                                    ))}
                                </select>
                                <span className='epf-strategy-rule__text'>then trade</span>
                                <select
                                    aria-label={`Strategy ${index + 1} trade`}
                                    className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--trade'
                                    value={strategy.trade}
                                    onChange={event => updateStrategy(strategy.id, 'trade', event.target.value)}
                                    disabled={isRunning}
                                >
                                    {CONDITION_TYPES.map(type => (
                                        <option key={`${strategy.id}-${type}`} value={type}>
                                            {type}
                                        </option>
                                    ))}
                                </select>

                                {requiresBarrier(strategy.trade) && (
                                    <>
                                        <span className='epf-strategy-rule__text'></span>
                                        <input
                                            aria-label={`Strategy ${index + 1} ${strategy.trade} barrier`}
                                            className='epf-field__control epf-strategy-rule__control epf-strategy-rule__control--barrier'
                                            type='number'
                                            min={strategy.trade === 'OVER' ? '0' : '1'}
                                            max={strategy.trade === 'OVER' ? '8' : '9'}
                                            value={strategy.barrier}
                                            onChange={event =>
                                                updateStrategy(strategy.id, 'barrier', event.target.value)
                                            }
                                            disabled={isRunning}
                                        />
                                    </>
                                )}
                            </div>

                            {/*  <p className='epf-strategy-preview'>{formatStrategySummary(strategy)}</p>*/}
                        </div>
                    ))}
                </div>
            </div>

            <div className='epf-cta-row'>
                <button
                    onClick={handleStart}
                    className={`epf-button epf-button--primary ${isRunning ? 'epf-button--stop' : ''}`}
                >
                    {isRunning ? <FaStop /> : <FaPlay />}
                    {isRunning ? ' STOP BOT' : ' EXECUTE STRATEGIES'}
                </button>
            </div>

            <div className='epf-status-grid'>
                <div className='epf-status-card'>
                    <span className='epf-status-card__label'>Status</span>
                    <strong className='epf-status-card__value'>{statusMessage}</strong>
                </div>
                <div className='epf-status-card'>
                    <span className='epf-status-card__label'>Last Signal</span>
                    <strong className='epf-status-card__value'>{lastSignalLabel}</strong>
                </div>
            </div>

            {renderCompactMonitor('main')}
        </div>
    );
};

export default ElitePremium;
