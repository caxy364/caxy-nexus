import React, { useCallback, useEffect, useRef, useState } from 'react';
import Swal from 'sweetalert2';
import { FaPlay, FaStop } from 'react-icons/fa';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import './PairedBot.css';
const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');
const SYMBOLS = [
    '1HZ10V',
    'R_10',
    '1HZ25V',
    'R_25',
    '1HZ50V',
    'R_50',
    '1HZ75V',
    'R_75',
    '1HZ100V',
    'R_100',
];
const LEG_KEYS = ['A', 'B'];
const DURATION_UNIT_LABELS = { t: 'Ticks', m: 'Minutes' };
const PROPOSAL_PAIR_MAX_SKEW_MS = 1500;
const PAIR_CONFIGS = {
    HIGH_LOW_TICK: {
        label: 'High Tick / Low Tick',
        description: 'A fixed five-tick pair. The selected tick is judged as the highest or lowest of the next five ticks.',
        fixedDuration: 5,
        durationUnits: ['t'],
        fields: [
            { key: 'selectedTick', label: 'Selected tick (1-5)', type: 'number', min: 1, max: 5, step: 1 },
        ],
        defaults: { selectedTick: '3' },
        legs: {
            A: { label: 'High Tick', contractType: 'TICKHIGH' },
            B: { label: 'Low Tick', contractType: 'TICKLOW' },
        },
    },
    TOUCH_NO_TOUCH: {
        label: 'Touch / No Touch',
        description: 'Both legs use the same barrier offset from entry: one wins on touch and the other wins when it is not touched.',
        durationUnits: ['t', 'm'],
        fields: [
            { key: 'duration', label: 'Duration', type: 'number', min: 2, step: 1 },
            { key: 'barrier', label: 'Barrier offset', type: 'number', step: 'any' },
        ],
        defaults: { duration: '5', barrier: '0.1' },
        barrierMode: 'single',
        legs: {
            A: { label: 'Touch', contractType: 'ONETOUCH' },
            B: { label: 'No Touch', contractType: 'NOTOUCH' },
        },
    },
    ENDS_BETWEEN_OUTSIDE: {
        label: 'Ends Between / Ends Outside',
        description: 'Both legs use the same low/high offsets: one wins inside the range and the other wins outside it.',
        durationUnits: ['t', 'm'],
        fields: [
            { key: 'duration', label: 'Duration', type: 'number', min: 2, step: 1 },
            { key: 'lowBarrier', label: 'Low barrier offset', type: 'number', step: 'any' },
            { key: 'highBarrier', label: 'High barrier offset', type: 'number', step: 'any' },
        ],
        defaults: { duration: '5', lowBarrier: '0.1', highBarrier: '0.2' },
        barrierMode: 'range',
        legs: {
            A: { label: 'Ends Between', contractType: 'EXPIRYRANGE' },
            B: { label: 'Ends Outside', contractType: 'EXPIRYMISS' },
        },
    },
    STAYS_BETWEEN_GOES_OUTSIDE: {
        label: 'Stays Between / Goes Outside',
        description: 'Both legs use the same low/high offsets: one wins while price stays inside and the other when either barrier is touched.',
        durationUnits: ['t', 'm'],
        fields: [
            { key: 'duration', label: 'Duration', type: 'number', min: 2, step: 1 },
            { key: 'lowBarrier', label: 'Low barrier offset', type: 'number', step: 'any' },
            { key: 'highBarrier', label: 'High barrier offset', type: 'number', step: 'any' },
        ],
        defaults: { duration: '5', lowBarrier: '0.1', highBarrier: '0.2' },
        barrierMode: 'range',
        legs: {
            A: { label: 'Stays Between', contractType: 'RANGE' },
            B: { label: 'Goes Outside', contractType: 'UPORDOWN' },
        },
    },
    HIGHER_LOWER: {
        label: 'Higher / Lower',
        description: 'The two legs use symmetrical offsets: Higher uses +offset and Lower uses -offset from entry.',
        durationUnits: ['t', 'm'],
        fields: [
            { key: 'duration', label: 'Duration', type: 'number', min: 2, step: 1 },
            { key: 'barrierOffset', label: 'Barrier offset', type: 'number', step: 'any' },
        ],
        defaults: { duration: '5', barrierOffset: '0.1' },
        barrierMode: 'directional',
        legs: {
            A: { label: 'Higher', contractType: 'HIGHER' },
            B: { label: 'Lower', contractType: 'LOWER' },
        },
    },
};
const formatSymbol = symbol => {
    if (!symbol) return '';
    if (symbol.startsWith('1HZ')) return `${symbol.replace('1HZ', '').replace('V', '')}(1s)`;
    if (symbol.startsWith('R_')) return symbol.replace('R_', 'V');
    return symbol;
};
const numberOrNull = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};
const decimalPlaces = value => {
    const text = String(value);
    if (text.includes('e-')) return Number(text.split('e-')[1]);
    return text.includes('.') ? text.split('.')[1].length : 0;
};
const getSynchronizedOffset = (inputOffset, pipSize, forcedSign) => {
    const offset = numberOrNull(inputOffset);
    const step = numberOrNull(pipSize);
    if (offset === null || step === null || step <= 0) return null;
    const roundedOffset = Math.round(Math.abs(offset) / step) * step;
    if (!Number.isFinite(roundedOffset) || roundedOffset <= 0) return null;
    const precision = Math.max(4, decimalPlaces(step));
    const sign = forcedSign || (String(inputOffset).trim().startsWith('-') ? '-' : '+');
    return `${sign}${roundedOffset.toFixed(precision)}`;
};
const signedOffset = value => {
    const text = String(value ?? '').trim();
    return /^[+-]/.test(text) ? text : `+${text}`;
};
const formatSignedOffset = (value, forcedSign) => {
    const parsed = numberOrNull(value);
    if (parsed === null) return '--';
    return forcedSign ? forcedSign + Math.abs(parsed) : signedOffset(parsed);
};
const getBarrierCount = config => {
    if (config.barrierMode === 'range') return 2;
    if (config.barrierMode === 'single' || config.barrierMode === 'directional') return 1;
    return 0;
};
const getContractAvailability = (availableContracts, contractType, durationUnit, duration, requiredBarrierCount) => {
    const contracts = (availableContracts || []).filter(item => item.contract_type === contractType);
    const expiryType = durationUnit === 't' ? 'tick' : 'intraday';
    const matchingExpiry = contracts.filter(item => item.expiry_type === expiryType);
    const supportsDuration = matchingExpiry.some(item => {
        const min = numberOrNull(item.min_contract_duration);
        const max = numberOrNull(item.max_contract_duration);
        return min !== null && max !== null && duration >= min && duration <= max;
    });
    return {
        contracts,
        matchingExpiry,
        supportsDuration,
        supportsBarrierCount: contracts.some(item => Number(item.barriers) >= requiredBarrierCount),
    };
};
const preparePairParameters = ({ config, settings, durationUnit, pipSize }) => {
    const rawDuration = config.fixedDuration ?? numberOrNull(settings.duration);
    if (rawDuration === null) return { error: 'Duration is required.' };
    const duration = config.fixedDuration
        ? config.fixedDuration
        : durationUnit === 't'
          ? Math.floor(rawDuration)
          : rawDuration;
    if (!Number.isInteger(duration) || duration < 1) {
        return { error: 'Duration must be a whole number of at least 1.' };
    }
    if (!['t', 'm'].includes(durationUnit)) {
        return { error: 'Duration unit must be ticks or minutes.' };
    }
    if (config.fixedDuration && durationUnit !== 't') {
        return { error: 'This contract pair only supports tick duration.' };
    }
    if (!numberOrNull(pipSize) || numberOrNull(pipSize) <= 0) {
        return { error: 'The official market precision is not available yet.' };
    }
    const result = { duration, durationUnit, selectedTick: null, barrier: null, barrier2: null };
    if (config === PAIR_CONFIGS.HIGH_LOW_TICK) {
        const selectedTick = numberOrNull(settings.selectedTick);
        if (!Number.isInteger(selectedTick) || selectedTick < 1 || selectedTick > 5) {
            return { error: 'Selected tick must be an integer from 1 to 5.' };
        }
        result.selectedTick = selectedTick;
    }
    if (config.barrierMode === 'single') {
        result.barrier = getSynchronizedOffset(settings.barrier, pipSize);
    }
    if (config.barrierMode === 'range') {
        const low = numberOrNull(settings.lowBarrier);
        const high = numberOrNull(settings.highBarrier);
        if (low === null || high === null || low <= 0 || high <= low) {
            return { error: 'High barrier must be greater than the positive low barrier.' };
        }
        result.barrier = getSynchronizedOffset(settings.highBarrier, pipSize, '+');
        result.barrier2 = getSynchronizedOffset(settings.lowBarrier, pipSize, '-');
        if (
            result.barrier &&
            result.barrier2 &&
            Number(result.barrier.slice(1)) <= Number(result.barrier2.slice(1))
        ) {
            return { error: 'Aligned high barrier must remain greater than the aligned low barrier.' };
        }
    }
    if (config.barrierMode === 'directional') {
        result.barrier = getSynchronizedOffset(settings.barrierOffset, pipSize, '+');
        result.barrier2 = getSynchronizedOffset(settings.barrierOffset, pipSize, '-');
    }
    if (config.barrierMode && (!result.barrier || (config.barrierMode === 'range' && !result.barrier2))) {
        return {
            error: 'Barrier must be greater than zero and align with the market pip size.',
        };
    }
    return result;
};
const buildProposalRequest = ({
    config,
    key,
    groupId,
    pairKey,
    symbol,
    amount,
    currency,
    duration,
    durationUnit,
    selectedTick,
    barrier,
    barrier2,
}) => {
    const leg = config.legs[key];
    const request = {
        proposal: 1,
        basis: 'stake',
        amount,
        currency,
        underlying_symbol: symbol,
        duration,
        duration_unit: durationUnit,
        contract_type: leg.contractType,
        passthrough: {
            group_id: groupId,
            pair_key: pairKey,
            leg_key: key,
            custom_type: leg.label,
            deriv_contract_type: leg.contractType,
            symbol,
            sent_stake: amount,
        },
    };
    if (selectedTick !== null) request.selected_tick = selectedTick;
    if (barrier) request.barrier = barrier;
    if (barrier2) request.barrier2 = barrier2;
    return request;
};
const createIdlePair = pairKey => {
    const config = PAIR_CONFIGS[pairKey];
    return {
        groupId: null,
        pairKey,
        label: config.label,
        symbol: null,
        status: 'IDLE',
        legs: {
            A: { label: config.legs.A.label, state: 'IDLE', profit: null, error: '' },
            B: { label: config.legs.B.label, state: 'IDLE', profit: null, error: '' },
        },
    };
};
const readableState = state => String(state || 'IDLE').replace(/_/g, ' ');
const PairedBot = () => {
    const store = useStore();
    const { transactions, journal, summary_card, run_panel, client } = store || {};
    const [pairKey, setPairKey] = useState('HIGH_LOW_TICK');
    const [pairSettings, setPairSettings] = useState(PAIR_CONFIGS.HIGH_LOW_TICK.defaults);
    const [durationUnit, setDurationUnit] = useState('t');
    const [selectedSymbol, setSelectedSymbol] = useState('R_50');
    const [stake, setStake] = useState('1');
    const [targetProfit, setTargetProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [executionMode, setExecutionMode] = useState('once');
    const [maxRuns, setMaxRuns] = useState('10');
    const [runsCompleted, setRunsCompleted] = useState(0);
    const [isRunning, setIsRunning] = useState(false);
    const [pairStatus, setPairStatus] = useState(createIdlePair('HIGH_LOW_TICK'));
    const [proposalError, setProposalError] = useState('');
    const [lastQuote, setLastQuote] = useState('--');
    const [totalProfit, setTotalProfit] = useState(0);
    const [marketSpecs, setMarketSpecs] = useState({});
    const [contractSpecs, setContractSpecs] = useState({});
    const pairKeyRef = useRef(pairKey);
    const pairSettingsRef = useRef(pairSettings);
    const durationUnitRef = useRef('t');
    const selectedSymbolRef = useRef(selectedSymbol);
    const marketSpecsRef = useRef({});
    const contractSpecsRef = useRef({});
    const stakeRef = useRef(stake);
    const targetProfitRef = useRef(targetProfit);
    const stopLossRef = useRef(stopLoss);
    const executionModeRef = useRef(executionMode);
    const maxRunsRef = useRef(maxRuns);
    const runsCompletedRef = useRef(0);
    const runningRef = useRef(false);
    const wsRef = useRef(null);
    const authorizedRef = useRef(false);
    const connectingRef = useRef(false);
    const reconnectRef = useRef(true);
    const skipReconnectRef = useRef(false);
    const requiresAuthRef = useRef(false);
    const reconnectTimeoutRef = useRef(null);
    const nextPairTimeoutRef = useRef(null);
    const startPendingRef = useRef(false);
    const executePairRef = useRef(null);
    const activeContractsRef = useRef(new Set());
    const completedContractsRef = useRef(new Set());
    const contractMetaRef = useRef({});
    const pairGroupsRef = useRef({});
    const currentGroupIdRef = useRef(null);
    const pendingProposalsRef = useRef(new Map());
    const proposalGroupsRef = useRef(new Map());
    const proposalGuardTimeoutsRef = useRef(new Map());
    const buyGuardTimeoutsRef = useRef(new Map());
    const recoveryTimeoutsRef = useRef(new Map());
    const processingRef = useRef(false);
    const totalProfitRef = useRef(0);
    const selectedPair = PAIR_CONFIGS[pairKey];
    const selectedMarketSpec = marketSpecs[selectedSymbol];
    const preparedPreview = selectedMarketSpec
        ? preparePairParameters({
              config: selectedPair,
              settings: pairSettings,
              durationUnit: selectedPair.fixedDuration ? 't' : durationUnit,
              pipSize: selectedMarketSpec.pip_size,
          })
        : null;
    const marketSymbols = Object.values(marketSpecs)
        .filter(
            item =>
                item?.underlying_symbol &&
                item.market === 'synthetic_index' &&
                item.exchange_is_open === 1 &&
                item.is_trading_suspended === 0
        )
        .map(item => item.underlying_symbol)
        .sort();
    const symbolOptions = marketSymbols.length ? marketSymbols : SYMBOLS;
    useEffect(() => {
        pairKeyRef.current = pairKey;
    }, [pairKey]);
    useEffect(() => {
        pairSettingsRef.current = pairSettings;
    }, [pairSettings]);
    useEffect(() => {
        selectedSymbolRef.current = selectedSymbol;
    }, [selectedSymbol]);
    useEffect(() => {
        marketSpecsRef.current = marketSpecs;
    }, [marketSpecs]);
    useEffect(() => {
        contractSpecsRef.current = contractSpecs;
    }, [contractSpecs]);
    useEffect(() => {
        durationUnitRef.current = durationUnit;
    }, [durationUnit]);
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
        executionModeRef.current = executionMode;
    }, [executionMode]);
    useEffect(() => {
        maxRunsRef.current = maxRuns;
    }, [maxRuns]);
    useEffect(() => {
        runningRef.current = isRunning;
        run_panel?.setIsRunning?.(isRunning);
        if (!isRunning && activeContractsRef.current.size === 0) {
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [isRunning, run_panel]);
    const publishContract = useCallback(
        contract => {
            transactions?.onBotContractEvent?.(contract);
            summary_card?.onBotContractEvent?.(contract);
        },
        [summary_card, transactions]
    );
    const publishError = useCallback(
        message => {
            journal?.onError?.(message);
        },
        [journal]
    );
    const publishResult = useCallback(
        contract => {
            journal?.onLogSuccess?.({
                log_type: Number(contract.profit || 0) > 0 ? 'profit' : 'lost',
                extra: {
                    currency: contract.currency || client?.currency || 'USD',
                    profit: Number(contract.profit || 0),
                },
            });
        },
        [client?.currency, journal]
    );
    const getAuthContext = useCallback(() => {
        try {
            const auth = JSON.parse(sessionStorage.getItem('auth_info') || 'null');
            const accounts = JSON.parse(sessionStorage.getItem('deriv_accounts') || 'null');
            if (!auth?.access_token || !Array.isArray(accounts) || accounts.length === 0) {
                return null;
            }
            const activeLoginId = localStorage.getItem('active_loginid');
            const activeAccount =
                accounts.find(account => account.account_id === activeLoginId) ||
                accounts.find(account => account.account_id?.startsWith('DOT')) ||
                accounts[0];
            return activeAccount?.account_id
                ? { accessToken: auth.access_token, activeAccount }
                : null;
        } catch (error) {
            console.error('[PairedBot] Failed to read session:', error);
            return null;
        }
    }, []);
    const getAuthenticatedUrl = useCallback(async () => {
        try {
            const context = getAuthContext();
            if (!context) throw new Error('Session Missing');
            const response = await fetch(
                `${DERIV_OPTIONS_API_URL}accounts/${context.activeAccount.account_id}/otp`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${context.accessToken}` },
                }
            );
            if (!response.ok) throw new Error('OTP Request Failed');
            const json = await response.json();
            if (!json?.data?.url) throw new Error('Authenticated URL Missing');
            return json.data.url;
        } catch (error) {
            setProposalError(error.message);
            publishError(error.message);
            return null;
        }
    }, [getAuthContext, publishError]);
    const requestMarketMetadata = useCallback(symbol => {
        if (wsRef.current?.readyState !== WebSocket.OPEN || !symbol) return;
        wsRef.current.send(JSON.stringify({ active_symbols: 'full' }));
        wsRef.current.send(JSON.stringify({ contracts_for: symbol }));
    }, []);
    const maybeExecutePendingPair = useCallback(() => {
        const symbol = selectedSymbolRef.current;
        if (
            !startPendingRef.current ||
            !runningRef.current ||
            !authorizedRef.current ||
            !marketSpecsRef.current[symbol]?.pip_size ||
            !Array.isArray(contractSpecsRef.current[symbol])
        ) {
            return;
        }
        startPendingRef.current = false;
        executePairRef.current?.(symbol);
    }, []);
    const updateGroup = useCallback((groupId, transform) => {
        const current = pairGroupsRef.current[groupId];
        if (!current) return null;
        const next = transform(current);
        pairGroupsRef.current[groupId] = next;
        if (currentGroupIdRef.current === groupId) {
            setPairStatus(next);
        }
        return next;
    }, []);
    const reconcileGroup = useCallback(
        groupId => {
            const group = pairGroupsRef.current[groupId];
            if (!group) return null;
            const stateA = group.legs.A.state;
            const stateB = group.legs.B.state;
            let status = group.status;
            if (stateA === 'ERROR' || stateB === 'ERROR') {
                status = 'ATTENTION_REQUIRED';
            } else if (stateA === 'COMPLETE' && stateB === 'COMPLETE') {
                status = 'PAIR_COMPLETE';
            } else if (stateA === 'ACTIVE' && stateB === 'ACTIVE') {
                status = 'BOTH_ACTIVE';
            } else if (stateA === 'ACTIVE' || stateB === 'ACTIVE') {
                status = 'ONE_ACTIVE';
            } else {
                status = 'BOTH_PENDING';
            }
            return updateGroup(groupId, current => ({ ...current, status }));
        },
        [updateGroup]
    );
    const updateLeg = useCallback(
        (groupId, key, state, details = {}) => {
            updateGroup(groupId, current => ({
                ...current,
                legs: {
                    ...current.legs,
                    [key]: {
                        ...current.legs[key],
                        state,
                        ...details,
                    },
                },
            }));
            return reconcileGroup(groupId);
        },
        [reconcileGroup, updateGroup]
    );
    const clearState = useCallback((preserveOpenContracts = false) => {
        pendingProposalsRef.current.clear();
        proposalGuardTimeoutsRef.current.forEach(timeoutId => window.clearTimeout(timeoutId));
        proposalGuardTimeoutsRef.current.clear();
        buyGuardTimeoutsRef.current.forEach(timeoutId => window.clearTimeout(timeoutId));
        buyGuardTimeoutsRef.current.clear();
        proposalGroupsRef.current.clear();
        recoveryTimeoutsRef.current.forEach(timeoutId => window.clearTimeout(timeoutId));
        recoveryTimeoutsRef.current.clear();
        if (!preserveOpenContracts) {
            activeContractsRef.current.clear();
            completedContractsRef.current.clear();
            contractMetaRef.current = {};
            pairGroupsRef.current = {};
            currentGroupIdRef.current = null;
            processingRef.current = false;
        }
    }, []);
    const stopBot = useCallback(
        (reason = 'Bot stopped.') => {
            const preserveOpenContracts = activeContractsRef.current.size > 0;
            setIsRunning(false);
            runningRef.current = false;
            startPendingRef.current = false;
            processingRef.current = false;
            if (nextPairTimeoutRef.current) {
                window.clearTimeout(nextPairTimeoutRef.current);
                nextPairTimeoutRef.current = null;
            }
            clearState(preserveOpenContracts);
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ forget_all: 'proposal' }));
                if (!preserveOpenContracts) {
                    wsRef.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
                }
            }
            run_panel?.setIsRunning?.(false);
            run_panel?.toggleDrawer?.(true);
            run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);
            if (preserveOpenContracts && currentGroupIdRef.current) {
                updateGroup(currentGroupIdRef.current, current => ({
                    ...current,
                    status: 'STOPPING',
                }));
                run_panel?.setContractStage?.(contract_stages.IS_STOPPING);
            } else {
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
                setPairStatus(createIdlePair(pairKeyRef.current));
            }
            console.log(`[PairedBot] ${reason}`);
        },
        [clearState, run_panel, updateGroup]
    );
    const scheduleNextPair = useCallback(() => {
        if (
            executionModeRef.current !== 'repeat' ||
            !runningRef.current ||
            nextPairTimeoutRef.current ||
            activeContractsRef.current.size > 0
        ) {
            return;
        }
        nextPairTimeoutRef.current = window.setTimeout(() => {
            nextPairTimeoutRef.current = null;
            if (runningRef.current && activeContractsRef.current.size === 0) {
                executePairRef.current?.(selectedSymbolRef.current);
            }
        }, 700);
    }, []);
    const completeContract = useCallback(
        contract => {
            const contractId = contract.contract_id;
            const contractKey = String(contractId);
            if (!contractId || completedContractsRef.current.has(contractKey)) return;
            const meta = contractMetaRef.current[contractKey] || {};
            const profit = Number(contract.profit || 0);
            completedContractsRef.current.add(contractKey);
            activeContractsRef.current.delete(contractKey);
            totalProfitRef.current += profit;
            setTotalProfit(totalProfitRef.current);
            const nativeContract = {
                ...meta,
                ...contract,
                id: contractId,
                contract_id: contractId,
                buy_price: contract.buy_price ?? meta.buy_price ?? 0,
                currency: contract.currency || client?.currency || 'USD',
                display_name: contract.display_name || formatSymbol(meta.symbol),
                underlying: contract.underlying || meta.symbol,
                underlying_symbol: contract.underlying_symbol || meta.symbol,
                group_id: meta.group_id,
                leg_key: meta.leg_key,
                result: profit > 0 ? 'won' : 'lost',
                status: profit > 0 ? 'won' : 'lost',
                is_sold: true,
            };
            publishContract(nativeContract);
            publishResult(nativeContract);
            if (meta.group_id && meta.leg_key) {
                updateLeg(meta.group_id, meta.leg_key, 'COMPLETE', {
                    profit,
                    error: '',
                });
            }
            if (activeContractsRef.current.size === 0) {
                processingRef.current = false;
                run_panel?.setHasOpenContract?.(false);
                const group = meta.group_id ? pairGroupsRef.current[meta.group_id] : null;
                const complete = group?.legs.A.state === 'COMPLETE' && group?.legs.B.state === 'COMPLETE';
                if (complete) {
                    const hitLimit =
                        totalProfitRef.current >= Number(targetProfitRef.current) ||
                        totalProfitRef.current <= -Number(stopLossRef.current);
                    const hitRunLimit =
                        executionModeRef.current === 'repeat' &&
                        runsCompletedRef.current >= Number(maxRunsRef.current);
                    if (hitLimit || hitRunLimit) {
                        const runMessage = hitRunLimit
                            ? `Completed ${runsCompletedRef.current} of ${maxRunsRef.current} requested runs.`
                            : `Final P/L: ${totalProfitRef.current.toFixed(2)} ${client?.currency || 'USD'}`;
                        stopBot(hitRunLimit ? 'Requested run count completed.' : 'Session ended by target or stop loss.');
                        Swal.fire(hitRunLimit ? 'Run Count Completed' : 'Session Ended', runMessage, 'info');
                    } else {
                        run_panel?.setContractStage?.(contract_stages.CONTRACT_CLOSED);
                        scheduleNextPair();
                    }
                } else {
                    setIsRunning(false);
                    runningRef.current = false;
                    run_panel?.setIsRunning?.(false);
                    run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
                }
            }
        },
        [
            client?.currency,
            publishContract,
            publishResult,
            run_panel,
            scheduleNextPair,
            stopBot,
            updateLeg,
        ]
    );
    const unwindGroup = useCallback(
        (groupId, reason) => {
            const group = pairGroupsRef.current[groupId];
            if (!group) return;
            updateGroup(groupId, current => ({ ...current, status: 'UNWINDING', error: reason }));
            LEG_KEYS.forEach(key => {
                const contractId = group.legs[key]?.contractId;
                if (contractId && activeContractsRef.current.has(String(contractId))) {
                    wsRef.current?.send(JSON.stringify({ sell: contractId, price: 0 }));
                    updateLeg(groupId, key, 'ACTIVE', { error: 'Pair protection is closing this leg.' });
                }
            });
            publishError(reason);
            run_panel?.setContractStage?.(contract_stages.IS_STOPPING);
        },
        [publishError, run_panel, updateGroup, updateLeg]
    );
    const rejectPendingPair = useCallback(
        (groupId, message) => {
            const proposalGroup = proposalGroupsRef.current.get(groupId);
            proposalGroup?.proposals && Object.values(proposalGroup.proposals).forEach(record => {
                pendingProposalsRef.current.delete(record.proposalId);
                wsRef.current?.send(JSON.stringify({ forget: record.proposalId }));
            });
            const timeoutId = proposalGuardTimeoutsRef.current.get(groupId);
            if (timeoutId) window.clearTimeout(timeoutId);
            proposalGuardTimeoutsRef.current.delete(groupId);
            proposalGroupsRef.current.delete(groupId);
            setProposalError(message);
            publishError(message);
            if (pairGroupsRef.current[groupId]) {
                updateGroup(groupId, current => ({ ...current, status: 'PAIR_ABORTED', error: message }));
            }
            processingRef.current = false;
            setIsRunning(false);
            runningRef.current = false;
            run_panel?.setIsRunning?.(false);
            run_panel?.setHasOpenContract?.(activeContractsRef.current.size > 0);
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        },
        [publishError, run_panel, updateGroup]
    );
    const markError = useCallback(
        (context, message) => {
            setProposalError(message);
            publishError(message);
            if (context?.group_id) {
                const timeoutId = buyGuardTimeoutsRef.current.get(context.group_id);
                if (timeoutId) window.clearTimeout(timeoutId);
                buyGuardTimeoutsRef.current.delete(context.group_id);
            }
            if (context?.group_id && context?.leg_key) {
                updateLeg(context.group_id, context.leg_key, 'ERROR', { error: message });
            }
            const group = context?.group_id ? pairGroupsRef.current[context.group_id] : null;
            const hasActiveLeg = group && LEG_KEYS.some(key => group.legs[key]?.contractId);
            if (context?.group_id && hasActiveLeg) {
                unwindGroup(context.group_id, message);
            } else if (context?.group_id) {
                rejectPendingPair(context.group_id, message);
            } else {
                processingRef.current = false;
                setIsRunning(false);
                runningRef.current = false;
                run_panel?.setIsRunning?.(false);
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            }
        },
        [publishError, rejectPendingPair, run_panel, unwindGroup, updateLeg]
    );
    const handleProposal = useCallback(
        data => {
            const proposal = data.proposal;
            const context = proposal?.passthrough || data.echo_req?.passthrough;
            if (!proposal?.id || proposal.ask_price === undefined || !context?.group_id || !context?.leg_key) {
                markError(context, 'Proposal response did not identify its paired leg.');
                return;
            }
            const proposalId = String(proposal.id);
            const askPrice = Number(proposal.ask_price);
            if (!Number.isFinite(askPrice) || askPrice <= 0) {
                markError(context, 'Proposal price was invalid. No leg was bought.');
                return;
            }
            const proposalGroup = proposalGroupsRef.current.get(context.group_id) || {
                groupId: context.group_id,
                proposals: {},
                buyStarted: false,
            };
            if (proposalGroup.buyStarted || proposalGroup.proposals[context.leg_key]) return;
            const record = {
                ...context,
                proposalId,
                askPrice,
                receivedAt: Date.now(),
            };
            pendingProposalsRef.current.set(proposalId, record);
            proposalGroup.proposals[context.leg_key] = record;
            proposalGroupsRef.current.set(context.group_id, proposalGroup);
            const proposalKeys = Object.keys(proposalGroup.proposals);
            if (proposalKeys.length === 1) {
                const timeoutId = window.setTimeout(() => {
                    const current = proposalGroupsRef.current.get(context.group_id);
                    if (current && Object.keys(current.proposals).length < LEG_KEYS.length) {
                        rejectPendingPair(context.group_id, 'Paired proposals did not arrive within 1.5 seconds. No leg was bought.');
                    }
                }, PROPOSAL_PAIR_MAX_SKEW_MS);
                proposalGuardTimeoutsRef.current.set(context.group_id, timeoutId);
                return;
            }
            const proposalA = proposalGroup.proposals.A;
            const proposalB = proposalGroup.proposals.B;
            if (!proposalA || !proposalB) {
                rejectPendingPair(context.group_id, 'Both paired proposal callbacks are required. No leg was bought.');
                return;
            }
            const skew = Math.abs(proposalA.receivedAt - proposalB.receivedAt);
            if (skew > PROPOSAL_PAIR_MAX_SKEW_MS) {
                rejectPendingPair(context.group_id, 'Paired proposal quotes were not received close enough together. No leg was bought.');
                return;
            }
            const timeoutId = proposalGuardTimeoutsRef.current.get(context.group_id);
            if (timeoutId) window.clearTimeout(timeoutId);
            proposalGuardTimeoutsRef.current.delete(context.group_id);
            proposalGroup.buyStarted = true;
            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
            const buyTimeoutId = window.setTimeout(() => {
                const group = pairGroupsRef.current[context.group_id];
                const bothBought = LEG_KEYS.every(key => group?.legs[key]?.state === 'ACTIVE');
                if (!bothBought) {
                    const missingLeg = LEG_KEYS.find(key => group?.legs[key]?.state !== 'ACTIVE') || 'B';
                    markError(
                        { group_id: context.group_id, leg_key: missingLeg },
                        'Both paired buy confirmations were not received in time. The active leg will be unwound.'
                    );
                }
                buyGuardTimeoutsRef.current.delete(context.group_id);
            }, PROPOSAL_PAIR_MAX_SKEW_MS);
            buyGuardTimeoutsRef.current.set(context.group_id, buyTimeoutId);
            [proposalA, proposalB].forEach(recordToBuy => {
                wsRef.current?.send(
                    JSON.stringify({ buy: recordToBuy.proposalId, price: recordToBuy.askPrice })
                );
            });
        },
        [markError, rejectPendingPair, run_panel]
    );
    const handleBuy = useCallback(
        data => {
            if (data.error) {
                const context = pendingProposalsRef.current.get(String(data.echo_req?.buy || ''));
                markError(context, data.error.message || 'Buy request failed.');
                return;
            }
            const buy = data.buy || {};
            const context =
                pendingProposalsRef.current.get(String(data.echo_req?.buy || '')) ||
                buy.passthrough ||
                {};
            if (!buy.contract_id || !context.group_id || !context.leg_key) {
                markError(context, 'Buy response did not identify its paired leg.');
                return;
            }
            pendingProposalsRef.current.delete(String(data.echo_req?.buy || ''));
            const contractKey = String(buy.contract_id);
            activeContractsRef.current.add(contractKey);
            const transaction = {
                id: buy.contract_id,
                contract_id: buy.contract_id,
                transaction_ids: { buy: buy.transaction_id },
                buy_price: buy.buy_price ?? Number(context.sent_stake),
                currency: client?.currency || 'USD',
                display_name: formatSymbol(context.symbol),
                underlying: context.symbol,
                underlying_symbol: context.symbol,
                contract_type: context.deriv_contract_type || context.custom_type,
                longcode: buy.longcode,
                date_start: Math.floor(Date.now() / 1000),
                group_id: context.group_id,
                leg_key: context.leg_key,
                status: 'open',
                is_sold: false,
            };
            contractMetaRef.current[contractKey] = transaction;
            publishContract(transaction);
            updateLeg(context.group_id, context.leg_key, 'ACTIVE', {
                contractId: buy.contract_id,
                profit: 0,
            });
            const group = pairGroupsRef.current[context.group_id];
            if (group && LEG_KEYS.every(key => group.legs[key]?.state === 'ACTIVE')) {
                const timeoutId = buyGuardTimeoutsRef.current.get(context.group_id);
                if (timeoutId) window.clearTimeout(timeoutId);
                buyGuardTimeoutsRef.current.delete(context.group_id);
            }
            run_panel?.setHasOpenContract?.(true);
            run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);
            wsRef.current?.send(
                JSON.stringify({
                    proposal_open_contract: 1,
                    contract_id: buy.contract_id,
                    subscribe: 1,
                })
            );
        },
        [client?.currency, markError, publishContract, run_panel, updateLeg]
    );
    const handleMessage = useCallback(
        event => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }
            if (data.error && (data.echo_req?.active_symbols || data.echo_req?.contracts_for)) {
                setProposalError(data.error.message || 'Deriv market metadata request failed.');
                if (startPendingRef.current) {
                    startPendingRef.current = false;
                    setIsRunning(false);
                    runningRef.current = false;
                    run_panel?.setIsRunning?.(false);
                    run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
                }
                return;
            }
            if (data.msg_type === 'active_symbols') {
                const nextSpecs = (data.active_symbols || []).reduce((result, item) => {
                    if (item?.underlying_symbol) result[item.underlying_symbol] = item;
                    return result;
                }, {});
                marketSpecsRef.current = nextSpecs;
                setMarketSpecs(nextSpecs);
                maybeExecutePendingPair();
                return;
            }
            if (data.msg_type === 'contracts_for') {
                const symbol = data.echo_req?.contracts_for || selectedSymbolRef.current;
                const available = data.contracts_for?.available || [];
                const nextSpecs = { ...contractSpecsRef.current, [symbol]: available };
                contractSpecsRef.current = nextSpecs;
                setContractSpecs(nextSpecs);
                maybeExecutePendingPair();
                return;
            }
            if (data.error) {
                const context =
                    data.echo_req?.passthrough ||
                    pendingProposalsRef.current.get(String(data.echo_req?.buy || ''));
                markError(context, data.error.message || 'Deriv request failed.');
                return;
            }
            if (data.msg_type === 'authorize') {
                authorizedRef.current = true;
                maybeExecutePendingPair();
                return;
            }
            if (data.msg_type === 'tick') {
                setLastQuote(String(data.tick?.quote ?? '--'));
                return;
            }
            if (data.msg_type === 'proposal' && data.proposal) {
                if (runningRef.current || activeContractsRef.current.size > 0) {
                    handleProposal(data);
                }
                return;
            }
            if (data.msg_type === 'buy') {
                if (runningRef.current || activeContractsRef.current.size > 0) {
                    handleBuy(data);
                }
                return;
            }
            if (data.msg_type === 'transaction') {
                const contractId = data.transaction?.contract_id;
                const contractKey = String(contractId || '');
                if (
                    data.transaction?.action !== 'sell' ||
                    !contractId ||
                    !activeContractsRef.current.has(contractKey) ||
                    completedContractsRef.current.has(contractKey)
                ) {
                    return;
                }
                if (recoveryTimeoutsRef.current.has(contractKey)) {
                    window.clearTimeout(recoveryTimeoutsRef.current.get(contractKey));
                }
                const timeoutId = window.setTimeout(() => {
                    recoveryTimeoutsRef.current.delete(contractKey);
                    if (
                        activeContractsRef.current.has(contractKey) &&
                        !completedContractsRef.current.has(contractKey) &&
                        wsRef.current?.readyState === WebSocket.OPEN
                    ) {
                        wsRef.current.send(
                            JSON.stringify({
                                proposal_open_contract: 1,
                                contract_id: contractId,
                            })
                        );
                    }
                }, 1500);
                recoveryTimeoutsRef.current.set(contractKey, timeoutId);
                return;
            }
            if (data.msg_type === 'proposal_open_contract') {
                const contract = data.proposal_open_contract;
                if (!contract) return;
                const contractKey = String(contract.contract_id || '');
                const meta = contractMetaRef.current[contractKey] || {};
                const status = String(contract.status || '').toLowerCase();
                const isComplete =
                    contract.is_sold === 1 ||
                    contract.is_sold === true ||
                    contract.is_sold === '1' ||
                    contract.is_expired === 1 ||
                    contract.is_expired === true ||
                    contract.is_settleable === 1 ||
                    contract.is_settleable === true ||
                    (status && status !== 'open');
                publishContract({
                    ...meta,
                    ...contract,
                    id: contract.contract_id,
                    contract_id: contract.contract_id,
                    group_id: meta.group_id,
                    leg_key: meta.leg_key,
                    underlying: contract.underlying || meta.symbol,
                    underlying_symbol: contract.underlying_symbol || meta.symbol,
                    is_sold: isComplete,
                });
                if (isComplete && activeContractsRef.current.has(contractKey)) {
                    completeContract(contract);
                }
            }
        },
        [
            completeContract,
            handleBuy,
            handleProposal,
            markError,
            maybeExecutePendingPair,
            publishContract,
            run_panel,
        ]
    );
    const connectSocket = useCallback(
        async ({ requireAuth = false, forceReconnect = false } = {}) => {
            const readyState = wsRef.current?.readyState;
            if (
                !forceReconnect &&
                (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING || connectingRef.current)
            ) {
                return true;
            }
            if (forceReconnect && wsRef.current) {
                skipReconnectRef.current = true;
                wsRef.current.close();
                wsRef.current = null;
                authorizedRef.current = false;
            }
            connectingRef.current = true;
            requiresAuthRef.current = requireAuth;
            try {
                const authenticatedUrl = requireAuth ? await getAuthenticatedUrl() : null;
                if (requireAuth && !authenticatedUrl) return false;
                wsRef.current = new WebSocket(authenticatedUrl || DERIV_PUBLIC_WS_URL);
                wsRef.current.onopen = () => {
                    authorizedRef.current = Boolean(authenticatedUrl);
                    setProposalError('');
                    requestMarketMetadata(selectedSymbolRef.current);
                    wsRef.current?.send(
                        JSON.stringify({
                            ticks: selectedSymbolRef.current,
                            subscribe: 1,
                        })
                    );
                    if (authenticatedUrl) {
                        wsRef.current?.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
                        maybeExecutePendingPair();
                    }
                };
                wsRef.current.onmessage = handleMessage;
                wsRef.current.onerror = error => console.error('[PairedBot] WebSocket error:', error);
                wsRef.current.onclose = () => {
                    authorizedRef.current = false;
                    wsRef.current = null;
                    if (reconnectRef.current && !skipReconnectRef.current) {
                        reconnectTimeoutRef.current = window.setTimeout(
                            () => connectSocket({ requireAuth: requiresAuthRef.current }),
                            800
                        );
                    }
                    skipReconnectRef.current = false;
                };
                return true;
            } finally {
                connectingRef.current = false;
            }
        },
        [getAuthenticatedUrl, handleMessage, maybeExecutePendingPair, requestMarketMetadata]
    );
    const executePair = useCallback(
        symbol => {
            const config = PAIR_CONFIGS[pairKeyRef.current];
            const amount = numberOrNull(stakeRef.current);
            if (!authorizedRef.current || wsRef.current?.readyState !== WebSocket.OPEN) {
                setProposalError('Authenticated trading connection is not ready.');
                return false;
            }
            if (!amount || amount <= 0) {
                setProposalError('Stake must be greater than zero.');
                return false;
            }
            const symbolInfo = marketSpecsRef.current[symbol];
            const availableContracts = contractSpecsRef.current[symbol];
            if (!symbolInfo?.pip_size) {
                setProposalError('Official market precision is not loaded for this symbol.');
                requestMarketMetadata(symbol);
                return false;
            }
            if (!Array.isArray(availableContracts)) {
                setProposalError('Official contract limits are not loaded for this symbol.');
                requestMarketMetadata(symbol);
                return false;
            }
            const durationUnit = config.fixedDuration ? 't' : durationUnitRef.current;
            const prepared = preparePairParameters({
                config,
                settings: pairSettingsRef.current,
                durationUnit,
                pipSize: symbolInfo.pip_size,
            });
            if (prepared.error) {
                setProposalError(prepared.error);
                return false;
            }
            const requiredBarrierCount = getBarrierCount(config);
            for (const key of LEG_KEYS) {
                const contractType = config.legs[key].contractType;
                const availability = getContractAvailability(
                    availableContracts,
                    contractType,
                    prepared.durationUnit,
                    prepared.duration,
                    requiredBarrierCount
                );
                if (!availability.contracts.length) {
                    setProposalError(`${contractType} is not available for ${formatSymbol(symbol)}.`);
                    return false;
                }
                if (!availability.matchingExpiry.length || !availability.supportsDuration) {
                    setProposalError(
                        `${contractType} does not support ${prepared.duration} ${DURATION_UNIT_LABELS[prepared.durationUnit].toLowerCase()} on ${formatSymbol(symbol)}.`
                    );
                    return false;
                }
                if (requiredBarrierCount > 0 && !availability.supportsBarrierCount) {
                    setProposalError(`${contractType} does not support the required barrier count.`);
                    return false;
                }
            }
            const requestedRuns = numberOrNull(maxRunsRef.current);
            if (
                executionModeRef.current === 'repeat' &&
                (!Number.isInteger(requestedRuns) || requestedRuns < 1 || runsCompletedRef.current >= requestedRuns)
            ) {
                return false;
            }
            runsCompletedRef.current += 1;
            setRunsCompleted(runsCompletedRef.current);
            const groupId = `paired-${pairKeyRef.current.toLowerCase()}-${symbol}-${Date.now()}`;
            const group = {
                groupId,
                pairKey: pairKeyRef.current,
                label: config.label,
                symbol,
                status: 'PAIR_CREATED',
                legs: {
                    A: { label: config.legs.A.label, state: 'PENDING', profit: null, error: '' },
                    B: { label: config.legs.B.label, state: 'PENDING', profit: null, error: '' },
                },
            };
            pairGroupsRef.current[groupId] = group;
            currentGroupIdRef.current = groupId;
            setPairStatus(group);
            setProposalError('');
            processingRef.current = true;
            LEG_KEYS.forEach(key => {
                wsRef.current?.send(
                    JSON.stringify(
                        buildProposalRequest({
                            config,
                            key,
                            groupId,
                            pairKey: pairKeyRef.current,
                            symbol,
                            amount,
                            currency: client?.currency || 'USD',
                            duration: prepared.duration,
                            durationUnit: prepared.durationUnit,
                            selectedTick: prepared.selectedTick,
                            barrier:
                                config.barrierMode === 'directional'
                                    ? key === 'A'
                                        ? prepared.barrier
                                        : prepared.barrier2
                                    : prepared.barrier,
                            barrier2: config.barrierMode === 'range' ? prepared.barrier2 : null,
                        })
                    )
                );
            });
            reconcileGroup(groupId);
            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
            return true;
        },
        [client?.currency, reconcileGroup, requestMarketMetadata, run_panel]
    );
    executePairRef.current = executePair;
    const startBot = useCallback(async () => {
        if (!getAuthContext()) {
            Swal.fire('Error', 'Login Required', 'error');
            return;
        }
        if (executionMode === 'repeat') {
            const requestedRuns = numberOrNull(maxRuns);
            if (!Number.isInteger(requestedRuns) || requestedRuns < 1) {
                setProposalError('Number of runs must be a whole number of at least 1.');
                return;
            }
        }
        if (runningRef.current) {
            stopBot();
            return;
        }
        totalProfitRef.current = 0;
        setTotalProfit(0);
        runsCompletedRef.current = 0;
        setRunsCompleted(0);
        setProposalError('');
        setLastQuote('--');
        setPairStatus(createIdlePair(pairKeyRef.current));
        clearState(false);
        transactions?.clear?.();
        summary_card?.clear?.();
        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);
        if (run_panel) {
            run_panel.run_id = `pairedbot-${Date.now()}`;
        }
        setIsRunning(true);
        runningRef.current = true;
        startPendingRef.current = true;
        if (wsRef.current?.readyState === WebSocket.OPEN && authorizedRef.current) {
            maybeExecutePendingPair();
            return;
        }
        const connected = await connectSocket({
            requireAuth: true,
            forceReconnect: Boolean(wsRef.current && !authorizedRef.current),
        });
        if (!connected) {
            startPendingRef.current = false;
            setIsRunning(false);
            runningRef.current = false;
            run_panel?.setIsRunning?.(false);
            run_panel?.setHasOpenContract?.(false);
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [
        clearState,
        connectSocket,
        getAuthContext,
        maybeExecutePendingPair,
        run_panel,
        stopBot,
        summary_card,
        transactions,
        executionMode,
        maxRuns,
    ]);
    const toggleBot = useCallback(() => {
        observer.emit(runningRef.current ? 'pairedbot.stop' : 'pairedbot.start');
    }, []);
    useEffect(() => {
        reconnectRef.current = true;
        const shouldAuthenticate = Boolean(getAuthContext());
        connectSocket({ requireAuth: shouldAuthenticate });
        const watchdog = window.setInterval(() => {
            if (reconnectRef.current) {
                connectSocket({
                    requireAuth: requiresAuthRef.current || shouldAuthenticate,
                });
            }
        }, 1500);
        return () => {
            reconnectRef.current = false;
            window.clearInterval(watchdog);
            if (reconnectTimeoutRef.current) {
                window.clearTimeout(reconnectTimeoutRef.current);
            }
            if (nextPairTimeoutRef.current) {
                window.clearTimeout(nextPairTimeoutRef.current);
            }
            if (wsRef.current) {
                skipReconnectRef.current = true;
                wsRef.current.close();
                wsRef.current = null;
            }
            clearState(false);
        };
    }, [clearState, connectSocket, getAuthContext]);
    useEffect(() => {
        requestMarketMetadata(selectedSymbol);
    }, [requestMarketMetadata, selectedSymbol]);
    useEffect(() => {
        const externalStop = () => {
            if (runningRef.current || activeContractsRef.current.size > 0) {
                stopBot('Bot stopped from the Deriv run panel.');
            }
        };
        observer.register('bot.click_stop', externalStop);
        return () => {
            if (observer.isRegistered('bot.click_stop')) {
                observer.unregister('bot.click_stop', externalStop);
            }
        };
    }, [stopBot]);
    useEffect(() => {
        observer.register('pairedbot.start', startBot);
        observer.register('pairedbot.stop', stopBot);
        return () => {
            if (observer.isRegistered('pairedbot.start')) {
                observer.unregister('pairedbot.start', startBot);
            }
            if (observer.isRegistered('pairedbot.stop')) {
                observer.unregister('pairedbot.stop', stopBot);
            }
        };
    }, [startBot, stopBot]);
    const changePair = event => {
        const nextKey = event.target.value;
        const nextConfig = PAIR_CONFIGS[nextKey];
        setPairKey(nextKey);
        setPairSettings(nextConfig.defaults);
        setDurationUnit(nextConfig.durationUnits?.[0] || 't');
        setPairStatus(createIdlePair(nextKey));
        setProposalError('');
    };
    const renderLeg = key => {
        const leg = pairStatus.legs[key];
        return (
            <div className={`pb-leg-card pb-leg-card--${String(leg.state).toLowerCase()}`} key={key}>
                <div className="pb-leg-heading">
                    <span>LEG {key}</span>
                    <strong>{leg.label}</strong>
                </div>
                <div className="pb-leg-state">{readableState(leg.state)}</div>
                {leg.profit !== null && <div className="pb-leg-profit">P/L: {Number(leg.profit).toFixed(2)}</div>}
                {leg.error && <div className="pb-leg-error">{leg.error}</div>}
            </div>
        );
    };

    return (
        <div className="pb-tool">
            <div className="pb-header">
                <div>
                    <span className="pb-kicker">Paired Contract Executor</span>
                    <h1>One operation. Two tracked legs.</h1>
                    <p>
                        Both legs are proposed together, share one group identifier, and remain visible until both
                        lifecycles are accounted for.
                    </p>
                </div>
                <span className={`pb-run-state ${isRunning ? 'is-live' : 'is-idle'}`}>
                    {isRunning ? 'LIVE' : 'STANDBY'}
                </span>
            </div>
            <div className="pb-controls">
                <label className="pb-field">
                    <span>Pair type</span>
                    <select value={pairKey} onChange={changePair} disabled={isRunning}>
                        {Object.entries(PAIR_CONFIGS).map(([key, config]) => (
                            <option value={key} key={key}>{config.label}</option>
                        ))}
                    </select>
                </label>
                <label className="pb-field">
                    <span>Volatility / market</span>
                    <select value={selectedSymbol} onChange={event => setSelectedSymbol(event.target.value)} disabled={isRunning}>
                        {symbolOptions.map(symbol => <option value={symbol} key={symbol}>{formatSymbol(symbol)}</option>)}
                    </select>
                </label>
                <label className="pb-field">
                    <span>Stake per leg</span>
                    <input type="number" min="0.01" step="0.01" value={stake} onChange={event => setStake(event.target.value)} disabled={isRunning} />
                </label>
                <label className="pb-field">
                    <span>Execution</span>
                    <select value={executionMode} onChange={event => setExecutionMode(event.target.value)} disabled={isRunning}>
                        <option value="once">One pair</option>
                        <option value="repeat">Repeat pairs</option>
                    </select>
                </label>
                <label className="pb-field">
                    <span>Number of runs</span>
                    <input
                        type="number"
                        min="1"
                        step="1"
                        value={maxRuns}
                        onChange={event => setMaxRuns(event.target.value)}
                        disabled={isRunning || executionMode === 'once'}
                    />
                </label>
                <label className="pb-field">
                    <span>Target P/L</span>
                    <input type="number" step="0.01" value={targetProfit} onChange={event => setTargetProfit(event.target.value)} disabled={isRunning} />
                </label>
                <label className="pb-field">
                    <span>Stop loss</span>
                    <input type="number" min="0" step="0.01" value={stopLoss} onChange={event => setStopLoss(event.target.value)} disabled={isRunning} />
                </label>
                {selectedPair.fields.map(field => (
                    <label className="pb-field" key={field.key}>
                        <span>{field.label}</span>
                        <input
                            type={field.type}
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            value={pairSettings[field.key] ?? ''}
                            onChange={event => setPairSettings(current => ({ ...current, [field.key]: event.target.value }))}
                            disabled={isRunning}
                        />
                    </label>
                ))}
                {selectedPair.fixedDuration ? (
                    <div className="pb-field pb-field--readonly">
                        <span>Duration</span>
                        <strong>5 Ticks (fixed)</strong>
                    </div>
                ) : (
                    <label className="pb-field">
                        <span>Duration unit</span>
                        <select value={durationUnit} onChange={event => setDurationUnit(event.target.value)} disabled={isRunning}>
                            {(selectedPair.durationUnits || ['t']).map(unit => (
                                <option value={unit} key={unit}>{DURATION_UNIT_LABELS[unit] || unit}</option>
                            ))}
                        </select>
                    </label>
                )}
            </div>
            <div className="pb-barrier-summary">
                <span className="pb-kicker">SmartTrader barrier offsets</span>
                <span>
                    Official pip size: <strong>{selectedMarketSpec?.pip_size ?? 'Loading...'}</strong>
                </span>
                {selectedPair.barrierMode === 'single' && (
                    <span>
                        Both legs:{' '}
                        <strong>
                            {preparedPreview?.barrier || formatSignedOffset(pairSettings.barrier)}
                        </strong>{' '}
                        from entry
                    </span>
                )}
                {selectedPair.barrierMode === 'directional' && (
                    <span>
                        Higher: <strong>{preparedPreview?.barrier || formatSignedOffset(pairSettings.barrierOffset, '+')}</strong>{' '}
                        · Lower: <strong>{preparedPreview?.barrier2 || formatSignedOffset(pairSettings.barrierOffset, '-')}</strong>
                    </span>
                )}
                {selectedPair.barrierMode === 'range' && (
                    <span>
                        Low barrier: <strong>{preparedPreview?.barrier2 || formatSignedOffset(pairSettings.lowBarrier, '-')}</strong>{' '}
                        · High barrier: <strong>{preparedPreview?.barrier || formatSignedOffset(pairSettings.highBarrier, '+')}</strong>
                    </span>
                )}
                {!selectedPair.barrierMode && <span>Fixed five-tick contract; no barrier offset.</span>}
            </div>
            <div className="pb-actions">
                <button type="button" className={`pb-run-button ${isRunning ? 'is-stop' : ''}`} onClick={toggleBot}>
                    {isRunning ? <FaStop /> : <FaPlay />}
                    {isRunning ? 'Stop paired execution' : 'Start paired execution'}
                </button>
                <div className="pb-live-metrics">
                    <span>Quote <strong>{lastQuote}</strong></span>
                    <span>Session P/L <strong className={totalProfit >= 0 ? 'is-positive' : 'is-negative'}>{totalProfit.toFixed(2)}</strong></span>
                    <span>Runs <strong>{runsCompleted} / {executionMode === 'repeat' ? maxRuns || '--' : '1'}</strong></span>
                </div>
            </div>
            {proposalError && <div className="pb-error" role="alert">{proposalError}</div>}
            <div className="pb-pair-summary">
                <div>
                    <span className="pb-kicker">Selected pair</span>
                    <strong>{selectedPair.label}</strong>
                    <p>{selectedPair.description}</p>
                </div>
                <div className="pb-group-id">
                    <span>Group</span>
                    <code>{pairStatus.groupId || 'Not created'}</code>
                </div>
                <div className="pb-status-pill">{readableState(pairStatus.status)}</div>
            </div>
            <div className="pb-legs">
                {LEG_KEYS.map(renderLeg)}
            </div>
        </div>
    );
};

export default PairedBot;
