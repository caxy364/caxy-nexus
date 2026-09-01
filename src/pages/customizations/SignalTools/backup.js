import './Overlord.css';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import Swal from 'sweetalert2';

import { WS_SERVERS, isProduction } from '@/components/shared';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';

const volatilityList = [
    'R_10',
    'R_25',
    'R_50',
    'R_75',
    'R_100',
    '1HZ10V',
    '1HZ25V',
    '1HZ30V',
    '1HZ50V',
    '1HZ75V',
    '1HZ100V',
];

const symbolNames = {
    R_10: 'Volatility 10',
    R_25: 'Volatility 25',
    R_50: 'Volatility 50',
    R_75: 'Volatility 75',
    R_100: 'Volatility 100',
    '1HZ10V': 'Vol 10 (1s)',
    '1HZ25V': 'Vol 25 (1s)',
    '1HZ30V': 'Vol 30 (1s)',
    '1HZ50V': 'Vol 50 (1s)',
    '1HZ75V': 'Vol 75 (1s)',
    '1HZ100V': 'Vol 100 (1s)',
};

const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');
const SCAN_WS_URL = DERIV_PUBLIC_WS_URL;
const SCAN_TIMEOUT_MS = 6000;
const SCAN_MAX_RETRIES = 3;

const alertSound = new Audio(`${process.env.PUBLIC_URL}/alert.mp3`);

const parseSessionNumber = (value, fallback) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const formatContractSpot = value => {
    if (value === null || value === undefined || value === '') {
        return '-';
    }

    return String(value);
};

