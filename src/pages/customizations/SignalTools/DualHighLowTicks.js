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
const PROPOSAL_PAIR_MAX_SKEW_MS = 1800;

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
        if (!auth?.access_token || !Array.isArray(accounts) || accounts.length === 0) return null;

        const activeLoginId = localStorage.getItem('active_loginid');
        const activeAccount =
            accounts.find(account => account.account_id === activeLoginId) ||
            accounts.find(account => account.account_id?.startsWith('DOT')) ||
            accounts[0];

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

const DualHighLowTicks = () => {
    const store = useStore();
    const { transactions, journal, summary_card, run_panel, client } = store || {};
    const [selectedSymbol, setSelectedSymbol] = useState('R_50');
    const [selectedTick, setSelectedTick] = useState('3');
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
    const groupRef = useRef(null);
    const pendingBuyContextRef = useRef(new Map());
    const pendingProposalRef = useRef(new Map());
    const pairGuardTimeoutRef = useRef(null);
    const totalProfitRef = useRef(0);
    const proposalGroupRef = useRef({});

    const publishContract = useCallback(
        contract => {
            transactions?.onBotContractEvent?.(contract);
            summary_card?.onBotContractEvent?.(contract);
        },
        [summary_card, transactions]
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

    const publishError = useCallback(message => {
        journal?.onError?.(message);
        setProposalError(message);
    }, [journal]);

    const stopBot = useCallback(
        (reason = 'Bot stopped.') => {
            setIsRunning(false);
            runningRef.current = false;
            if (pairGuardTimeoutRef.current) {
                window.clearTimeout(pairGuardTimeoutRef.current);
                pairGuardTimeoutRef.current = null;
            }
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ forget_all: 'proposal' }));
                wsRef.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
            }
            run_panel?.setIsRunning?.(false);
            run_panel?.setHasOpenContract?.(activeContractsRef.current.size > 0);
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            setPairStatus(createIdleGroup(selectedSymbol));
            console.log(`[DualHighLowTicks] ${reason}`);
        },
        [run_panel, selectedSymbol]
    );

    const getAuthenticatedUrl = useCallback(async () => {
        try {
            const context = getAuthContext();
            if (!context) throw new Error('Session Missing');

            const response = await fetch(`${DERIV_OPTIONS_API_URL}accounts/${context.activeAccount.account_id}/otp`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${context.accessToken}` },
            });
            if (!response.ok) throw new Error('OTP Request Failed');

            const json = await response.json();
            if (!json?.data?.url) throw new Error('Authenticated URL Missing');
            return json.data.url;
        } catch (error) {
            publishError(error.message);
            return null;
        }
    }, [publishError]);

    const connectSocket = useCallback(
        async ({ requireAuth = false } = {}) => {
            if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
                return true;
            }

            const authenticatedUrl = requireAuth ? await getAuthenticatedUrl() : null;
            if (requireAuth && !authenticatedUrl) return false;

            wsRef.current = new WebSocket(authenticatedUrl || DERIV_PUBLIC_WS_URL);

            wsRef.current.onopen = () => {
                wsRef.current?.send(JSON.stringify({ active_symbols: 'full' }));
                wsRef.current?.send(JSON.stringify({ contracts_for: selectedSymbol }));
                wsRef.current?.send(JSON.stringify({ ticks: selectedSymbol, subscribe: 1 }));
                wsRef.current?.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
            };

            wsRef.current.onmessage = event => {
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch {
                    return;
                }

                if (data.error) {
                    const context = data.echo_req?.passthrough || pendingBuyContextRef.current.get(String(data.echo_req?.buy || ''));
                    if (context?.group_id) {
                        setProposalError(data.error.message || 'Buy failed.');
                    }
                    return;
                }

                if (data.msg_type === 'active_symbols' || data.msg_type === 'contracts_for') {
                    return;
                }

                if (data.msg_type === 'proposal' && data.proposal) {
                    const proposal = data.proposal;
                    const context = proposal?.passthrough || data.echo_req?.passthrough;
                    if (!context?.group_id || !context?.leg_key) return;

                    pendingProposalRef.current.set(String(proposal.id), context);
                    proposalGroupRef.current[context.group_id] = proposalGroupRef.current[context.group_id] || { proposals: {} };
                    proposalGroupRef.current[context.group_id].proposals[context.leg_key] = {
                        proposalId: proposal.id,
                        askPrice: Number(proposal.ask_price),
                        receivedAt: Date.now(),
                        symbol: context.symbol,
                        groupId: context.group_id,
                        legKey: context.leg_key,
                        contractType: context.deriv_contract_type,
                        sentStake: context.sent_stake,
                    };

                    if (Object.keys(proposalGroupRef.current[context.group_id].proposals).length === 2) {
                        const proposalA = proposalGroupRef.current[context.group_id].proposals.A;
                        const proposalB = proposalGroupRef.current[context.group_id].proposals.B;
                        const skew = Math.abs(proposalA.receivedAt - proposalB.receivedAt);
                        if (skew <= PROPOSAL_PAIR_MAX_SKEW_MS) {
                            const buyTimeout = window.setTimeout(() => {
                                const group = proposalGroupRef.current[context.group_id];
                                if (!group) return;
                                const bothReady = ['A', 'B'].every(key => !!group.proposals[key]);
                                if (!bothReady) {
                                    setProposalError('Both pair proposals were not received in time.');
                                    stopBot('Pair proposal timeout.');
                                }
                            }, PROPOSAL_PAIR_MAX_SKEW_MS);
                            if (pairGuardTimeoutRef.current) window.clearTimeout(pairGuardTimeoutRef.current);
                            pairGuardTimeoutRef.current = buyTimeout;
                            [proposalA, proposalB].forEach(record => {
                                wsRef.current?.send(JSON.stringify({ buy: record.proposalId, price: record.askPrice }));
                            });
                        } else {
                            setProposalError('The dual tick pair proposals were not received closely enough together.');
                            stopBot('Proposal skew too large.');
                        }
                    }
                    return;
                }

                if (data.msg_type === 'buy' && data.buy) {
                    const buy = data.buy;
                    const context = pendingProposalRef.current.get(String(data.echo_req?.buy || '')) || buy.passthrough || {};
                    pendingProposalRef.current.delete(String(data.echo_req?.buy || ''));

                    if (!buy.contract_id || !context.group_id || !context.leg_key) return;

                    const contractKey = String(buy.contract_id);
                    activeContractsRef.current.add(contractKey);
                    contractMetaRef.current[contractKey] = {
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
                        group_id: context.group_id,
                        leg_key: context.leg_key,
                        status: 'open',
                        is_sold: false,
                    };

                    publishContract(contractMetaRef.current[contractKey]);
                    run_panel?.setHasOpenContract?.(true);
                    run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);
                    wsRef.current?.send(JSON.stringify({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 }));

                    setPairStatus(current => ({
                        ...current,
                        groupId: context.group_id,
                        status: 'PAIR_ACTIVE',
                        legs: {
                            ...current.legs,
                            [context.leg_key]: { ...current.legs[context.leg_key], state: 'ACTIVE' },
                        },
                    }));
                    return;
                }

                if (data.msg_type === 'proposal_open_contract') {
                    const contract = data.proposal_open_contract;
                    if (!contract || !contract.contract_id) return;

                    const contractKey = String(contract.contract_id);
                    const meta = contractMetaRef.current[contractKey] || {};
                    const isComplete =
                        contract.is_sold === 1 ||
                        contract.is_sold === true ||
                        contract.is_sold === '1' ||
                        String(contract.status || '').toLowerCase() === 'won' ||
                        String(contract.status || '').toLowerCase() === 'lost';

                    const finalContract = {
                        ...meta,
                        ...contract,
                        id: contract.contract_id,
                        contract_id: contract.contract_id,
                        group_id: meta.group_id,
                        leg_key: meta.leg_key,
                        underlying: contract.underlying || meta.symbol,
                        underlying_symbol: contract.underlying_symbol || meta.symbol,
                        is_sold: isComplete,
                    };
                    publishContract(finalContract);

                    if (isComplete && activeContractsRef.current.has(contractKey)) {
                        const profit = Number(contract.profit || 0);
                        completedContractsRef.current.add(contractKey);
                        activeContractsRef.current.delete(contractKey);
                        totalProfitRef.current += profit;
                        setTotalProfit(totalProfitRef.current);

                        const native = {
                            ...finalContract,
                            profit,
                            result: profit > 0 ? 'won' : 'lost',
                            status: profit > 0 ? 'won' : 'lost',
                        };
                        publishContract(native);
                        publishResult(native);

                        setPairStatus(current => ({
                            ...current,
                            legs: {
                                ...current.legs,
                                [meta.leg_key || 'A']: {
                                    ...(current.legs[meta.leg_key || 'A'] || {}),
                                    state: 'COMPLETE',
                                    profit,
                                    error: '',
                                },
                            },
                        }));

                        if (activeContractsRef.current.size === 0) {
                            const hitLimit = totalProfitRef.current >= Number(targetProfit) || totalProfitRef.current <= -Number(stopLoss);
                            if (hitLimit) {
                                stopBot(`Session ended by target/stop loss: ${totalProfitRef.current.toFixed(2)}`);
                                Swal.fire('Session Ended', `Final P/L: ${totalProfitRef.current.toFixed(2)} ${client?.currency || 'USD'}`, 'info');
                            } else {
                                run_panel?.setHasOpenContract?.(false);
                                run_panel?.setContractStage?.(contract_stages.CONTRACT_CLOSED);
                            }
                        }
                    }
                }
            };

            wsRef.current.onerror = error => {
                console.error('[DualHighLowTicks] WebSocket error:', error);
            };

            wsRef.current.onclose = () => {
                if (runningRef.current) {
                    setProposalError('Trading connection closed.');
                    setIsRunning(false);
                    runningRef.current = false;
                }
            };

            return true;
        },
        [client?.currency, publishContract, publishResult, run_panel, selectedSymbol, stopBot, stopLoss, targetProfit]
    );

    const executePair = useCallback(async () => {
        if (runningRef.current) {
            stopBot('Bot already running.');
            return;
        }

        const numericStake = Number(stake);
        if (!Number.isFinite(numericStake) || numericStake <= 0) {
            setProposalError('Stake must be greater than zero.');
            return;
        }

        const tickNumber = Number(selectedTick);
        if (!Number.isInteger(tickNumber) || tickNumber < 1 || tickNumber > 5) {
            setProposalError('Selected tick must be an integer from 1 to 5.');
            return;
        }

        const authExists = getAuthContext();
        if (!authExists) {
            Swal.fire('Error', 'Login Required', 'error');
            return;
        }

        const connected = await connectSocket({ requireAuth: true });
        if (!connected) {
            setProposalError('Authentication failed.');
            return;
        }

        const groupId = `dual-high-low-${Date.now()}`;
        const group = {
            groupId,
            symbol: selectedSymbol,
            status: 'PAIR_CREATED',
            legs: {
                A: { label: LEG_CONFIG.A.label, state: 'PENDING', profit: null, error: '' },
                B: { label: LEG_CONFIG.B.label, state: 'PENDING', profit: null, error: '' },
            },
        };
        groupRef.current = groupId;
        proposalGroupRef.current[groupId] = { proposals: {} };
        setPairStatus(group);
        setProposalError('');
        setTotalProfit(0);
        totalProfitRef.current = 0;
        activeContractsRef.current.clear();
        completedContractsRef.current.clear();
        contractMetaRef.current = {};

        transactions?.clear?.();
        summary_card?.clear?.();

        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        run_panel?.toggleDrawer?.(true);
        run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

        setIsRunning(true);
        runningRef.current = true;

        LEG_KEYS.forEach(key => {
            const contractType = LEG_CONFIG[key].contract_type;
            const proposalRequest = {
                proposal: 1,
                basis: 'stake',
                amount: numericStake,
                currency: client?.currency || 'USD',
                underlying_symbol: selectedSymbol,
                contract_type: contractType,
                duration: 5,
                duration_unit: 't',
                selected_tick: tickNumber,
                passthrough: {
                    group_id: groupId,
                    leg_key: key,
                    custom_type: LEG_CONFIG[key].label,
                    deriv_contract_type: contractType,
                    symbol: selectedSymbol,
                    sent_stake: numericStake,
                },
            };
            wsRef.current?.send(JSON.stringify(proposalRequest));
        });
    }, [client?.currency, connectSocket, run_panel, selectedSymbol, selectedTick, stake, stopBot, summary_card, transactions]);

    const toggleBot = useCallback(() => {
        if (isRunning) {
            stopBot('Manual stop.');
            return;
        }
        executePair();
    }, [executePair, isRunning, stopBot]);

    useEffect(() => {
        const shouldAuthenticate = Boolean(getAuthContext());
        connectSocket({ requireAuth: shouldAuthenticate });
        return () => {
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            if (pairGuardTimeoutRef.current) {
                window.clearTimeout(pairGuardTimeoutRef.current);
            }
        };
    }, [connectSocket]);

    const statusText = useMemo(() => {
        if (isRunning) return 'LIVE';
        return 'STANDBY';
    }, [isRunning]);

    return (
        <div className='dhl-tool'>
            <div className='dhl-header'>
                <div>
                    <span className='dhl-kicker'>Paired hedging</span>
                    <h1>Dual High / Low Ticks</h1>
                    <p>Open both legs together using the same tick and duration. One leg is intended to hedge the other.</p>
                </div>
                <span className={`dhl-run-state ${isRunning ? 'is-live' : 'is-idle'}`}>{statusText}</span>
            </div>

            <div className='dhl-controls'>
                <label className='dhl-field'>
                    <span>Volatility / market</span>
                    <select value={selectedSymbol} onChange={event => setSelectedSymbol(event.target.value)} disabled={isRunning}>
                        {SYMBOLS.map(symbol => (
                            <option key={symbol} value={symbol}>{formatSymbol(symbol)}</option>
                        ))}
                    </select>
                </label>

                <label className='dhl-field'>
                    <span>Selected tick</span>
                    <select value={selectedTick} onChange={event => setSelectedTick(event.target.value)} disabled={isRunning}>
                        {[1, 2, 3, 4, 5].map(tick => (
                            <option key={tick} value={tick}>Tick {tick}</option>
                        ))}
                    </select>
                </label>

                <label className='dhl-field'>
                    <span>Stake per leg</span>
                    <input type='number' min='0.01' step='0.01' value={stake} onChange={event => setStake(event.target.value)} disabled={isRunning} />
                </label>

                <label className='dhl-field'>
                    <span>Target P/L</span>
                    <input type='number' step='0.01' value={targetProfit} onChange={event => setTargetProfit(event.target.value)} disabled={isRunning} />
                </label>

                <label className='dhl-field'>
                    <span>Stop loss</span>
                    <input type='number' min='0' step='0.01' value={stopLoss} onChange={event => setStopLoss(event.target.value)} disabled={isRunning} />
                </label>

                <div className='dhl-field dhl-field--readonly'>
                    <span>Duration</span>
                    <strong>5 ticks fixed</strong>
                </div>
            </div>

            <div className='dhl-actions'>
                <button type='button' className={`dhl-run-button ${isRunning ? 'is-stop' : ''}`} onClick={toggleBot}>
                    {isRunning ? <FaStop /> : <FaPlay />}
                    {isRunning ? 'Stop hedged pair' : 'Execute trades'}
                </button>
                <div className='dhl-metrics'>
                    <span>Session P/L <strong className={totalProfit >= 0 ? 'is-positive' : 'is-negative'}>{totalProfit.toFixed(2)}</strong></span>
                </div>
            </div>

            {proposalError && <div className='dhl-error' role='alert'>{proposalError}</div>}

            <div className='dhl-pair-summary'>
                <div>
                    <span className='dhl-kicker'>Selected pair</span>
                    <strong>Tick High / Tick Low</strong>
                    <p>Both legs share the same symbol, duration, and selected tick, and are executed as one paired hedge.</p>
                </div>
                <div className='dhl-group-id'>
                    <span>Group</span>
                    <code>{pairStatus.groupId || 'Not created'}</code>
                </div>
                <div className='dhl-status-pill'>{String(pairStatus.status || 'IDLE').replace(/_/g, ' ')}</div>
            </div>

            <div className='dhl-legs'>
                {LEG_KEYS.map(key => (
                    <div className={`dhl-leg-card dhl-leg-card--${String(pairStatus.legs[key].state || 'idle').toLowerCase()}`} key={key}>
                        <div className='dhl-leg-heading'>
                            <span>LEG {key}</span>
                            <strong>{LEG_CONFIG[key].label}</strong>
                        </div>
                        <div className='dhl-leg-state'>{String(pairStatus.legs[key].state || 'IDLE').replace(/_/g, ' ')}</div>
                        {pairStatus.legs[key].profit !== null && (
                            <div className='dhl-leg-profit'>P/L: {Number(pairStatus.legs[key].profit).toFixed(2)}</div>
                        )}
                        {pairStatus.legs[key].error && <div className='dhl-leg-error'>{pairStatus.legs[key].error}</div>}
                    </div>
                ))}
            </div>
        </div>
    );
};

export default DualHighLowTicks;
