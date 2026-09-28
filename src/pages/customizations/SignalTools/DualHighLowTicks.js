import React, { useCallback, useEffect, useRef, useState } from 'react';
import Swal from 'sweetalert2';
import { FaPlay, FaStop } from 'react-icons/fa';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { contract_stages } from '@/constants/contract-stage';
import { useStore } from '@/hooks/useStore';
import './DualHighLowTicks.css';

const OPTIONS_URL = (
    isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING
).replace(/ws\/public$/, '');

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

const LEGS = {
    A: {
        label: 'Tick High',
        type: 'TICKHIGH',
    },
    B: {
        label: 'Tick Low',
        type: 'TICKLOW',
    },
};

const TERMINAL = new Set([
    'won',
    'lost',
    'sold',
    'cancelled',
    'expired',
]);

const formatSymbol = symbol => {
    if (symbol?.startsWith('1HZ')) {
        return `${symbol.replace('1HZ', '').replace('V', '')}(1s)`;
    }

    if (symbol?.startsWith('R_')) {
        return symbol.replace('R_', 'V');
    }

    return symbol || '';
};

const authContext = () => {
    try {
        const auth = JSON.parse(
            sessionStorage.getItem('auth_info') || 'null'
        );

        const accounts = JSON.parse(
            sessionStorage.getItem('deriv_accounts') || 'null'
        );

        const activeLoginId =
            localStorage.getItem('active_loginid');

        const account =
            accounts?.find(
                acc => acc.account_id === activeLoginId
            ) ||
            accounts?.find(
                acc => acc.account_id?.startsWith('DOT')
            ) ||
            accounts?.[0];

        if (
            auth?.access_token &&
            account?.account_id
        ) {
            return {
                token: auth.access_token,
                account,
            };
        }

        return null;
    } catch {
        return null;
    }
};

const complete = contract =>
    contract?.is_sold === 1 ||
    contract?.is_sold === true ||
    contract?.is_sold === '1' ||
    TERMINAL.has(
        String(contract?.status || '').toLowerCase()
    );

const idle = symbol => ({
    groupId: null,
    symbol,
    status: 'IDLE',

    legs: {
        A: {
            label: LEGS.A.label,
            state: 'IDLE',
            profit: null,
            entry: '-',
            exit: '',
            error: '',
        },

        B: {
            label: LEGS.B.label,
            state: 'IDLE',
            profit: null,
            entry: '-',
            exit: '',
            error: '',
        },
    },
});

