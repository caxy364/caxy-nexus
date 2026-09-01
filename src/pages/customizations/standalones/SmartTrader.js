import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaPlay, FaStop } from 'react-icons/fa';
import { IoChevronDown } from 'react-icons/io5';
import Swal from 'sweetalert2';
import { isProduction, WS_SERVERS } from '@/components/shared';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { getSymbolDisplayNameSync } from '@/utils/symbol-display-name';
import { TradeTypesDigitsDiffersIcon } from '@deriv/quill-icons/TradeTypes';
import { TradeTypesDigitsEvenIcon } from '@deriv/quill-icons/TradeTypes';
import { TradeTypesDigitsMatchesIcon } from '@deriv/quill-icons/TradeTypes';
import { TradeTypesDigitsOddIcon } from '@deriv/quill-icons/TradeTypes';
import { TradeTypesDigitsOverIcon } from '@deriv/quill-icons/TradeTypes';
import { TradeTypesDigitsUnderIcon } from '@deriv/quill-icons/TradeTypes';
import { TradeTypesUpsAndDownsFallIcon } from '@deriv/quill-icons/TradeTypes';
import { TradeTypesUpsAndDownsRiseIcon } from '@deriv/quill-icons/TradeTypes';
import Marketview from '../MiniAnalysis/Marketview';
import './SmartTrader.css';

const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');

const CONTRACT_TYPE_MAP = Object.freeze({
    CALL: 'CALL',
    PUT: 'PUT',
    EVEN: 'DIGITEVEN',
    ODD: 'DIGITODD',
    OVER: 'DIGITOVER',
    UNDER: 'DIGITUNDER',
    MATCHES: 'DIGITMATCH',
    DIFFERS: 'DIGITDIFF',
});

const BARRIER_CONTRACT_TYPES = ['OVER', 'UNDER', 'MATCHES', 'DIFFERS'];
const ALL_SYMBOLS = ['1HZ10V', 'R_10',  '1HZ25V', 'R_25',  '1HZ50V', 'R_50', '1HZ75V', 'R_75',  '1HZ100V', 'R_100'];