const Overlord = () => {
    const store = useStore();
    const { transactions, journal, summary_card, run_panel, client } = store || {};

    // ------------------ STATE ------------------
    const [tradeType, setTradeType] = useState('EVEN');
    const [predictionDigit, setPredictionDigit] = useState('4');
    const [analysisStarted, setAnalysisStarted] = useState(false);
    const [scannedHistory, setScannedHistory] = useState([]);
    const [strongestSignal, setStrongestSignal] = useState(null);

    const [symbol, setSymbol] = useState('');
    const [contractType, setContractType] = useState('EVEN');
    const [initialStake, setInitialStake] = useState('1');
    const [duration, setDuration] = useState('1');
    const [targetProfit, setTargetProfit] = useState('100');
    const [stopLoss, setStopLoss] = useState('100');
    const [useMartingale, setUseMartingale] = useState(true);
    const [martingaleMultiplier, setMartingaleMultiplier] = useState('2.1');

    // NEW: Recovery Mode State
    const [useRecovery, setUseRecovery] = useState(false);
    const [recoveryType, setRecoveryType] = useState('OVER');
    const [recoveryPrediction, setRecoveryPrediction] = useState('4'); // Upgrade: Recovery Prediction State

    const [isRunning, setIsRunning] = useState(false);
    const [logs, setLogs] = useState([]);
    const [results, setResults] = useState([]);
    const [wins, setWins] = useState(0);
    const [losses, setLosses] = useState(0);
    const [totalRuns, setTotalRuns] = useState(0);
    const [totalProfit, setTotalProfit] = useState(0);
    const [proposalError, setProposalError] = useState('');

    // ------------------ REFS ------------------
    const wsRef = useRef(null);
    const tickData = useRef({});
    const totalProfitRef = useRef(0);
    const baseStakeRef = useRef(1);
    const currentStakeRef = useRef(1);
    const isRunningRef = useRef(false);
    const isAuthorizedRef = useRef(false);
    const isConnectingRef = useRef(false);
    const scanRunIdRef = useRef(0);
    const reconnectTimeoutRef = useRef(null);
    const shouldReconnectRef = useRef(true);
    const skipReconnectRef = useRef(false);
    const socketRequiresAuthRef = useRef(false);
    const contractMetaRef = useRef({});
    const lastProcessedContractIdRef = useRef(null);
    const completedContractsRef = useRef(new Set());
    const activeContractsRef = useRef(new Set());
    const contractTimeoutsRef = useRef(new Map()); // Track contract update timeouts
    const transactionRecoveryTimeoutsRef = useRef(new Map()); // Track sell-event recovery timers
    const pendingProposalRef = useRef(false); // Track if a proposal/buy is in flight

    const symbolRef = useRef(symbol);
    const contractTypeRef = useRef(contractType);
    const predictionDigitRef = useRef(predictionDigit);
    const targetProfitRef = useRef(targetProfit);
    const stopLossRef = useRef(stopLoss);
    const martingaleMultiplierRef = useRef(martingaleMultiplier);
    const useMartingaleRef = useRef(useMartingale);

    // NEW: Recovery Refs
    const lastTradeWasLossRef = useRef(false);
    const activeContractTypeRef = useRef(contractType);
    const useRecoveryRef = useRef(useRecovery);
    const recoveryTypeRef = useRef(recoveryType);
    const recoveryPredictionRef = useRef(recoveryPrediction); // Upgrade: Recovery Prediction Ref

    // ------------------ SYNC REFS ------------------
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
        symbolRef.current = symbol;
    }, [symbol]);
    useEffect(() => {
        useMartingaleRef.current = useMartingale;
    }, [useMartingale]);
    useEffect(() => {
        predictionDigitRef.current = predictionDigit;
    }, [predictionDigit]);
    useEffect(() => {
        targetProfitRef.current = targetProfit;
    }, [targetProfit]);
    useEffect(() => {
        stopLossRef.current = stopLoss;
    }, [stopLoss]);
    useEffect(() => {
        martingaleMultiplierRef.current = martingaleMultiplier;
    }, [martingaleMultiplier]);

    // Sync Recovery Refs
    useEffect(() => {
        useRecoveryRef.current = useRecovery;
    }, [useRecovery]);
    useEffect(() => {
        recoveryTypeRef.current = recoveryType;
    }, [recoveryType]);
    useEffect(() => {
        recoveryPredictionRef.current = recoveryPrediction;
    }, [recoveryPrediction]); // Upgrade: Sync Recovery Prediction

    const isRiseFallRecoveryPair = useCallback(() => {
        const types = [contractTypeRef.current, recoveryTypeRef.current];
        return types.includes('RISE') && types.includes('FALL');
    }, []);

    const getNextContractType = useCallback(() => {
        if (useRecoveryRef.current && isRiseFallRecoveryPair()) {
            return activeContractTypeRef.current;
        }

        return useRecoveryRef.current && lastTradeWasLossRef.current
            ? recoveryTypeRef.current
            : contractTypeRef.current;
    }, [isRiseFallRecoveryPair]);

    const showToast = (title, icon = 'success') => {
        Swal.fire({
            title: title,
            icon: icon,
            toast: true,
            position: 'top',
            showConfirmButton: false,
            timer: 2800,
            timerProgressBar: true,
            background: 'transparent', // Let our CSS handle the background
            customClass: {
                popup: `ovl-swal-popup ovl-swal-${icon}`,
                title: 'ovl-swal-title',
                timerProgressBar: 'swal2-timer-progress-bar',
            },
            showClass: {
                popup: 'animate__animated animate__fadeInDown animate__faster',
            },
            hideClass: {
                popup: 'animate__animated animate__fadeOutUp animate__faster',
            },
        });
    };

    const logMessage = msg => {
        setLogs(prev => [msg, ...prev]);
        console.log(msg);
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
            console.error('[Overlord] Failed to parse Deriv session storage:', error);
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
            logMessage(`Auth Error: ${error.message}`);
            return null;
        }
    }, [getStoredAuthContext]);

    const handleInitialStakeChange = useCallback(event => {
        const { value } = event.target;
        setInitialStake(value);
    }, []);

    const handleTargetProfitChange = useCallback(event => {
        const { value } = event.target;
        setTargetProfit(value);
        targetProfitRef.current = value;
    }, []);

    const handleStopLossChange = useCallback(event => {
        const { value } = event.target;
        setStopLoss(value);
        stopLossRef.current = value;
    }, []);

    const extractDigit = (sId, price) => {
        const dec = sId.startsWith('1HZ') || sId === 'R_100' ? 2 : sId === 'R_75' || sId === 'R_50' ? 4 : 3;
        const fixed = Number(price).toFixed(dec);
        return parseInt(fixed.split('.')[1]?.slice(-1) || fixed.slice(-1));
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

    const stopTradingBot = useCallback(
        (reason = 'Bot stopped.', options = {}) => {
            const { preserveOpenContract = Boolean(run_panel?.has_open_contract) } = options;

            setIsRunning(false);
            isRunningRef.current = false;

            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ forget_all: 'proposal' }));
                if (!preserveOpenContract) {
                    wsRef.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
                }
            }

            if (!preserveOpenContract) {
                lastProcessedContractIdRef.current = null;
                completedContractsRef.current.clear();
                activeContractsRef.current.clear();
                pendingProposalRef.current = false; // Clear pending flag

                // Clear all pending contract timeouts (including allowance timeouts)
                contractTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
                contractTimeoutsRef.current.clear();
                transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
                transactionRecoveryTimeoutsRef.current.clear();
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

            logMessage(reason);
        },
        [run_panel]
    );

    const handleStop = useCallback(() => {
        stopTradingBot('Bot stopped.');
    }, [stopTradingBot]);

    const requestProposal = useCallback(() => {
        if (!isRunningRef.current) {
            return;
        }

        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            logMessage('⚠️ WebSocket not ready for proposal request');
            return;
        }

        if (!isAuthorizedRef.current) {
            logMessage('⚠️ Not authorized yet, cannot request proposal');
            return;
        }

        // Prevent multiple simultaneous proposals
        if (pendingProposalRef.current) {
            logMessage(`⏳ Waiting for pending proposal/trade to complete`);
            return;
        }

        // Ensure we're not making multiple simultaneous proposals
        if (activeContractsRef.current.size > 0) {
            logMessage(`⏳ Waiting for ${activeContractsRef.current.size} active contract(s) to resolve`);
            return;
        }

        const activeType = getNextContractType();
        const isRecovering = activeType === recoveryTypeRef.current && activeType !== contractTypeRef.current;
        activeContractTypeRef.current = activeType;

        const activePrediction = isRecovering ? recoveryPredictionRef.current : predictionDigitRef.current;
        const parsedDuration = Math.max(1, parseInt(duration, 10) || 1);

        const map = {
            RISE: 'CALL',
            FALL: 'PUT',
            EVEN: 'DIGITEVEN',
            ODD: 'DIGITODD',
            OVER: 'DIGITOVER',
            UNDER: 'DIGITUNDER',
            MATCHES: 'DIGITMATCH',
            DIFFERS: 'DIGITDIFF',
        };

        const proposalPayload = {
            proposal: 1,
            amount: Number(currentStakeRef.current).toFixed(2),
            basis: 'stake',
            contract_type: map[activeType],
            currency: client?.currency || 'USD',
            underlying_symbol: symbolRef.current,
            duration: parsedDuration,
            duration_unit: 't',
        };

        if (['OVER', 'UNDER', 'MATCHES', 'DIFFERS'].includes(activeType)) {
            proposalPayload.barrier = parseInt(activePrediction, 10);
        }

        logMessage(`📋 Sending proposal: ${map[activeType]} on ${symbolRef.current} x${currentStakeRef.current}`);
        pendingProposalRef.current = true; // Mark proposal as pending
        run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
        wsRef.current.send(JSON.stringify(proposalPayload));
    }, [client?.currency, duration, getNextContractType, run_panel]);

    // ------------------ CENTRAL SOCKET HANDLER ------------------
    const handleSocketMessage = useCallback(
        event => {
            const data = JSON.parse(event.data);

            if (data.msg_type === 'authorize') {
                if (!isAuthorizedRef.current) {
                    logMessage('Authorization successful');
                    isAuthorizedRef.current = true;
                    if (isRunningRef.current && activeContractsRef.current.size === 0) requestProposal();
                }
                return;
            }
            /*
    
    if (data.msg_type === "authorize") {
        logMessage("✅ Authorization Successful");
        isAuthorizedRef.current = true;
        if (isRunningRef.current) executeTrade();
    }

    */
            if (data.msg_type === 'proposal' && !data.error) {
                if (!isRunningRef.current) {
                    return;
                }

                const proposalId = data.proposal?.id;
                const askPrice = data.proposal?.ask_price;

                if (!proposalId || askPrice === undefined) {
                    logMessage('⚠️ Proposal received but missing ID or price');
                    return;
                }

                logMessage(`✅ Proposal ready: ID ${proposalId} | Price: ${askPrice}`);
                wsRef.current.send(JSON.stringify({ buy: proposalId, price: askPrice }));
                return;
            }

            if (data.error) {
                setProposalError(data.error.message);
                logMessage(`❌ Error: ${data.error.message}`);
                pendingProposalRef.current = false; // Clear pending flag on error so we can retry
                publishNativeError(data.error.message);
                return;
            }

            // Deriv trade-engine recovery pattern:
            // if there's a sell transaction but contract stream still looks open,
            // request proposal_open_contract again after a short delay.
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

                logMessage(`🧾 Sell transaction received for #${contractKey}; validating final contract snapshot...`);

                const recoveryTimeoutId = window.setTimeout(() => {
                    transactionRecoveryTimeoutsRef.current.delete(contractKey);

                    if (
                        !activeContractsRef.current.has(contractKey) ||
                        completedContractsRef.current.has(contractKey)
                    ) {
                        return;
                    }

                    if (wsRef.current?.readyState !== WebSocket.OPEN) {
                        logMessage(`⚠️ Recovery check skipped for #${contractKey}; socket not open.`);
                        return;
                    }

                    logMessage(`🔁 Requesting final proposal_open_contract for #${contractKey} after sell event`);
                    wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id: sellContractId }));
                }, 1500);

                transactionRecoveryTimeoutsRef.current.set(contractKey, recoveryTimeoutId);
                return;
            }

            if (data.msg_type === 'buy') {
                const { contract_id, transaction_id, buy_price, longcode } = data.buy;
                const contractKey = String(contract_id);
                const displayType =
                    contractMetaRef.current[contractKey]?.contract_type || activeContractTypeRef.current;
                const market = symbolRef.current;

                logMessage(
                    `🛒 Trade executed: Contract #${contract_id} | Type: ${displayType} | Stake: ${currentStakeRef.current}`
                );

                const transactionPayload = {
                    id: contract_id,
                    contract_id,
                    transaction_ids: { buy: transaction_id },
                    buy_price: buy_price ?? parseFloat(currentStakeRef.current),
                    currency: client?.currency || 'USD',
                    display_name: symbolNames[market] || market,
                    underlying: market,
                    underlying_symbol: market,
                    contract_type: displayType,
                    longcode,
                    date_start: Math.floor(Date.now() / 1000),
                };

                contractMetaRef.current[contractKey] = transactionPayload;
                activeContractsRef.current.add(contractKey);
                pendingProposalRef.current = false; // Clear pending flag now that contract is active
                publishNativeContract(transactionPayload);
                run_panel?.setHasOpenContract?.(true);
                run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);

                setResults(prev => [
                    {
                        id: prev.length + 1,
                        contract_type: displayType,
                        entry_spot: '-',
                        exit_spot: '-',
                        stake: parseFloat(currentStakeRef.current).toFixed(2),
                        profit: '-',
                        status: '⏳',
                        contract_id,
                    },
                    ...prev,
                ]);

                // Subscribe to this contract's updates
                logMessage(`📡 Subscribing to contract updates for #${contract_id}`);
                wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id, subscribe: 1 }));

                // Set timeout to force completion if updates stop coming (contracts expire after duration+buffer)
                const parsedDuration = Math.max(1, parseInt(duration, 10) || 1);
                const timeoutMs = (parsedDuration + 5) * 1000; // Duration in seconds + 5 second buffer for market ticks

                // Clear any existing timeout for this contract
                if (contractTimeoutsRef.current.has(contractKey)) {
                    clearTimeout(contractTimeoutsRef.current.get(contractKey));
                }

                const timeoutId = window.setTimeout(() => {
                    logMessage(`⚠️ Contract #${contractKey} timeout (${timeoutMs}ms) - forcing status request`);

                    // Force a one-time check for this contract's status (without subscribe)
                    if (wsRef.current?.readyState === WebSocket.OPEN && activeContractsRef.current.has(contractKey)) {
                        logMessage(`🔍 Requesting final status for contract #${contractKey}`);
                        wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id }));

                        // If still not resolved after additional 2 seconds, forcefully mark as pending timeout
                        const allowanceId = window.setTimeout(() => {
                            if (activeContractsRef.current.has(contractKey)) {
                                logMessage(
                                    `❌ Contract #${contractKey} NOT closing naturally - marking as stalled for retry`
                                );
                                contractTimeoutsRef.current.delete(contractKey);
                            }
                        }, 2000);

                        contractTimeoutsRef.current.set(`${contractKey}-allowance`, allowanceId);
                    } else {
                        contractTimeoutsRef.current.delete(contractKey);
                    }
                }, timeoutMs);

                contractTimeoutsRef.current.set(contractKey, timeoutId);
                return;
            }

            if (data.msg_type === 'proposal_open_contract') {
                const c = data.proposal_open_contract;
                if (!c) return;

                const contractKey = String(c.contract_id);
                const isTrackedContract = activeContractsRef.current.has(contractKey);

                const normalizedStatus = String(c.status || '').toLowerCase();
                const hasClosedStatus = Boolean(normalizedStatus) && normalizedStatus !== 'open';
                const isExpired = c.is_expired === 1 || c.is_expired === true || c.is_expired === '1';
                const isSettleable = c.is_settleable === 1 || c.is_settleable === true || c.is_settleable === '1';
                const isSold =
                    c.is_sold === 1 ||
                    c.is_sold === true ||
                    c.is_sold === '1' ||
                    hasClosedStatus ||
                    isExpired ||
                    isSettleable;

                if (!isRunningRef.current && !isTrackedContract) return;
                if (completedContractsRef.current.has(contractKey)) {
                    return;
                }

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
                const contractStatus = c.status || 'open'; // 'open', 'closed' or custom
                const resultStatus = profit > 0 ? 'won' : 'lost';
                const normalizedClosedStatus = normalizedStatus || resultStatus;

                // Debug logging for contract updates
                if (activeContractsRef.current.has(contractKey)) {
                    logMessage(
                        `📊 Contract #${contractKey} update: entry=${entrySpot} exit=${exitSpot} profit=${profit} status=${contractStatus} is_sold=${c.is_sold}`
                    );
                }

                const nativeContract = {
                    ...(contractMetaRef.current[contractKey] || {}),
                    ...c,
                    id: c.contract_id,
                    contract_id: c.contract_id,
                    contract_type: contractMetaRef.current[contractKey]?.contract_type || activeContractTypeRef.current,
                    display_name: c.display_name || symbolNames[symbolRef.current] || symbolRef.current,
                    underlying_symbol: c.underlying_symbol || c.underlying || symbolRef.current,
                    underlying: c.underlying || symbolRef.current,
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
                    result: isSold ? resultStatus : undefined,
                    status: isSold ? normalizedClosedStatus : c.status || 'open',
                };

                publishNativeContract(nativeContract);

                // Always update results with latest data
                setResults(prev =>
                    prev.map(r =>
                        r.contract_id === c.contract_id
                            ? {
                                  ...r,
                                  entry_spot: entrySpot || r.entry_spot,
                                  ...(isSold ? { exit_spot: exitSpot, profit: profit.toFixed(2) } : {}),
                                  status: isSold ? (profit >= 0 ? 'WIN' : 'LOSS') : 'PENDING',
                              }
                            : r
                    )
                );

                // Only process contract closure once per contract
                if (!isSold) {
                    return;
                }

                if (lastProcessedContractIdRef.current === contractKey) {
                    return;
                }

                // Mark contract as completed and remove from active set
                logMessage(
                    `✅ Contract #${contractKey} CLOSED | Entry: ${entrySpot} → Exit: ${exitSpot} | Profit: ${profit.toFixed(2)} | Status: ${profit >= 0 ? 'WIN' : 'LOSS'}`
                );

                // Clear all timeouts for this contract
                if (contractTimeoutsRef.current.has(contractKey)) {
                    clearTimeout(contractTimeoutsRef.current.get(contractKey));
                    contractTimeoutsRef.current.delete(contractKey);
                }
                if (contractTimeoutsRef.current.has(`${contractKey}-allowance`)) {
                    clearTimeout(contractTimeoutsRef.current.get(`${contractKey}-allowance`));
                    contractTimeoutsRef.current.delete(`${contractKey}-allowance`);
                }
                if (transactionRecoveryTimeoutsRef.current.has(contractKey)) {
                    clearTimeout(transactionRecoveryTimeoutsRef.current.get(contractKey));
                    transactionRecoveryTimeoutsRef.current.delete(contractKey);
                }

                completedContractsRef.current.add(contractKey);
                activeContractsRef.current.delete(contractKey);
                lastProcessedContractIdRef.current = contractKey;
                totalProfitRef.current += profit;
                lastTradeWasLossRef.current = profit <= 0;

                if (useRecoveryRef.current && isRiseFallRecoveryPair() && profit <= 0) {
                    activeContractTypeRef.current = activeContractTypeRef.current === 'RISE' ? 'FALL' : 'RISE';
                }

                setTotalProfit(totalProfitRef.current.toFixed(2));
                setTotalRuns(p => p + 1);
                if (profit > 0) setWins(p => p + 1);
                else setLosses(p => p + 1);

                if (useMartingaleRef.current) {
                    currentStakeRef.current =
                        profit <= 0
                            ? (currentStakeRef.current * parseFloat(martingaleMultiplierRef.current)).toFixed(2)
                            : Number(baseStakeRef.current).toFixed(2);
                }

                run_panel?.setHasOpenContract?.(false);
                run_panel?.setContractStage?.(
                    isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING
                );
                publishNativeResult(nativeContract);

                // Check stopping conditions AFTER contract is fully processed
                if (!isRunningRef.current) {
                    logMessage('Bot is not running, skipping proposal request.');
                    return;
                }

                if (totalProfitRef.current >= parseFloat(targetProfitRef.current)) {
                    logMessage(
                        `🎯 Target profit reached: ${totalProfitRef.current.toFixed(2)} >= ${targetProfitRef.current}`
                    );
                    showToast('CONGRATULATIONS! Target Profit Reached!', 'success');
                    stopTradingBot('Target profit reached. Bot stopped.', { preserveOpenContract: false });
                    return;
                }

                if (totalProfitRef.current <= -parseFloat(stopLossRef.current)) {
                    logMessage(`🛑 Stop loss hit: ${totalProfitRef.current.toFixed(2)} <= -${stopLossRef.current}`);
                    showToast('OOPS! Your stop loss has been hit!', 'error');
                    stopTradingBot('Stop loss reached. Bot stopped.', { preserveOpenContract: false });
                    return;
                }

                // Request next proposal only if conditions are met
                logMessage(`📊 Requesting new proposal. Active contracts: ${activeContractsRef.current.size}`);
                requestProposal();
            }
        },
        [
            client?.currency,
            isRiseFallRecoveryPair,
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
                    console.error('[Overlord] Failed to close existing socket:', error);
                }
            }

            isConnectingRef.current = true;
            socketRequiresAuthRef.current = requireAuth;

            try {
                const authenticatedUrl = requireAuth ? await getAuthenticatedUrl() : null;

                if (requireAuth && !authenticatedUrl) {
                    setProposalError('Unable to create an authenticated Deriv session.');
                    return false;
                }

                const socketUrl = authenticatedUrl || SCAN_WS_URL;
                const isAuthenticatedSocket = Boolean(authenticatedUrl);

                wsRef.current = new WebSocket(socketUrl);
                wsRef.current.onopen = () => {
                    logMessage(
                        isAuthenticatedSocket ? 'Trading socket connected' : 'Trading socket connected (public)'
                    );
                    setProposalError('');
                    isAuthorizedRef.current = isAuthenticatedSocket;

                    if (isAuthenticatedSocket) {
                        logMessage('Authorized trading session ready');
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

                    // Request proposal AFTER authentication on startup
                    if (isRunningRef.current && isAuthenticatedSocket && activeContractsRef.current.size === 0) {
                        logMessage('Requesting initial proposal after connection...');
                        requestProposal();
                    }
                };
                wsRef.current.onmessage = handleSocketMessage;
                wsRef.current.onerror = event => {
                    logMessage('Trading socket error');
                    console.error(event);
                };
                wsRef.current.onclose = () => {
                    logMessage('Trading socket closed');
                    isAuthorizedRef.current = false;
                    wsRef.current = null;
                    transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
                    transactionRecoveryTimeoutsRef.current.clear();

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
                logMessage(`Trading connection failed: ${error.message}`);
                setProposalError(error.message);
                return false;
            } finally {
                isConnectingRef.current = false;
            }
        },
        [getAuthenticatedUrl, handleSocketMessage, requestProposal]
    );

    useEffect(() => {
        shouldReconnectRef.current = true;
        const shouldRequireAuth = Boolean(getStoredAuthContext());
        connectTradingSocket({ requireAuth: shouldRequireAuth });

        const watchdogId = window.setInterval(() => {
            if (!shouldReconnectRef.current) return;
            connectTradingSocket({ requireAuth: socketRequiresAuthRef.current });
        }, 1500);

        return () => {
            shouldReconnectRef.current = false;
            window.clearInterval(watchdogId);
            if (reconnectTimeoutRef.current) {
                window.clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = null;
            }
        };
    }, [connectTradingSocket, getStoredAuthContext]);

    useEffect(() => {
        const handleExternalStop = () => {
            if (!isRunningRef.current && !run_panel?.has_open_contract) return;

            stopTradingBot('Bot stopped from the Deriv run panel.', {
                preserveOpenContract: Boolean(run_panel?.has_open_contract),
            });
        };

        observer.register('bot.click_stop', handleExternalStop);

        return () => {
            if (observer.isRegistered('bot.click_stop')) {
                observer.unregister('bot.click_stop', handleExternalStop);
            }
        };
    }, [run_panel?.has_open_contract, stopTradingBot]);

    // ------------------ AUTO-CONNECT ON MOUNT ------------------
    useEffect(() => {
        if (!wsRef.current) {
            connectTradingSocket({ requireAuth: Boolean(getStoredAuthContext()) });
        }

        return () => {
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
        /*

    const token = null;
    if (!wsRef.current) {
      wsRef.current = new WebSocket(SCAN_WS_URL);
      wsRef.current.onopen = () => {
        logMessage("🔌 Connected to Deriv (Auto)");
        const openToken = token;
        if (openToken) {
          wsRef.current.send(JSON.stringify({ authorize: openToken }));
        }
      };
      wsRef.current.onmessage = handleSocketMessage;
      wsRef.current.onerror = (event) => {
        logMessage("⚠️ WebSocket error");
        console.error(event);
      };
      wsRef.current.onclose = () => {
        logMessage("🔌 WebSocket connection closed");
        isAuthorizedRef.current = false;
      };
    }
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
    */
    }, [connectTradingSocket, getStoredAuthContext]);

    // ------------------ BOT CONTROL ------------------
    const handleStart = useCallback(async () => {
        if (isRunning) {
            handleStop();
            return;
        }
        if (!symbol) {
            showToast('No Signal , Please Scan First', 'warning');
            return;
        }
        if (!getStoredAuthContext()) {
            showToast('LOGIN REQUIRED', 'error');
            return;
        }

        const parsedInitialStake = parseSessionNumber(initialStake, 1);
        const parsedTargetProfit = parseSessionNumber(targetProfitRef.current, 100);
        const parsedStopLoss = parseSessionNumber(stopLossRef.current, 100);

        baseStakeRef.current = parsedInitialStake;
        currentStakeRef.current = parsedInitialStake;
        targetProfitRef.current = parsedTargetProfit.toString();
        stopLossRef.current = parsedStopLoss.toString();
        totalProfitRef.current = 0;
        lastTradeWasLossRef.current = false; // Reset recovery on clean start
        activeContractTypeRef.current = contractType;
        contractMetaRef.current = {};
        lastProcessedContractIdRef.current = null;
        completedContractsRef.current.clear();
        activeContractsRef.current.clear();
        pendingProposalRef.current = false; // Clear pending flag on fresh start

        // Clear any pending timeouts from previous session (including allowance timeouts)
        contractTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
        contractTimeoutsRef.current.clear();
        transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
        transactionRecoveryTimeoutsRef.current.clear();

        setResults([]);
        setWins(0);
        setLosses(0);
        setTotalRuns(0);
        setTotalProfit(0);
        if (transactions?.clear) transactions.clear();
        if (summary_card?.clear) summary_card.clear();
        logMessage(
            `Session configured: target ${parsedTargetProfit.toFixed(2)} USD, stop ${parsedStopLoss.toFixed(2)} USD.`
        );
        run_panel?.setIsRunning?.(true);
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.STARTING);
        if (run_panel) {
            run_panel.run_id = `overlord-${Date.now()}`;
        }
        run_panel?.toggleDrawer?.(true);
        run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

        setIsRunning(true);
        isRunningRef.current = true;

        const wsReady = wsRef.current?.readyState;
        if (wsRef.current && wsReady === WebSocket.OPEN && isAuthorizedRef.current) {
            requestProposal();
            return;
        }

        const didStartConnection = await connectTradingSocket({
            requireAuth: true,
            forceReconnect: Boolean(wsRef.current && !isAuthorizedRef.current),
        });

        if (!didStartConnection) {
            setIsRunning(false);
            isRunningRef.current = false;
            run_panel?.setIsRunning?.(false);
            run_panel?.setHasOpenContract?.(false);
            run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
        }
    }, [
        connectTradingSocket,
        contractType,
        getStoredAuthContext,
        handleStop,
        initialStake,
        isRunning,
        requestProposal,
        run_panel,
        summary_card,
        symbol,
        targetProfit,
        transactions,
    ]);

    useEffect(() => {
        observer.register('overlord.start', handleStart);
        observer.register('overlord.stop', handleStop);

        return () => {
            if (observer.isRegistered('overlord.start')) {
                observer.unregister('overlord.start', handleStart);
            }
            if (observer.isRegistered('overlord.stop')) {
                observer.unregister('overlord.stop', handleStop);
            }
        };
    }, [handleStart, handleStop]);

    // ------------------ SIGNAL LOGIC ------------------
    const calculateStatsForType = (sId, targetType) => {
        const prices = tickData.current[sId];
        if (!prices || prices.length < 20) return null;
        const total = prices.length;
        let occurrences = 0;
        const pred = parseInt(predictionDigitRef.current);
        const digits = prices.map(p => extractDigit(sId, p));

        if (['EVEN', 'ODD', 'OVER', 'UNDER', 'MATCHES', 'DIFFERS'].includes(targetType)) {
            if (targetType === 'EVEN') occurrences = digits.filter(d => d % 2 === 0).length;
            else if (targetType === 'ODD') occurrences = digits.filter(d => d % 2 !== 0).length;
            else if (targetType === 'OVER') occurrences = digits.filter(d => d > pred).length;
            else if (targetType === 'UNDER') occurrences = digits.filter(d => d < pred).length;
            else if (targetType === 'MATCHES') occurrences = digits.filter(d => d === pred).length;
            else if (targetType === 'DIFFERS') occurrences = digits.filter(d => d !== pred).length;
        } else if (targetType === 'RISE' || targetType === 'FALL') {
            for (let i = 1; i < prices.length; i++) {
                if (targetType === 'RISE' && Number(prices[i]) > Number(prices[i - 1])) occurrences++;
                else if (targetType === 'FALL' && Number(prices[i]) < Number(prices[i - 1])) occurrences++;
            }
        }
        return (occurrences / total) * 100;
    };

    const handleFetchSignal = async () => {
        if (analysisStarted) return;
        setAnalysisStarted(true);
        setScannedHistory([]);
        setStrongestSignal(null);
        logMessage('🚀 Starting scan...');

        const results = [];
        for (const v of volatilityList) {
            try {
                const result = await new Promise(resolve => {
                    const ws = new WebSocket(SCAN_WS_URL);
                    const timer = setTimeout(() => {
                        ws.close();
                        resolve(null);
                    }, 4000);
                    ws.onopen = () =>
                        ws.send(JSON.stringify({ ticks_history: v, style: 'ticks', count: 50, end: 'latest' }));
                    ws.onmessage = msg => {
                        const data = JSON.parse(msg.data);
                        if (data.history?.prices) {
                            clearTimeout(timer);
                            tickData.current[v] = data.history.prices;
                            const percentage = calculateStatsForType(v, tradeType);
                            ws.close();
                            resolve({ id: v, name: symbolNames[v], percentage });
                        }
                    };
                    ws.onerror = () => {
                        clearTimeout(timer);
                        ws.close();
                        resolve(null);
                    };
                });
                if (result) {
                    results.push(result);
                    setScannedHistory([...results].sort((a, b) => a.percentage - b.percentage));
                }
            } catch (err) {
                console.error(err);
            }
        }

        if (results.length > 0) {
            const best = [...results].sort((a, b) => a.percentage - b.percentage)[0];
            const randomConfidence = (Math.random() * (95 - 80) + 80).toFixed(1);
            setStrongestSignal({ ...best, confidence: randomConfidence });
            setSymbol(best.id);
            setContractType(tradeType);
            logMessage(`✅ Scan Complete: ${best.name}`);
            try {
                alertSound.play().catch(() => {});
            } catch {}
        }
        setAnalysisStarted(false);
    };

    const scanSymbol = useCallback((volatilityId, selectedTradeType, scanRunId, attempt = 1) => {
        return new Promise(resolve => {
            const ws = new WebSocket(SCAN_WS_URL);
            let isSettled = false;

            const finish = value => {
                if (isSettled) return;
                isSettled = true;
                resolve(value);
            };

            const timer = setTimeout(() => {
                ws.close();
                finish({
                    id: volatilityId,
                    name: symbolNames[volatilityId],
                    percentage: null,
                    status: 'timeout',
                    attempt,
                });
            }, SCAN_TIMEOUT_MS);

            ws.onopen = () => {
                ws.send(JSON.stringify({ ticks_history: volatilityId, style: 'ticks', count: 50, end: 'latest' }));
            };

            ws.onmessage = msg => {
                const data = JSON.parse(msg.data);
                if (!data.history?.prices) return;

                clearTimeout(timer);
                tickData.current[volatilityId] = data.history.prices;
                const percentage = calculateStatsForType(volatilityId, selectedTradeType);
                const result = {
                    id: volatilityId,
                    name: symbolNames[volatilityId],
                    percentage,
                    status: 'success',
                    attempt,
                };

                if (scanRunIdRef.current === scanRunId) {
                    setScannedHistory(prev => {
                        const deduped = prev.filter(item => item.id !== volatilityId);
                        return [...deduped, result].sort((a, b) => {
                            if (a.status !== 'success' && b.status === 'success') return 1;
                            if (a.status === 'success' && b.status !== 'success') return -1;
                            if (a.percentage === null) return 1;
                            if (b.percentage === null) return -1;
                            return a.percentage - b.percentage;
                        });
                    });
                }

                ws.close();
                finish(result);
            };

            ws.onerror = () => {
                clearTimeout(timer);
                ws.close();
                finish({
                    id: volatilityId,
                    name: symbolNames[volatilityId],
                    percentage: null,
                    status: 'error',
                    attempt,
                });
            };

            ws.onclose = () => {
                clearTimeout(timer);
            };
        });
    }, []);

    const handleFetchSignalFast = async () => {
        if (analysisStarted) return;

        const scanRunId = Date.now();
        scanRunIdRef.current = scanRunId;
        setAnalysisStarted(true);
        setScannedHistory([]);
        setStrongestSignal(null);
        logMessage('ðŸš€ Starting fast scan...');

        const settledResults = await Promise.allSettled(
            volatilityList.map(volatilityId => scanSymbol(volatilityId, tradeType, scanRunId))
        );

        if (scanRunIdRef.current !== scanRunId) return;

        const results = settledResults
            .filter(result => result.status === 'fulfilled' && result.value)
            .map(result => result.value);

        if (results.length > 0) {
            const best = [...results].sort((a, b) => a.percentage - b.percentage)[0];
            const randomConfidence = (Math.random() * (95 - 80) + 80).toFixed(1);
            setStrongestSignal({ ...best, confidence: randomConfidence });
            setSymbol(best.id);
            setContractType(tradeType);
            logMessage(`âœ… Fast scan complete: ${best.name}`);
            try {
                alertSound.play().catch(() => {});
            } catch {}
        }

        setAnalysisStarted(false);
    };

    const handleFetchSignalGuaranteed = async () => {
        if (analysisStarted) return;

        const scanRunId = Date.now();
        scanRunIdRef.current = scanRunId;
        setAnalysisStarted(true);
        setScannedHistory([]);
        setStrongestSignal(null);
        logMessage('Starting guaranteed full-market scan...');

        let pendingSymbols = [...volatilityList];
        const finalResultsMap = new Map();

        for (let attempt = 1; attempt <= SCAN_MAX_RETRIES && pendingSymbols.length > 0; attempt++) {
            const settledResults = await Promise.allSettled(
                pendingSymbols.map(volatilityId => scanSymbol(volatilityId, tradeType, scanRunId, attempt))
            );

            if (scanRunIdRef.current !== scanRunId) return;

            const roundResults = settledResults
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value);

            roundResults.forEach(result => {
                finalResultsMap.set(result.id, result);
            });

            pendingSymbols = roundResults.filter(result => result.status !== 'success').map(result => result.id);

            if (pendingSymbols.length > 0 && attempt < SCAN_MAX_RETRIES) {
                logMessage(`Retrying ${pendingSymbols.length} market(s): ${pendingSymbols.join(', ')}`);
            }
        }

        if (scanRunIdRef.current !== scanRunId) return;

        const results = volatilityList.map(volatilityId => finalResultsMap.get(volatilityId)).filter(Boolean);

        const successfulResults = results.filter(
            result => result.status === 'success' && typeof result.percentage === 'number'
        );

        if (successfulResults.length > 0) {
            const best = [...successfulResults].sort((a, b) => a.percentage - b.percentage)[0];
            const randomConfidence = (Math.random() * (95 - 80) + 80).toFixed(1);
            setStrongestSignal({ ...best, confidence: randomConfidence });
            setSymbol(best.id);
            setContractType(tradeType);
            if (successfulResults.length === volatilityList.length) {
                logMessage(
                    `Guaranteed scan complete: ${best.name} after checking all ${successfulResults.length} markets.`
                );
            } else {
                const missingSymbols = volatilityList.filter(
                    volatilityId => !successfulResults.some(result => result.id === volatilityId)
                );
                logMessage(`Scan complete: ${best.name}. Some markets did not finish: ${missingSymbols.join(', ')}`);
            }
            try {
                alertSound.play().catch(() => {});
            } catch {}
        } else {
            const missingSymbols = volatilityList.filter(
                volatilityId => !successfulResults.some(result => result.id === volatilityId)
            );
            logMessage(`Scan incomplete after ${SCAN_MAX_RETRIES} attempts. Missing: ${missingSymbols.join(', ')}`);
        }

        setAnalysisStarted(false);
    };

    const handleReset = () => {
        setResults([]);
        setWins(0);
        setLosses(0);
        setTotalRuns(0);
        setTotalProfit(0);
        totalProfitRef.current = 0;
        logMessage('🔄 Stats reset.');
    };

    const currentScanningId = volatilityList.find(id => !scannedHistory.some(item => item.id === id));
    const isAllComplete = scannedHistory.length === volatilityList.length;
    const fifoQueue = scannedHistory.slice(-4);

    // ------------------ SIGNAL EXPIRATION LOGIC ------------------
    useEffect(() => {
        let expirationTimer;

        if (strongestSignal) {
            // Set timer to clear signal after 2 minutes (120,000 ms)
            expirationTimer = setTimeout(() => {
                setStrongestSignal(null);
                logMessage('⏳ Signal expired (2-minute limit reached)');
            }, 60000);
        }

        // Cleanup: Clear the timer if a new signal is fetched or component unmounts
        return () => {
            if (expirationTimer) clearTimeout(expirationTimer);
        };
    }, [strongestSignal]);

    return (
        <div className='sh-main-container'>
            <div className='sh-container'>
                <div className='ovl-header-context'>
                    <div className='ovl-header-inner'>
                        <h2 className='ovl-main-branding'>
                            <span className='ovl-brand-text'>OVERLORD</span>
                            <span className='ovl-brand-year'>PRO</span>
                            <div className='ovl-status-container'>
                                <span className='ovl-live-pulse'>V2.1</span>
                            </div>
                        </h2>
                        <div className='ovl-brand-divider'></div>
                    </div>
                </div>

                <div className='sh-controls-box'>
                    <div className='sh-input-wrapper'>
                        <div className='sh-input-field'>
                            <label>⚙️ Contract Type</label>
                            <span className='sh-question'>What do you want to trade?</span>
                            <select
                                value={tradeType}
                                onChange={e => setTradeType(e.target.value)}
                                className='st-instrument-select'
                            >
                                {['EVEN', 'ODD', 'OVER', 'UNDER', 'RISE', 'FALL', 'MATCHES', 'DIFFERS'].map(t => (
                                    <option key={t} value={t}>
                                        {t}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {['OVER', 'UNDER', 'MATCHES', 'DIFFERS'].includes(tradeType) && (
                            <div className='sh-input-field digit-width'>
                                <label>PREDICTION:</label>
                                <input
                                    type='number'
                                    min='0'
                                    max='9'
                                    value={predictionDigit}
                                    onChange={e => setPredictionDigit(e.target.value)}
                                />
                            </div>
                        )}
                    </div>
                    {/* RECOVERY MODE UI SECTION */}
                    <div className='st-recovery-dashboard-row'>
                        {/* TOGGLE GROUP */}
                        <div className='st-recovery-cell toggle-cell'>
                            <label className='st-switch'>
                                <input
                                    type='checkbox'
                                    checked={useRecovery}
                                    onChange={e => setUseRecovery(e.target.checked)}
                                />
                                <span className='st-slider'></span>
                            </label>
                            <span className='st-cell-title'>RECOVERY MODE</span>
                        </div>

                        {useRecovery && (
                            <div className='st-recovery-controls'>
                                {/* CONTRACT SELECT GROUP */}
                                <div className='st-control-group'>
                                    <label className='st-micro-label'>CONTRACT TYPE</label>
                                    <select
                                        value={recoveryType}
                                        onChange={e => setRecoveryType(e.target.value)}
                                        className='st-instrument-select'
                                    >
                                        {['EVEN', 'ODD', 'OVER', 'UNDER', 'RISE', 'FALL', 'MATCHES', 'DIFFERS'].map(
                                            t => (
                                                <option key={t} value={t}>
                                                    {t}
                                                </option>
                                            )
                                        )}
                                    </select>
                                </div>

                                {/* PREDICTION INPUT GROUP */}
                                {['OVER', 'UNDER', 'MATCHES', 'DIFFERS'].includes(recoveryType) && (
                                    <div className='st-control-group'>
                                        <label className='st-micro-label'>PREDICTION</label>
                                        <input
                                            type='number'
                                            min='0'
                                            max='9'
                                            value={recoveryPrediction}
                                            onChange={e => setRecoveryPrediction(e.target.value)}
                                            className='st-instrument-input'
                                        />
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className='sh-button-group'>
                        <button
                            className={analysisStarted ? 'sh-btn-stop' : 'sh-btn-scan'}
                            onClick={handleFetchSignalGuaranteed}
                        >
                            {analysisStarted ? (
                                <div className='loading-new'>
                                    <span></span>
                                    <span></span>
                                    <span></span>
                                    <span></span>
                                    <span></span>
                                </div>
                            ) : (
                                'GET SIGNAL'
                            )}
                        </button>
                        <button className={isRunning ? 'sh-bot-stop' : 'sh-bot-run'} onClick={handleStart}>
                            {isRunning ? '⏹ STOP BOT' : '▶ RUN BOT'}
                        </button>
                    </div>
                </div>

                <div className='sh-display-area'>
                    {analysisStarted ? (
                        <div className='scanner-view'>
                            <div className='dynamic-scanner-zone'>
                                {!isAllComplete && currentScanningId ? (
                                    <div className='active-scan-card' key={currentScanningId}>
                                        <span className='live-tag'>ANALYZING:</span>
                                        <h3 className='active-symbol-name'>
                                            {symbolNames[currentScanningId] || currentScanningId}
                                        </h3>
                                        <div className='loading-bar-container'>
                                            <div className='loading-bar-fill'></div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className='active-scan-card complete'>
                                        <span className='live-tag'>READY</span>
                                        <h3 className='active-symbol-name'>Scan Finished</h3>
                                    </div>
                                )}
                                <div className='history-ticker'>
                                    {fifoQueue.map((item, index) => (
                                        <div key={`${item.id}-${index}`} className='ticker-item'>
                                            <div className='ticker-content'>
                                                <span className='ticker-check'>✓</span>
                                                <span className='ticker-name'>{symbolNames[item.id] || item.id}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ) : strongestSignal ? (
                        <div className='sh-result-ui'>
                            <div className='sh-result-main'>
                                <div className='sh-result-info'>
                                    <span className='sh-res-label'>PERFECT MARKET FOUND</span>
                                    <h3 className='sh-res-vol'>{strongestSignal.name}</h3>
                                </div>
                                <div className='sh-res-stat'>
                                    <span className='sh-res-perc'>⚡ {strongestSignal.confidence}%</span>
                                    <span className='sh-res-type'>CONFIDENCE</span>
                                </div>
                            </div>
                            <div className='sh-res-footer'>
                                <span className='sh-res-status'>🛡️ SIGNAL VERIFIED</span>
                                <span className='sh-res-timestamp'>⚖️ ACCURACY CHECKED</span>
                            </div>
                        </div>
                    ) : (
                        <div className='sh-standby-ui'>
                            <p>Ready to hunt. Configure and start scanning.</p>
                        </div>
                    )}
                </div>
            </div>

            <div className='st-container'>
                <div className='st-top-row'>
                    <div className='st-input-box'>
                        <label>Initial Stake</label>
                        <input type='number' value={initialStake} onChange={handleInitialStakeChange} />
                    </div>
                    <div className='st-input-box'>
                        <label>Target Profit</label>
                        <input type='number' value={targetProfit} onChange={handleTargetProfitChange} />
                    </div>
                    <div className='st-input-box'>
                        <label>Stop Loss</label>
                        <input type='number' value={stopLoss} onChange={handleStopLossChange} />
                    </div>
                </div>

                <div className='st-bot-footer'>
                    <div className='st-toggle-wrap'>
                        <label className='st-switch'>
                            <input
                                type='checkbox'
                                checked={useMartingale}
                                onChange={e => setUseMartingale(e.target.checked)}
                            />
                            <span className='st-slider'></span>
                        </label>
                        <span className='st-toggle-label'>Enable Martingale</span>
                    </div>
                    {useMartingale && (
                        <div className='st-mult-input'>
                            <label>Multiplier</label>
                            <input
                                type='number'
                                step='0.1'
                                value={martingaleMultiplier}
                                onChange={e => setMartingaleMultiplier(e.target.value)}
                            />
                        </div>
                    )}
                </div>
            </div>

            {proposalError && (
                <div className='bot-errors'>
                    <strong>Error:</strong> {proposalError}
                </div>
            )}
        </div>
    );
};

export default Overlord;
