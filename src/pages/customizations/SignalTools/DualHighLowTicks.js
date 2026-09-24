import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
const SYMBOLS = ['1HZ10V', 'R_10', '1HZ25V', 'R_25', '1HZ50V', 'R_50', '1HZ75V', 'R_75', '1HZ100V', 'R_100'];
const LEG_KEYS = ['A', 'B'];
const LEG_CONFIG = {
    A: { label: 'Tick High', contract_type: 'TICKHIGH' },
    B: { label: 'Tick Low', contract_type: 'TICKLOW' },
};
const PROPOSAL_PAIR_MAX_SKEW_MS = 1200;
const BUY_PAIR_TIMEOUT_MS = 2500;
const TERMINAL_STATUSES = new Set(['won', 'lost', 'sold', 'cancelled', 'expired']);

const formatSymbol = symbol => {
    if (!symbol) return '';
    if (symbol.startsWith('1HZ')) return `${symbol.replace('1HZ', '').replace('V', '')}(1s)`;
    if (symbol.startsWith('R_')) return symbol.replace('R_', 'V');
    return symbol;
};

const getAuthContext = () => {
    try {
        const auth = JSON.parse(sessionStorage.getItem('auth_info') || 'null');
        const accounts = JSON.parse(sessionStorage.getItem('deriv_accounts') || 'null');
        if (!auth?.access_token || !Array.isArray(accounts) || !accounts.length) return null;
        const activeLoginId = localStorage.getItem('active_loginid');
        const activeAccount = accounts.find(account => account.account_id === activeLoginId) ||
            accounts.find(account => account.account_id?.startsWith('DOT')) || accounts[0];
        return activeAccount?.account_id ? { accessToken: auth.access_token, activeAccount } : null;
    } catch (error) {
        console.error('[DualHighLowTicks] Failed to read auth context:', error);
        return null;
    }
};

const createIdleGroup = symbol => ({
    groupId: null,
    symbol,
    status: 'IDLE',
    legs: {
        A: { label: LEG_CONFIG.A.label, state: 'IDLE', profit: null, error: '' },
        B: { label: LEG_CONFIG.B.label, state: 'IDLE', profit: null, error: '' },
    },
});

const isComplete = contract => {
    const status = String(contract?.status || '').toLowerCase();
    return contract?.is_sold === 1 || contract?.is_sold === true || contract?.is_sold === '1' || TERMINAL_STATUSES.has(status);
};

