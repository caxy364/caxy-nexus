import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FaPlay, FaStop } from 'react-icons/fa';
import Swal from 'sweetalert2';

import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { observer } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';

import './Higherlower.css';

const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');
const JOURNAL_SLOT_ID = 'db-journal-custom-slot';
const SCAN_COOLDOWN_MS = 250;
const FIXED_DURATION_TICKS = 5;
const PRICE_HISTORY_LIMIT = 90;
const DIGIT_MONITOR_LIMIT = 6;
const FAST_MOMENTUM_WINDOW = 8;
const MARKET_SCAN_WINDOW = 16;
const MIN_MARKET_HISTORY = 12;
const MIN_READY_MARKETS = 4;
const AUTO_ENTRY_SCORE = 0.62;
const AUTO_ENTRY_LEAD = 0.015;
const HIGH_CONVICTION_SCORE = 0.76;

const CUSTOM_BARRIERS = [
    '1HZ10V',
    'B +/-0.09',
    'R_10',
    'B +/-0.06',
    
    '1HZ25V',
    'B +/-16.5',
    'R_25',
    'B +/-0.1',
    
    '1HZ50V',
    'B +/-13.0',
    'R_50',
    'B +/-0.0050',
    '1HZ75V',
    'B +/-0.28',
    'R_75',
    'B +/-2.7',
   
    '1HZ100V',
    'B +/-0.12',
    'R_100',
    'B +/-0.09',
];

const extractBarrierMagnitude = rawBarrier => {
    const text = String(rawBarrier ?? '').trim();
    const explicitMatch = text.match(/\+\/-\s*(\d*\.?\d+)/);
    if (explicitMatch?.[1]) return explicitMatch[1];

    const genericMatch = text.match(/(\d*\.?\d+)/);
    return genericMatch?.[1] || '';
};

const CUSTOM_BARRIER_MAP = CUSTOM_BARRIERS.reduce((map, entry, index, array) => {
    if (index % 2 !== 0) return map;

    const symbol = entry;
    const magnitude = extractBarrierMagnitude(array[index + 1]);
    const value = Number(magnitude);

    if (symbol && Number.isFinite(value)) {
        map[symbol] = { value, magnitude };
    }

    return map;
}, {});

const SYMBOLS = CUSTOM_BARRIERS.filter((_, index) => index % 2 === 0);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const formatBarrierValue = value => {
    if (!Number.isFinite(value)) return '0';
    return Number(value.toFixed(10)).toString();
};

const getBarrierMagnitudeText = (symbol, value) =>
    CUSTOM_BARRIER_MAP[symbol]?.magnitude || formatBarrierValue(Math.abs(value));

const getBarrierText = (symbol, value) => {
    const magnitude = getBarrierMagnitudeText(symbol, value);
    return magnitude ? `+/-${magnitude}` : '--';
};

const formatBarrier = (symbol, value, sign) => `${sign}${getBarrierMagnitudeText(symbol, value)}`;

const getLongestDirectionalStreak = moves => {
    let longest = 0;
    let current = 0;
    let previousDirection = 0;

    moves.forEach(move => {
        const direction = Math.sign(move);
        if (!direction) return;

        current = direction === previousDirection ? current + 1 : 1;
        longest = Math.max(longest, current);
        previousDirection = direction;
    });

    return longest;
};

const getMappedBarrier = symbol => CUSTOM_BARRIER_MAP[symbol]?.value || 0.3;

const getMoveMetrics = (moves, barrier) => {
    const actionableMoves = moves.filter(move => move !== 0);
    if (!actionableMoves.length) return null;

    const up = actionableMoves.filter(move => move > 0).length;
    const down = actionableMoves.filter(move => move < 0).length;
    const totalMovement = actionableMoves.reduce((sum, move) => sum + Math.abs(move), 0);
    const netMovement = actionableMoves.reduce((sum, move) => sum + move, 0);
    const avgMove = totalMovement / actionableMoves.length;
    const consistency = Math.max(up, down) / actionableMoves.length;
    const efficiency = totalMovement ? Math.abs(netMovement) / totalMovement : 0;
    const streak = getLongestDirectionalStreak(actionableMoves) / actionableMoves.length;
    const weightedNet = actionableMoves.reduce((sum, move, index, array) => {
        const weight = (index + 1) / array.length;
        return sum + move * weight;
    }, 0);
    const weightedMovement = actionableMoves.reduce((sum, move, index, array) => {
        const weight = (index + 1) / array.length;
        return sum + Math.abs(move) * weight;
    }, 0);
    const weightedEfficiency = weightedMovement ? Math.abs(weightedNet) / weightedMovement : 0;
    const impulse = avgMove ? clamp(Math.abs(actionableMoves[actionableMoves.length - 1]) / avgMove / 2, 0, 1.25) : 0;
    const bias = (up - down) / actionableMoves.length;
    const direction = netMovement >= 0 ? 'UP' : 'DOWN';
    const reach = clamp((avgMove * FIXED_DURATION_TICKS) / Math.max(barrier, 0.01), 0, 1.25);

    return {
        up,
        down,
        totalMovement,
        netMovement,
        avgMove,
        consistency,
        efficiency,
        weightedEfficiency,
        streak,
        impulse,
        bias,
        direction,
        reach,
    };
};