const DualHighLowTicks = () => {
    const {
        transactions,
        journal,
        summary_card,
        run_panel,
        client,
    } = useStore() || {};

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

    // --------------------------------------------------
    // WebSocket / execution refs
    // --------------------------------------------------

    const ws = useRef(null);
    const runningRef = useRef(false);
    const reconnectRef = useRef(null);

    const nextStakeRef = useRef({
        A: 1,
        B: 1,
    });

    const proposalsRef = useRef(new Map());
    const groupsRef = useRef(new Map());
    const contractsRef = useRef(new Map());

    const activeRef = useRef(new Set());
    const completedRef = useRef(new Set());

    // Stores current pair's individual leg results
    const pairProfitRef = useRef({});

    const totalRef = useRef(0);

    // --------------------------------------------------
    // Tick synchronization
    // --------------------------------------------------

    const currentTickRef = useRef(0);
    const pendingStartTickRef = useRef(null);
    const activePairRef = useRef(null);
    const tickSubscribedRef = useRef(false);

    // --------------------------------------------------
    // Error reporting
    // --------------------------------------------------

    const reportError = useCallback(
        message => {
            setError(message);
            journal?.onError?.(message);
        },
        [journal]
    );

    // --------------------------------------------------
    // Publish contract events to the store
    // --------------------------------------------------

    const publish = useCallback(
        contract => {
            transactions?.onBotContractEvent?.(contract);
            summary_card?.onBotContractEvent?.(contract);
        },
        [transactions, summary_card]
    );

    // --------------------------------------------------
    // Get authenticated trading WebSocket URL
    // --------------------------------------------------

    const getUrl = useCallback(async () => {
        const context = authContext();

        if (!context) {
            throw new Error('Login Required');
        }

        const response = await fetch(
            `${OPTIONS_URL}accounts/${context.account.account_id}/otp`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${context.token}`,
                },
            }
        );

        if (!response.ok) {
            throw new Error('OTP Request Failed');
        }

        const json = await response.json();

        if (!json?.data?.url) {
            throw new Error('Authenticated URL Missing');
        }

        return json.data.url;
    }, []);

    // --------------------------------------------------
    // Stop session
    // --------------------------------------------------

    const stop = useCallback(
        (reason = '', preserveContracts = false) => {
            runningRef.current = false;

            setRunning(false);

            activePairRef.current = null;
            pendingStartTickRef.current = null;

            proposalsRef.current.clear();
            groupsRef.current.clear();

            if (ws.current?.readyState === WebSocket.OPEN) {
                ws.current.send(
                    JSON.stringify({
                        forget_all: 'proposal',
                    })
                );

                if (!preserveContracts) {
                    ws.current.send(
                        JSON.stringify({
                            forget_all: 'proposal_open_contract',
                        })
                    );

                    activeRef.current.forEach(contractId => {
                        ws.current.send(
                            JSON.stringify({
                                sell: Number(contractId),
                                price: 0,
                            })
                        );
                    });
                }
            }

            run_panel?.setIsRunning?.(false);

            run_panel?.setHasOpenContract?.(
                activeRef.current.size > 0
            );

            run_panel?.setContractStage?.(
                activeRef.current.size > 0
                    ? contract_stages.IS_STOPPING
                    : contract_stages.NOT_RUNNING
            );

            if (reason) {
                reportError(reason);
            }
        },
        [reportError, run_panel]
    );

    // --------------------------------------------------
    // Fire the two contracts simultaneously
    // --------------------------------------------------

    const firePair = useCallback(() => {
        if (
            !runningRef.current ||
            ws.current?.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        if (activePairRef.current) {
            return;
        }

        const amount = Number(stake);
        const ticks = Number(duration);
        const tick = Number(selectedTick);

        if (
            !Number.isFinite(amount) ||
            amount <= 0 ||
            !Number.isInteger(ticks) ||
            ticks < 1 ||
            !Number.isInteger(tick) ||
            tick < 1 ||
            tick > 5
        ) {
            reportError(
                'Invalid stake, selected tick, or duration.'
            );
            return;
        }

        const groupId = `dhl-${Date.now()}-${currentTickRef.current}`;

        pairProfitRef.current = {};

        groupsRef.current.set(groupId, {
            proposals: {},
            buying: false,
        });

        activePairRef.current = {
            groupId,
            startTick: currentTickRef.current,
            endTick: currentTickRef.current + ticks,
            legs: {
                A: null,
                B: null,
            },
            settled: {
                A: false,
                B: false,
            },
        };

        setStatus({
            groupId,
            symbol,
            status: 'PAIR_CREATED',
            legs: {
                A: {
                    label: LEGS.A.label,
                    state: 'PENDING',
                    profit: null,
                    entry: '-',
                    exit: '',
                    error: '',
                },
                B: {
                    label: LEGS.B.label,
                    state: 'PENDING',
                    profit: null,
                    entry: '-',
                    exit: '',
                    error: '',
                },
            },
        });

        ['A', 'B'].forEach(key => {
            const legStake = Number(
                nextStakeRef.current[key].toFixed(2)
            );

            const context = {
                group_id: groupId,
                leg_key: key,
                symbol,
                custom_type: LEGS[key].label,
                deriv_contract_type: LEGS[key].type,
                sent_stake: legStake,
                duration: ticks,
                duration_unit: 't',
                start_tick: currentTickRef.current,
                selected_tick: tick,
            };

            ws.current.send(
                JSON.stringify({
                    proposal: 1,
                    basis: 'stake',
                    amount: legStake,
                    currency: client?.currency || 'USD',
                    underlying_symbol: symbol,
                    contract_type: LEGS[key].type,
                    duration: ticks,
                    duration_unit: 't',
                    selected_tick: tick,
                    passthrough: context,
                })
            );
        });
    }, [
        client?.currency,
        duration,
        reportError,
        selectedTick,
        stake,
        symbol,
    ]);

    // --------------------------------------------------
    // Tick handler
    // --------------------------------------------------

    const onTick = useCallback(() => {
        if (!runningRef.current) {
            return;
        }

        currentTickRef.current += 1;

        const activePair = activePairRef.current;

        if (
            activePair &&
            currentTickRef.current >= activePair.endTick
        ) {
            if (
                activePair.settled.A &&
                activePair.settled.B
            ) {
                activePairRef.current = null;
            }
        }

        if (activePairRef.current) {
            return;
        }

        if (pendingStartTickRef.current === null) {
            pendingStartTickRef.current = currentTickRef.current;
        }

        if (
            pendingStartTickRef.current === currentTickRef.current &&
            !activePairRef.current
        ) {
            pendingStartTickRef.current = null;
            firePair();
        }
    }, [firePair]);

    // --------------------------------------------------
    // WebSocket message handler
    // --------------------------------------------------

    const onMessage = useCallback(
        event => {
            let data;

            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }

            const echoed = data.echo_req?.passthrough;

            if (data.error) {
                const message =
                    data.error.message || 'Deriv request failed.';
                reportError(message);
                stop(message, true);
                return;
            }

            if (data.msg_type === 'tick' && data.tick) {
                onTick();
                return;
            }

            if (
                data.msg_type === 'proposal' &&
                data.proposal?.id
            ) {
                const context =
                    data.proposal.passthrough || echoed;

                if (
                    !context?.group_id ||
                    !context?.leg_key
                ) {
                    return;
                }

                const group = groupsRef.current.get(
                    context.group_id
                );

                if (!group) {
                    return;
                }

                if (
                    group.buying ||
                    group.proposals[context.leg_key]
                ) {
                    return;
                }

                group.proposals[context.leg_key] = {
                    ...context,
                    id: String(data.proposal.id),
                    price: Number(data.proposal.ask_price),
                    received: performance.now(),
                };

                proposalsRef.current.set(
                    String(data.proposal.id),
                    group.proposals[context.leg_key]
                );

                if (
                    !group.proposals.A ||
                    !group.proposals.B
                ) {
                    return;
                }

                if (
                    currentTickRef.current !== context.start_tick
                ) {
                    reportError(
                        'Proposals arrived after tick boundary. Skipping pair.'
                    );
                    groupsRef.current.delete(context.group_id);
                    activePairRef.current = null;
                    return;
                }

                group.buying = true;

                ['A', 'B'].forEach(key => {
                    const proposal = group.proposals[key];
                    ws.current.send(
                        JSON.stringify({
                            buy: proposal.id,
                            price: proposal.price,
                        })
                    );
                });

                return;
            }

            if (
                data.msg_type === 'buy' &&
                data.buy?.contract_id
            ) {
                const proposalId = String(
                    data.echo_req?.buy || ''
                );

                const context =
                    proposalsRef.current.get(proposalId) ||
                    data.buy.passthrough;

                if (
                    !context?.group_id ||
                    !context?.leg_key
                ) {
                    return;
                }

                const contractId = String(
                    data.buy.contract_id
                );

                activeRef.current.add(contractId);

                const meta = {
                    ...context,
                    id: contractId,
                    contract_id: data.buy.contract_id,
                    buy_price: Number(
                        data.buy.buy_price || context.sent_stake
                    ),
                    currency: client?.currency || 'USD',
                    display_name: formatSymbol(context.symbol),
                    contract_type: context.deriv_contract_type,
                    status: 'open',
                    entry_spot: null,
                    exit_spot: null,
                };

                contractsRef.current.set(contractId, meta);
                publish(meta);

                setStatus(current => ({
                    ...current,
                    status: 'ACTIVE',
                    legs: {
                        ...current.legs,
                        [context.leg_key]: {
                            ...current.legs[context.leg_key],
                            state: 'ACTIVE',
                        },
                    },
                }));

                ws.current.send(
                    JSON.stringify({
                        proposal_open_contract: 1,
                        contract_id: data.buy.contract_id,
                        subscribe: 1,
                    })
                );

                return;
            }

            if (
                data.msg_type === 'proposal_open_contract' &&
                data.proposal_open_contract
            ) {
                const contract = data.proposal_open_contract;
                const contractId = String(contract.contract_id || '');
                const meta = contractsRef.current.get(contractId);

                if (!meta) {
                    return;
                }

                const finished = complete(contract);

                const entry =
                    contract.entry_spot_display_value ??
                    contract.entry_spot ??
                    contract.entry_tick_display_value ??
                    contract.entry_tick ??
                    '-';

                const exit = finished
                    ? (
                        contract.exit_tick_display_value ??
                        contract.exit_tick ??
                        contract.exit_spot_display_value ??
                        contract.exit_spot ??
                        ''
                    )
                    : '';

                const normalized = {
                    ...meta,
                    ...contract,
                    id: contract.contract_id,
                    contract_id: contract.contract_id,
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
                            state: finished ? 'FINISHED' : 'ACTIVE',
                            entry,
                            exit,
                            profit: finished
                                ? Number(contract.profit || 0)
                                : current.legs[meta.leg_key].profit,
                        },
                    },
                }));

                if (!finished) {
                    return;
                }

                if (
                    !activeRef.current.has(contractId) ||
                    completedRef.current.has(contractId)
                ) {
                    return;
                }

                completedRef.current.add(contractId);
                activeRef.current.delete(contractId);

                const profit = Number(contract.profit || 0);
                pairProfitRef.current[meta.leg_key] = profit;
                totalRef.current += profit;
                setTotalProfit(totalRef.current);

                journal?.onLogSuccess?.({
                    log_type: profit > 0 ? 'profit' : 'lost',
                    extra: {
                        currency: client?.currency || 'USD',
                        profit,
                    },
                });

                const activePair = activePairRef.current;

                if (
                    activePair &&
                    activePair.groupId === meta.group_id
                ) {
                    activePair.settled[meta.leg_key] = true;

                    if (
                        activePair.settled.A &&
                        activePair.settled.B
                    ) {
                        const pairProfit =
                            Number(pairProfitRef.current.A || 0) +
                            Number(pairProfitRef.current.B || 0);

                        const factor = Math.max(
                            1,
                            Number(multiplier) || 1
                        );

                        if (martingaleMode === 'split') {
                            ['A', 'B'].forEach(key => {
                                nextStakeRef.current[key] =
                                    Number(pairProfitRef.current[key] || 0) < 0
                                        ? nextStakeRef.current[key] * factor
                                        : Number(stake);
                            });
                        } else {
                            ['A', 'B'].forEach(key => {
                                nextStakeRef.current[key] =
                                    pairProfit < 0
                                        ? nextStakeRef.current[key] * factor
                                        : Number(stake);
                            });
                        }

                        pairProfitRef.current = {};
                        activePairRef.current = null;
                        groupsRef.current.delete(meta.group_id);

                        const reachedLimit =
                            totalRef.current >= Number(target) ||
                            totalRef.current <= -Math.abs(Number(stopLoss));

                        if (reachedLimit) {
                            stop(
                                `Session limit reached: ${totalRef.current.toFixed(2)}`,
                                true
                            );

                            Swal.fire(
                                'Session Ended',
                                `Final P/L: ${totalRef.current.toFixed(2)} ${
                                    client?.currency || 'USD'
                                }`,
                                'info'
                            );
                        }
                    }
                }
            }
        },
        [
            client?.currency,
            journal,
            martingaleMode,
            multiplier,
            onTick,
            publish,
            reportError,
            stake,
            stop,
            stopLoss,
            target,
        ]
    );

    // --------------------------------------------------
    // Connect WebSocket
    // --------------------------------------------------

    const connect = useCallback(async () => {
        if (
            ws.current?.readyState === WebSocket.OPEN ||
            ws.current?.readyState === WebSocket.CONNECTING
        ) {
            return true;
        }

        try {
            const url = await getUrl();
            ws.current = new WebSocket(url);

            ws.current.onopen = () => {
                if (!tickSubscribedRef.current) {
                    ws.current.send(
                        JSON.stringify({
                            ticks: symbol,
                            subscribe: 1,
                        })
                    );

                    ws.current.send(
                        JSON.stringify({
                            transaction: 1,
                            subscribe: 1,
                        })
                    );

                    tickSubscribedRef.current = true;
                }
            };

            ws.current.onmessage = onMessage;

            ws.current.onerror = () => {
                reportError('WebSocket connection error');
            };

            ws.current.onclose = () => {
                tickSubscribedRef.current = false;
                if (runningRef.current) {
                    reconnectRef.current = setTimeout(() => {
                        connect();
                    }, 1000);
                }
            };

            return true;
        } catch (err) {
            reportError(err.message || 'Connection failed');
            return false;
        }
    }, [getUrl, onMessage, reportError, symbol]);

    // --------------------------------------------------
    // Start session
    // --------------------------------------------------

    const start = async () => {
        setError('');
        const initialStake = Number(stake);

        if (!Number.isFinite(initialStake) || initialStake <= 0) {
            reportError('Please specify a valid starting stake.');
            return;
        }

        nextStakeRef.current = {
            A: initialStake,
            B: initialStake,
        };

        totalRef.current = 0;
        setTotalProfit(0);

        activeRef.current.clear();
        completedRef.current.clear();
        pairProfitRef.current = {};
        currentTickRef.current = 0;
        pendingStartTickRef.current = null;

        runningRef.current = true;
        setRunning(true);

        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);

        const connected = await connect();
        if (!connected) {
            stop('Failed to connect to trading endpoint.');
        }
    };

    useEffect(() => {
        return () => {
            if (reconnectRef.current) {
                clearTimeout(reconnectRef.current);
            }
            if (ws.current) {
                ws.current.close();
            }
        };
    }, []);

    return (
        <div className="dhl-tool">
            <div className="dhl-header">
                <div>
                    <span className="dhl-kicker">Deriv Automated Execution</span>
                    <h1>Dual High Low Ticks Bot</h1>
                    <p>Simultaneously execute Tick High and Tick Low contracts synchronously.</p>
                </div>
                <div className={`dhl-run-state ${running ? 'is-live' : 'is-idle'}`}>
                    {running ? 'Running' : 'Idle'}
                </div>
            </div>

            {error && <div className="dhl-error">{error}</div>}

            <div className="dhl-controls">
                <div className="dhl-field">
                    <span>Symbol</span>
                    <select
                        value={symbol}
                        onChange={e => setSymbol(e.target.value)}
                        disabled={running}
                    >
                        {SYMBOLS.map(sym => (
                            <option key={sym} value={sym}>
                                {formatSymbol(sym)}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="dhl-field">
                    <span>Selected Tick (1-5)</span>
                    <input
                        type="number"
                        min="1"
                        max="5"
                        value={selectedTick}
                        onChange={e => setSelectedTick(e.target.value)}
                        disabled={running}
                    />
                </div>

                <div className="dhl-field">
                    <span>Duration (Ticks)</span>
                    <input
                        type="number"
                        min="1"
                        value={duration}
                        onChange={e => setDuration(e.target.value)}
                        disabled={running}
                    />
                </div>

                <div className="dhl-field">
                    <span>Initial Stake</span>
                    <input
                        type="number"
                        min="0.35"
                        step="0.01"
                        value={stake}
                        onChange={e => setStake(e.target.value)}
                        disabled={running}
                    />
                </div>

                <div className="dhl-field">
                    <span>Target Profit</span>
                    <input
                        type="number"
                        min="1"
                        value={target}
                        onChange={e => setTarget(e.target.value)}
                        disabled={running}
                    />
                </div>

                <div className="dhl-field">
                    <span>Stop Loss</span>
                    <input
                        type="number"
                        min="1"
                        value={stopLoss}
                        onChange={e => setStopLoss(e.target.value)}
                        disabled={running}
                    />
                </div>

                <div className="dhl-field">
                    <span>Martingale Mode</span>
                    <select
                        value={martingaleMode}
                        onChange={e => setMartingaleMode(e.target.value)}
                        disabled={running}
                    >
                        <option value="net">Net Loss (Combined)</option>
                        <option value="split">Split Leg Loss</option>
                    </select>
                </div>

                <div className="dhl-field">
                    <span>Multiplier</span>
                    <input
                        type="number"
                        step="0.1"
                        min="1"
                        value={multiplier}
                        onChange={e => setMultiplier(e.target.value)}
                        disabled={running}
                    />
                </div>

                <div className="dhl-field dhl-field--readonly">
                    <span>Active Currency</span>
                    <strong>{client?.currency || 'USD'}</strong>
                </div>
            </div>

            <div className="dhl-actions">
                {!running ? (
                    <button className="dhl-run-button" onClick={start}>
                        <FaPlay /> Run Bot
                    </button>
                ) : (
                    <button className="dhl-run-button is-stop" onClick={() => stop('User stopped')}>
                        <FaStop /> Stop Bot
                    </button>
                )}

                <div className="dhl-metrics">
                    Total Session P/L:{' '}
                    <strong className={totalProfit < 0 ? 'is-negative' : ''}>
                        {totalProfit.toFixed(2)} {client?.currency || 'USD'}
                    </strong>
                </div>
            </div>

            <div className="dhl-pair-summary">
                <div className="dhl-group-id">
                    <span>Current Pair Context</span>
                    <code>{status.groupId || 'No active pair group'}</code>
                </div>
                <div className="dhl-status-pill">{status.status}</div>
            </div>

            <div className="dhl-legs">
                {['A', 'B'].map(key => {
                    const leg = status.legs[key];
                    const isComplete = leg.state === 'FINISHED';

                    return (
                        <div
                            key={key}
                            className={`dhl-leg-card ${isComplete ? 'dhl-leg-card--complete' : ''}`}
                        >
                            <div className="dhl-leg-heading">
                                <h3>{leg.label}</h3>
                                <span>{key}</span>
                            </div>

                            <div className="dhl-leg-state">Status: {leg.state}</div>

                            <div style={{ marginTop: '10px', fontSize: '13px' }}>
                                <div>Entry Spot: <strong>{leg.entry}</strong></div>
                                <div>Exit Spot: <strong>{leg.exit || '-'}</strong></div>
                            </div>

                            <div className="dhl-leg-profit">
                                Profit:{' '}
                                {leg.profit !== null ? (
                                    <span style={{ color: leg.profit < 0 ? '#c43f4d' : '#087443' }}>
                                        {leg.profit.toFixed(2)} {client?.currency || 'USD'}
                                    </span>
                                ) : (
                                    '-'
                                )}
                            </div>

                            {leg.error && <div className="dhl-leg-error">{leg.error}</div>}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default DualHighLowTicks;