const DualHighLowTicks = () => {
    const store = useStore();
    const { transactions, journal, summary_card, run_panel, client } = store || {};
    const [selectedSymbol, setSelectedSymbol] = useState('R_50');
    const [selectedTick, setSelectedTick] = useState('3');
    const [duration, setDuration] = useState('3');
    const [stake, setStake] = useState('1');
    const [targetProfit, setTargetProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [isRunning, setIsRunning] = useState(false);
    const [pairStatus, setPairStatus] = useState(createIdleGroup('R_50'));
    const [proposalError, setProposalError] = useState('');
    const [totalProfit, setTotalProfit] = useState(0);

    const wsRef = useRef(null);
    const runningRef = useRef(false);
    const activeContractsRef = useRef(new Set());
    const completedContractsRef = useRef(new Set());
    const contractMetaRef = useRef({});
    const proposalGroupsRef = useRef(new Map());
    const pendingProposalRef = useRef(new Map());
    const groupRef = useRef(null);
    const pairTimeoutsRef = useRef(new Map());
    const totalProfitRef = useRef(0);

    const publishContract = useCallback(contract => {
        transactions?.onBotContractEvent?.(contract);
        summary_card?.onBotContractEvent?.(contract);
    }, [summary_card, transactions]);

    const publishResult = useCallback(contract => {
        journal?.onLogSuccess?.({
            log_type: Number(contract.profit || 0) > 0 ? 'profit' : 'lost',
            extra: { currency: contract.currency || client?.currency || 'USD', profit: Number(contract.profit || 0) },
        });
    }, [client?.currency, journal]);

    const setError = useCallback(message => {
        setProposalError(message);
        journal?.onError?.(message);
    }, [journal]);

    const updateLeg = useCallback((groupId, key, details) => {
        if (groupRef.current !== groupId) return;
        setPairStatus(current => ({
            ...current,
            status: details.state === 'ERROR' ? 'ATTENTION_REQUIRED' : current.status,
            legs: { ...current.legs, [key]: { ...current.legs[key], ...details } },
        }));
    }, []);

    const sellOpenLegs = useCallback(reason => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) return;
        activeContractsRef.current.forEach(contractKey => {
            const contractId = contractMetaRef.current[contractKey]?.contract_id;
            if (contractId) wsRef.current.send(JSON.stringify({ sell: contractId, price: 0 }));
        });
        if (reason) setError(`${reason} Any already purchased leg is being closed.`);
    }, [setError]);

    const stopBot = useCallback((reason = 'Bot stopped.', preserveOpen = false) => {
        runningRef.current = false;
        setIsRunning(false);
        pairTimeoutsRef.current.forEach(timeout => window.clearTimeout(timeout));
        pairTimeoutsRef.current.clear();
        proposalGroupsRef.current.clear();
        pendingProposalRef.current.clear();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ forget_all: 'proposal' }));
            if (!preserveOpen) wsRef.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
        }
        if (!preserveOpen) sellOpenLegs(reason);
        run_panel?.setIsRunning?.(false);
        run_panel?.setHasOpenContract?.(activeContractsRef.current.size > 0);
        run_panel?.setContractStage?.(activeContractsRef.current.size ? contract_stages.IS_STOPPING : contract_stages.NOT_RUNNING);
        if (!activeContractsRef.current.size) setPairStatus(createIdleGroup(selectedSymbol));
        console.log(`[DualHighLowTicks] ${reason}`);
    }, [run_panel, selectedSymbol, sellOpenLegs]);

    const getAuthenticatedUrl = useCallback(async () => {
        try {
            const context = getAuthContext();
            if (!context) throw new Error('Session Missing');
            const response = await fetch(`${DERIV_OPTIONS_API_URL}accounts/${context.activeAccount.account_id}/otp`, {
                method: 'POST', headers: { Authorization: `Bearer ${context.accessToken}` },
            });
            if (!response.ok) throw new Error('OTP Request Failed');
            const json = await response.json();
            if (!json?.data?.url) throw new Error('Authenticated URL Missing');
            return json.data.url;
        } catch (error) {
            setError(error.message);
            return null;
        }
    }, [setError]);

    const connectSocket = useCallback(async () => {
        if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return true;
        const url = await getAuthenticatedUrl();
        if (!url) return false;
        wsRef.current = new WebSocket(url);
        wsRef.current.onopen = () => {
            wsRef.current.send(JSON.stringify({ ticks: selectedSymbol, subscribe: 1 }));
            wsRef.current.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
        };
        return true;
    }, [getAuthenticatedUrl, selectedSymbol]);

    const handleMessage = useCallback(event => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        const requestContext = data.echo_req?.passthrough;
        if (data.error) {
            const context = requestContext || pendingProposalRef.current.get(String(data.echo_req?.buy || ''));
            const message = data.error.message || 'Deriv request failed.';
            if (context?.group_id) {
                updateLeg(context.group_id, context.leg_key || 'A', { state: 'ERROR', error: message });
                sellOpenLegs(message);
                stopBot(message, true);
            } else setError(message);
            return;
        }
        if (data.msg_type === 'proposal' && data.proposal) {
            const context = data.proposal.passthrough || requestContext;
            if (!context?.group_id || !context.leg_key || !data.proposal.id) return;
            const group = proposalGroupsRef.current.get(context.group_id) || { proposals: {}, buying: false };
            if (group.buying || group.proposals[context.leg_key]) return;
            const record = { ...context, proposalId: String(data.proposal.id), askPrice: Number(data.proposal.ask_price), receivedAt: Date.now() };
            if (!Number.isFinite(record.askPrice) || record.askPrice <= 0) {
                setError('Invalid proposal price. Neither leg was purchased.');
                stopBot('Invalid proposal price.');
                return;
            }
            group.proposals[context.leg_key] = record;
            proposalGroupsRef.current.set(context.group_id, group);
            pendingProposalRef.current.set(record.proposalId, record);
            if (Object.keys(group.proposals).length === 1) {
                const timeout = window.setTimeout(() => {
                    const current = proposalGroupsRef.current.get(context.group_id);
                    if (current && !current.proposals.A || current && !current.proposals.B) {
                        setError('Both proposals did not arrive together. No leg was purchased.');
                        stopBot('Incomplete proposal pair.');
                    }
                }, PROPOSAL_PAIR_MAX_SKEW_MS);
                pairTimeoutsRef.current.set(context.group_id, timeout);
                return;
            }
            const proposalA = group.proposals.A;
            const proposalB = group.proposals.B;
            if (!proposalA || !proposalB || Math.abs(proposalA.receivedAt - proposalB.receivedAt) > PROPOSAL_PAIR_MAX_SKEW_MS) {
                setError('The pair proposals were not synchronized closely enough. No leg was purchased.');
                stopBot('Proposal synchronization failed.');
                return;
            }
            group.buying = true;
            const timeout = pairTimeoutsRef.current.get(context.group_id);
            if (timeout) window.clearTimeout(timeout);
            [proposalA, proposalB].forEach(proposal => wsRef.current.send(JSON.stringify({ buy: proposal.proposalId, price: proposal.askPrice })));
            const buyTimeout = window.setTimeout(() => {
                const bothActive = LEG_KEYS.every(key => pairStatus.legs[key]?.state === 'ACTIVE');
                if (!bothActive && runningRef.current) {
                    sellOpenLegs('The two buy confirmations were not received together.');
                    stopBot('Buy pair synchronization failed.', true);
                }
            }, BUY_PAIR_TIMEOUT_MS);
            pairTimeoutsRef.current.set(context.group_id, buyTimeout);
            return;
        }
        if (data.msg_type === 'buy' && data.buy) {
            const buy = data.buy;
            const context = pendingProposalRef.current.get(String(data.echo_req?.buy || '')) || buy.passthrough || {};
            if (!buy.contract_id || !context.group_id || !context.leg_key) return;
            pendingProposalRef.current.delete(String(data.echo_req?.buy || ''));
            const key = String(buy.contract_id);
            activeContractsRef.current.add(key);
            contractMetaRef.current[key] = {
                id: buy.contract_id, contract_id: buy.contract_id, buy_price: buy.buy_price ?? context.sent_stake,
                currency: client?.currency || 'USD', display_name: formatSymbol(context.symbol), underlying: context.symbol,
                underlying_symbol: context.symbol, contract_type: context.deriv_contract_type, longcode: buy.longcode,
                group_id: context.group_id, leg_key: context.leg_key, status: 'open', is_sold: false,
            };
            publishContract(contractMetaRef.current[key]);
            updateLeg(context.group_id, context.leg_key, { state: 'ACTIVE', contractId: buy.contract_id, profit: 0 });
            run_panel?.setHasOpenContract?.(true);
            wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 }));
            return;
        }
        if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
            const contract = data.proposal_open_contract;
            const key = String(contract.contract_id || '');
            const meta = contractMetaRef.current[key] || {};
            publishContract({ ...meta, ...contract, id: contract.contract_id, contract_id: contract.contract_id, is_sold: isComplete(contract) });
            if (!isComplete(contract) || !activeContractsRef.current.has(key) || completedContractsRef.current.has(key)) return;
            completedContractsRef.current.add(key);
            activeContractsRef.current.delete(key);
            const profit = Number(contract.profit || 0);
            totalProfitRef.current += profit;
            setTotalProfit(totalProfitRef.current);
            const result = { ...meta, ...contract, id: contract.contract_id, contract_id: contract.contract_id, profit, result: profit > 0 ? 'won' : 'lost', status: profit > 0 ? 'won' : 'lost', is_sold: true };
            publishContract(result);
            publishResult(result);
            updateLeg(meta.group_id, meta.leg_key, { state: 'COMPLETE', profit, error: '' });
            if (!activeContractsRef.current.size) {
                const hitLimit = totalProfitRef.current >= Number(targetProfit) || totalProfitRef.current <= -Number(stopLoss);
                if (hitLimit) {
                    stopBot(`Session ended at ${totalProfitRef.current.toFixed(2)}.`, true);
                    Swal.fire('Session Ended', `Final P/L: ${totalProfitRef.current.toFixed(2)} ${client?.currency || 'USD'}`, 'info');
                } else {
                    runningRef.current = false;
                    setIsRunning(false);
                    run_panel?.setHasOpenContract?.(false);
                    run_panel?.setContractStage?.(contract_stages.CONTRACT_CLOSED);
                    setPairStatus(current => ({ ...current, status: 'PAIR_COMPLETE' }));
                }
            }
        }
    }, [client?.currency, pairStatus.legs, publishContract, publishResult, run_panel, sellOpenLegs, setError, stopBot, targetProfit, stopLoss, updateLeg]);

    useEffect(() => {
        connectSocket();
        return () => {
            pairTimeoutsRef.current.forEach(timeout => window.clearTimeout(timeout));
            wsRef.current?.close();
        };
    }, [connectSocket]);

    const executePair = useCallback(async () => {
        if (runningRef.current) return stopBot('Bot already running.');
        const amount = Number(stake);
        const tick = Number(selectedTick);
        const ticks = Number(duration);
        if (!Number.isFinite(amount) || amount <= 0) return setError('Stake must be greater than zero.');
        if (!Number.isInteger(tick) || tick < 1 || tick > 5) return setError('Selected tick must be an integer from 1 to 5.');
        if (!Number.isInteger(ticks) || ticks < 1 || ticks > 10) return setError('Duration must be a whole number from 1 to 10 ticks.');
        if (!getAuthContext()) return Swal.fire('Error', 'Login Required', 'error');
        if (!(await connectSocket()) || wsRef.current?.readyState !== WebSocket.OPEN) return setError('Authenticated trading connection is not ready.');

        const groupId = `dual-high-low-${Date.now()}`;
        groupRef.current = groupId;
        proposalGroupsRef.current.set(groupId, { proposals: {}, buying: false });
        setPairStatus({ groupId, symbol: selectedSymbol, status: 'PAIR_CREATED', legs: {
            A: { label: LEG_CONFIG.A.label, state: 'PENDING', profit: null, error: '' },
            B: { label: LEG_CONFIG.B.label, state: 'PENDING', profit: null, error: '' },
        } });
        setProposalError('');
        setTotalProfit(0);
        totalProfitRef.current = 0;
        activeContractsRef.current.clear();
        completedContractsRef.current.clear();
        contractMetaRef.current = {};
        transactions?.clear?.();
        summary_card?.clear?.();
        runningRef.current = true;
        setIsRunning(true);
        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);

        LEG_KEYS.forEach(key => {
            const contractType = LEG_CONFIG[key].contract_type;
            const passthrough = {
                group_id: groupId, leg_key: key, custom_type: LEG_CONFIG[key].label,
                deriv_contract_type: contractType, symbol: selectedSymbol, sent_stake: amount,
                duration: ticks, duration_unit: 't', selected_tick: tick,
            };
            wsRef.current.send(JSON.stringify({
                proposal: 1, basis: 'stake', amount, currency: client?.currency || 'USD',
                underlying_symbol: selectedSymbol, contract_type: contractType,
                duration: ticks, duration_unit: 't', selected_tick: tick, passthrough,
            }));
        });
    }, [client?.currency, connectSocket, duration, run_panel, selectedSymbol, selectedTick, setError, stake, stopBot, summary_card, transactions]);

    const toggleBot = useCallback(() => isRunning ? stopBot('Manual stop.') : executePair(), [executePair, isRunning, stopBot]);
    const statusText = useMemo(() => isRunning ? 'LIVE' : 'STANDBY', [isRunning]);

    return (
        <div className='dhl-tool'>
            <div className='dhl-header'><div><span className='dhl-kicker'>Paired hedging</span><h1>Dual High / Low Ticks</h1><p>Both legs use the same symbol, selected tick, and exact configured duration.</p></div><span className={`dhl-run-state ${isRunning ? 'is-live' : 'is-idle'}`}>{statusText}</span></div>
            <div className='dhl-controls'>
                <label className='dhl-field'><span>Volatility / market</span><select value={selectedSymbol} onChange={event => setSelectedSymbol(event.target.value)} disabled={isRunning}>{SYMBOLS.map(symbol => <option key={symbol} value={symbol}>{formatSymbol(symbol)}</option>)}</select></label>
                <label className='dhl-field'><span>Selected tick position</span><select value={selectedTick} onChange={event => setSelectedTick(event.target.value)} disabled={isRunning}>{[1, 2, 3, 4, 5].map(tick => <option key={tick} value={tick}>Tick {tick}</option>)}</select></label>
                <label className='dhl-field'><span>Contract duration (ticks)</span><input type='number' min='1' max='10' step='1' value={duration} onChange={event => setDuration(event.target.value)} disabled={isRunning} /></label>
                <label className='dhl-field'><span>Stake per leg</span><input type='number' min='0.01' step='0.01' value={stake} onChange={event => setStake(event.target.value)} disabled={isRunning} /></label>
                <label className='dhl-field'><span>Target P/L</span><input type='number' step='0.01' value={targetProfit} onChange={event => setTargetProfit(event.target.value)} disabled={isRunning} /></label>
                <label className='dhl-field'><span>Stop loss</span><input type='number' min='0' step='0.01' value={stopLoss} onChange={event => setStopLoss(event.target.value)} disabled={isRunning} /></label>
            </div>
            <div className='dhl-actions'><button type='button' className={`dhl-run-button ${isRunning ? 'is-stop' : ''}`} onClick={toggleBot}>{isRunning ? <FaStop /> : <FaPlay />}{isRunning ? 'Stop hedged pair' : 'Execute trades'}</button><div className='dhl-metrics'><span>Session P/L <strong className={totalProfit >= 0 ? 'is-positive' : 'is-negative'}>{totalProfit.toFixed(2)}</strong></span></div></div>
            {proposalError && <div className='dhl-error' role='alert'>{proposalError}</div>}
            <div className='dhl-pair-summary'><div><span className='dhl-kicker'>Selected pair</span><strong>Tick High / Tick Low</strong><p>Exact duration: {duration} ticks · Selected position: tick {selectedTick}.</p></div><div className='dhl-group-id'><span>Group</span><code>{pairStatus.groupId || 'Not created'}</code></div><div className='dhl-status-pill'>{String(pairStatus.status || 'IDLE').replace(/_/g, ' ')}</div></div>
            <div className='dhl-legs'>{LEG_KEYS.map(key => <div className={`dhl-leg-card dhl-leg-card--${String(pairStatus.legs[key].state || 'idle').toLowerCase()}`} key={key}><div className='dhl-leg-heading'><span>LEG {key}</span><strong>{LEG_CONFIG[key].label}</strong></div><div className='dhl-leg-state'>{String(pairStatus.legs[key].state || 'IDLE').replace(/_/g, ' ')}</div>{pairStatus.legs[key].profit !== null && <div className='dhl-leg-profit'>P/L: {Number(pairStatus.legs[key].profit).toFixed(2)}</div>}{pairStatus.legs[key].error && <div className='dhl-leg-error'>{pairStatus.legs[key].error}</div>}</div>)}</div>
        </div>
    );
};

export default DualHighLowTicks;