const SmartTrader = () => {
    const store = useStore();
    const { client, journal, run_panel, summary_card, transactions } = store || {};

    const [symbol, setSymbol] = useState('1HZ10V');
    const [contractType, setContractType] = useState('UNDER');
    const [initialStake, setInitialStake] = useState('1');
    const [duration, setDuration] = useState('1');
    const [targetProfit, setTargetProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [useMartingale, setUseMartingale] = useState(true);
    const [useBulk, setUseBulk] = useState(false);
    const [martingaleMultiplier, setMartingaleMultiplier] = useState('2.1');
    const [predictionDigit, setPredictionDigit] = useState('7');
    const [bulkCount, setBulkCount] = useState('10');
    const [useRecovery, setUseRecovery] = useState(false);
    const [recoveryContractType, setRecoveryContractType] = useState('EVEN');
    const [recoveryPredictionDigit, setRecoveryPredictionDigit] = useState('5');
    const [autoSwitch, setAutoSwitch] = useState(false);

    const [isRunning, setIsRunning] = useState(false);
    const [, setLogs] = useState([]);
    const [results, setResults] = useState([]);
    const [wins, setWins] = useState(0);
    const [losses, setLosses] = useState(0);
    const [totalRuns, setTotalRuns] = useState(0);
    const [totalProfit, setTotalProfit] = useState(0);
    const [proposalError, setProposalError] = useState('');
    const [currentPrice, setCurrentPrice] = useState(null);
    const [isExpanded, setIsExpanded] = useState(false);

    const wsRef = useRef(null);
    const totalProfitRef = useRef(0);
    const baseStakeRef = useRef(1);
    const currentStakeRef = useRef(1);
    const isRunningRef = useRef(false);
    const isAuthorizedRef = useRef(false);
    const isConnectingRef = useRef(false);
    const shouldReconnectRef = useRef(true);
    const reconnectTimeoutRef = useRef(null);
    const skipReconnectRef = useRef(false);
    const socketRequiresAuthRef = useRef(false);
    const pendingProposalRef = useRef(false);
    const pendingTradeMetaRef = useRef(null);
    const contractMetaRef = useRef({});
    const lastProcessedContractIdRef = useRef(null);
    const completedContractsRef = useRef(new Set());
    const activeContractsRef = useRef(new Set());
    const transactionRecoveryTimeoutsRef = useRef(new Map());
    const activeContractTypeRef = useRef(contractType);
    const initialStakeRef = useRef(initialStake);
    const durationRef = useRef(duration);
    const bulkCountRef = useRef(bulkCount);

    const contractTypeRef = useRef(contractType);
    const useMartingaleRef = useRef(useMartingale);
    const useBulkRef = useRef(useBulk);
    const predictionDigitRef = useRef(predictionDigit);
    const targetProfitRef = useRef(targetProfit);
    const stopLossRef = useRef(stopLoss);
    const martingaleMultiplierRef = useRef(martingaleMultiplier);
    const useRecoveryRef = useRef(useRecovery);
    const recoveryContractTypeRef = useRef(recoveryContractType);
    const recoveryPredictionDigitRef = useRef(recoveryPredictionDigit);
    const lastTradeWasLossRef = useRef(false);
    const symbolRef = useRef(symbol);
    const autoSwitchRef = useRef(autoSwitch);

    useEffect(() => {
        isRunningRef.current = isRunning;
    }, [isRunning]);

    useEffect(() => {
        run_panel?.setIsRunning?.(isRunning);
        if (!isRunning && !run_panel?.has_open_contract) {
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [isRunning, run_panel]);

    useEffect(() => {
        contractTypeRef.current = contractType;
    }, [contractType]);

    useEffect(() => {
        useMartingaleRef.current = useMartingale;
    }, [useMartingale]);

    useEffect(() => {
        useBulkRef.current = useBulk;
    }, [useBulk]);

    useEffect(() => {
        predictionDigitRef.current = predictionDigit;
    }, [predictionDigit]);

    useEffect(() => {
        initialStakeRef.current = initialStake;
    }, [initialStake]);

    useEffect(() => {
        durationRef.current = duration;
    }, [duration]);

    useEffect(() => {
        bulkCountRef.current = bulkCount;
    }, [bulkCount]);

    useEffect(() => {
        targetProfitRef.current = targetProfit;
    }, [targetProfit]);

    useEffect(() => {
        stopLossRef.current = stopLoss;
    }, [stopLoss]);

    useEffect(() => {
        martingaleMultiplierRef.current = martingaleMultiplier;
    }, [martingaleMultiplier]);

    useEffect(() => {
        useRecoveryRef.current = useRecovery;
    }, [useRecovery]);

    useEffect(() => {
        recoveryContractTypeRef.current = recoveryContractType;
    }, [recoveryContractType]);

    useEffect(() => {
        recoveryPredictionDigitRef.current = recoveryPredictionDigit;
    }, [recoveryPredictionDigit]);

    useEffect(() => {
        symbolRef.current = symbol;
    }, [symbol]);

    useEffect(() => {
        autoSwitchRef.current = autoSwitch;
    }, [autoSwitch]);

    const logMessage = useCallback(message => {
        setLogs(prev_logs => [message, ...prev_logs]);
    }, []);

    const publishNativeContract = useCallback(
        contract_data => {
            if (!transactions || !summary_card) return;
            transactions.onBotContractEvent(contract_data);
            summary_card.onBotContractEvent(contract_data);
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
        contract_data => {
            if (journal?.onLogSuccess) {
                journal.onLogSuccess({
                    log_type: contract_data.profit > 0 ? 'profit' : 'lost',
                    extra: {
                        currency: contract_data.currency,
                        profit: contract_data.profit,
                    },
                });
            }
        },
        [journal]
    );

    const clearRecoveryTimeouts = useCallback(() => {
        transactionRecoveryTimeoutsRef.current.forEach(timeout_id => clearTimeout(timeout_id));
        transactionRecoveryTimeoutsRef.current.clear();
    }, []);

    const clearContractTracking = useCallback(() => {
        pendingProposalRef.current = false;
        pendingTradeMetaRef.current = null;
        contractMetaRef.current = {};
        lastProcessedContractIdRef.current = null;
        completedContractsRef.current.clear();
        activeContractsRef.current.clear();
        clearRecoveryTimeouts();
    }, [clearRecoveryTimeouts]);

    const getStoredAuthContext = useCallback(() => {
        try {
            const auth_raw = sessionStorage.getItem('auth_info');
            const accounts_raw = sessionStorage.getItem('deriv_accounts');

            if (!auth_raw || !accounts_raw) return null;

            const { access_token } = JSON.parse(auth_raw);
            const accounts = JSON.parse(accounts_raw);

            if (!access_token || !Array.isArray(accounts) || accounts.length === 0) {
                return null;
            }

            const active_login_id = localStorage.getItem('active_loginid');
            const active_account =
                accounts.find(account => account.account_id === active_login_id) ||
                accounts.find(account => account.account_id?.startsWith('DOT')) ||
                accounts[0];

            if (!active_account?.account_id) return null;

            return {
                accessToken: access_token,
                activeAccount: active_account,
            };
        } catch (error) {
            console.error('[SmartTrader] Failed to parse Deriv session storage:', error);
            return null;
        }
    }, []);

    const getAuthenticatedUrl = useCallback(async () => {
        try {
            const auth_context = getStoredAuthContext();
            if (!auth_context) throw new Error('Session Missing');

            const { accessToken, activeAccount } = auth_context;
            const response = await fetch(`${DERIV_OPTIONS_API_URL}accounts/${activeAccount.account_id}/otp`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            });

            if (!response.ok) throw new Error('OTP Request Failed');

            const data = await response.json();
            const authenticated_url = data?.data?.url;

            if (!authenticated_url) throw new Error('Authenticated URL Missing');

            return authenticated_url;
        } catch (error) {
            logMessage(`Auth Error: ${error.message}`);
            return null;
        }
    }, [getStoredAuthContext, logMessage]);

    const getActiveTradeSettings = useCallback(() => {
        const using_recovery = lastTradeWasLossRef.current && useRecoveryRef.current;
        const active_type = using_recovery ? recoveryContractTypeRef.current : contractTypeRef.current;
        const active_prediction = using_recovery ? recoveryPredictionDigitRef.current : predictionDigitRef.current;
        const deriv_contract_type = CONTRACT_TYPE_MAP[active_type] || active_type;
        const barrier = BARRIER_CONTRACT_TYPES.includes(active_type)
            ? parseInt(active_prediction, 10)
            : undefined;

        return {
            activeType: active_type,
            activePrediction: active_prediction,
            barrier,
            derivContractType: deriv_contract_type,
        };
    }, []);

    const requestProposal = useCallback(() => {
        if (!isRunningRef.current) return;

        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            logMessage('WebSocket not ready for proposal request');
            return;
        }

        if (!isAuthorizedRef.current) {
            logMessage('Trading session is not authorized yet');
            return;
        }

        if (pendingProposalRef.current) {
            logMessage('Waiting for pending proposal to resolve');
            return;
        }

        if (activeContractsRef.current.size > 0) {
            logMessage(`Waiting for ${activeContractsRef.current.size} active contract(s) to settle`);
            return;
        }

        const { activeType, barrier, derivContractType } = getActiveTradeSettings();
        const parsed_duration = Math.max(1, parseInt(durationRef.current, 10) || 1);
        const parsed_stake = Number(currentStakeRef.current).toFixed(2);

        activeContractTypeRef.current = activeType;
        pendingTradeMetaRef.current = {
            uiContractType: activeType,
            derivContractType,
            barrier,
            stake: parsed_stake,
        };
        pendingProposalRef.current = true;
        setProposalError('');
        run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);

        wsRef.current.send(
            JSON.stringify({
                proposal: 1,
                amount: parsed_stake,
                basis: 'stake',
                contract_type: derivContractType,
                currency: client?.currency || 'USD',
                underlying_symbol: symbolRef.current,
                duration: parsed_duration,
                duration_unit: 't',
                ...(barrier !== undefined ? { barrier } : {}),
            })
        );
    }, [client?.currency, getActiveTradeSettings, logMessage, run_panel]);

    const firePrecisionBurst = useCallback(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !isAuthorizedRef.current) {
            logMessage('Trading socket is not ready for bulk execution');
            return;
        }

        const parsed_count = Math.max(1, parseInt(bulkCountRef.current, 10) || 1);
        const parsed_duration = Math.max(1, parseInt(durationRef.current, 10) || 1);
        const parsed_stake = parseFloat(initialStakeRef.current) || 0;
        const active_type = contractTypeRef.current;
        const deriv_contract_type = CONTRACT_TYPE_MAP[active_type] || active_type;
        const barrier = BARRIER_CONTRACT_TYPES.includes(active_type)
            ? parseInt(predictionDigitRef.current, 10)
            : undefined;

        activeContractTypeRef.current = active_type;
        pendingTradeMetaRef.current = {
            uiContractType: active_type,
            derivContractType: deriv_contract_type,
            barrier,
            stake: parsed_stake.toFixed(2),
        };
        setProposalError('');
        run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);

        for (let index = 0; index < parsed_count; index += 1) {
            window.setTimeout(() => {
                if (!isRunningRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

                wsRef.current.send(
                    JSON.stringify({
                        buy: 1,
                        subscribe: 1,
                        price: parsed_stake,
                        parameters: {
                            amount: parsed_stake,
                            basis: 'stake',
                            contract_type: deriv_contract_type,
                            currency: client?.currency || 'USD',
                            underlying_symbol: symbolRef.current,
                            duration: parsed_duration,
                            duration_unit: 't',
                            ...(barrier !== undefined ? { barrier } : {}),
                        },
                    })
                );
            }, index * 50);
        }
    }, [client?.currency, logMessage, run_panel]);

    const stopTradingBot = useCallback(
        (reason = 'Bot stopped.', options = {}) => {
            const preserve_open_contract =
                options.preserveOpenContract ?? Boolean(activeContractsRef.current.size > 0 || run_panel?.has_open_contract);

            setIsRunning(false);
            isRunningRef.current = false;
            pendingProposalRef.current = false;

            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ forget_all: 'proposal' }));
                if (!preserve_open_contract) {
                    wsRef.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
                }
            }

            if (!preserve_open_contract) {
                clearContractTracking();
            }

            run_panel?.setIsRunning?.(false);
            run_panel?.toggleDrawer?.(true);
            run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

            if (preserve_open_contract) {
                run_panel?.setHasOpenContract?.(true);
                run_panel?.setContractStage?.(contract_stages.IS_STOPPING);
            } else {
                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
            }

            logMessage(reason);
        },
        [clearContractTracking, logMessage, run_panel]
    );

    const handleStop = useCallback(() => {
        const preserve_open_contract = activeContractsRef.current.size > 0;
        stopTradingBot(
            preserve_open_contract
                ? 'Bot stopped. Waiting for active contracts to finish...'
                : 'Bot stopped.',
            { preserveOpenContract: preserve_open_contract }
        );
    }, [stopTradingBot]);

    const handleNormalSequence = useCallback(
        profit => {
            if (useMartingaleRef.current) {
                currentStakeRef.current =
                    profit <= 0
                        ? parseFloat(
                              (Number(currentStakeRef.current) * parseFloat(martingaleMultiplierRef.current || '1')).toFixed(
                                  2
                              )
                          )
                        : parseFloat(baseStakeRef.current);
            }

            lastTradeWasLossRef.current = profit <= 0;

            if (!isRunningRef.current) {
                if (activeContractsRef.current.size === 0) {
                    run_panel?.setHasOpenContract?.(false);
                    run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
                }
                return;
            }

            if (totalProfitRef.current >= parseFloat(targetProfitRef.current)) {
                Swal.fire({ title: 'TARGET PROFIT HIT!', icon: 'success' });
                stopTradingBot('Target profit reached. Bot stopped.', { preserveOpenContract: false });
                return;
            }

            if (totalProfitRef.current <= -parseFloat(stopLossRef.current)) {
                Swal.fire({ title: 'STOP LOSS HIT!', icon: 'error' });
                stopTradingBot('Stop loss reached. Bot stopped.', { preserveOpenContract: false });
                return;
            }

            if (autoSwitchRef.current) {
                const other_symbols = ALL_SYMBOLS.filter(item => item !== symbolRef.current);
                const new_symbol = other_symbols[Math.floor(Math.random() * other_symbols.length)];
                logMessage(`Auto-switching to ${new_symbol}`);
                setSymbol(new_symbol);
                symbolRef.current = new_symbol;
            }

            window.setTimeout(() => {
                if (isRunningRef.current) {
                    requestProposal();
                }
            }, 500);
        },
        [logMessage, requestProposal, run_panel, stopTradingBot]
    );

    const handleSocketMessage = useCallback(
        event => {
            const data = JSON.parse(event.data);

            if (data.msg_type === 'authorize') {
                isAuthorizedRef.current = true;
                logMessage('Trading session authorized');
                if (isRunningRef.current && activeContractsRef.current.size === 0) {
                    useBulkRef.current ? firePrecisionBurst() : requestProposal();
                }
                return;
            }

            if (data.msg_type === 'proposal' && !data.error) {
                if (!isRunningRef.current) return;

                const proposal_id = data.proposal?.id;
                const ask_price = data.proposal?.ask_price;

                if (!proposal_id || ask_price === undefined) {
                    logMessage('Proposal received without an id or ask price');
                    pendingProposalRef.current = false;
                    return;
                }

                wsRef.current.send(JSON.stringify({ buy: proposal_id, price: ask_price }));
                return;
            }

            if (data.error) {
                const error_code = data.error.code;
                const error_message = data.error.message;
                const open_position_limit_reached =
                    /(cannot hold more than \d+ contracts|open positions of this asset and trade type|open position limit)/i.test(
                        error_message || ''
                    );
                const session_trading_limit_reached =
                    [
                        'CompanyWideLimitExceeded',
                        'DailyProfitLimitExceeded',
                        'ProductSpecificTurnoverLimitExceeded',
                        'MaxAggregateOpenStakeExceeded',
                    ].includes(error_code) ||
                    /(no further trading is allowed|maximum daily stake|growth rate and instrument)/i.test(
                        error_message || ''
                    );

                setProposalError(error_message);
                pendingProposalRef.current = false;
                logMessage(`Trade error: ${error_message}`);
                publishNativeError(error_message);

                if (open_position_limit_reached) {
                    stopTradingBot('Open position limit reached. Bot stopped.', { preserveOpenContract: false });
                    return;
                }

                if (session_trading_limit_reached) {
                    stopTradingBot('Trading is blocked for this contract type in the current session.', {
                        preserveOpenContract: false,
                    });
                }
                return;
            }

            if (data.msg_type === 'transaction') {
                const action = data.transaction?.action;
                const sell_contract_id = data.transaction?.contract_id;
                const contract_key = String(sell_contract_id ?? '');

                if (action !== 'sell' || !sell_contract_id || !activeContractsRef.current.has(contract_key)) {
                    return;
                }

                if (completedContractsRef.current.has(contract_key)) {
                    return;
                }

                if (transactionRecoveryTimeoutsRef.current.has(contract_key)) {
                    clearTimeout(transactionRecoveryTimeoutsRef.current.get(contract_key));
                }

                const timeout_id = window.setTimeout(() => {
                    transactionRecoveryTimeoutsRef.current.delete(contract_key);

                    if (
                        !activeContractsRef.current.has(contract_key) ||
                        completedContractsRef.current.has(contract_key) ||
                        wsRef.current?.readyState !== WebSocket.OPEN
                    ) {
                        return;
                    }

                    wsRef.current.send(
                        JSON.stringify({
                            proposal_open_contract: 1,
                            contract_id: sell_contract_id,
                        })
                    );
                }, 1500);

                transactionRecoveryTimeoutsRef.current.set(contract_key, timeout_id);
                return;
            }

            if (data.msg_type === 'buy') {
                const { contract_id, transaction_id, buy_price, longcode } = data.buy || {};

                if (!contract_id) {
                    pendingProposalRef.current = false;
                    return;
                }

                const contract_key = String(contract_id);
                const market = symbolRef.current;
                const trade_meta = pendingTradeMetaRef.current || {
                    uiContractType: activeContractTypeRef.current,
                    derivContractType: CONTRACT_TYPE_MAP[activeContractTypeRef.current] || activeContractTypeRef.current,
                    barrier: undefined,
                    stake: Number(useBulkRef.current ? initialStakeRef.current : currentStakeRef.current).toFixed(2),
                };

                const transaction_payload = {
                    id: contract_id,
                    contract_id,
                    transaction_ids: {
                        buy: transaction_id,
                    },
                    buy_price: buy_price ?? parseFloat(trade_meta.stake),
                    currency: client?.currency || 'USD',
                    display_name: getSymbolDisplayNameSync(market),
                    underlying: market,
                    underlying_symbol: market,
                    contract_type: trade_meta.derivContractType,
                    longcode,
                    barrier: trade_meta.barrier,
                    tick_count: Math.max(1, parseInt(durationRef.current, 10) || 1),
                    date_start: Math.floor(Date.now() / 1000),
                };

                contractMetaRef.current[contract_key] = transaction_payload;
                completedContractsRef.current.delete(contract_key);
                activeContractsRef.current.add(contract_key);
                pendingProposalRef.current = false;
                setProposalError('');

                publishNativeContract(transaction_payload);
                run_panel?.setHasOpenContract?.(true);
                run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);

                setResults(prev_results => [
                    {
                        contract_id,
                        contract_type: trade_meta.uiContractType,
                        entry_spot: '-',
                        exit_spot: '-',
                        stake: Number(buy_price ?? trade_meta.stake).toFixed(2),
                        profit: null,
                        status: 'PENDING',
                    },
                    ...prev_results,
                ]);

                wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id, subscribe: 1 }));
                return;
            }

            if (data.msg_type === 'proposal_open_contract') {
                const contract = data.proposal_open_contract;
                if (!contract) return;

                const contract_key = String(contract.contract_id);
                const is_tracked_contract = activeContractsRef.current.has(contract_key);

                if (!isRunningRef.current && !is_tracked_contract) return;
                if (completedContractsRef.current.has(contract_key)) return;

                const normalized_status = String(contract.status || '').toLowerCase();
                const has_closed_status = Boolean(normalized_status) && normalized_status !== 'open';
                const is_expired = contract.is_expired === 1 || contract.is_expired === true || contract.is_expired === '1';
                const is_settleable =
                    contract.is_settleable === 1 ||
                    contract.is_settleable === true ||
                    contract.is_settleable === '1';
                const is_sold =
                    contract.is_sold === 1 ||
                    contract.is_sold === true ||
                    contract.is_sold === '1' ||
                    has_closed_status ||
                    is_expired ||
                    is_settleable;

                const entry_spot =
                    contract.entry_spot_display_value ??
                    contract.entry_tick_display_value ??
                    contract.entry_spot ??
                    contract.entry_tick ??
                    '-';

                const exit_spot =
                    contract.exit_spot_display_value ??
                    contract.exit_tick_display_value ??
                    contract.exit_spot ??
                    contract.exit_tick ??
                    contract.current_spot_display_value ??
                    contract.current_spot ??
                    '-';

                const profit = parseFloat(contract.profit ?? 0);
                const result_status = profit > 0 ? 'won' : 'lost';
                const native_contract = {
                    ...(contractMetaRef.current[contract_key] || {}),
                    ...contract,
                    id: contract.contract_id,
                    contract_id: contract.contract_id,
                    contract_type:
                        contract.contract_type ||
                        contractMetaRef.current[contract_key]?.contract_type ||
                        pendingTradeMetaRef.current?.derivContractType,
                    display_name:
                        contract.display_name ||
                        contractMetaRef.current[contract_key]?.display_name ||
                        getSymbolDisplayNameSync(contract.underlying_symbol || contract.underlying || symbolRef.current),
                    underlying_symbol:
                        contract.underlying_symbol ||
                        contractMetaRef.current[contract_key]?.underlying_symbol ||
                        contract.underlying ||
                        symbolRef.current,
                    underlying:
                        contract.underlying ||
                        contractMetaRef.current[contract_key]?.underlying ||
                        contract.underlying_symbol ||
                        symbolRef.current,
                    buy_price:
                        contract.buy_price ??
                        contractMetaRef.current[contract_key]?.buy_price ??
                        parseFloat(pendingTradeMetaRef.current?.stake || currentStakeRef.current),
                    currency: contract.currency || client?.currency || 'USD',
                    transaction_ids:
                        contract.transaction_ids || contractMetaRef.current[contract_key]?.transaction_ids || undefined,
                    entry_spot,
                    exit_spot: is_sold ? exit_spot : undefined,
                    is_sold,
                    is_expired: is_expired || contract.is_expired,
                    is_settleable: is_settleable || contract.is_settleable,
                    result: is_sold ? result_status : undefined,
                    status: is_sold ? normalized_status || result_status : contract.status || 'open',
                };

                contractMetaRef.current[contract_key] = native_contract;
                publishNativeContract(native_contract);

                setResults(prev_results =>
                    prev_results.map(result =>
                        result.contract_id === contract.contract_id
                            ? {
                                  ...result,
                                  entry_spot,
                                  ...(is_sold
                                      ? {
                                            exit_spot,
                                            profit: profit.toFixed(2),
                                            status: profit >= 0 ? 'WIN' : 'LOSS',
                                        }
                                      : {}),
                              }
                            : result
                    )
                );

                if (!is_sold) return;
                if (lastProcessedContractIdRef.current === contract_key) return;

                if (transactionRecoveryTimeoutsRef.current.has(contract_key)) {
                    clearTimeout(transactionRecoveryTimeoutsRef.current.get(contract_key));
                    transactionRecoveryTimeoutsRef.current.delete(contract_key);
                }

                completedContractsRef.current.add(contract_key);
                activeContractsRef.current.delete(contract_key);
                lastProcessedContractIdRef.current = contract_key;
                totalProfitRef.current += profit;

                setTotalProfit(totalProfitRef.current.toFixed(2));
                setTotalRuns(prev_total_runs => prev_total_runs + 1);

                if (profit > 0) {
                    setWins(prev_wins => prev_wins + 1);
                } else {
                    setLosses(prev_losses => prev_losses + 1);
                }

                run_panel?.setHasOpenContract?.(activeContractsRef.current.size > 0);
                run_panel?.setContractStage?.(
                    activeContractsRef.current.size > 0
                        ? contract_stages.PURCHASE_RECEIVED
                        : isRunningRef.current
                          ? contract_stages.CONTRACT_CLOSED
                          : contract_stages.NOT_RUNNING
                );
                publishNativeResult(native_contract);

                if (useBulkRef.current) {
                    if (activeContractsRef.current.size === 0) {
                        setIsRunning(false);
                        isRunningRef.current = false;
                        run_panel?.setIsRunning?.(false);
                        run_panel?.setHasOpenContract?.(false);
                        run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
                        logMessage('Bulk Finished');
                    }
                    return;
                }

                handleNormalSequence(profit);
            }
        },
        [
            client?.currency,
            firePrecisionBurst,
            handleNormalSequence,
            logMessage,
            publishNativeContract,
            publishNativeError,
            publishNativeResult,
            requestProposal,
            run_panel,
            stopTradingBot,
        ]
    );

    const connectTradingSocket = useCallback(
        async (options = {}) => {
            const { requireAuth = false, forceReconnect = false } = options;
            const socket_state = wsRef.current?.readyState;

            if (
                !forceReconnect &&
                (socket_state === WebSocket.OPEN || socket_state === WebSocket.CONNECTING || isConnectingRef.current)
            ) {
                return true;
            }

            if (forceReconnect && wsRef.current) {
                skipReconnectRef.current = true;
                const existing_socket = wsRef.current;
                wsRef.current = null;
                isAuthorizedRef.current = false;

                try {
                    existing_socket.close();
                } catch (error) {
                    console.error('[SmartTrader] Failed to close existing socket:', error);
                }
            }

            isConnectingRef.current = true;
            socketRequiresAuthRef.current = requireAuth;

            try {
                const authenticated_url = requireAuth ? await getAuthenticatedUrl() : null;

                if (requireAuth && !authenticated_url) {
                    setProposalError('Unable to create an authenticated Deriv session.');
                    return false;
                }

                const socket_url = authenticated_url || DERIV_PUBLIC_WS_URL;
                const is_authenticated_socket = Boolean(authenticated_url);

                wsRef.current = new WebSocket(socket_url);
                wsRef.current.onopen = () => {
                    logMessage(is_authenticated_socket ? 'Trading socket connected' : 'Public socket connected');
                    setProposalError('');
                    isAuthorizedRef.current = is_authenticated_socket;

                    if (is_authenticated_socket) {
                        wsRef.current.send(JSON.stringify({ transaction: 1, subscribe: 1 }));

                        activeContractsRef.current.forEach(active_contract_id => {
                            wsRef.current.send(
                                JSON.stringify({
                                    proposal_open_contract: 1,
                                    contract_id: Number(active_contract_id),
                                    subscribe: 1,
                                })
                            );
                        });

                        if (isRunningRef.current && activeContractsRef.current.size === 0) {
                            useBulkRef.current ? firePrecisionBurst() : requestProposal();
                        }
                    }
                };

                wsRef.current.onmessage = handleSocketMessage;
                wsRef.current.onerror = error => {
                    logMessage('Trading socket error');
                    console.error(error);
                };

                wsRef.current.onclose = () => {
                    logMessage('Trading socket closed');
                    isAuthorizedRef.current = false;
                    wsRef.current = null;

                    const should_reconnect = shouldReconnectRef.current && !skipReconnectRef.current;
                    skipReconnectRef.current = false;

                    if (should_reconnect) {
                        reconnectTimeoutRef.current = window.setTimeout(() => {
                            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current });
                        }, 1000);
                    }
                };

                return true;
            } catch (error) {
                logMessage(`Trading connection failed: ${error.message}`);
                setProposalError(error.message);
                return false;
            } finally {
                isConnectingRef.current = false;
            }
        },
        [firePrecisionBurst, getAuthenticatedUrl, handleSocketMessage, logMessage, requestProposal]
    );

    const handleStart = useCallback(async () => {
        if (isRunningRef.current) {
            handleStop();
            return;
        }

        if (!getStoredAuthContext()) {
            Swal.fire({ title: 'Login Required!', icon: 'error', draggable: false });
            return;
        }

        totalProfitRef.current = parseFloat(totalProfit) || 0;
        baseStakeRef.current = parseFloat(initialStakeRef.current) || 0;
        currentStakeRef.current = parseFloat(initialStakeRef.current) || 0;
        activeContractsRef.current.clear();
        completedContractsRef.current.clear();
        contractMetaRef.current = {};
        lastProcessedContractIdRef.current = null;
        pendingProposalRef.current = false;
        pendingTradeMetaRef.current = null;
        clearRecoveryTimeouts();
        setProposalError('');

        setIsRunning(true);
        isRunningRef.current = true;

        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        run_panel?.toggleDrawer?.(true);
        run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

        if (run_panel) {
            run_panel.run_id = `smarttrader-${Date.now()}`;
        }

        const socket_state = wsRef.current?.readyState;
        if (wsRef.current && socket_state === WebSocket.OPEN && isAuthorizedRef.current) {
            useBulkRef.current ? firePrecisionBurst() : requestProposal();
            return;
        }

        const did_connect = await connectTradingSocket({
            requireAuth: true,
            forceReconnect: Boolean(wsRef.current && !isAuthorizedRef.current),
        });

        if (!did_connect) {
            setIsRunning(false);
            isRunningRef.current = false;
            run_panel?.setIsRunning?.(false);
            run_panel?.setHasOpenContract?.(false);
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [
        clearRecoveryTimeouts,
        connectTradingSocket,
        firePrecisionBurst,
        getStoredAuthContext,
        handleStop,
        requestProposal,
        run_panel,
        totalProfit,
    ]);

    const handleToggleBot = useCallback(() => {
        if (isRunningRef.current) {
            handleStop();
            return;
        }

        handleStart();
    }, [handleStart, handleStop]);

    const handleReset = () => {
        setLogs([]);
        setResults([]);
        setWins(0);
        setLosses(0);
        setTotalRuns(0);
        setTotalProfit(0);
        totalProfitRef.current = 0;
        currentStakeRef.current = baseStakeRef.current;
        lastTradeWasLossRef.current = false;
    };

    useEffect(() => {
        shouldReconnectRef.current = true;
        const should_require_auth = Boolean(getStoredAuthContext());

        connectTradingSocket({ requireAuth: should_require_auth });

        const watchdog_id = window.setInterval(() => {
            if (!shouldReconnectRef.current) return;
            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current || should_require_auth });
        }, 1500);

        return () => {
            shouldReconnectRef.current = false;
            window.clearInterval(watchdog_id);

            if (reconnectTimeoutRef.current) {
                window.clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }

            clearRecoveryTimeouts();

            if (wsRef.current) {
                skipReconnectRef.current = true;
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [clearRecoveryTimeouts, connectTradingSocket, getStoredAuthContext]);

    useEffect(() => {
        observer.register('smarttrader.start', handleStart);
        observer.register('smarttrader.stop', handleStop);

        return () => {
            if (observer.isRegistered('smarttrader.start')) {
                observer.unregister('smarttrader.start', handleStart);
            }

            if (observer.isRegistered('smarttrader.stop')) {
                observer.unregister('smarttrader.stop', handleStop);
            }
        };
    }, [handleStart, handleStop]);

    useEffect(() => {
        const price_socket = new WebSocket(DERIV_PUBLIC_WS_URL);

        price_socket.onopen = () => {
            price_socket.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
        };

        price_socket.onmessage = event => {
            const data = JSON.parse(event.data);
            if (data.msg_type === 'tick') {
                setCurrentPrice(data.tick.quote);
            }
        };

        return () => {
            price_socket.close();
        };
    }, [symbol]);

    useEffect(() => {
        if (isRunning) {
            setIsExpanded(true);
        }
    }, [isRunning]);

    const getDecimalPlaces = selected_symbol =>
        ['1HZ15V', '1HZ30V', '1HZ90V'].includes(selected_symbol)
            ? 3
            : selected_symbol.startsWith('R_50') || selected_symbol.startsWith('R_75')
              ? 4
              : 2;

    const handleCollapse = () => {
        setIsExpanded(false);
    };

    return (
        <div className='overall-container'>
            <div className='pro-master-wrapper'>
                <div className='pro-header-flex'>
                    <div className='pro-titles'>
                        <h2 className='pro-main-heading'>360 Smart Trader</h2>
                        <p className='pro-sub-heading'>
                            Execute Bulk Trades | Recover with any Contract Type | Vol Autoswitch
                        </p>
                    </div>
                    <div className='pro-price-ticker'>
                        Price: {currentPrice ? currentPrice.toFixed(getDecimalPlaces(symbol)) : 'Loading...'}
                    </div>
                </div>

                <div className={`pro-control-deck ${isRunning ? 'pro-minimized' : ''}`}>
                    <div className='pro-input-grid'>
                        <label className='pro-input-box'>
                            Volatility:
                            <select value={symbol} onChange={e => setSymbol(e.target.value)} className='pro-select-field'>
                                {ALL_SYMBOLS.map(item => (
                                    <option key={item} value={item}>
                                        {item.startsWith('1HZ')
                                            ? `Volatility ${item.replace('1HZ', '').replace('V', '')} 1s`
                                            : item.startsWith('R_')
                                              ? `Volatility ${item.replace('R_', '')}`
                                              : item}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className='pro-input-box'>
                            Contract Type:
                            <select
                                className='pro-select-field'
                                value={contractType}
                                onChange={e => setContractType(e.target.value)}
                            >
                                <option value='CALL'>Rise</option>
                                <option value='PUT'>Fall</option>
                                <option value='EVEN'>Even</option>
                                <option value='ODD'>Odd</option>
                                <option value='OVER'>Over</option>
                                <option value='UNDER'>Under</option>
                                <option value='MATCHES'>Matches</option>
                                <option value='DIFFERS'>Differs</option>
                            </select>
                        </label>

                        {BARRIER_CONTRACT_TYPES.includes(contractType) && (
                            <label className='pro-input-box'>
                                Prediction:
                                <input
                                    className='pro-field-entry'
                                    type='number'
                                    min={0}
                                    max={9}
                                    value={predictionDigit}
                                    onChange={e => setPredictionDigit(e.target.value)}
                                />
                            </label>
                        )}

                        <label className='pro-input-box'>
                            Stake:
                            <input
                                className='pro-field-entry'
                                type='number'
                                value={initialStake}
                                onChange={e => setInitialStake(e.target.value)}
                            />
                        </label>

                        <label className='pro-input-box'>
                            Duration (ticks):
                            <input
                                className='pro-field-entry'
                                type='number'
                                value={duration}
                                onChange={e => setDuration(e.target.value)}
                            />
                        </label>

                        <label className='pro-input-box'>
                            Target Profit:
                            <input
                                className='pro-field-entry'
                                type='number'
                                value={targetProfit}
                                onChange={e => setTargetProfit(e.target.value)}
                            />
                        </label>

                        <label className='pro-input-box'>
                            Stop Loss:
                            <input
                                className='pro-field-entry'
                                type='number'
                                value={stopLoss}
                                onChange={e => setStopLoss(e.target.value)}
                            />
                        </label>
                    </div>

                    <div className='pro-logic-bar'>
                        <label className='pro-switch-container'>
                            <input type='checkbox' checked={autoSwitch} onChange={e => setAutoSwitch(e.target.checked)} />
                            <span className='pro-slider-track'></span>
                            <span className='pro-switch-label'>Auto-Switch Volatility</span>
                        </label>

                        <div className='pro-feature-row'>
                            <label className='pro-switch-container'>
                                <input type='checkbox' checked={useBulk} onChange={e => setUseBulk(e.target.checked)} />
                                <span className='pro-slider-track'></span>
                                <span className='pro-switch-label'>Enable Bulk</span>
                            </label>
                            {useBulk && (
                                <input
                                    type='number'
                                    value={bulkCount}
                                    onChange={e => setBulkCount(e.target.value)}
                                    className='checkbox-entry'
                                />
                            )}
                        </div>

                        <div className='pro-feature-row'>
                            <label className='pro-switch-container'>
                                <input
                                    type='checkbox'
                                    checked={useMartingale}
                                    onChange={e => setUseMartingale(e.target.checked)}
                                />
                                <span className='pro-slider-track'></span>
                                <span className='pro-switch-label'>Use Martingale</span>
                            </label>
                            {useMartingale && (
                                <input
                                    className='checkbox-entry'
                                    type='number'
                                    step='0.1'
                                    value={martingaleMultiplier}
                                    onChange={e => setMartingaleMultiplier(e.target.value)}
                                />
                            )}
                        </div>

                        <div className='pro-feature-row'>
                            <label className='pro-switch-container'>
                                <input
                                    type='checkbox'
                                    checked={useRecovery}
                                    onChange={e => setUseRecovery(e.target.checked)}
                                />
                                <span className='pro-slider-track'></span>
                                <span className='pro-switch-label'>Recover with:</span>
                            </label>
                            {useRecovery && (
                                <div className='pro-recovery-inputs'>
                                    <select
                                        className='pro-mini-select'
                                        value={recoveryContractType}
                                        onChange={e => setRecoveryContractType(e.target.value)}
                                    >
                                        <option value='CALL'>Rise</option>
                                        <option value='PUT'>Fall</option>
                                        <option value='EVEN'>Even</option>
                                        <option value='ODD'>Odd</option>
                                        <option value='OVER'>Over</option>
                                        <option value='UNDER'>Under</option>
                                        <option value='MATCHES'>Matches</option>
                                        <option value='DIFFERS'>Differs</option>
                                    </select>
                                    {BARRIER_CONTRACT_TYPES.includes(recoveryContractType) && (
                                        <input
                                            className='checkbox-entry'
                                            type='number'
                                            min={0}
                                            max={9}
                                            value={recoveryPredictionDigit}
                                            onChange={e => setRecoveryPredictionDigit(e.target.value)}
                                        />
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className='pro-action-btns'>
                    <button onClick={handleToggleBot} className={isRunning ? 'pro-btn-stop' : 'pro-btn-run'}>
                        {isRunning ? (
                            <>
                                <FaStop /> {useBulk ? ' STOP BULK' : ' STOP BOT'}
                            </>
                        ) : (
                            <>
                                <FaPlay /> {useBulk ? ' RUN BULK' : ' RUN BOT'}
                            </>
                        )}
                    </button>
                   
                </div>

                <Marketview
                    isRunning={isRunning}
                    useBulk={useBulk}
                    handleToggleBot={handleToggleBot}
                    sharedSymbol={symbol}
                    setSharedSymbol={setSymbol}
                />

                {proposalError && (
                    <div className='bot-errors'>
                        <strong>Error:</strong> {proposalError}
                    </div>
                )}
            </div>
        </div>
    );
};

export default SmartTrader;