const getSignalDecision = (bestSignal, runnerUp, readyMarkets = 0) => {
    if (!bestSignal) {
        return { shouldTrade: false, lead: 0, reason: 'waiting' };
    }

    const lead = bestSignal.score - (runnerUp?.score ?? 0);
    const enoughMarketsReady = readyMarkets >= MIN_READY_MARKETS;
    const scoreFloor = enoughMarketsReady ? AUTO_ENTRY_SCORE : AUTO_ENTRY_SCORE + 0.04;
    const leadFloor =
        bestSignal.score >= HIGH_CONVICTION_SCORE
            ? AUTO_ENTRY_LEAD * 0.4
            : enoughMarketsReady
              ? AUTO_ENTRY_LEAD
              : AUTO_ENTRY_LEAD + 0.025;

    if (!enoughMarketsReady && bestSignal.score < HIGH_CONVICTION_SCORE) {
        return { shouldTrade: false, lead, reason: 'warming' };
    }

    if (bestSignal.score < scoreFloor) {
        return { shouldTrade: false, lead, reason: 'soft' };
    }

    if (lead < leadFloor) {
        return { shouldTrade: false, lead, reason: 'crowded' };
    }

    if (Math.abs(bestSignal.bias) < 0.15) {
        return { shouldTrade: false, lead, reason: 'flat' };
    }

    if (bestSignal.burstScore < 0.58 || bestSignal.pressure < 0.6) {
        return { shouldTrade: false, lead, reason: 'cooling' };
    }

    if (bestSignal.reach < 0.88 && bestSignal.burstReach < 0.92) {
        return { shouldTrade: false, lead, reason: 'barrier' };
    }

    return { shouldTrade: true, lead, reason: 'ready' };
};

