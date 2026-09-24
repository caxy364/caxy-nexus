import React, { useCallback, useEffect, useRef, useState } from 'react';
import Swal from 'sweetalert2';
import { FaPlay, FaStop } from 'react-icons/fa';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import './DualHigherLower.css';

const WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const OPTIONS_URL = WS_URL.replace(/ws\/public$/, '');
const SYMBOLS = ['1HZ10V', 'R_10', '1HZ25V', 'R_25', '1HZ50V', 'R_50', '1HZ75V', 'R_75', '1HZ100V', 'R_100'];
const CONTRACTS = ['TICKHIGH', 'TICKLOW'];

const displaySymbol = symbol => symbol?.startsWith('1HZ') ? `${symbol.replace('1HZ', '').replace('V', '')}(1s)` : symbol?.startsWith('R_') ? symbol.replace('R_', 'V') : symbol;

const getAuth = () => {
    try {
        const auth = JSON.parse(sessionStorage.getItem('auth_info') || '{}');
        const accounts = JSON.parse(sessionStorage.getItem('deriv_accounts') || '[]');
        const loginid = localStorage.getItem('active_loginid');
        const account = accounts.find(item => item.account_id === loginid) || accounts.find(item => item.account_id?.startsWith('DOT')) || accounts[0];
        return auth.access_token && account?.account_id ? { token: auth.access_token, account } : null;
    } catch { return null; }
};

