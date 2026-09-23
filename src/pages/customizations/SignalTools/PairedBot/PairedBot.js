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
            { key: 'duration', label: 'Duration (ticks)', type: 'number', min: 2, step: 1 },
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
            { key: 'duration', label: 'Duration (ticks)', type: 'number', min: 2, step: 1 },
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
            { key: 'duration', label: 'Duration (ticks)', type: 'number', min: 2, step: 1 },
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
            { key: 'duration', label: 'Duration (ticks)', type: 'number', min: 2, step: 1 },
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
const signedOffset = value => {
    const text = String(value ?? '').trim();
    return /^[+-]/.test(text) ? text : `+${text}`;
};
const formatSignedOffset = (value, forcedSign) => {
    const parsed = numberOrNull(value);
    if (parsed === null) return '--';
    return forcedSign ? forcedSign + Math.abs(parsed) : signedOffset(parsed);
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
    const [isRunning, setIsRunning] = useState(false);
    const [pairStatus, setPairStatus] = useState(createIdlePair('HIGH_LOW_TICK'));
    const [proposalError, setProposalError] = useState('');
    const [lastQuote, setLastQuote] = useState('--');
    const [totalProfit, setTotalProfit] = useState(0);
    const pairKeyRef = useRef(pairKey);
    const pairSettingsRef = useRef(pairSettings);
    const durationUnitRef = useRef('t');
    const selectedSymbolRef = useRef(selectedSymbol);
    const stakeRef = useRef(stake);
    const targetProfitRef = useRef(targetProfit);
    const stopLossRef = useRef(stopLoss);
    const executionModeRef = useRef(executionMode);
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
    const recoveryTimeoutsRef = useRef(new Map());
    const processingRef = useRef(false);
    const totalProfitRef = useRef(0);
    const selectedPair = PAIR_CONFIGS[pairKey];
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
    const buildRequest = useCallback(
        (config, key, groupId, symbol, amount) => {
            const leg = config.legs[key];
            const settings = pairSettingsRef.current;
            const request = {
                proposal: 1,
                basis: 'stake',
                amount,
                currency: client?.currency || 'USD',
                underlying_symbol: symbol,
                duration: config.fixedDuration || numberOrNull(settings.duration),
                duration_unit: config.fixedDuration ? 't' : durationUnitRef.current,
                contract_type: leg.contractType,
                passthrough: {
                    group_id: groupId,
                    pair_key: pairKeyRef.current,
                    leg_key: key,
                    custom_type: leg.label,
                    deriv_contract_type: leg.contractType,
                    symbol,
                    sent_stake: amount,
                },
            };
            if (pairKeyRef.current === 'HIGH_LOW_TICK') {
                request.selected_tick = numberOrNull(settings.selectedTick);
            }
            if (config.barrierMode === 'single') {
                request.barrier = signedOffset(settings.barrier);
            }
            if (config.barrierMode === 'range') {
                request.barrier = `+${numberOrNull(settings.highBarrier)}`;
                request.barrier2 = `-${numberOrNull(settings.lowBarrier)}`;
            }
            if (config.barrierMode === 'directional') {
                request.barrier =
                    key === 'A'
                        ? `+${numberOrNull(settings.barrierOffset)}`
                        : `-${numberOrNull(settings.barrierOffset)}`;
            }
            return request;
        },
        [client?.currency]
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
                    if (hitLimit) {
                        stopBot('Session ended by target or stop loss.');
                        Swal.fire(
                            'Session Ended',
                            `Final P/L: ${totalProfitRef.current.toFixed(2)} ${client?.currency || 'USD'}`,
                            'info'
                        );
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
    const markError = useCallback(
        (context, message) => {
            setProposalError(message);
            publishError(message);
            if (context?.group_id && context?.leg_key) {
                updateLeg(context.group_id, context.leg_key, 'ERROR', { error: message });
            }
            processingRef.current = false;
            if (activeContractsRef.current.size === 0) {
                setIsRunning(false);
                runningRef.current = false;
                run_panel?.setIsRunning?.(false);
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            }
        },
        [publishError, run_panel, updateLeg]
    );
    const handleProposal = useCallback(
        data => {
            const proposal = data.proposal;
            const context = proposal?.passthrough || data.echo_req?.passthrough;
            if (!proposal?.id || proposal.ask_price === undefined || !context?.group_id) {
                markError(context, 'Proposal response did not identify its paired leg.');
                return;
            }
            pendingProposalsRef.current.set(String(proposal.id), context);
            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
            wsRef.current?.send(
                JSON.stringify({
                    buy: proposal.id,
                    price: proposal.ask_price,
                })
            );
        },
        [markError, run_panel]
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
            if (data.error) {
                const context =
                    data.echo_req?.passthrough ||
                    pendingProposalsRef.current.get(String(data.echo_req?.buy || ''));
                markError(context, data.error.message || 'Deriv request failed.');
                return;
            }
            if (data.msg_type === 'authorize') {
                authorizedRef.current = true;
                if (startPendingRef.current && runningRef.current) {
                    startPendingRef.current = false;
                    executePairRef.current?.(selectedSymbolRef.current);
                }
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
        [completeContract, handleBuy, handleProposal, markError, publishContract]
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
                    wsRef.current?.send(
                        JSON.stringify({
                            ticks: selectedSymbolRef.current,
                            subscribe: 1,
                        })
                    );
                    if (authenticatedUrl) {
                        wsRef.current?.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
                        if (startPendingRef.current && runningRef.current) {
                            startPendingRef.current = false;
                            executePairRef.current?.(selectedSymbolRef.current);
                        }
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
        [getAuthenticatedUrl, handleMessage]
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
            if (!config.fixedDuration) {
                const duration = numberOrNull(pairSettingsRef.current.duration);
                const allowedUnits = config.durationUnits || ['t'];
                if (!Number.isInteger(duration) || duration < 2) {
                    setProposalError('Duration must be a whole number of at least 2.');
                    return false;
                }
                if (!allowedUnits.includes(durationUnitRef.current)) {
                    setProposalError('Select a valid duration unit for this contract pair.');
                    return false;
                }
            }
            if (pairKeyRef.current === 'HIGH_LOW_TICK') {
                const selectedTick = numberOrNull(pairSettingsRef.current.selectedTick);
                if (!Number.isInteger(selectedTick) || selectedTick < 1 || selectedTick > 5) {
                    setProposalError('Selected tick must be an integer from 1 to 5.');
                    return false;
                }
            }
            if (config.barrierMode === 'range') {
                const low = numberOrNull(pairSettingsRef.current.lowBarrier);
                const high = numberOrNull(pairSettingsRef.current.highBarrier);
                if (!low || !high || high <= low) {
                    setProposalError('High barrier must be greater than the positive low barrier.');
                    return false;
                }
            }
            if (config.barrierMode === 'directional') {
                const offset = numberOrNull(pairSettingsRef.current.barrierOffset);
                if (!offset || offset <= 0) {
                    setProposalError('Barrier offset must be greater than zero.');
                    return false;
                }
            }
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
                    JSON.stringify(buildRequest(config, key, groupId, symbol, amount))
                );
            });
            reconcileGroup(groupId);
            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
            return true;
        },
        [buildRequest, reconcileGroup, run_panel]
    );
    executePairRef.current = executePair;
    const startBot = useCallback(async () => {
        if (!getAuthContext()) {
            Swal.fire('Error', 'Login Required', 'error');
            return;
        }
        if (runningRef.current) {
            stopBot();
            return;
        }
        totalProfitRef.current = 0;
        setTotalProfit(0);
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
            startPendingRef.current = false;
            executePairRef.current?.(selectedSymbolRef.current);
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
        run_panel,
        stopBot,
        summary_card,
        transactions,
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
                        {SYMBOLS.map(symbol => <option value={symbol} key={symbol}>{formatSymbol(symbol)}</option>)}
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
                {selectedPair.barrierMode === 'single' && (
                    <span>Both legs: <strong>{formatSignedOffset(pairSettings.barrier)}</strong> from entry</span>
                )}
                {selectedPair.barrierMode === 'directional' && (
                    <span>Higher: <strong>{formatSignedOffset(pairSettings.barrierOffset, '+')}</strong> · Lower: <strong>{formatSignedOffset(pairSettings.barrierOffset, '-')}</strong></span>
                )}
                {selectedPair.barrierMode === 'range' && (
                    <span>Low barrier: <strong>{formatSignedOffset(pairSettings.lowBarrier, '-')}</strong> · High barrier: <strong>{formatSignedOffset(pairSettings.highBarrier, '+')}</strong></span>
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
