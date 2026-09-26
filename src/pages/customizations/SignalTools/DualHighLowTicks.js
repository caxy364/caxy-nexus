import React, { useCallback, useEffect, useRef, useState } from 'react';
import Swal from 'sweetalert2';
import { FaPlay, FaStop } from 'react-icons/fa';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { contract_stages } from '@/constants/contract-stage';
import { useStore } from '@/hooks/useStore';
import './DualHighLowTicks.css';

const OPTIONS_URL = (isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING).replace(/ws\/public$/, '');
const SYMBOLS = ['1HZ10V', 'R_10', '1HZ25V', 'R_25', '1HZ50V', 'R_50', '1HZ75V', 'R_75', '1HZ100V', 'R_100'];
const LEGS = { A: { label: 'Tick High', type: 'TICKHIGH' }, B: { label: 'Tick Low', type: 'TICKLOW' } };
const TERMINAL = new Set(['won', 'lost', 'sold', 'cancelled', 'expired']);

const formatSymbol = s => s?.startsWith('1HZ') ? `${s.replace('1HZ', '').replace('V', '')}(1s)` : s?.startsWith('R_') ? s.replace('R_', 'V') : s || '';

const authContext = () => {
    try {
        const auth = JSON.parse(sessionStorage.getItem('auth_info') || 'null');
        const accounts = JSON.parse(sessionStorage.getItem('deriv_accounts') || 'null');
        const id = localStorage.getItem('active_loginid');
        const account = accounts?.find(a => a.account_id === id) || accounts?.find(a => a.account_id?.startsWith('DOT')) || accounts?.[0];
        return auth?.access_token && account?.account_id ? { token: auth.access_token, account } : null;
    } catch { return null; }
};

const complete = c => c?.is_sold === 1 || c?.is_sold === true || c?.is_sold === '1' || TERMINAL.has(String(c?.status || '').toLowerCase());

const idle = symbol => ({
    groupId: null, symbol, status: 'IDLE',
    legs: {
        A: { label: LEGS.A.label, state: 'IDLE', profit: null, entry: '-', exit: '', error: '' },
        B: { label: LEGS.B.label, state: 'IDLE', profit: null, entry: '-', exit: '', error: '' }
    }
});