const Higherlower = () => {
    const store = useStore();
    const { transactions, journal, summary_card, run_panel, client } = store || {};

    const [isRunning, setIsRunning] = useState(false);
    const [, setResults] = useState([]);
    const [, setWins] = useState(0);
    const [, setLosses] = useState(0);
    const [, setTotalRuns] = useState(0);
    const [, setTotalProfit] = useState(0);
    const [liveDigits, setLiveDigits] = useState({});
    const [momentumMap, setMomentumMap] = useState({});
    const [selectedSymbol, setSelectedSymbol] = useState('-');
    const [selectedBarrier, setSelectedBarrier] = useState('--');
    const [scanStatus, setScanStatus] = useState('Waiting for momentum scan...');
    const [lastTriggeredSymbol, setLastTriggeredSymbol] = useState(null);
    const [journalMonitorTarget, setJournalMonitorTarget] = useState(null);

    const [stake, setStake] = useState('1');
    const [targetProfit, setTargetProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [martingaleMode, setMartingaleMode] = useState('net');
    const [mFactor, setMFactor] = useState('2.5');

    const stakeRef = useRef('1');
    const targetProfitRef = useRef('100');
    const stopLossRef = useRef('100');
    const mFactorRef = useRef('1.8');
    const mModeRef = useRef('net');

    const wsRef = useRef(null);
    const isAuthorizedRef = useRef(false);
    const isConnectingRef = useRef(false);
    const shouldReconnectRef = useRef(true);
    const skipReconnectRef = useRef(false);
    const socketRequiresAuthRef = useRef(false);
    const totalProfitRef = useRef(0);
    const isRunningRef = useRef(false);
    const isProcessingRef = useRef(false);
    const activeContractsRef = useRef(new Set());
    const completedContractsRef = useRef(new Set());
    const nextStakeRef = useRef({ HIGHER: 1, LOWER: 1 });
    const priceHistoryRef = useRef({});
    const digitHistoryRef = useRef({});
    const contractMetaRef = useRef({});
    const tradeGroupRef = useRef({});
    const loggedContractResultsRef = useRef(new Set());
    const reconnectTimeoutRef = useRef(null);
    const lastScanAtRef = useRef(0);
    const pendingTradeContextsRef = useRef([]);
    const pendingProposalContextsRef = useRef(new Map());
    const transactionRecoveryTimeoutsRef = useRef(new Map());

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
        mModeRef.current = martingaleMode;
    }, [martingaleMode]);
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
        if (!isRunning) {
            const base = Number(parseFloat(stakeRef.current).toFixed(2)) || 1;
            nextStakeRef.current = { HIGHER: base, LOWER: base };
        }
    }, [stake, isRunning]);

    const formatSymbolDisplay = sym => {
        if (!sym) return '';
        if (sym.startsWith('1HZ')) return `${sym.replace('1HZ', '').replace('V', '')}(1s)`;
        if (sym.startsWith('R_')) return sym.replace('R_', 'V');
        return sym;
    };

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
            const isWon = contractData.result ? contractData.result === 'won' : contractData.profit > 0;
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
                accounts.find(acc => acc.account_id === activeLoginId) ||
                accounts.find(acc => acc.account_id?.startsWith('DOT')) ||
                accounts[0];

            if (!activeAccount?.account_id) return null;

            return {
                accessToken: access_token,
                activeAccount,
            };
        } catch (error) {
            console.error('[Higherlower] Failed to parse Deriv session storage:', error);
            return null;
        }
    }, []);

    const getAuthenticatedUrl = useCallback(async () => {
        try {
            const authContext = getStoredAuthContext();
            if (!authContext) throw new Error('Session Missing');

            const { accessToken, activeAccount } = authContext;
            const res = await fetch(`${DERIV_OPTIONS_API_URL}accounts/${activeAccount.account_id}/otp`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            });

            if (!res.ok) throw new Error('OTP Request Failed');

            const json = await res.json();
            const authenticatedUrl = json?.data?.url;

            if (!authenticatedUrl) throw new Error('Authenticated URL Missing');

            return authenticatedUrl;
        } catch (error) {
            publishNativeError(error.message);
            return null;
        }
    }, [getStoredAuthContext, publishNativeError]);

    const stopTradingBot = useCallback(
        (reason = 'Bot stopped.', options = {}) => {
            const { preserveOpenContract = activeContractsRef.current.size > 0 } = options;

            setIsRunning(false);
            isRunningRef.current = false;
            isProcessingRef.current = false;
            pendingTradeContextsRef.current = [];
            pendingProposalContextsRef.current.clear();
            tradeGroupRef.current = {};
            loggedContractResultsRef.current = new Set();
            setScanStatus(reason);

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
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            }
        },
        [run_panel]
    );

    const handleStop = useCallback(() => {
        stopTradingBot('Bot stopped.');
    }, [stopTradingBot]);

    const handleRunToggle = useCallback(() => {
        observer.emit(isRunningRef.current ? 'higherlower.stop' : 'higherlower.start');
    }, []);

    const syncTradeGroupOutcome = useCallback(
        groupId => {
            if (!groupId) return;
            const group = tradeGroupRef.current[groupId];
            if (!group) return;

            const settledContracts = Object.values(group.contracts || {});
            if (!settledContracts.length) return;

            const hasWinningContract = settledContracts.some(contract => parseFloat(contract.profit ?? 0) > 0);
            const isResolved = settledContracts.length >= 2;
            if (!hasWinningContract && !isResolved) return;

            const pairStatus = hasWinningContract ? 'won' : 'lost';
            const pairLabel = pairStatus === 'won' ? 'WIN' : 'LOSS';

            settledContracts.forEach(contract => {
                const pairedContract = { ...contract, result: pairStatus, status: pairStatus };
                publishNativeContract(pairedContract);

                if (!loggedContractResultsRef.current.has(contract.contract_id)) {
                    publishNativeResult(pairedContract);
                    loggedContractResultsRef.current.add(contract.contract_id);
                }
            });

            setResults(prev => prev.map(item => (group.contracts[item.id] ? { ...item, status: pairLabel } : item)));
        },
        [publishNativeContract, publishNativeResult]
    );

    const evaluateSymbolMomentum = useCallback(symbol => {
        const history = Array.isArray(priceHistoryRef.current[symbol]) ? priceHistoryRef.current[symbol] : [];
        if (history.length < MIN_MARKET_HISTORY) return null;

        const recent = history.slice(-(MARKET_SCAN_WINDOW + 1));
        const burst = history.slice(-(FAST_MOMENTUM_WINDOW + 1));
        const recentMoves = [];
        const burstMoves = [];
        const barrier = getMappedBarrier(symbol);

        for (let i = 1; i < recent.length; i++) {
            recentMoves.push(Number(recent[i]) - Number(recent[i - 1]));
        }

        for (let i = 1; i < burst.length; i++) {
            burstMoves.push(Number(burst[i]) - Number(burst[i - 1]));
        }

        const trendMetrics = getMoveMetrics(recentMoves, barrier);
        const burstMetrics = getMoveMetrics(burstMoves, barrier);
        if (!trendMetrics || !burstMetrics) return null;

        const directionAgreement = trendMetrics.direction === burstMetrics.direction ? 1 : 0;
        const burstScore = clamp(
            burstMetrics.consistency * 0.34 +
                burstMetrics.weightedEfficiency * 0.24 +
                burstMetrics.streak * 0.14 +
                Math.min(burstMetrics.reach, 1.1) * 0.2 +
                burstMetrics.impulse * 0.08,
            0,
            1
        );
        const adjustedScore = clamp(
            trendMetrics.consistency * 0.24 +
                trendMetrics.efficiency * 0.2 +
                trendMetrics.weightedEfficiency * 0.16 +
                trendMetrics.streak * 0.12 +
                Math.min(trendMetrics.reach, 1.05) * 0.14 +
                burstScore * 0.1 +
                directionAgreement * 0.04,
            0,
            0.995
        );
        const bias = burstMetrics.bias * 0.6 + trendMetrics.bias * 0.4;
        const reach = Math.max(trendMetrics.reach * 0.45 + burstMetrics.reach * 0.55, 0);
        const pressure = clamp(Math.abs(bias) * 0.42 + burstScore * 0.34 + Math.min(reach, 1) * 0.24, 0, 1);

        return {
            score: adjustedScore,
            burstScore,
            pressure,
            bias,
            direction: bias >= 0 ? 'UP' : 'DOWN',
            up: trendMetrics.up,
            down: trendMetrics.down,
            avgMove: trendMetrics.avgMove,
            barrier,
            reach,
            burstReach: burstMetrics.reach,
            readyDepth: history.length,
            directionAgreement,
        };
    }, []);

    const scanForMomentum = useCallback(() => {
        const nextMomentumMap = {};
        const rankedSignals = [];

        SYMBOLS.forEach(symbol => {
            const profile = evaluateSymbolMomentum(symbol);
            if (!profile) return;
            nextMomentumMap[symbol] = profile;
            rankedSignals.push({ symbol, ...profile });
        });

        setMomentumMap(nextMomentumMap);
        rankedSignals.sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            if (right.pressure !== left.pressure) return right.pressure - left.pressure;
            return right.burstScore - left.burstScore;
        });

        return {
            bestSignal: rankedSignals[0] || null,
            runnerUp: rankedSignals[1] || null,
            readyMarkets: rankedSignals.length,
        };
    }, [evaluateSymbolMomentum]);

    const executeHedgeTrade = useCallback((symbol, signal) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const higherStake = Number(nextStakeRef.current.HIGHER.toFixed(2));
        const lowerStake = Number(nextStakeRef.current.LOWER.toFixed(2));
        const higherBarrierValue = formatBarrier(symbol, signal.barrier, '+');
        const lowerBarrierValue = formatBarrier(symbol, signal.barrier, '-');
        const groupId = `hl-${symbol}-${Date.now()}`;

        const common = {
            proposal: 1,
            basis: 'stake',
            currency: client?.currency || 'USD',
            underlying_symbol: symbol,
            duration: FIXED_DURATION_TICKS,
            duration_unit: 't',
        };

        ws.send(
            JSON.stringify({
                ...common,
                amount: higherStake,
                contract_type: 'HIGHER',
                barrier: higherBarrierValue,
                passthrough: {
                    custom_type: 'HIGHER',
                    symbol,
                    sent_stake: higherStake,
                    barrier: higherBarrierValue,
                    momentum_score: signal.score,
                    momentum_direction: signal.direction,
                    group_id: groupId,
                },
            })
        );

        ws.send(
            JSON.stringify({
                ...common,
                amount: lowerStake,
                contract_type: 'LOWER',
                barrier: lowerBarrierValue,
                passthrough: {
                    custom_type: 'LOWER',
                    symbol,
                    sent_stake: lowerStake,
                    barrier: lowerBarrierValue,
                    momentum_score: signal.score,
                    momentum_direction: signal.direction,
                    group_id: groupId,
                },
            })
        );
    }, [client?.currency]);

    const handleProposal = useCallback(
        data => {
            const proposalId = data.proposal?.id;
            const askPrice = data.proposal?.ask_price;
            const passthrough = data.proposal?.passthrough || data.echo_req?.passthrough;

            if (!proposalId || askPrice === undefined) {
                publishNativeError('Proposal received without a valid id or ask price.');
                if (activeContractsRef.current.size === 0) {
                    isProcessingRef.current = false;
                    run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
                }
                return;
            }

            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
            if (passthrough) {
                pendingTradeContextsRef.current.push(passthrough);
                pendingProposalContextsRef.current.set(String(proposalId), passthrough);
            }
            wsRef.current?.send(
                JSON.stringify({
                    buy: proposalId,
                    price: askPrice,
                })
            );
        },
        [publishNativeError, run_panel]
    );

    const handleBuy = useCallback(
        data => {
            if (data.error) {
                isProcessingRef.current = false;
                activeContractsRef.current.clear();
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
                publishNativeError(data.error.message);
                return;
            }

            const { contract_id, transaction_id, buy_price, longcode } = data.buy || {};
            const proposalId = data.echo_req?.buy;
            const proposalKey = String(proposalId ?? '');
            const passthrough =
                (proposalId ? pendingProposalContextsRef.current.get(proposalKey) : null) ||
                pendingTradeContextsRef.current.shift() ||
                {};
            const { symbol, custom_type, sent_stake, group_id, barrier } = passthrough;

            if (proposalId) {
                pendingProposalContextsRef.current.delete(proposalKey);
            }

            if (!contract_id || !symbol || !custom_type) return;

            activeContractsRef.current.add(String(contract_id));

            const transactionPayload = {
                id: contract_id,
                contract_id,
                transaction_ids: { buy: transaction_id },
                buy_price: buy_price ?? parseFloat(sent_stake),
                currency: client?.currency || 'USD',
                display_name: formatSymbolDisplay(symbol),
                underlying: symbol,
                underlying_symbol: symbol,
                contract_type: custom_type,
                barrier,
                longcode,
                date_start: Math.floor(Date.now() / 1000),
                group_id,
                status: 'open',
                is_sold: false,
                entry_spot: '-',
            };

            contractMetaRef.current[String(contract_id)] = transactionPayload;
            publishNativeContract(transactionPayload);
            run_panel?.setHasOpenContract?.(true);
            run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);

            setResults(prev => [
                {
                    id: contract_id,
                    symbol,
                    contract_type: custom_type,
                    entry_spot: '-',
                    exit_spot: '-',
                    profit: 0,
                    stake: parseFloat(sent_stake).toFixed(2),
                    status: 'PENDING',
                },
                ...prev,
            ]);

            wsRef.current?.send(JSON.stringify({ proposal_open_contract: 1, contract_id, subscribe: 1 }));
        },
        [client?.currency, publishNativeContract, publishNativeError, run_panel]
    );

    const handleContractCompletion = useCallback(
        contract => {
            const profit = parseFloat(contract.profit ?? 0);
            const contractId = contract.contract_id;
            const factor = parseFloat(mFactorRef.current);
            const baseStake = Number(parseFloat(stakeRef.current).toFixed(2));
            const contractKey = String(contractId);
            const meta = contractMetaRef.current[contractKey] || {};
            const side = meta.contract_type === 'HIGHER' ? 'HIGHER' : 'LOWER';
            const groupId = meta.group_id;

            if (mModeRef.current === 'split') {
                if (profit < 0) {
                    const nextValue = nextStakeRef.current[side] * factor;
                    nextStakeRef.current[side] = Number(nextValue.toFixed(2));
                } else {
                    nextStakeRef.current[side] = baseStake;
                }
            }

            totalProfitRef.current += profit;
            activeContractsRef.current.delete(contractKey);
            completedContractsRef.current.add(contractKey);

            const nativeContract = {
                ...meta,
                ...contract,
                id: contractId,
                contract_id: contractId,
                buy_price: contract.buy_price ?? meta.buy_price ?? 0,
                currency: contract.currency || client?.currency || 'USD',
                display_name:
                    contract.display_name ||
                    formatSymbolDisplay(contract.underlying_symbol || contract.underlying || meta.underlying_symbol),
                underlying_symbol: contract.underlying_symbol || contract.underlying || meta.underlying_symbol,
                underlying: contract.underlying || meta.underlying_symbol,
                transaction_ids: meta.transaction_ids || contract.transaction_ids,
                result: profit > 0 ? 'won' : 'lost',
                status: profit > 0 ? 'won' : 'lost',
            };

            if (groupId) {
                tradeGroupRef.current[groupId] = tradeGroupRef.current[groupId] || { contracts: {} };
                tradeGroupRef.current[groupId].contracts[contractId] = nativeContract;
            } else {
                publishNativeContract(nativeContract);
                publishNativeResult(nativeContract);
            }

            setResults(prev =>
                prev.map(r =>
                    r.id === contractId
                        ? {
                              ...r,
                              entry_spot: contract.entry_spot_display_value ?? '-',
                              exit_spot: contract.exit_tick_display_value ?? '-',
                              profit,
                              status: profit > 0 ? 'WIN' : 'LOSS',
                          }
                        : r
                )
            );

            if (groupId) {
                syncTradeGroupOutcome(groupId);
            }

            setTotalProfit(totalProfitRef.current.toFixed(2));
            if (profit > 0) setWins(prev => prev + 1);
            else setLosses(prev => prev + 1);
            setTotalRuns(prev => prev + 1);

            if (activeContractsRef.current.size === 0) {
                isProcessingRef.current = false;
                lastScanAtRef.current = 0;

                if (mModeRef.current === 'net') {
                    setResults(current => {
                        const lastTwo = current.slice(0, 2);
                        const combinedProfit = lastTwo.reduce((acc, item) => acc + (parseFloat(item.profit) || 0), 0);

                        if (combinedProfit < 0) {
                            const higher = nextStakeRef.current.HIGHER * factor;
                            const lower = nextStakeRef.current.LOWER * factor;
                            nextStakeRef.current.HIGHER = Number(higher.toFixed(2));
                            nextStakeRef.current.LOWER = Number(lower.toFixed(2));
                        } else {
                            nextStakeRef.current = { HIGHER: baseStake, LOWER: baseStake };
                        }
                        return current;
                    });
                }

                const limitHit =
                    totalProfitRef.current >= parseFloat(targetProfitRef.current) ||
                    totalProfitRef.current <= -parseFloat(stopLossRef.current);

                if (limitHit) {
                    stopTradingBot('Session ended by target/stop loss.', { preserveOpenContract: false });
                    Swal.fire('Session Ended', `Final P/L: ${totalProfitRef.current.toFixed(2)} USD`, 'info');
                } else {
                    run_panel?.setHasOpenContract?.(false);
                    run_panel?.setContractStage?.(
                        isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING
                    );
                }
            }
        },
        [client?.currency, publishNativeContract, publishNativeResult, run_panel, stopTradingBot, syncTradeGroupOutcome]
    );

    const handleTick = useCallback(
        tick => {
            const { symbol, quote } = tick || {};
            if (!symbol || typeof quote === 'undefined') return;

            const currentDigit = parseInt(String(quote).slice(-1), 10);
            if (!digitHistoryRef.current[symbol]) digitHistoryRef.current[symbol] = [];
            digitHistoryRef.current[symbol].push(currentDigit);
            if (digitHistoryRef.current[symbol].length > DIGIT_MONITOR_LIMIT) {
                digitHistoryRef.current[symbol].shift();
            }
            setLiveDigits(prev => ({
                ...prev,
                [symbol]: [...digitHistoryRef.current[symbol]],
            }));

            if (!priceHistoryRef.current[symbol]) priceHistoryRef.current[symbol] = [];
            priceHistoryRef.current[symbol].push(Number(quote));
            if (priceHistoryRef.current[symbol].length > PRICE_HISTORY_LIMIT) {
                priceHistoryRef.current[symbol].shift();
            }

            const profile = evaluateSymbolMomentum(symbol);
            if (profile) {
                setMomentumMap(prev => ({ ...prev, [symbol]: profile }));
            }

            if (!isRunningRef.current || activeContractsRef.current.size > 0 || isProcessingRef.current) return;

            const now = Date.now();
            if (now - lastScanAtRef.current < SCAN_COOLDOWN_MS) return;
            lastScanAtRef.current = now;

            const scanResult = scanForMomentum();
            const readyMarkets = scanResult?.readyMarkets ?? 0;
            if (!scanResult?.bestSignal) {
                if (readyMarkets > 0) {
                    setScanStatus(`Ranking live momentum... ${readyMarkets}/${SYMBOLS.length} markets are ready.`);
                } else {
                    setScanStatus('Collecting live tick data for the first momentum leader...');
                }
                return;
            }

            const { bestSignal, runnerUp } = scanResult;
            const formattedSymbol = formatSymbolDisplay(bestSignal.symbol);
            const barrierLabel = getBarrierText(bestSignal.symbol, bestSignal.barrier);
            const decision = getSignalDecision(bestSignal, runnerUp, readyMarkets);

            setSelectedSymbol(formattedSymbol);
            setSelectedBarrier(barrierLabel);

            if (!decision.shouldTrade) {
                if (decision.reason === 'warming') {
                    setScanStatus(
                        `Live leader is ${formattedSymbol}, but only ${readyMarkets}/${SYMBOLS.length} markets are ready. Waiting for stronger confirmation.`
                    );
                } else if (decision.reason === 'crowded') {
                    setScanStatus(
                        `${formattedSymbol} is leading, but the field is still tight. Lead: ${(decision.lead * 100).toFixed(1)}%.`
                    );
                } else if (decision.reason === 'cooling') {
                    setScanStatus(
                        `${formattedSymbol} is moving fast, but the latest burst is cooling before entry. Pressure ${(bestSignal.pressure * 100).toFixed(1)}%.`
                    );
                } else if (decision.reason === 'barrier') {
                    setScanStatus(
                        `${formattedSymbol} has direction, but price flow is still weak for barrier ${barrierLabel}.`
                    );
                } else if (decision.reason === 'flat') {
                    setScanStatus(`${formattedSymbol} is active, but directional bias is still too flat.`);
                } else {
                    setScanStatus(
                        `${formattedSymbol} is best right now, but live quality is only ${(bestSignal.score * 100).toFixed(1)}%.`
                    );
                }
                return;
            }

            isProcessingRef.current = true;
            setLastTriggeredSymbol(bestSignal.symbol);
            setScanStatus(
                `Locked on ${formattedSymbol} with barrier ${barrierLabel} (${bestSignal.direction}, ${(bestSignal.score * 100).toFixed(1)}%, pressure ${(bestSignal.pressure * 100).toFixed(1)}%). Executing hedge...`
            );
            executeHedgeTrade(bestSignal.symbol, bestSignal);
            setTimeout(() => setLastTriggeredSymbol(null), 2000);
        },
        [evaluateSymbolMomentum, executeHedgeTrade, scanForMomentum]
    );

    const handleSocketMessage = useCallback(
        event => {
            const data = JSON.parse(event.data);
            if (data.error) {
                publishNativeError(data.error.message);
                pendingTradeContextsRef.current = [];
                if (activeContractsRef.current.size === 0) {
                    isProcessingRef.current = false;
                }
            }

            if (data.msg_type === 'tick') handleTick(data.tick);

            if (data.msg_type === 'authorize') {
                isAuthorizedRef.current = true;
                return;
            }

            if (data.msg_type === 'transaction') {
                const action = data.transaction?.action;
                const sellContractId = data.transaction?.contract_id;
                const contractKey = String(sellContractId ?? '');

                if (action !== 'sell' || !sellContractId || !activeContractsRef.current.has(contractKey)) {
                    return;
                }

                if (completedContractsRef.current.has(contractKey)) {
                    return;
                }

                if (transactionRecoveryTimeoutsRef.current.has(contractKey)) {
                    clearTimeout(transactionRecoveryTimeoutsRef.current.get(contractKey));
                }

                const recoveryTimeoutId = window.setTimeout(() => {
                    transactionRecoveryTimeoutsRef.current.delete(contractKey);

                    if (
                        !activeContractsRef.current.has(contractKey) ||
                        completedContractsRef.current.has(contractKey) ||
                        wsRef.current?.readyState !== WebSocket.OPEN
                    ) {
                        return;
                    }

                    wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id: sellContractId }));
                }, 1500);

                transactionRecoveryTimeoutsRef.current.set(contractKey, recoveryTimeoutId);
                return;
            }

            if (data.msg_type === 'proposal_open_contract') {
                const c = data.proposal_open_contract;
                const contractKey = String(c?.contract_id ?? '');
                const normalizedStatus = String(c?.status || '').toLowerCase();
                const hasClosedStatus = Boolean(normalizedStatus) && normalizedStatus !== 'open';
                const isExpired = c?.is_expired === 1 || c?.is_expired === true || c?.is_expired === '1';
                const isSettleable = c?.is_settleable === 1 || c?.is_settleable === true || c?.is_settleable === '1';
                const isSold =
                    c?.is_sold === 1 ||
                    c?.is_sold === true ||
                    c?.is_sold === '1' ||
                    hasClosedStatus ||
                    isExpired ||
                    isSettleable;

                if (c) {
                    const meta = contractMetaRef.current[contractKey] || {};
                    publishNativeContract({
                        ...meta,
                        ...c,
                        id: c.contract_id,
                        contract_id: c.contract_id,
                        buy_price: c.buy_price ?? meta.buy_price ?? 0,
                        currency: c.currency || client?.currency || 'USD',
                        display_name:
                            c.display_name ||
                            formatSymbolDisplay(c.underlying_symbol || c.underlying || meta.underlying_symbol),
                        underlying_symbol: c.underlying_symbol || c.underlying || meta.underlying_symbol,
                        underlying: c.underlying || meta.underlying_symbol,
                        transaction_ids: meta.transaction_ids || c.transaction_ids,
                        entry_spot: c.entry_spot_display_value ?? c.entry_spot ?? '-',
                        exit_spot: isSold
                            ? c.exit_tick_display_value ?? c.exit_spot_display_value ?? c.exit_tick ?? c.exit_spot ?? '-'
                            : undefined,
                        is_sold: isSold,
                        status: isSold ? (parseFloat(c.profit ?? 0) > 0 ? 'won' : 'lost') : c.status || 'open',
                        result: isSold ? (parseFloat(c.profit ?? 0) > 0 ? 'won' : 'lost') : undefined,
                    });
                }

                if (c && isSold && activeContractsRef.current.has(contractKey) && !completedContractsRef.current.has(contractKey)) {
                    handleContractCompletion(c);
                }
                return;
            }

            if (isRunningRef.current) {
                if (data.msg_type === 'proposal' && data.proposal) handleProposal(data);
                if (data.msg_type === 'buy') handleBuy(data);
            }
        },
        [client?.currency, handleBuy, handleContractCompletion, handleProposal, handleTick, publishNativeContract, publishNativeError]
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
                    console.error('[Higherlower] Failed to close existing socket:', error);
                }
            }

            isConnectingRef.current = true;
            socketRequiresAuthRef.current = requireAuth;

            try {
                const authenticatedUrl = requireAuth ? await getAuthenticatedUrl() : null;

                if (requireAuth && !authenticatedUrl) {
                    return false;
                }

                const socketUrl = authenticatedUrl || DERIV_PUBLIC_WS_URL;
                const isAuthenticatedSocket = Boolean(authenticatedUrl);

                wsRef.current = new WebSocket(socketUrl);
                wsRef.current.onopen = () => {
                    isAuthorizedRef.current = isAuthenticatedSocket;
                    SYMBOLS.forEach(symbol => wsRef.current.send(JSON.stringify({ ticks: symbol, subscribe: 1 })));

                    if (isAuthenticatedSocket) {
                        wsRef.current.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
                        activeContractsRef.current.forEach(activeContractId => {
                            wsRef.current.send(
                                JSON.stringify({
                                    proposal_open_contract: 1,
                                    contract_id: Number(activeContractId),
                                    subscribe: 1,
                                })
                            );
                        });
                    }
                };
                wsRef.current.onmessage = handleSocketMessage;
                wsRef.current.onclose = () => {
                    isAuthorizedRef.current = false;
                    wsRef.current = null;
                    const shouldReconnect = shouldReconnectRef.current && !skipReconnectRef.current;
                    skipReconnectRef.current = false;
                    if (shouldReconnect) {
                        reconnectTimeoutRef.current = window.setTimeout(() => {
                            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current });
                        }, 700);
                    }
                };
                return true;
            } finally {
                isConnectingRef.current = false;
            }
        },
        [getAuthenticatedUrl, handleSocketMessage]
    );

    useEffect(() => {
        shouldReconnectRef.current = true;
        const shouldRequireAuth = Boolean(getStoredAuthContext());
        connectTradingSocket({ requireAuth: shouldRequireAuth });

        const watchdogId = window.setInterval(() => {
            if (!shouldReconnectRef.current) return;
            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current || shouldRequireAuth });
        }, 1500);

        return () => {
            shouldReconnectRef.current = false;
            if (reconnectTimeoutRef.current) {
                window.clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
            window.clearInterval(watchdogId);
            if (wsRef.current) {
                skipReconnectRef.current = true;
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [connectTradingSocket, getStoredAuthContext]);

    const handleStart = useCallback(async () => {
        if (!getStoredAuthContext()) {
            Swal.fire('Error', 'Login Required', 'error');
            return;
        }

        if (isRunning) {
            handleStop();
            return;
        }

        totalProfitRef.current = 0;
        setResults([]);
        setWins(0);
        setLosses(0);
        setTotalRuns(0);
        setTotalProfit(0);
        setSelectedSymbol('-');
        setSelectedBarrier('--');
        setScanStatus('Tracking the strongest live momentum across volatility markets...');
        lastScanAtRef.current = 0;
        contractMetaRef.current = {};
        tradeGroupRef.current = {};
        loggedContractResultsRef.current = new Set();
        completedContractsRef.current.clear();
        pendingTradeContextsRef.current = [];
        pendingProposalContextsRef.current.clear();

        const base = Number(parseFloat(stakeRef.current).toFixed(2)) || 1;
        nextStakeRef.current = { HIGHER: base, LOWER: base };

        if (transactions?.clear) transactions.clear();
        if (summary_card?.clear) summary_card.clear();

        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        if (run_panel) {
            run_panel.run_id = `higherlower-${Date.now()}`;
        }
        run_panel?.toggleDrawer?.(true);
        run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

        setIsRunning(true);
        isRunningRef.current = true;

        const wsReady = wsRef.current?.readyState;
        if (wsRef.current && wsReady === WebSocket.OPEN && isAuthorizedRef.current) {
            return;
        }

        const didConnect = await connectTradingSocket({
            requireAuth: true,
            forceReconnect: Boolean(wsRef.current && !isAuthorizedRef.current),
        });

        if (!didConnect) {
            setIsRunning(false);
            isRunningRef.current = false;
            run_panel?.setIsRunning?.(false);
            run_panel?.setHasOpenContract?.(false);
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [connectTradingSocket, getStoredAuthContext, handleStop, isRunning, run_panel, summary_card, transactions]);

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
        observer.register('higherlower.start', handleStart);
        observer.register('higherlower.stop', handleStop);

        return () => {
            if (observer.isRegistered('higherlower.start')) {
                observer.unregister('higherlower.start', handleStart);
            }
            if (observer.isRegistered('higherlower.stop')) {
                observer.unregister('higherlower.stop', handleStop);
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

        return () => window.cancelAnimationFrame(frameId);
    }, [run_panel?.active_index]);

    const renderCompactMonitor = (variant = 'panel') => (
        <div className={`hl-compact-row ${variant === 'journal' ? 'hl-compact-row--journal' : ''}`}>
            {SYMBOLS.map(symbol => {
                const profile = momentumMap[symbol];
                const direction = profile?.direction || '--';
                const score = Number.isFinite(profile?.score) ? `${(profile.score * 100).toFixed(0)}%` : '--';
                const barrier = Number.isFinite(profile?.barrier)
                    ? `B ${getBarrierText(symbol, profile.barrier)}`
                    : 'B --';
                const digits = Array.isArray(liveDigits[symbol]) ? liveDigits[symbol] : [];

                return (
                    <div
                        key={symbol}
                        className={`hl-mini-card ${lastTriggeredSymbol === symbol ? 'hl-mini-card--active' : ''}`}
                    >
                        <div className='hl-mini-top'>
                            <span className='hl-mini-symbol'>{formatSymbolDisplay(symbol)}</span>
                            <span
                                className={`hl-mini-score ${direction === 'UP' ? 'up' : direction === 'DOWN' ? 'down' : ''}`}
                            >
                                {direction} {score}
                            </span>
                        </div>
                        <div className='hl-mini-detail'>{barrier}</div>
                        <div className='hl-mini-digits'>
                            {digits.map((digit, index) => (
                                <span
                                    key={`${symbol}-${index}`}
                                    className={`hl-mini-digit ${digit >= 5 ? 'hl-mini-digit--hot' : ''}`}
                                >
                                    {digit}
                                </span>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );

    return (
        <div className='hl-tool'>
            {journalMonitorTarget ? createPortal(renderCompactMonitor('journal'), journalMonitorTarget) : null}

            <div className='hl-header'>
                <div className='hl-header-top'>
                    <span className='hl-header-kicker'>Higher / Lower Hedger</span>
                    <span className={`hl-header-state ${isRunning ? 'is-live' : 'is-idle'}`}>
                        {isRunning ? 'LIVE SCAN' : 'STANDBY'}
                    </span>
                </div>
           
                <p>
                    Scans all volatility markets, then enters a fixed 5-tick
                    Higher/Lower hedge on the cleanest market.
                </p>
            </div>

            <div className='hl-settings-grid'>
                <div className='hl-input-group hl-input-group--third'>
                    <label>Stake </label>
                    <input
                        type='number'
                        step='0.01'
                        value={stake}
                        onChange={e => setStake(e.target.value)}
                        disabled={isRunning}
                    />
                </div>

                <div className='hl-input-group hl-input-group--third'>
                    <label>Target Profit</label>
                    <input
                        type='number'
                        value={targetProfit}
                        onChange={e => setTargetProfit(e.target.value)}
                        disabled={isRunning}
                    />
                </div>

                <div className='hl-input-group hl-input-group--third'>
                    <label>Stop Loss</label>
                    <input
                        type='number'
                        value={stopLoss}
                        onChange={e => setStopLoss(e.target.value)}
                        disabled={isRunning}
                    />
                </div>

                <div className='hl-input-group hl-input-group--half'>
                    <label>Martingale Mode</label>
                    <select
                        value={martingaleMode}
                        onChange={e => setMartingaleMode(e.target.value)}
                        disabled={isRunning}
                    >
                        <option value='net'>When BOTH lose</option>
                        <option value='split'>On every loss</option>
                    </select>
                </div>

                <div className='hl-input-group hl-input-group--half'>
                    <label>Multiplier</label>
                    <input
                        type='number'
                        step='0.1'
                        value={mFactor}
                        onChange={e => setMFactor(e.target.value)}
                        disabled={isRunning}
                    />
                </div>
            </div>

            <div className='hl-actions'>
                <button onClick={handleRunToggle} className={`hl-run-button ${isRunning ? 'is-stop' : ''}`}>
                    {isRunning ? <FaStop /> : <FaPlay />}
                    {isRunning ? ' STOP BOT' : ' START BOT'}
                </button>
            </div>

            <div className='hl-meta-strip'>
                <div className='hl-meta-item'>
                    <span>Duration</span>
                    <strong>{FIXED_DURATION_TICKS} ticks</strong>
                </div>
                <div className='hl-meta-item'>
                    <span>Selected market</span>
                    <strong>{selectedSymbol}</strong>
                </div>
                <div className='hl-meta-item'>
                    <span>Active barrier</span>
                    <strong>{selectedBarrier}</strong>
                </div>
                <div className='hl-meta-item hl-meta-item--status'>
                    <span>Status</span>
                    <strong>{scanStatus}</strong>
                </div>
            </div>

            {renderCompactMonitor()}
        </div>
    );
};

export default Higherlower;
