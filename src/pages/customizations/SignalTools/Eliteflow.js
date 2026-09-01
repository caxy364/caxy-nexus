import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    FaPlay,
    FaStop,
    FaRocket,
    FaChartLine,
    FaCogs,
    FaUndo,
    FaExchangeAlt,
} from 'react-icons/fa';
import { IoChevronDown } from 'react-icons/io5';
import Swal from 'sweetalert2';
import {
    TradeTypesDigitsEvenIcon,
    TradeTypesDigitsOddIcon,
    TradeTypesDigitsOverIcon,
    TradeTypesDigitsUnderIcon,
    TradeTypesUpsAndDownsFallIcon,
    TradeTypesUpsAndDownsRiseIcon,
} from '@deriv/quill-icons/TradeTypes';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import './Eliteflow.css';

const SYMBOLS = ['1HZ10V', 'R_10', '1HZ25V', 'R_25', '1HZ50V', 'R_50', '1HZ75V', 'R_75', '1HZ100V', 'R_100'];

const STRATEGY_INFO = {
    even_odd:
        "This tool checks and analyze all the last digits of every Volatility and  Once it detects a consecutive sequence of 'N' Even digits, it trades ODD in that Volatility .If it detects a consecutive sequence of 'N' Odd digits, it trades EVEN in that Volatility. ",
    over_under:
        "This tool monitors all volatilities and once it finds a market with 'N' Over digits in a row, it trades Under 7 in that market. If it finds 'N' Under digits in a row, it trades Over 2. Change Martingale to 2.5 or above for full recovery incase of a loss.",
    rise_fall:
        "This tools maps through all volatilities and when it finds a Market with 'N' consecutive Rises, it trades a Fall in that market. If it finds 'N' consecutive Falls, it trades a Rise.",
};

const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');

const formatContractSpot = value => {
    if (value === null || value === undefined || value === '') return '-';
    return String(value);
};