const DualHighLowTicks = () => {
    const { transactions, journal, summary_card, run_panel, client } = useStore() || {};
    const [symbol, setSymbol] = useState('R_50');
    const [selectedTick, setSelectedTick] = useState('3');
    const [duration, setDuration] = useState('3');
    const [stake, setStake] = useState('1');
    const [target, setTarget] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [martingaleMode, setMartingaleMode] = useState('net');
    const [multiplier, setMultiplier] = useState('2.1');
    const [running, setRunning] = useState(false);
    const [error, setError] = useState('');
    const [totalProfit, setTotalProfit] = useState(0);
    const [status, setStatus] = useState(idle('R_50'));

    // ---- refs ----
    const ws = useRef(null);
    const runningRef = useRef(false);
    const reconnectRef = useRef(null);
    const nextStakeRef = useRef({ A: 1, B: 1 });
    const proposalsRef = useRef(new Map());
    const groupsRef = useRef(new Map());
    const contractsRef = useRef(new Map());
    const activeRef = useRef(new Set());
    const completedRef = useRef(new Set());
    const pairProfitRef = useRef({});
    const totalRef = useRef(0);

    // ---- NEW tick-driven refs ----
    const currentTickRef = useRef(0);         // monotonically increasing tick counter
    const pendingStartTickRef = useRef(null); // tick on which to fire next pair
    const activePairRef = useRef(null);       // { groupId, startTick, endTick, legs }
    const tickSubscribedRef = useRef(false);

    const reportError = useCallback(message => {
        setError(message);
        journal?.onError?.(message);
    }, [journal]);

    const publish = useCallback(c => {
        transactions?.onBotContractEvent?.(c);
        summary_card?.onBotContractEvent?.(c);
    }, [transactions, summary_card]);

    const getUrl = useCallback(async () => {
        const context = authContext();
        if (!context) throw new Error('Login Required');
        const response = await fetch(
            `${OPTIONS_URL}accounts/${context.account.account_id}/otp`,
            { method: 'POST', headers: { Authorization: `Bearer ${context.token}` } }
        );
        if (!response.ok) throw new Error('OTP Request Failed');
        const json = await response.json();
        if (!json?.data?.url) throw new Error('Authenticated URL Missing');
        return json.data.url;
    }, []);

    // ---------- stop ----------
    const stop = useCallback((reason = '', preserveContracts = false) => {
        runningRef.current = false;
        setRunning(false);
        activePairRef.current = null;
        pendingStartTickRef.current = null;
        proposalsRef.current.clear();
        groupsRef.current.clear();
        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({ forget_all: 'proposal' }));
            if (!preserveContracts) {
                ws.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
                activeRef.current.forEach(id =>
                    ws.current.send(JSON.stringify({ sell: Number(id), price: 0 }))
                );
            }
        }
        run_panel?.setIsRunning?.(false);
        run_panel?.setHasOpenContract?.(activeRef.current.size > 0);
        run_panel?.setContractStage?.(
            activeRef.current.size ? contract_stages.IS_STOPPING : contract_stages.NOT_RUNNING
        );
        if (reason) reportError(reason);
    }, [reportError, run_panel]);

    // ---------- fire pair on current tick ----------
    const firePair = useCallback(() => {
        if (!runningRef.current || ws.current?.readyState !== WebSocket.OPEN) return;
        if (activePairRef.current) return; // one pair at a time

        const amount = Number(stake);
        const ticks = Number(duration);
        const tick = Number(selectedTick);
        const groupId = `dhl-${Date.now()}-${currentTickRef.current}`;

        groupsRef.current.set(groupId, { proposals: {}, buying: false });

        activePairRef.current = {
            groupId,
            startTick: currentTickRef.current,
            endTick: currentTickRef.current + ticks,  // duration N ticks
            legs: { A: null, B: null },
            settled: { A: false, B: false },
        };

        setStatus({
            groupId, symbol, status: 'PAIR_CREATED',
            legs: {
                A: { label: LEGS.A.label, state: 'PENDING', profit: null, entry: '-', exit: '', error: '' },
                B: { label: LEGS.B.label, state: 'PENDING', profit: null, entry: '-', exit: '', error: '' }
            }
        });

        ['A', 'B'].forEach(key => {
            const context = {
                group_id: groupId,
                leg_key: key,
                symbol,
                custom_type: LEGS[key].label,
                deriv_contract_type: LEGS[key].type,
                sent_stake: Number(nextStakeRef.current[key].toFixed(2)),
                duration: ticks,
                duration_unit: 't',
                start_tick: currentTickRef.current,
            };
            ws.current.send(JSON.stringify({
                proposal: 1,
                basis: 'stake',
                amount: context.sent_stake,
                currency: client?.currency || 'USD',
                underlying_symbol: symbol,
                contract_type: LEGS[key].type,
                duration: ticks,
                duration_unit: 't',
                passthrough: context,
            }));
        });
    }, [client?.currency, duration, selectedTick, stake, symbol]);

    // ---------- tick handler (the clock) ----------
    const onTick = useCallback(tick => {
        if (!runningRef.current) return;
        currentTickRef.current += 1;

        // if a pair is active and its end tick has arrived → mark ready for next
        if (activePairRef.current && currentTickRef.current >= activePairRef.current.endTick) {
            // The pair's contracts will settle on their own; we just clear the "busy" flag
            // so the next pair can start on the next tick.
            if (activePairRef.current.settled.A && activePairRef.current.settled.B) {
                activePairRef.current = null;
            }
        }

        // if no active pair and no pending start → schedule start on this tick
        if (!activePairRef.current && pendingStartTickRef.current === null) {
            pendingStartTickRef.current = currentTickRef.current;
        }

        // fire the pair on the exact tick we scheduled
        if (pendingStartTickRef.current === currentTickRef.current && !activePairRef.current) {
            pendingStartTickRef.current = null;
            firePair();
        }
    }, [firePair]);

    // ---------- message handler ----------
    const onMessage = useCallback(event => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        const echoed = data.echo_req?.passthrough;

        if (data.error) {
            reportError(data.error.message || 'Deriv request failed.');
            stop(data.error.message || 'Deriv request failed.', true);
            return;
        }

        // ---- ticks (the clock) ----
        if (data.msg_type === 'tick' && data.tick) {
            onTick(data.tick);
            return;
        }

        // ---- proposals ----
        if (data.msg_type === 'proposal' && data.proposal?.id) {
            const context = data.proposal.passthrough || echoed;
            if (!context?.group_id || !context.leg_key) return;
            const group = groupsRef.current.get(context.group_id);
            if (!group || group.buying || group.proposals[context.leg_key]) return;

            group.proposals[context.leg_key] = {
                ...context,
                id: String(data.proposal.id),
                price: Number(data.proposal.ask_price),
                received: performance.now(),
            };
            proposalsRef.current.set(String(data.proposal.id), group.proposals[context.leg_key]);

            if (!group.proposals.A || !group.proposals.B) return;

            // Only buy if we're still on the same tick the pair started on
            if (currentTickRef.current !== context.start_tick) {
                reportError('Proposals arrived after tick boundary. Skipping pair.');
                groupsRef.current.delete(context.group_id);
                activePairRef.current = null;
                return;
            }

            group.buying = true;
            ['A', 'B'].forEach(key =>
                ws.current.send(JSON.stringify({
                    buy: group.proposals[key].id,
                    price: group.proposals[key].price,
                }))
            );
            return;
        }

        // ---- buys ----
        if (data.msg_type === 'buy' && data.buy?.contract_id) {
            const proposalId = String(data.echo_req?.buy || '');
            const context = proposalsRef.current.get(proposalId) || data.buy.passthrough;
            if (!context?.group_id || !context.leg_key) return;

            const id = String(data.buy.contract_id);
            activeRef.current.add(id);
            const meta = {
                ...context,
                id,
                contract_id: data.buy.contract_id,
                buy_price: Number(data.buy.buy_price || context.sent_stake),
                currency: client?.currency || 'USD',
                display_name: formatSymbol(context.symbol),
                contract_type: context.deriv_contract_type,
                status: 'open',
                entry_spot: null,
                exit_spot: null,
            };
            contractsRef.current.set(id, meta);
            publish(meta);

            setStatus(current => ({
                ...current,
                status: 'ACTIVE',
                legs: {
                    ...current.legs,
                    [context.leg_key]: { ...current.legs[context.leg_key], state: 'ACTIVE' }
                }
            }));

            ws.current.send(JSON.stringify({
                proposal_open_contract: 1,
                contract_id: data.buy.contract_id,
                subscribe: 1,
            }));
            return;
        }

        // ---- contract updates ----
        if (data.msg_type === 'proposal_open_contract' && data.proposal_open_contract) {
            const c = data.proposal_open_contract;
            const id = String(c.contract_id || '');
            const meta = contractsRef.current.get(id);
            if (!meta) return;

            const finished = complete(c);
            const entry = c.entry_spot_display_value ?? c.entry_spot ?? c.entry_tick_display_value ?? c.entry_tick ?? '-';
            const exit = finished
                ? (c.exit_tick_display_value ?? c.exit_tick ?? c.exit_spot_display_value ?? c.exit_spot ?? '')
                : '';

            const normalized = {
                ...meta, ...c,
                id: c.contract_id,
                contract_id: c.contract_id,
                entry_spot: entry,
                exit_spot: exit,
                is_sold: finished,
            };
            publish(normalized);

            setStatus(current => ({
                ...current,
                legs: {
                    ...current.legs,
                    [meta.leg_key]: {
                        ...current.legs[meta.leg_key],
                        entry, exit,
                        profit: finished ? Number(c.profit || 0) : current.legs[meta.leg_key].profit,
                    }
                }
            }));

            if (!finished || !activeRef.current.has(id) || completedRef.current.has(id)) return;

            completedRef.current.add(id);
            activeRef.current.delete(id);

            const profit = Number(c.profit || 0);
            pairProfitRef.current[meta.leg_key] = profit;
            totalRef.current += profit;
            setTotalProfit(totalRef.current);
            journal?.onLogSuccess?.({
                log_type: profit > 0 ? 'profit' : 'lost',
                extra: { currency: client?.currency || 'USD', profit }
            });

            // Mark leg settled in the active pair
            if (activePairRef.current && activePairRef.current.groupId === meta.group_id) {
                activePairRef.current.settled[meta.leg_key] = true;
                if (activePairRef.current.settled.A && activePairRef.current.settled.B) {
                    activePairRef.current = null; // ready for next pair on next tick
                }
            }

            // ---- martingale ----
            const pairProfit = Number(pairProfitRef.current.A || 0) + Number(pairProfitRef.current.B || 0);
            const factor = Math.max(1, Number(multiplier) || 1);
            if (martingaleMode === 'split') {
                ['A', 'B'].forEach(key => {
                    nextStakeRef.current[key] = pairProfitRef.current[key] < 0
                        ? nextStakeRef.current[key] * factor
                        : Number(stake);
                });
            } else {
                ['A', 'B'].forEach(key => {
                    nextStakeRef.current[key] = pairProfit < 0
                        ? nextStakeRef.current[key] * factor
                        : Number(stake);
                });
            }
            pairProfitRef.current = {};

            // ---- target / stop loss ----
            const limit = totalRef.current >= Number(target) || totalRef.current <= -Math.abs(Number(stopLoss));
            if (limit) {
                stop(`Session limit reached: ${totalRef.current.toFixed(2)}`, true);
                Swal.fire('Session Ended', `Final P/L: ${totalRef.current.toFixed(2)} ${client?.currency || 'USD'}`, 'info');
            }
        }
    }, [client?.currency, journal, martingaleMode, multiplier, onTick, publish, reportError, stake, stop, stopLoss, target]);

    // ---------- connect ----------
    const connect = useCallback(async () => {
        if (ws.current?.readyState === WebSocket.OPEN || ws.current?.readyState === WebSocket.CONNECTING) return true;
        try {
            ws.current = new WebSocket(await getUrl());
            ws.current.onopen = () => {
                if (!tickSubscribedRef.current) {
                    ws.current.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
                    ws.current.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
                    tickSubscribedRef.current = true;
                }
            };
            ws.current.onmessage = onMessage;
            ws.current.onerror = () => reportError('WebSocket connection error');
            ws.current.onclose = () => {
                ws.current = null;
                tickSubscribedRef.current = false;
                if (runningRef.current) reconnectRef.current = setTimeout(connect, 1000);
            };
            return true;
        } catch (e) {
            reportError(e.message);
            return false;
        }
    }, [getUrl, onMessage, reportError, symbol]);

    // ---------- start ----------
    const start = useCallback(async () => {
        if (runningRef.current) return stop('Manual stop.');

        const amount = Number(stake);
        const tick = Number(selectedTick);
        const ticks = Number(duration);
        const factor = Number(multiplier);

        if (!Number.isFinite(amount) || amount <= 0 ||
            !Number.isInteger(tick) || tick < 1 || tick > 5 ||
            !Number.isInteger(ticks) || ticks < 1 || ticks > 10 ||
            !Number.isFinite(factor) || factor < 1) {
            return reportError('Check stake, selected tick, duration, and multiplier values.');
        }
        if (!authContext()) return Swal.fire('Error', 'Login Required', 'error');
        if (!(await connect()) || ws.current?.readyState !== WebSocket.OPEN) return;

        nextStakeRef.current = { A: amount, B: amount };
        totalRef.current = 0;
        setTotalProfit(0);
        activeRef.current.clear();
        completedRef.current.clear();
        contractsRef.current.clear();
        currentTickRef.current = 0;
        pendingStartTickRef.current = null;
        activePairRef.current = null;
        transactions?.clear?.();
        summary_card?.clear?.();

        runningRef.current = true;
        setRunning(true);
        setError('');
        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        // Pair will fire on the next tick automatically via onTick
    }, [connect, duration, multiplier, reportError, run_panel, selectedTick, stake, stop, summary_card, transactions]);

    // ---------- cleanup ----------
    useEffect(() => () => {
        runningRef.current = false;
        clearTimeout(reconnectRef.current);
        ws.current?.close();
    }, []);

    // ---------- UI ----------
    return (
        <div className='dhl-tool'>
            <div className='dhl-header'>
                <div>
                    <span className='dhl-kicker'>Tick-synchronized execution</span>
                    <h1>Dual High / Low Ticks</h1>
                    <p>Both contracts enter on the same tick, run for exactly N ticks, and re-enter on the next available tick.</p>
                </div>
                <span className={`dhl-run-state ${running ? 'is-live' : 'is-idle'}`}>
                    {running ? 'LIVE' : 'STANDBY'}
                </span>
            </div>

            <div className='dhl-controls'>
                <label className='dhl-field'><span>Volatility / market</span>
                    <select value={symbol} onChange={e => setSymbol(e.target.value)} disabled={running}>
                        {SYMBOLS.map(s => <option key={s} value={s}>{formatSymbol(s)}</option>)}
                    </select>
                </label>
                <label className='dhl-field'><span>Selected tick position</span>
                    <select value={selectedTick} onChange={e => setSelectedTick(e.target.value)} disabled={running}>
                        {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>Tick {n}</option>)}
                    </select>
                </label>
                <label className='dhl-field'><span>Contract duration (ticks)</span>
                    <input type='number' min='1' max='10' value={duration} onChange={e => setDuration(e.target.value)} disabled={running} />
                </label>
                <label className='dhl-field'><span>Stake per leg</span>
                    <input type='number' min='0.01' step='0.01' value={stake} onChange={e => setStake(e.target.value)} disabled={running} />
                </label>
                <label className='dhl-field'><span>Martingale mode</span>
                    <select value={martingaleMode} onChange={e => setMartingaleMode(e.target.value)} disabled={running}>
                        <option value='net'>Multiply both on pair loss</option>
                        <option value='split'>Multiply losing leg only</option>
                    </select>
                </label>
                <label className='dhl-field'><span>Multiplier</span>
                    <input type='number' min='1' step='0.1' value={multiplier} onChange={e => setMultiplier(e.target.value)} disabled={running} />
                </label>
                <label className='dhl-field'><span>Target P/L</span>
                    <input type='number' step='0.01' value={target} onChange={e => setTarget(e.target.value)} disabled={running} />
                </label>
                <label className='dhl-field'><span>Stop loss</span>
                    <input type='number' min='0' step='0.01' value={stopLoss} onChange={e => setStopLoss(e.target.value)} disabled={running} />
                </label>
            </div>

            <div className='dhl-actions'>
                <button type='button' className={`dhl-run-button ${running ? 'is-stop' : ''}`} onClick={start}>
                    {running ? <FaStop /> : <FaPlay />} {running ? 'Stop session' : 'Execute trades'}
                </button>
                <div className='dhl-metrics'>
                    Session P/L <strong className={totalProfit >= 0 ? 'is-positive' : 'is-negative'}>{totalProfit.toFixed(2)}</strong>
                </div>
            </div>

            {error && <div className='dhl-error' role='alert'>{error}</div>}

            <div className='dhl-pair-summary'>
                <div>
                    <span className='dhl-kicker'>Selected pair</span>
                    <strong>Tick High / Tick Low</strong>
                    <p>{duration} ticks · selected position: tick {selectedTick}</p>
                </div>
                <div className='dhl-group-id'><span>Group</span><code>{status.groupId || 'Not created'}</code></div>
                <div className='dhl-status-pill'>{String(status.status).replace(/_/g, ' ')}</div>
            </div>

            <div className='dhl-legs'>
                {['A', 'B'].map(key => (
                    <div className={`dhl-leg-card dhl-leg-card--${String(status.legs[key].state).toLowerCase()}`} key={key}>
                        <div className='dhl-leg-heading'><span>LEG {key}</span><strong>{LEGS[key].label}</strong></div>
                        <div className='dhl-leg-state'>{status.legs[key].state}</div>
                        <div>Entry: {status.legs[key].entry}</div>
                        <div>Exit: {status.legs[key].exit || '-'}</div>
                        {status.legs[key].profit !== null && (
                            <div className='dhl-leg-profit'>P/L: {Number(status.legs[key].profit).toFixed(2)}</div>
                        )}
                        {status.legs[key].error && <div className='dhl-leg-error'>{status.legs[key].error}</div>}
                    </div>
                ))}
            </div>
        </div>
    );
};

export default DualHighLowTicks;