const DualHighLowTicks = () => {
    const { transactions, journal, summary_card, run_panel, client } = useStore() || {};
    const [running, setRunning] = useState(false);
    const [symbol, setSymbol] = useState('R_10');
    const [selectedTick, setSelectedTick] = useState('3');
    const [stake, setStake] = useState('1');
    const [target, setTarget] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [mode, setMode] = useState('net');
    const [factor, setFactor] = useState('2.1');
    const [error, setError] = useState('');

    const ws = useRef(null);
    const runningRef = useRef(false);
    const processingRef = useRef(false);
    const activeRef = useRef(new Set());
    const completedRef = useRef(new Set());
    const metadataRef = useRef({});
    const pendingRef = useRef(new Map());
    const nextStakeRef = useRef({ TICKHIGH: 1, TICKLOW: 1 });
    const totalProfitRef = useRef(0);

    const publish = useCallback(contract => {
        transactions?.onBotContractEvent?.(contract);
        summary_card?.onBotContractEvent?.(contract);
    }, [summary_card, transactions]);

    const reportError = useCallback(message => {
        setError(message || 'Unknown Deriv API error');
        journal?.onError?.(message || 'Unknown Deriv API error');
    }, [journal]);

    const authUrl = useCallback(async () => {
        const context = getAuth();
        if (!context) return null;
        try {
            const response = await fetch(`${OPTIONS_URL}accounts/${context.account.account_id}/otp`, { method: 'POST', headers: { Authorization: `Bearer ${context.token}` } });
            const data = await response.json();
            return data?.data?.url || null;
        } catch { return null; }
    }, []);

    const stop = useCallback((reason = '') => {
        runningRef.current = false;
        processingRef.current = false;
        setRunning(false);
        pendingRef.current.clear();
        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({ forget_all: 'proposal' }));
            ws.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
        }
        run_panel?.setIsRunning?.(false);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        if (reason) setError(reason);
    }, [run_panel]);

    const finish = useCallback(contract => {
        const id = String(contract.contract_id || '');
        if (!id || completedRef.current.has(id)) return;
        completedRef.current.add(id);
        activeRef.current.delete(id);
        const value = Number(contract.profit || 0);
        totalProfitRef.current += value;
        const meta = metadataRef.current[id] || {};
        const result = { ...meta, ...contract, id: contract.contract_id, contract_id: contract.contract_id, result: value > 0 ? 'won' : 'lost', status: value > 0 ? 'won' : 'lost', is_sold: true };
        publish(result);
        journal?.onLogSuccess?.({ log_type: value > 0 ? 'profit' : 'lost', extra: { currency: client?.currency || 'USD', profit: value } });

        if (mode === 'split') {
            const side = meta.contract_type === 'TICKHIGH' ? 'TICKHIGH' : 'TICKLOW';
            nextStakeRef.current[side] = value < 0 ? Number((nextStakeRef.current[side] * Number(factor || 1)).toFixed(2)) : Number(stake || 1);
        }
        if (!activeRef.current.size) {
            processingRef.current = false;
            if (mode === 'net') {
                if (totalProfitRef.current < 0) CONTRACTS.forEach(type => { nextStakeRef.current[type] = Number((nextStakeRef.current[type] * Number(factor || 1)).toFixed(2)); });
                else CONTRACTS.forEach(type => { nextStakeRef.current[type] = Number(stake || 1); });
            }
            const limit = totalProfitRef.current >= Number(target || 0) || totalProfitRef.current <= -Number(stopLoss || 0);
            if (limit) { stop('Session ended by target/stop loss.'); Swal.fire('Session Ended', `Final P/L: ${totalProfitRef.current.toFixed(2)} USD`, 'info'); }
            else run_panel?.setContractStage?.(contract_stages.CONTRACT_CLOSED);
        }
    }, [client?.currency, factor, journal, mode, publish, run_panel, stake, stop, stopLoss, target]);

    const sendPair = useCallback(() => {
        if (ws.current?.readyState !== WebSocket.OPEN) return;
        const groupId = `dual-tick-${symbol}-${Date.now()}`;
        CONTRACTS.forEach(type => {
            const amount = Number(nextStakeRef.current[type].toFixed(2));
            ws.current.send(JSON.stringify({ proposal: 1, basis: 'stake', amount, currency: client?.currency || 'USD', underlying_symbol: symbol, contract_type: type, duration: 5, duration_unit: 't', selected_tick: Number(selectedTick), passthrough: { symbol, custom_type: type, sent_stake: amount, group_id: groupId, selected_tick: Number(selectedTick) } }));
        });
    }, [client?.currency, selectedTick, symbol]);

    const onMessage = useCallback(event => {
        const data = JSON.parse(event.data);
        if (data.error) { processingRef.current = false; reportError(data.error.message); return; }
        if (data.msg_type === 'tick') {
            if (runningRef.current && !activeRef.current.size && !processingRef.current) { processingRef.current = true; sendPair(); }
            return;
        }
        if (data.msg_type === 'proposal' && data.proposal) {
            const context = data.proposal.passthrough || data.echo_req?.passthrough || {};
            pendingRef.current.set(String(data.proposal.id), context);
            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
            ws.current?.send(JSON.stringify({ buy: data.proposal.id, price: data.proposal.ask_price }));
            return;
        }
        if (data.msg_type === 'buy' && data.buy) {
            const context = pendingRef.current.get(String(data.echo_req?.buy)) || {};
            pendingRef.current.delete(String(data.echo_req?.buy));
            const id = String(data.buy.contract_id);
            activeRef.current.add(id);
            metadataRef.current[id] = { id: data.buy.contract_id, contract_id: data.buy.contract_id, transaction_ids: { buy: data.buy.transaction_id }, buy_price: data.buy.buy_price, currency: client?.currency || 'USD', display_name: displaySymbol(context.symbol), underlying: context.symbol, underlying_symbol: context.symbol, contract_type: context.custom_type, selected_tick: context.selected_tick, group_id: context.group_id, status: 'open' };
            publish(metadataRef.current[id]);
            run_panel?.setHasOpenContract?.(true);
            run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);
            ws.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id: data.buy.contract_id, subscribe: 1 }));
            return;
        }
        if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
            const contract = data.proposal_open_contract;
            const status = String(contract.status || '').toLowerCase();
            const sold = contract.is_sold === 1 || contract.is_sold === true || contract.is_expired === 1 || (status && status !== 'open');
            const meta = metadataRef.current[String(contract.contract_id)] || {};
            publish({ ...meta, ...contract, id: contract.contract_id, contract_id: contract.contract_id, is_sold: sold });
            if (sold) finish(contract);
        }
    }, [client?.currency, finish, publish, reportError, run_panel, sendPair]);

    const start = useCallback(async () => {
        if (!getAuth()) return Swal.fire('Error', 'Login Required', 'error');
        if (running) return stop();
        const url = await authUrl();
        if (!url) return reportError('Unable to authenticate with Deriv.');
        transactions?.clear?.(); summary_card?.clear?.();
        totalProfitRef.current = 0; activeRef.current.clear(); completedRef.current.clear(); metadataRef.current = {}; processingRef.current = false;
        nextStakeRef.current = { TICKHIGH: Number(stake || 1), TICKLOW: Number(stake || 1) };
        ws.current = new WebSocket(url);
        ws.current.onopen = () => { ws.current.send(JSON.stringify({ ticks: symbol, subscribe: 1 })); ws.current.send(JSON.stringify({ transaction: 1, subscribe: 1 })); };
        ws.current.onmessage = onMessage;
        ws.current.onerror = () => reportError('WebSocket connection error.');
        ws.current.onclose = () => { if (runningRef.current) reportError('Connection closed.'); };
        runningRef.current = true; setRunning(true); setError('');
        run_panel?.setIsRunning?.(true); run_panel?.setHasOpenContract?.(false); run_panel?.setContractStage?.(contract_stages.STARTING); run_panel?.toggleDrawer?.(true); run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);
    }, [authUrl, onMessage, reportError, run_panel, running, stake, stop, summary_card, symbol, transactions]);

    useEffect(() => () => { runningRef.current = false; ws.current?.close(); }, []);
    useEffect(() => { observer.register('dualhighlowticks.start', start); observer.register('dualhighlowticks.stop', stop); return () => { observer.unregister('dualhighlowticks.start', start); observer.unregister('dualhighlowticks.stop', stop); }; }, [start, stop]);

    return <div className='dhl-tool'><header><h1>Dual High/Low Ticks</h1><p>Executes High Tick and Low Tick together. Each contract has the strict Deriv duration of five ticks.</p></header><div className='dhl-settings'><label>Volatility<select value={symbol} onChange={e => setSymbol(e.target.value)} disabled={running}>{SYMBOLS.map(item => <option key={item} value={item}>{displaySymbol(item)}</option>)}</select></label><label>Selected tick<select value={selectedTick} onChange={e => setSelectedTick(e.target.value)} disabled={running}>{[1, 2, 3, 4, 5].map(item => <option key={item} value={item}>Tick {item}</option>)}</select></label><label>Duration<strong>5 ticks</strong></label><label>Stake<input type='number' step='0.01' value={stake} onChange={e => setStake(e.target.value)} disabled={running} /></label><label>Target Profit<input type='number' value={target} onChange={e => setTarget(e.target.value)} disabled={running} /></label><label>Stop Loss<input type='number' value={stopLoss} onChange={e => setStopLoss(e.target.value)} disabled={running} /></label><label>Martingale<select value={mode} onChange={e => setMode(e.target.value)} disabled={running}><option value='net'>When BOTH lose</option><option value='split'>On every loss</option></select></label><label>Multiplier<input type='number' step='0.1' value={factor} onChange={e => setFactor(e.target.value)} disabled={running} /></label></div><button type='button' className={running ? 'stop' : ''} onClick={start}>{running ? <FaStop /> : <FaPlay />} {running ? ' STOP BOT' : ' EXECUTE TRADES'}</button>{error && <p className='dhl-error'>{error}</p>}</div>;
};

export default DualHighLowTicks;