const parseSessionNumber = (value, fallback) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const EliteFlow = () => {
    const store = useStore();
    const { transactions, journal, summary_card, run_panel, client } = store || {};

    const [activeTool, setActiveTool] = useState(null);
    const [isRunning, setIsRunning] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    const [results, setResults] = useState([]);
    const [marketData, setMarketData] = useState({});
    const [totalRuns, setTotalRuns] = useState(0);
    const [wins, setWins] = useState(0);
    const [losses, setLosses] = useState(0);
    const [totalProfit, setTotalProfit] = useState(0);
    const [proposalError, setProposalError] = useState('');
    const [config, setConfig] = useState({
        stake: '2',
        target: '100',
        stopLoss: '100',
        mFactor: '2.1',
        length: '4',
    });

    const wsRef = useRef(null);
    const reconnectTimeoutRef = useRef(null);
    const shouldReconnectRef = useRef(true);
    const skipReconnectRef = useRef(false);
    const socketRequiresAuthRef = useRef(false);
    const isAuthorizedRef = useRef(false);
    const isConnectingRef = useRef(false);
    const isRunningRef = useRef(false);
    const isProcessingRef = useRef(false);
    const currentStakeRef = useRef(1);
    const historyRef = useRef({});
    const activeToolRef = useRef(null);
    const configRef = useRef(config);
    const activeContractsRef = useRef(new Set());
    const completedContractsRef = useRef(new Set());
    const contractMetaRef = useRef({});
    const transactionRecoveryTimeoutsRef = useRef(new Map());
    const pendingProposalRef = useRef(false);
    const pendingTradeContextRef = useRef(null);

    useEffect(() => {
        configRef.current = config;
    }, [config]);

    useEffect(() => {
        isRunningRef.current = isRunning;
    }, [isRunning]);

    useEffect(() => {
        activeToolRef.current = activeTool;
    }, [activeTool]);

    useEffect(() => {
        run_panel?.setIsRunning?.(isRunning);
        if (!isRunning && !run_panel?.has_open_contract) {
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [isRunning, run_panel]);

    const notify = useCallback((title, icon = 'success') => {
        const iconColor = icon === 'success' ? '#4caf50' : icon === 'error' ? '#f44336' : '#2196f3';
        Swal.fire({
            title,
            icon,
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 3000,
            timerProgressBar: true,
            didOpen: toast => {
                toast.style.background = 'rgba(27, 192, 178, 0.98)';
                toast.style.backdropFilter = 'blur(10px)';
                toast.style.borderLeft = `5px solid ${iconColor}`;
            },
        });
    }, []);

    const formatSymbolDisplay = sym => {
        if (!sym) return '';
        if (sym.startsWith('1HZ')) return `${sym.replace('1HZ', '').replace('V', '')}(1s)`;
        if (sym.startsWith('R_')) return sym.replace('R_', 'V');
        return sym;
    };

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
            console.error('[EliteFlow] Failed to parse Deriv session storage:', error);
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
            setProposalError(error.message);
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
            if (journal?.onLogSuccess) {
                journal.onLogSuccess({
                    log_type: contractData.profit > 0 ? 'profit' : 'lost',
                    extra: {
                        currency: contractData.currency,
                        profit: contractData.profit,
                    },
                });
            }
        },
        [journal]
    );

    const clearContractTracking = useCallback(
        ({ preserveOpenContract = false } = {}) => {
            if (!preserveOpenContract) {
                activeContractsRef.current.clear();
                completedContractsRef.current.clear();
                contractMetaRef.current = {};
                isProcessingRef.current = false;
            }

            pendingProposalRef.current = false;
            transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
            transactionRecoveryTimeoutsRef.current.clear();
        },
        []
    );

    const stopTradingBot = useCallback(
        (reason = 'Bot stopped.', options = {}) => {
            const { preserveOpenContract = Boolean(activeContractsRef.current.size > 0 || run_panel?.has_open_contract) } =
                options;

            setIsRunning(false);
            isRunningRef.current = false;
            pendingProposalRef.current = false;

            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ forget_all: 'proposal' }));
                if (!preserveOpenContract) {
                    wsRef.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
                }
            }

            clearContractTracking({ preserveOpenContract });

            run_panel?.setIsRunning?.(false);
            run_panel?.toggleDrawer?.(true);
            run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

            if (preserveOpenContract) {
                run_panel?.setContractStage?.(contract_stages.IS_STOPPING);
            } else {
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            }

            if (reason) {
                notify(reason, 'info');
            }
        },
        [clearContractTracking, notify, run_panel]
    );

    const renderMiniSignal = (symbol, strategyId, isMobile = false) => {
        const data = marketData[symbol];
        if (!data) return <div className='matrix-card empty' key={symbol}>--</div>;

        const L = parseInt(config.length, 10) || 4;
        const dispDigits = data.digits.slice(-L);
        const dispPrices = data.prices.slice(-(L + 1));

        let items = [];
        let isStrategyMet = false;

        if (strategyId === 'even_odd') {
            isStrategyMet =
                dispDigits.length === L && (dispDigits.every(d => d % 2 === 0) || dispDigits.every(d => d % 2 !== 0));
            items = dispDigits.map((d, i) => (
                <span key={i} className={`token token-${d % 2 === 0 ? 'even' : 'odd'}`}>
                    {d % 2 === 0 ? 'E' : 'O'}
                </span>
            ));
        } else if (strategyId === 'over_under') {
            isStrategyMet = dispDigits.length === L && (dispDigits.every(d => d > 5) || dispDigits.every(d => d < 4));
            items = dispDigits.map((d, i) => (
                <span key={i} className={`token token-${d > 4 ? 'over' : 'under'}`}>
                    {d > 4 ? 'O' : 'U'}
                </span>
            ));
        } else if (strategyId === 'rise_fall') {
            if (dispPrices.length >= L + 1) {
                const moves = [];
                for (let i = 1; i < dispPrices.length; i += 1) {
                    moves.push(dispPrices[i] > dispPrices[i - 1] ? 'R' : 'F');
                }
                isStrategyMet = moves.length === L && (moves.every(m => m === 'R') || moves.every(m => m === 'F'));
                items = moves.map((m, i) => (
                    <span key={i} className={`token token-${m === 'R' ? 'rise' : 'fall'}`}>
                        {m}
                    </span>
                ));
            }
        }

        return (
            <div className={`matrix-card ${isStrategyMet ? 'signal-active' : ''} ${isMobile ? 'mini-mobile' : ''}`} key={symbol}>
                <div className='matrix-badge'>
                    <span className='matrix-sym-text'>{formatSymbolDisplay(symbol)}</span>
                </div>
                <div className='matrix-tokens-container'>{items}</div>
            </div>
        );
    };

    const requestTradeProposal = useCallback(
        (symbol, contractType, barrier = null) => {
            if (!isRunningRef.current || pendingProposalRef.current || activeContractsRef.current.size > 0) return;
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !isAuthorizedRef.current) {
                isProcessingRef.current = false;
                return;
            }

            const proposalPayload = {
                proposal: 1,
                amount: Number(currentStakeRef.current).toFixed(2),
                basis: 'stake',
                contract_type: contractType,
                currency: client?.currency || 'USD',
                underlying_symbol: symbol,
                duration: 1,
                duration_unit: 't',
                passthrough: {
                    symbol,
                    stake: Number(currentStakeRef.current).toFixed(2),
                    contract_type: contractType,
                },
            };

            if (barrier !== null) {
                proposalPayload.barrier = barrier;
            }

            pendingTradeContextRef.current = {
                symbol,
                stake: Number(currentStakeRef.current).toFixed(2),
                contract_type: contractType,
                barrier,
            };
            pendingProposalRef.current = true;
            run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
            wsRef.current.send(JSON.stringify(proposalPayload));
        },
        [client?.currency, run_panel]
    );

    const handleSettlement = useCallback(
        c => {
            if (!c) return;

            const contractKey = String(c.contract_id);
            const normalizedStatus = String(c.status || '').toLowerCase();
            const hasClosedStatus = Boolean(normalizedStatus) && normalizedStatus !== 'open';
            const isExpired = c.is_expired === 1 || c.is_expired === true || c.is_expired === '1';
            const isSettleable = c.is_settleable === 1 || c.is_settleable === true || c.is_settleable === '1';
            const isSold =
                c.is_sold === 1 || c.is_sold === true || c.is_sold === '1' || hasClosedStatus || isExpired || isSettleable;

            const entrySpot = formatContractSpot(
                c.entry_spot_display_value ?? c.entry_tick_display_value ?? c.entry_spot ?? c.entry_tick
            );
            const exitSpot = formatContractSpot(
                c.exit_spot_display_value ??
                    c.exit_tick_display_value ??
                    c.exit_spot ??
                    c.exit_tick ??
                    c.current_spot_display_value ??
                    c.current_spot
            );
            const profit = parseFloat(c.profit ?? 0);

            const nativeContract = {
                ...(contractMetaRef.current[contractKey] || {}),
                ...c,
                id: c.contract_id,
                contract_id: c.contract_id,
                display_name: contractMetaRef.current[contractKey]?.display_name || formatSymbolDisplay(c.underlying_symbol || c.underlying),
                underlying_symbol:
                    c.underlying_symbol || c.underlying || contractMetaRef.current[contractKey]?.underlying_symbol,
                underlying: c.underlying || contractMetaRef.current[contractKey]?.underlying_symbol,
                buy_price:
                    c.buy_price ??
                    contractMetaRef.current[contractKey]?.buy_price ??
                    parseFloat(currentStakeRef.current),
                currency: c.currency || client?.currency || 'USD',
                transaction_ids: contractMetaRef.current[contractKey]?.transaction_ids || c.transaction_ids,
                entry_spot: entrySpot,
                exit_spot: isSold ? exitSpot : undefined,
                is_sold: isSold,
                is_expired: isExpired || c.is_expired,
                is_settleable: isSettleable || c.is_settleable,
                result: isSold ? (profit > 0 ? 'won' : 'lost') : undefined,
                status: isSold ? normalizedStatus || (profit > 0 ? 'won' : 'lost') : c.status || 'open',
            };

            publishNativeContract(nativeContract);

            setResults(prev =>
                prev.map(r =>
                    r.contract_id === c.contract_id
                        ? {
                              ...r,
                              entry_spot: entrySpot || r.entry_spot,
                              ...(isSold ? { exit_tick: exitSpot, profit, status: 'COMPLETED' } : {}),
                          }
                        : r
                )
            );

            if (!isSold || completedContractsRef.current.has(contractKey)) {
                return;
            }

            completedContractsRef.current.add(contractKey);
            activeContractsRef.current.delete(contractKey);
            transactionRecoveryTimeoutsRef.current.delete(contractKey);
            isProcessingRef.current = false;
            pendingProposalRef.current = false;

            const conf = configRef.current;
            currentStakeRef.current =
                profit <= 0
                    ? Number((currentStakeRef.current * parseFloat(conf.mFactor)).toFixed(2))
                    : parseSessionNumber(conf.stake, 2);

            let shouldStopForLimit = false;
            let nextTotalProfit = 0;

            setTotalProfit(prev => {
                nextTotalProfit = Number((prev + profit).toFixed(2));
                if (nextTotalProfit >= parseFloat(conf.target)) {
                    shouldStopForLimit = true;
                } else if (nextTotalProfit <= parseFloat(conf.stopLoss) * -1) {
                    shouldStopForLimit = true;
                }
                return nextTotalProfit;
            });

            if (profit > 0) setWins(p => p + 1);
            else setLosses(p => p + 1);
            setTotalRuns(p => p + 1);

            run_panel?.setHasOpenContract?.(false);
            run_panel?.setContractStage?.(
                isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING
            );
            publishNativeResult(nativeContract);

            if (shouldStopForLimit) {
                if (nextTotalProfit >= parseFloat(conf.target)) {
                    stopTradingBot(`CONGRATULATIONS! Target Profit Hit: +$${nextTotalProfit}`, {
                        preserveOpenContract: false,
                    });
                } else {
                    stopTradingBot(`Stop Loss Hit: $${nextTotalProfit}`, { preserveOpenContract: false });
                }
            }
        },
        [client?.currency, publishNativeContract, publishNativeResult, run_panel, stopTradingBot]
    );

    const handleTickData = useCallback(
        tick => {
            const { symbol, quote } = tick;
            const digit = parseInt(quote.toString().slice(-1), 10);
            if (!historyRef.current[symbol]) historyRef.current[symbol] = { digits: [], prices: [] };
            const hist = historyRef.current[symbol];
            hist.digits = [...hist.digits, digit].slice(-10);
            hist.prices = [...hist.prices, quote].slice(-10);

            setMarketData(prev => ({ ...prev, [symbol]: { digits: [...hist.digits], prices: [...hist.prices] } }));

            if (!isRunningRef.current || isProcessingRef.current || pendingProposalRef.current) return;
            if (!activeToolRef.current) return;

            const L = parseInt(configRef.current.length, 10) || 4;
            if (hist.digits.length < L) return;

            let tradeType = null;
            let barrier = null;
            const digits = hist.digits.slice(-L);

            if (activeToolRef.current === 'even_odd') {
                if (digits.every(d => d % 2 !== 0)) tradeType = 'DIGITEVEN';
                else if (digits.every(d => d % 2 === 0)) tradeType = 'DIGITODD';
            } else if (activeToolRef.current === 'over_under') {
                if (digits.every(d => d > 5)) {
                    tradeType = 'DIGITUNDER';
                    barrier = 7;
                } else if (digits.every(d => d < 4)) {
                    tradeType = 'DIGITOVER';
                    barrier = 2;
                }
            } else if (activeToolRef.current === 'rise_fall') {
                const prices = hist.prices.slice(-(L + 1));
                if (prices.length >= L + 1) {
                    const moves = [];
                    for (let i = 1; i < prices.length; i += 1) {
                        moves.push(prices[i] > prices[i - 1] ? 'UP' : 'DOWN');
                    }
                    if (moves.every(m => m === 'UP')) tradeType = 'PUT';
                    else if (moves.every(m => m === 'DOWN')) tradeType = 'CALL';
                }
            }

            if (tradeType) {
                isProcessingRef.current = true;
                requestTradeProposal(symbol, tradeType, barrier);
            }
        },
        [requestTradeProposal]
    );

    const handleSocketMessage = useCallback(
        event => {
            const data = JSON.parse(event.data);

            if (data.msg_type === 'tick') {
                handleTickData(data.tick);
                return;
            }

            if (data.msg_type === 'authorize') {
                isAuthorizedRef.current = true;
                return;
            }

            if (data.msg_type === 'proposal' && !data.error) {
                const proposalId = data.proposal?.id;
                const askPrice = data.proposal?.ask_price;

                if (!proposalId || askPrice === undefined) {
                    pendingProposalRef.current = false;
                    isProcessingRef.current = false;
                    return;
                }

                wsRef.current.send(JSON.stringify({ buy: proposalId, price: askPrice }));
                return;
            }

            if (data.msg_type === 'buy' && !data.error) {
                const { contract_id, transaction_id, buy_price, longcode } = data.buy;
                const pt = pendingTradeContextRef.current || {};
                const contractKey = String(contract_id);
                const market = pt.symbol;

                const transactionPayload = {
                    id: contract_id,
                    contract_id,
                    transaction_ids: { buy: transaction_id },
                    buy_price: buy_price ?? parseFloat(currentStakeRef.current),
                    currency: client?.currency || 'USD',
                    display_name: formatSymbolDisplay(market),
                    underlying: market,
                    underlying_symbol: market,
                    contract_type: pt.contract_type,
                    longcode,
                    date_start: Math.floor(Date.now() / 1000),
                };

                contractMetaRef.current[contractKey] = transactionPayload;
                activeContractsRef.current.add(contractKey);
                pendingProposalRef.current = false;
                pendingTradeContextRef.current = null;
                publishNativeContract(transactionPayload);
                run_panel?.setHasOpenContract?.(true);
                run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);

                setResults(prev => [
                    {
                        id: contract_id,
                        contract_type: pt.contract_type,
                        symbol: pt.symbol,
                        entry_spot: '-',
                        exit_tick: '-',
                        stake: pt.stake,
                        profit: 0,
                        status: 'PENDING',
                        contract_id,
                    },
                    ...prev,
                ]);

                wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id, subscribe: 1 }));
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
                handleSettlement(data.proposal_open_contract);
                return;
            }

            if (data.error) {
                const errorMessage = data.error.message || 'Unknown Deriv API error';
                setProposalError(errorMessage);
                pendingProposalRef.current = false;
                isProcessingRef.current = false;
                pendingTradeContextRef.current = null;
                publishNativeError(errorMessage);
            }
        },
        [client?.currency, handleSettlement, handleTickData, publishNativeContract, publishNativeError, run_panel]
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
                    console.error('[EliteFlow] Failed to close existing socket:', error);
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
                    setProposalError('');
                    isAuthorizedRef.current = isAuthenticatedSocket;

                    SYMBOLS.forEach(symbol => {
                        wsRef.current.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
                    });

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
                wsRef.current.onerror = error => {
                    console.error(error);
                };
                wsRef.current.onclose = () => {
                    isAuthorizedRef.current = false;
                    wsRef.current = null;

                    const shouldReconnect = shouldReconnectRef.current && !skipReconnectRef.current;
                    skipReconnectRef.current = false;

                    if (shouldReconnect) {
                        reconnectTimeoutRef.current = window.setTimeout(() => {
                            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current });
                        }, 1000);
                    }
                };

                return true;
            } catch (error) {
                setProposalError(error.message);
                return false;
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
            window.clearInterval(watchdogId);
            if (reconnectTimeoutRef.current) {
                window.clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
            if (wsRef.current) {
                skipReconnectRef.current = true;
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [connectTradingSocket, getStoredAuthContext]);

    const handleConfigure = toolId => {
        setActiveTool(toolId);
        notify('Strategy Loaded Successfully!', 'info');
    };

    const handleReset = useCallback(() => {
        setResults([]);
        setTotalRuns(0);
        setWins(0);
        setLosses(0);
        setTotalProfit(0);
        currentStakeRef.current = parseSessionNumber(configRef.current.stake, 2);
        if (transactions?.clear) transactions.clear();
        if (summary_card?.clear) summary_card.clear();
        notify('Your history has been cleared.', 'info');
    }, [notify, summary_card, transactions]);

    const handleStop = useCallback(() => {
        if (!isRunningRef.current && activeContractsRef.current.size === 0 && !run_panel?.has_open_contract) return;

        stopTradingBot('Bot stopped.', {
            preserveOpenContract: Boolean(activeContractsRef.current.size > 0 || run_panel?.has_open_contract),
        });
    }, [run_panel?.has_open_contract, stopTradingBot]);

    const handleStart = useCallback(async () => {
        if (isRunningRef.current) {
            handleStop();
            return;
        }

        if (!activeToolRef.current) {
            Swal.fire({ title: 'Load a strategy first', icon: 'warning' });
            return;
        }

        if (!getStoredAuthContext()) {
            Swal.fire({ title: 'Login Required!', icon: 'error' });
            return;
        }

        setIsExpanded(true);
        currentStakeRef.current = parseSessionNumber(configRef.current.stake, 2);
        setProposalError('');
        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        if (run_panel) {
            run_panel.run_id = `elite-${Date.now()}`;
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
    }, [connectTradingSocket, getStoredAuthContext, handleStop, run_panel]);

    useEffect(() => {
        const handleExternalStop = () => {
            if (!isRunningRef.current && activeContractsRef.current.size === 0 && !run_panel?.has_open_contract) return;

            stopTradingBot('Bot stopped from the Deriv run panel.', {
                preserveOpenContract: Boolean(activeContractsRef.current.size > 0 || run_panel?.has_open_contract),
            });
        };

        observer.register('bot.click_stop', handleExternalStop);
        observer.register('elite.start', handleStart);
        observer.register('elite.stop', handleStop);

        return () => {
            if (observer.isRegistered('bot.click_stop')) {
                observer.unregister('bot.click_stop', handleExternalStop);
            }
            if (observer.isRegistered('elite.start')) {
                observer.unregister('elite.start', handleStart);
            }
            if (observer.isRegistered('elite.stop')) {
                observer.unregister('elite.stop', handleStop);
            }
        };
    }, [handleStart, handleStop, run_panel?.has_open_contract, stopTradingBot]);

    const getStrategyTitle = id => {
        if (id === 'even_odd') return 'EVEN/ODD STRATEGY';
        if (id === 'over_under') return 'OVER-2/UNDER-7 STRATEGY';
        if (id === 'rise_fall') return 'RISE/FALL STRATEGY';
        return id.replace('_', '/').toUpperCase();
    };

    return (
        <div className='eliteflow-container'>
            <div className='elite-header-container'>
                <div className='brand-group'>
                    <span className='parent-brand'>360</span>
                    <h1 className='main-logo'>
                        <span className='text-bold'>ELITE</span>
                        <span className='text-thin'>FLOW</span>
                    </h1>
                </div>
                <div className='system-status'>
                    <div className='strategy-indicators'>
                        <span className='indicator-dot active'>S1</span>
                        <span className='indicator-dot active'>S2</span>
                        <span className='indicator-dot active'>S3</span>
                    </div>
                    <div className='engine-label'>3-CORE ENGINE</div>
                </div>
            </div>

            <div className='strategy-selection-grid'>
                {['even_odd', 'over_under', 'rise_fall'].map(id => (
                    <ToolCard
                        key={id}
                        id={id}
                        title={getStrategyTitle(id)}
                        icon={id === 'even_odd' ? <FaCogs /> : id === 'over_under' ? <FaRocket /> : <FaChartLine />}
                        activeTool={activeTool}
                        handleConfigure={handleConfigure}
                        config={config}
                        setConfig={setConfig}
                        isRunning={isRunning}
                        handleStart={handleStart}
                        SYMBOLS={SYMBOLS}
                        setActiveTool={setActiveTool}
                        renderMiniSignal={renderMiniSignal}
                    />
                ))}
            </div>

            {(isExpanded || results.length > 0) && (
                <div className={`main-transactions-section ${isExpanded ? 'expanded' : ''}`}>
                    <div className='expanded-top'>
                        <div className='header-left'>
                            <button onClick={() => setIsExpanded(!isExpanded)} className='table-collapse-btn'>
                                <IoChevronDown size={22} />
                            </button>
                            <div className={isRunning ? 'bot-status-elite active' : 'bot-status-elite idle'}>
                                <span className='status-dot' />
                                <span>
                                    {isRunning ? 'Finding Patterns & Executing Trades...' : 'Run Bot to Start Trading'}
                                </span>
                            </div>
                            <div className='mobile-signal-strip'>{SYMBOLS.map(symbol => renderMiniSignal(symbol, activeTool, true))}</div>
                        </div>
                        <div className='user-buttons' style={{ display: 'flex', gap: '10px' }}>
                            <button onClick={handleStart} className={isRunning ? 'my-stop-button' : 'my-run-button'}>
                                {isRunning ? (
                                    <>
                                        <FaStop /> STOP BOT
                                    </>
                                ) : (
                                    <>
                                        <FaPlay /> RUN BOT
                                    </>
                                )}
                            </button>
                            <button onClick={handleReset} className='data-reset-btn' disabled={isRunning}>
                                <FaUndo /> RESET
                            </button>
                        </div>
                    </div>

                    <div className='main-table-contents'>
                        <table>
                            <thead>
                                <tr>
                                    <th>Contract Type</th>
                                    <th>Entry/Exit </th>
                                    <th>Stake & P/L</th>
                                </tr>
                            </thead>
                            <tbody>
                                {results.map(r => (
                                    <tr key={r.contract_id} className='transaction-row'>
                                        <td>
                                            <div className='contract-cell'>
                                                <span>{String(r.contract_type || '-').replace('DIGIT', '')}</span>
                                                <div className='contract-icon-wrapper'>
                                                    {String(r.contract_type || '').includes('EVEN') && <TradeTypesDigitsEvenIcon />}
                                                    {String(r.contract_type || '').includes('ODD') && <TradeTypesDigitsOddIcon />}
                                                    {String(r.contract_type || '').includes('OVER') && <TradeTypesDigitsOverIcon />}
                                                    {String(r.contract_type || '').includes('UNDER') && <TradeTypesDigitsUnderIcon />}
                                                    {r.contract_type === 'CALL' && <TradeTypesUpsAndDownsRiseIcon />}
                                                    {r.contract_type === 'PUT' && <TradeTypesUpsAndDownsFallIcon />}
                                                    <span className='market-superscript'>{formatSymbolDisplay(r.symbol)}</span>
                                                </div>
                                            </div>
                                        </td>
                                        <td className='entry-exit'>
                                            <div className='cell-stack align-end'>
                                                <span>{r.entry_spot}</span>
                                                <span>{r.exit_tick}</span>
                                            </div>
                                        </td>
                                        <td className='stake-profit'>
                                            <div className='cell-stack align-end'>
                                                <span className='stake'>{parseFloat(r.stake).toFixed(2)} USD</span>
                                                <span
                                                    className={`profit ${
                                                        r.status === 'PENDING'
                                                            ? ''
                                                            : parseFloat(r.profit) >= 0
                                                              ? 'profit-win '
                                                              : 'profit-loss'
                                                    }`}
                                                >
                                                    {r.status === 'PENDING' ? '--' : `${parseFloat(r.profit).toFixed(2)} USD`}
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <div className='pro-summary-grid'>
                        <SummaryCard label='Runs' value={totalRuns} />
                        <SummaryCard label='Wins' value={wins} />
                        <SummaryCard label='Losses' value={losses} />
                        <SummaryCard
                            label='Net P/L'
                            value={totalProfit}
                            className={totalProfit >= 0 ? 'profit-won' : 'profit-lost'}
                        />
                    </div>
                    {proposalError && (
                        <div style={{ color: '#ff8080', marginTop: '12px', fontSize: '12px' }}>
                            <strong>Error:</strong> {proposalError}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const SummaryCard = ({ label, value, className = '' }) => (
    <div className='pro-summary-card'>
        <h3>{label}</h3>
        <p className={className}>{value}</p>
    </div>
);

const ToolCard = ({
    id,
    title,
    icon: Icon,
    activeTool,
    handleConfigure,
    config,
    setConfig,
    isRunning,
    handleStart,
    SYMBOLS,
    setActiveTool,
    renderMiniSignal,
}) => {
    const isThisActive = activeTool === id;
    return (
        <div className={`strategy-card ${isThisActive ? 'active-tool' : ''}`}>
            <div className='card-header'>
                <div className='card-icon'>{Icon}</div>
                <h3>{title}</h3>
            </div>
            <div className='strategy-description'>
                <p>{STRATEGY_INFO[id]}</p>
            </div>
            {!isThisActive ? (
                <div className='card-idle-view'>
                    <button className='launch-btn' onClick={() => handleConfigure(id)}>
                        LOAD THIS STRATEGY
                    </button>
                </div>
            ) : (
                <div className='card-active-view'>
                    <div className='mini-config-grid extended'>
                        <ConfigInput
                            label='Stake'
                            value={config.stake}
                            type='number'
                            onChange={val => setConfig({ ...config, stake: val })}
                        />
                        <ConfigInput
                            label='Martingale'
                            value={config.mFactor}
                            type='number'
                            onChange={val => setConfig({ ...config, mFactor: val })}
                        />
                        <ConfigInput
                            label='Digits to Check-(N)'
                            value={config.length}
                            type='number'
                            min='1'
                            max='10'
                            onChange={val => setConfig({ ...config, length: val })}
                        />
                        <ConfigInput
                            label='Target Profit'
                            value={config.target}
                            type='number'
                            onChange={val => setConfig({ ...config, target: val })}
                        />
                        <ConfigInput
                            label='StopLoss'
                            value={config.stopLoss}
                            type='number'
                            onChange={val => setConfig({ ...config, stopLoss: val })}
                        />
                    </div>
                    <div className='card-action-btns'>
                        <button onClick={handleStart} className={isRunning ? 'card-stop-btn' : 'card-run-btn'}>
                            {isRunning ? <FaStop /> : <FaPlay />} {isRunning ? 'STOP BOT' : 'RUN BOT'}
                        </button>
                        <button onClick={() => setActiveTool(null)} className='switch-strategy-btn' disabled={isRunning}>
                            <FaExchangeAlt /> SWITCH STRATEGY
                        </button>
                    </div>
                    <div className='market-matrix-container'>
                        <div className='matrix-scroll'>{SYMBOLS.map(s => renderMiniSignal(s, id))}</div>
                    </div>
                </div>
            )}
        </div>
    );
};

const ConfigInput = ({ label, icon, value, onChange, ...props }) => (
    <div className='mini-input'>
        <label>
            {icon} {label}
        </label>
        <input value={value} onChange={e => onChange(e.target.value)} {...props} />
    </div>
);

export default EliteFlow;
