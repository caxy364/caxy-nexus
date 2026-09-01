import React, { useState, useRef, useEffect, useCallback } from 'react';
import './Oracle.css';
import Swal from "sweetalert2";
import { WS_SERVERS, isProduction } from '@/components/shared';
import { useStore } from '@/hooks/useStore';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';

import { FaPlay, FaStop } from "react-icons/fa";

const TRADE_TYPE_TABS = [
  { id: 'EVEN/ODD', label: 'Even / Odd' },
  { id: 'OVER/UNDER', label: 'Over / Under' },
  { id: 'RISE/FALL', label: 'Rise / Fall' },
  { id: 'DIFFERS', label: 'Differs' },
];


const volatilityList = [
  'R_10', 'R_25', 'R_50', 'R_75', 'R_100',
  '1HZ10V', '1HZ25V', '1HZ30V', '1HZ50V', '1HZ75V', '1HZ100V',
];

const symbolNames = {
  'R_10': 'Volatility 10', 'R_25': 'Volatility 25', 'R_50': 'Volatility 50',
  'R_75': 'Volatility 75', 'R_100': 'Volatility 100', '1HZ10V': 'Vol 10 (1s)',
  '1HZ25V': 'Vol 25 (1s)', '1HZ30V': 'Vol 30 (1s)', '1HZ50V': 'Vol 50 (1s)',
  '1HZ75V': 'Vol 75 (1s)', '1HZ100V': 'Vol 100 (1s)',
};

const CONTRACT_TYPE_MAP = Object.freeze({
  RISE: 'CALL',
  FALL: 'PUT',
  EVEN: 'DIGITEVEN',
  ODD: 'DIGITODD',
  OVER: 'DIGITOVER',
  UNDER: 'DIGITUNDER',
  MATCHES: 'DIGITMATCH',
  DIFFERS: 'DIGITDIFF',
});

const BARRIER_CONTRACT_TYPES = ['OVER', 'UNDER', 'MATCHES', 'DIFFERS'];
const getDerivContractType = type => CONTRACT_TYPE_MAP[type] || type;

const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');
const SCAN_WS_URL = DERIV_PUBLIC_WS_URL;
const SCAN_HISTORY_COUNT = 100;
const SCAN_TIMEOUT_MS = 15000;
const SCAN_STEP_DELAY_MS = 180;
const SCAN_SYMBOL_TIMEOUT_MS = 1200;
const alertSound = new Audio(`${process.env.PUBLIC_URL}/alert.mp3`);

const formatContractSpot = value => {
  if (value === null || value === undefined || value === '') {
    return '-';
  }

  return String(value);
};

const Oracle = () => {
  const store = useStore();
  const { transactions, journal, summary_card, run_panel, client } = store || {};

  const [tradeType, setTradeType] = useState('EVEN/ODD');
  const [analysisStarted, setAnalysisStarted] = useState(false);
  const [currentScanSymbol, setCurrentScanSymbol] = useState('');
  const [topScanResult, setTopScanResult] = useState(null);
  const [strongestSignal, setStrongestSignal] = useState(null);
  const [signalTimeLeft, setSignalTimeLeft] = useState(0);
  const [scannedMarketsCount, setScannedMarketsCount] = useState(0);

  const scanSocketRef = useRef(null);
  const tickData = useRef({});
  const latestDataRef = useRef({});
  const scannedSymbolsRef = useRef(new Set());
  const tradeTypeRef = useRef(tradeType);
  const activeScanTypeRef = useRef(tradeType);
  const scanSessionRef = useRef(0);
  const scanFinalizedRef = useRef(false);
  const signalTimeout = useRef(null);
  const countdownInterval = useRef(null);
  const scanTimeoutRef = useRef(null);
  const scanStepTimerRef = useRef(null);
  const scanSymbolTimeoutRef = useRef(null);
  const scanQueueRef = useRef([]);
  const pendingScanSymbolRef = useRef(null);
  
  // ------------------ INPUTS ------------------
  const [symbol, setSymbol] = useState("");
  const [contractType, setContractType] = useState("");
  const [initialStake, setInitialStake] = useState("1");
  const [duration] = useState("1");
  const [targetProfit, setTargetProfit] = useState("100");
  const [stopLoss, setStopLoss] = useState("100");
  const [useMartingale, setUseMartingale] = useState(true);
  const [martingaleMultiplier, setMartingaleMultiplier] = useState("2.1");
  const [predictionDigit, setPredictionDigit] = useState("7");

  // ------------------ BOT STATE ------------------
  const [isRunning, setIsRunning] = useState(false);
  const [, setLogs] = useState([]);
  const [, setResults] = useState([]);
  const [, setWins] = useState(0);
  const [, setLosses] = useState(0);
  const [, setTotalRuns] = useState(0);
  const [, setTotalProfit] = useState(0);
  const [proposalError, setProposalError] = useState("");

  // ------------------ REFS ------------------
  const wsRef = useRef(null);
  const totalProfitRef = useRef(0);
  const baseStakeRef = useRef(1);
  const currentStakeRef = useRef(1);
  const isRunningRef = useRef(false);
  const isAuthorizedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const reconnectTimeoutRef = useRef(null);
  const shouldReconnectRef = useRef(true);
  const skipReconnectRef = useRef(false);
  const socketRequiresAuthRef = useRef(false);
  const pendingProposalRef = useRef(false);
  const pendingTradeMetaRef = useRef(null);
  const contractMetaRef = useRef({});
  const activeContractsRef = useRef(new Set());
  const completedContractsRef = useRef(new Set());
  const lastProcessedContractIdRef = useRef(null);
  const transactionRecoveryTimeoutsRef = useRef(new Map());

  // Important: keep refs for *signal values* so proposals use them (avoids stale state issues)
  const symbolRef = useRef(symbol);           // tracks symbol to trade
  const contractTypeRef = useRef(contractType); // tracks contract type (EVEN/ODD/... etc)
  const useMartingaleRef = useRef(useMartingale);
  const predictionDigitRef = useRef(predictionDigit);
  const targetProfitRef = useRef(targetProfit);
  const stopLossRef = useRef(stopLoss);
  const martingaleMultiplierRef = useRef(martingaleMultiplier);
  const lastTradeWasLossRef = useRef(false);

  // ------------------ SYNC REFS ------------------
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { tradeTypeRef.current = tradeType; }, [tradeType]);
  useEffect(() => { contractTypeRef.current = contractType; }, [contractType]);
  useEffect(() => { symbolRef.current = symbol; }, [symbol]); // keep symbolRef in sync with state
  useEffect(() => { useMartingaleRef.current = useMartingale; }, [useMartingale]);
  useEffect(() => { predictionDigitRef.current = predictionDigit; }, [predictionDigit]);
  useEffect(() => { targetProfitRef.current = targetProfit; }, [targetProfit]);
  useEffect(() => { stopLossRef.current = stopLoss; }, [stopLoss]);
  useEffect(() => { martingaleMultiplierRef.current = martingaleMultiplier; }, [martingaleMultiplier]);
  useEffect(() => {
    run_panel?.setIsRunning?.(isRunning);
    if (!isRunning && !run_panel?.has_open_contract) {
      run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
    }
  }, [isRunning, run_panel]);

  const logMessage = (msg) => {
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
        accounts.find(account => account.account_id === activeLoginId) ||
        accounts.find(account => account.account_id?.startsWith('DOT')) ||
        accounts[0];

      if (!activeAccount?.account_id) return null;

      return {
        accessToken: access_token,
        activeAccount,
      };
    } catch (error) {
      console.error('[Oracle] Failed to parse Deriv session storage:', error);
      return null;
    }
  }, []);

  const getAuthenticatedUrl = useCallback(async () => {
    try {
      const authContext = getStoredAuthContext();
      if (!authContext) throw new Error('Session Missing');

      const { accessToken, activeAccount } = authContext;
      const response = await fetch(`${DERIV_OPTIONS_API_URL}accounts/${activeAccount.account_id}/otp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) throw new Error('OTP Request Failed');

      const data = await response.json();
      const authenticatedUrl = data?.data?.url;

      if (!authenticatedUrl) throw new Error('Authenticated URL Missing');

      return authenticatedUrl;
    } catch (error) {
      logMessage(`Auth Error: ${error.message}`);
      return null;
    }
  }, [getStoredAuthContext]);

  const clearContractTracking = useCallback(() => {
    pendingProposalRef.current = false;
    pendingTradeMetaRef.current = null;
    contractMetaRef.current = {};
    lastProcessedContractIdRef.current = null;
    completedContractsRef.current.clear();
    activeContractsRef.current.clear();
    transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
    transactionRecoveryTimeoutsRef.current.clear();
  }, []);

  const parseLimitAmount = useCallback((value) => {
    const parsedValue = Number.parseFloat(value);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      return null;
    }

    return Number(parsedValue.toFixed(2));
  }, []);

  const getTransactionsStatisticsTotals = useCallback(() => {
    const totalProfitLoss = Number(transactions?.statistics?.total_profit ?? 0);

    return {
      totalProfitLoss: Number.isFinite(totalProfitLoss) ? Number(totalProfitLoss.toFixed(2)) : 0,
    };
  }, [transactions]);

  const getTriggeredTradingLimit = useCallback(() => {
    const { totalProfitLoss } = getTransactionsStatisticsTotals();
    const targetProfitLimit = parseLimitAmount(targetProfitRef.current);

    if (targetProfitLimit !== null && totalProfitLoss >= targetProfitLimit) {
      return {
        alert: {
          title: "CONGRATULATIONS!",
          text: "Target profit hit...",
          icon: "success",
          draggable: false,
        },
        reason: "Target profit reached. Bot stopped.",
      };
    }

    const stopLossLimit = parseLimitAmount(stopLossRef.current);
    if (stopLossLimit !== null && totalProfitLoss <= -stopLossLimit) {
      return {
        alert: {
          title: "OOPS",
          text: "You have hit your stoploss",
          icon: "error",
          draggable: false,
        },
        reason: "Stop loss reached. Bot stopped.",
      };
    }

    return null;
  }, [getTransactionsStatisticsTotals, parseLimitAmount]);


    // ------------------ BOT FUNCTIONS ------------------
  const handleStart = () => {
    if (isRunning) {
      setIsRunning(false);
      isRunningRef.current = false;
      logMessage("ðŸ›‘ Bot stopped.");
      return;
    }

    const token = localStorage.getItem("authToken");
    if (!token) {
      Swal.fire({ title: "Login Required!", icon: "error", draggable: false });
      return;
    }

    contractMetaRef.current = {};
    lastTradeWasLossRef.current = false;
    baseStakeRef.current = parseFloat(initialStake) || 0;
    currentStakeRef.current = parseFloat(initialStake) || 0;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      logMessage("â™»ï¸ Reusing existing WebSocket connection...");
      setIsRunning(true);
      requestProposal(); // will use refs for symbol & contract type
      return;
    }

    wsRef.current = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=70505");
    setIsRunning(true);

    wsRef.current.onopen = () => {
      logMessage("ðŸ”Œ Connected to Deriv WebSocket");
      wsRef.current.send(JSON.stringify({ authorize: token }));
    };

    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.msg_type === "authorize") {
        logMessage(`âœ… Authorized as ${data.authorize.loginid}`);
        requestProposal();
      }

      if (data.msg_type === "proposal" && data.proposal?.id) {
        if (!isRunningRef.current) return;
        const { id, display_name, ask_price } = data.proposal;
        logMessage(`ðŸ“Š Proposal: ${display_name} | Buy for $${ask_price}`);
        wsRef.current.send(JSON.stringify({ buy: id, price: ask_price }));
      }

      if (data.msg_type === "buy") {
        const { contract_id, longcode, buy_price } = data.buy;
        logMessage(`ðŸŽ¯ Bought: ${longcode} for $${buy_price}`);

        setResults(prev => [
          {
            id: prev.length + 1,
            contract_type: contractTypeRef.current,
            entry_spot: "-",
            exit_spot: "-",
            stake: parseFloat(currentStakeRef.current).toFixed(2),
            profit: "-",
            status: "â³",
            contract_id,
          },
          ...prev,
        ]);

        wsRef.current.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id,
          subscribe: 1,
        }));
      }

      if (data.msg_type === "proposal_open_contract") {
        const c = data.proposal_open_contract;
        if (!c) return;

        if (c.entry_spot_display_value && !c.is_sold) {
          setResults(prev =>
            prev.map(r =>
              r.contract_id === c.contract_id
                ? { ...r, entry_spot: c.entry_spot_display_value }
                : r
            )
          );
        }

        if (c.is_sold) {
          const profit = parseFloat(c.profit ?? 0);
          const result = profit > 0 ? "WIN " : "LOSS ";

          totalProfitRef.current += profit;
          setTotalProfit(totalProfitRef.current.toFixed(2));
          setTotalRuns(p => p + 1);
          if (profit > 0) setWins(p => p + 1);
          else setLosses(p => p + 1);

          logMessage(`ðŸ’° Contract ended: ${result} | Profit: $${profit.toFixed(2)}`);

          setResults(prev =>
            prev.map(r =>
              r.contract_id === c.contract_id
                ? {
                    ...r,
                    entry_spot: c.entry_spot_display_value ?? "-",
                    exit_spot: c.exit_spot_display_value ?? c.exit_tick_display_value ?? "-",
                    profit: profit.toFixed(2),
                    status: result,
                  }
                : r
            )
          );

          // Martingale
          if (useMartingaleRef.current) {
            if (profit <= 0) {
              currentStakeRef.current = parseFloat(
                (currentStakeRef.current * parseFloat(martingaleMultiplierRef.current)).toFixed(2)
              );
              logMessage(`ðŸ” Martingale applied (x${martingaleMultiplierRef.current}). Next stake: $${currentStakeRef.current}`);
            } else {
              currentStakeRef.current = baseStakeRef.current;
              logMessage(`âœ… Win detected. Resetting stake to base: $${baseStakeRef.current}`);
            }
          }

          lastTradeWasLossRef.current = profit <= 0;

          // TP / SL logic
          const triggeredLimit = getTriggeredTradingLimit();
          if (triggeredLimit) {
            Swal.fire(triggeredLimit.alert);
            setIsRunning(false);
            isRunningRef.current = false;
            logMessage(triggeredLimit.reason);
            return;
          }

          // Continue next trade
          setTimeout(() => {
            if (isRunningRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
              logMessage("â™»ï¸ Starting next trade...");
              requestProposal();
            }
          }, 0);
        }
      }
    };

    wsRef.current.onclose = () => {
      logMessage("ðŸ”’ WebSocket closed");
      setIsRunning(false);
    };
  };

  void handleStart;

  
  // NOTE: requestProposal now uses symbolRef.current and contractTypeRef.current
  const requestProposal = useCallback(() => {
    if (!isRunningRef.current) return;

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      logMessage("Trading socket not ready for proposal request");
      return;
    }

    if (!isAuthorizedRef.current) {
      logMessage("Trading session is not authorized yet");
      return;
    }

    if (pendingProposalRef.current) {
      logMessage("Waiting for pending proposal to resolve");
      return;
    }

    if (activeContractsRef.current.size > 0) {
      logMessage("Waiting for active contract to settle");
      return;
    }

    const activeType = contractTypeRef.current;
    const derivContractType = getDerivContractType(activeType);
    const parsedDuration = Math.max(1, parseInt(duration, 10) || 1);
    const parsedStake = Number(currentStakeRef.current).toFixed(2);
    const barrier = BARRIER_CONTRACT_TYPES.includes(activeType)
      ? parseInt(predictionDigitRef.current, 10)
      : undefined;
    const type = activeType;
    const proposal = {
      proposal: 1,
      amount: parsedStake,
      basis: "stake",
      contract_type: derivContractType,
      currency: client?.currency || "USD",
      underlying_symbol: symbolRef.current,
      duration: parsedDuration,
      duration_unit: "t",
      ...(barrier !== undefined ? { barrier } : {}),
    };
    Object.defineProperty(proposal, "symbol", { value: symbolRef.current, enumerable: false });

    pendingTradeMetaRef.current = {
      uiContractType: activeType,
      derivContractType,
      barrier,
      stake: parsedStake,
    };
    pendingProposalRef.current = true;
    setProposalError("");
    run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);

    logMessage(`ðŸ“© Requesting proposal for ${type}${barrier !== undefined ? ` | Prediction: ${barrier}` : ""} on ${proposal.symbol}`);
    wsRef.current.send(JSON.stringify(proposal));
  }, [client?.currency, duration, run_panel]);

  const publishNativeContract = useCallback((contractData) => {
    if (!transactions || !summary_card) return;
    transactions.onBotContractEvent(contractData);
    summary_card.onBotContractEvent(contractData);
  }, [summary_card, transactions]);

  const publishNativeError = useCallback((message) => {
    if (journal?.onError) {
      journal.onError(message);
    }
  }, [journal]);

  const publishNativeResult = useCallback((contractData) => {
    if (journal?.onLogSuccess) {
      journal.onLogSuccess({
        log_type: contractData.profit > 0 ? "profit" : "lost",
        extra: {
          currency: contractData.currency,
          profit: contractData.profit,
        },
      });
    }
  }, [journal]);

  const stopTradingBotNative = useCallback((reason = "Bot stopped.", options = {}) => {
    const preserveOpenContract =
      options.preserveOpenContract ?? Boolean(activeContractsRef.current.size > 0 || run_panel?.has_open_contract);

    setIsRunning(false);
    isRunningRef.current = false;
    pendingProposalRef.current = false;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ forget_all: "proposal" }));
      if (!preserveOpenContract) {
        wsRef.current.send(JSON.stringify({ forget_all: "proposal_open_contract" }));
      }
    }

    if (!preserveOpenContract) {
      clearContractTracking();
    }

    run_panel?.setIsRunning?.(false);
    run_panel?.toggleDrawer?.(true);
    run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

    if (preserveOpenContract) {
      run_panel?.setHasOpenContract?.(true);
      run_panel?.setContractStage?.(contract_stages.IS_STOPPING);
    } else {
      run_panel?.setHasOpenContract?.(false);
      run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
    }

    logMessage(reason);
  }, [clearContractTracking, run_panel]);

  const handleStop = useCallback(() => {
    const preserveOpenContract = activeContractsRef.current.size > 0;

    stopTradingBotNative(
      preserveOpenContract ? "Bot stopped. Waiting for active contract to finish..." : "Bot stopped.",
      { preserveOpenContract }
    );
  }, [stopTradingBotNative]);

  const handleTradeSequence = useCallback((profit) => {
    if (useMartingaleRef.current) {
      currentStakeRef.current =
        profit <= 0
          ? parseFloat((Number(currentStakeRef.current) * parseFloat(martingaleMultiplierRef.current || "1")).toFixed(2))
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

    const triggeredLimit = getTriggeredTradingLimit();
    if (triggeredLimit) {
      Swal.fire(triggeredLimit.alert);
      stopTradingBotNative(triggeredLimit.reason, { preserveOpenContract: false });
      return;
    }

    window.setTimeout(() => {
      if (isRunningRef.current) {
        requestProposal();
      }
    }, 0);
  }, [getTriggeredTradingLimit, requestProposal, run_panel, stopTradingBotNative]);

  const handleTradingSocketMessage = useCallback((event) => {
    const data = JSON.parse(event.data);

    if (data.msg_type === "authorize") {
      isAuthorizedRef.current = true;
      logMessage("Trading session authorized");
      if (isRunningRef.current && activeContractsRef.current.size === 0) {
        requestProposal();
      }
      return;
    }

    if (data.msg_type === "proposal" && !data.error) {
      if (!isRunningRef.current) return;

      const proposalId = data.proposal?.id;
      const askPrice = data.proposal?.ask_price;

      if (!proposalId || askPrice === undefined) {
        logMessage("Proposal received without an id or ask price");
        pendingProposalRef.current = false;
        return;
      }

      wsRef.current.send(JSON.stringify({ buy: proposalId, price: askPrice }));
      return;
    }

    if (data.error) {
      const errorCode = data.error.code;
      const errorMessage = data.error.message;
      const openPositionLimitReached =
        /(cannot hold more than \d+ contracts|open positions of this asset and trade type|open position limit)/i.test(
          errorMessage || ""
        );
      const sessionTradingLimitReached =
        [
          "CompanyWideLimitExceeded",
          "DailyProfitLimitExceeded",
          "ProductSpecificTurnoverLimitExceeded",
          "MaxAggregateOpenStakeExceeded",
        ].includes(errorCode) ||
        /(no further trading is allowed|maximum daily stake|growth rate and instrument)/i.test(errorMessage || "");

      setProposalError(errorMessage);
      pendingProposalRef.current = false;
      logMessage(`Trade error: ${errorMessage}`);
      publishNativeError(errorMessage);

      if (openPositionLimitReached) {
        stopTradingBotNative("Open position limit reached. Bot stopped.", { preserveOpenContract: false });
        return;
      }

      if (sessionTradingLimitReached) {
        stopTradingBotNative("Trading is blocked for this contract type in the current session.", {
          preserveOpenContract: false,
        });
      }
      return;
    }

    if (data.msg_type === "transaction") {
      const action = data.transaction?.action;
      const sellContractId = data.transaction?.contract_id;
      const contractKey = String(sellContractId ?? "");

      if (action !== "sell" || !sellContractId || !activeContractsRef.current.has(contractKey)) {
        return;
      }

      if (completedContractsRef.current.has(contractKey)) {
        return;
      }

      if (transactionRecoveryTimeoutsRef.current.has(contractKey)) {
        clearTimeout(transactionRecoveryTimeoutsRef.current.get(contractKey));
      }

      const timeoutId = window.setTimeout(() => {
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

      transactionRecoveryTimeoutsRef.current.set(contractKey, timeoutId);
      return;
    }

    if (data.msg_type === "buy") {
      const { contract_id, transaction_id, buy_price, longcode } = data.buy || {};
      if (!contract_id) {
        pendingProposalRef.current = false;
        return;
      }

      const contractKey = String(contract_id);
      const market = symbolRef.current;
      const tradeMeta = pendingTradeMetaRef.current || {
        uiContractType: contractTypeRef.current,
        derivContractType: getDerivContractType(contractTypeRef.current),
        barrier: undefined,
        stake: Number(currentStakeRef.current).toFixed(2),
      };
      const transactionPayload = {
        id: contract_id,
        contract_id,
        transaction_ids: { buy: transaction_id },
        buy_price: buy_price ?? parseFloat(tradeMeta.stake),
        currency: client?.currency || "USD",
        display_name: symbolNames[market] || market,
        underlying: market,
        underlying_symbol: market,
        contract_type: tradeMeta.derivContractType,
        longcode,
        barrier: tradeMeta.barrier,
        tick_count: Math.max(1, parseInt(duration, 10) || 1),
        date_start: Math.floor(Date.now() / 1000),
      };

      contractMetaRef.current[contractKey] = transactionPayload;
      completedContractsRef.current.delete(contractKey);
      activeContractsRef.current.add(contractKey);
      pendingProposalRef.current = false;
      setProposalError("");

      publishNativeContract(transactionPayload);
      run_panel?.setHasOpenContract?.(true);
      run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);

      setResults(prev => [
        {
          contract_id,
          contract_type: tradeMeta.uiContractType,
          entry_spot: "-",
          exit_spot: "-",
          stake: Number(buy_price ?? tradeMeta.stake).toFixed(2),
          profit: null,
          status: "PENDING",
        },
        ...prev,
      ]);

      wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id, subscribe: 1 }));
      return;
    }

    if (data.msg_type === "proposal_open_contract") {
      const contract = data.proposal_open_contract;
      if (!contract) return;

      const contractKey = String(contract.contract_id);
      const isTrackedContract = activeContractsRef.current.has(contractKey);

      if (!isRunningRef.current && !isTrackedContract) return;
      if (completedContractsRef.current.has(contractKey)) return;

      const normalizedStatus = String(contract.status || "").toLowerCase();
      const hasClosedStatus = Boolean(normalizedStatus) && normalizedStatus !== "open";
      const isExpired = contract.is_expired === 1 || contract.is_expired === true || contract.is_expired === "1";
      const isSettleable =
        contract.is_settleable === 1 || contract.is_settleable === true || contract.is_settleable === "1";
      const isSold =
        contract.is_sold === 1 ||
        contract.is_sold === true ||
        contract.is_sold === "1" ||
        hasClosedStatus ||
        isExpired ||
        isSettleable;

      const entrySpot = formatContractSpot(
        contract.entry_spot_display_value ??
          contract.entry_tick_display_value ??
          contract.entry_spot ??
          contract.entry_tick
      );
      const exitSpot = formatContractSpot(
        contract.exit_spot_display_value ??
          contract.exit_tick_display_value ??
          contract.exit_spot ??
          contract.exit_tick ??
          contract.current_spot_display_value ??
          contract.current_spot
      );
      const profit = parseFloat(contract.profit ?? 0);
      const resultStatus = profit > 0 ? "won" : "lost";
      const nativeContract = {
        ...(contractMetaRef.current[contractKey] || {}),
        ...contract,
        id: contract.contract_id,
        contract_id: contract.contract_id,
        contract_type:
          contract.contract_type ||
          contractMetaRef.current[contractKey]?.contract_type ||
          pendingTradeMetaRef.current?.derivContractType,
        display_name:
          contract.display_name ||
          contractMetaRef.current[contractKey]?.display_name ||
          symbolNames[contract.underlying_symbol || contract.underlying || symbolRef.current] ||
          symbolRef.current,
        underlying_symbol:
          contract.underlying_symbol ||
          contractMetaRef.current[contractKey]?.underlying_symbol ||
          contract.underlying ||
          symbolRef.current,
        underlying:
          contract.underlying ||
          contractMetaRef.current[contractKey]?.underlying ||
          contract.underlying_symbol ||
          symbolRef.current,
        buy_price:
          contract.buy_price ??
          contractMetaRef.current[contractKey]?.buy_price ??
          parseFloat(pendingTradeMetaRef.current?.stake || currentStakeRef.current),
        currency: contract.currency || client?.currency || "USD",
        transaction_ids:
          contract.transaction_ids || contractMetaRef.current[contractKey]?.transaction_ids || undefined,
        entry_spot: entrySpot,
        exit_spot: isSold ? exitSpot : undefined,
        is_sold: isSold,
        is_expired: isExpired || contract.is_expired,
        is_settleable: isSettleable || contract.is_settleable,
        result: isSold ? resultStatus : undefined,
        status: isSold ? normalizedStatus || resultStatus : contract.status || "open",
      };

      contractMetaRef.current[contractKey] = nativeContract;
      publishNativeContract(nativeContract);

      setResults(prev =>
        prev.map(result =>
          result.contract_id === contract.contract_id
            ? {
                ...result,
                entry_spot: entrySpot,
                ...(isSold
                  ? {
                      exit_spot: exitSpot,
                      profit: profit.toFixed(2),
                      status: profit >= 0 ? "WIN" : "LOSS",
                    }
                  : {}),
              }
            : result
        )
      );

      if (!isSold) return;
      if (lastProcessedContractIdRef.current === contractKey) return;

      if (transactionRecoveryTimeoutsRef.current.has(contractKey)) {
        clearTimeout(transactionRecoveryTimeoutsRef.current.get(contractKey));
        transactionRecoveryTimeoutsRef.current.delete(contractKey);
      }

      completedContractsRef.current.add(contractKey);
      activeContractsRef.current.delete(contractKey);
      lastProcessedContractIdRef.current = contractKey;
      totalProfitRef.current += profit;

      setTotalProfit(totalProfitRef.current.toFixed(2));
      setTotalRuns(p => p + 1);
      if (profit > 0) setWins(p => p + 1);
      else setLosses(p => p + 1);

      run_panel?.setHasOpenContract?.(activeContractsRef.current.size > 0);
      run_panel?.setContractStage?.(
        activeContractsRef.current.size > 0
          ? contract_stages.PURCHASE_RECEIVED
          : isRunningRef.current
            ? contract_stages.CONTRACT_CLOSED
            : contract_stages.NOT_RUNNING
      );
      publishNativeResult(nativeContract);

      handleTradeSequence(profit);
    }
  }, [
    client?.currency,
    duration,
    handleTradeSequence,
    publishNativeContract,
    publishNativeError,
    publishNativeResult,
    requestProposal,
    run_panel,
    stopTradingBotNative,
  ]);

  const connectTradingSocket = useCallback(async (options = {}) => {
    const { requireAuth = false, forceReconnect = false } = options;
    const socketState = wsRef.current?.readyState;

    if (
      !forceReconnect &&
      (socketState === WebSocket.OPEN || socketState === WebSocket.CONNECTING || isConnectingRef.current)
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
        console.error("[Oracle] Failed to close existing socket:", error);
      }
    }

    isConnectingRef.current = true;
    socketRequiresAuthRef.current = requireAuth;

    try {
      const authenticatedUrl = requireAuth ? await getAuthenticatedUrl() : null;

      if (requireAuth && !authenticatedUrl) {
        setProposalError("Unable to create an authenticated Deriv session.");
        return false;
      }

      const socketUrl = authenticatedUrl || DERIV_PUBLIC_WS_URL;
      const isAuthenticatedSocket = Boolean(authenticatedUrl);

      wsRef.current = new WebSocket(socketUrl);
      wsRef.current.onopen = () => {
        logMessage(isAuthenticatedSocket ? "Trading socket connected" : "Public socket connected");
        setProposalError("");
        isAuthorizedRef.current = isAuthenticatedSocket;

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

          if (isRunningRef.current && activeContractsRef.current.size === 0) {
            requestProposal();
          }
        }
      };
      wsRef.current.onmessage = handleTradingSocketMessage;
      wsRef.current.onerror = error => {
        logMessage("Trading socket error");
        console.error(error);
      };
      wsRef.current.onclose = () => {
        logMessage("Trading socket closed");
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
  }, [getAuthenticatedUrl, handleTradingSocketMessage, requestProposal]);

  const handleBotStart = useCallback(async () => {
    if (isRunningRef.current) {
      handleStop();
      return;
    }

    if (!symbolRef.current) {
      Swal.fire({ title: "No Signal", text: "Please scan first", icon: "warning", draggable: false });
      return;
    }

    if (!getStoredAuthContext()) {
      Swal.fire({ title: "Login Required!", icon: "error", draggable: false });
      return;
    }

    const triggeredLimit = getTriggeredTradingLimit();
    if (triggeredLimit) {
      Swal.fire(triggeredLimit.alert);
      logMessage(triggeredLimit.reason);
      return;
    }

    clearContractTracking();
    lastTradeWasLossRef.current = false;
    baseStakeRef.current = parseFloat(initialStake) || 0;
    currentStakeRef.current = parseFloat(initialStake) || 0;
    setProposalError("");

    if (summary_card?.clear) summary_card.clear();
    run_panel?.setIsRunning?.(true);
    run_panel?.setHasOpenContract?.(false);
    run_panel?.setContractStage?.(contract_stages.STARTING);
    if (run_panel) {
      run_panel.run_id = `signalhub-${Date.now()}`;
    }
    run_panel?.toggleDrawer?.(true);
    run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

    setIsRunning(true);
    isRunningRef.current = true;

    const socketState = wsRef.current?.readyState;
    if (wsRef.current && socketState === WebSocket.OPEN && isAuthorizedRef.current) {
      requestProposal();
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
  }, [
    clearContractTracking,
    connectTradingSocket,
    getStoredAuthContext,
    getTriggeredTradingLimit,
    handleStop,
    initialStake,
    requestProposal,
    run_panel,
    summary_card,
  ]);

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

  useEffect(() => {
    const handleExternalStop = () => {
      if (!isRunningRef.current && activeContractsRef.current.size === 0 && !run_panel?.has_open_contract) return;

      stopTradingBotNative("Bot stopped from the Deriv run panel.", {
        preserveOpenContract: Boolean(activeContractsRef.current.size > 0 || run_panel?.has_open_contract),
      });
    };

    observer.register("bot.click_stop", handleExternalStop);
    observer.register("oracle.start", handleBotStart);
    observer.register("oracle.stop", handleStop);

    return () => {
      if (observer.isRegistered("bot.click_stop")) {
        observer.unregister("bot.click_stop", handleExternalStop);
      }
      if (observer.isRegistered("oracle.start")) {
        observer.unregister("oracle.start", handleBotStart);
      }
      if (observer.isRegistered("oracle.stop")) {
        observer.unregister("oracle.stop", handleStop);
      }
    };
  }, [handleBotStart, handleStop, run_panel?.has_open_contract, stopTradingBotNative]);

  const handleToggleAnalysis = () => {
    if (analysisStarted) {
      stopAll();
    } else {
      startScan();
    }
  };

  const closeScanSockets = () => {
    if (scanSocketRef.current) {
      scanSocketRef.current.close();
      scanSocketRef.current = null;
    }
  };

  const clearScanTimers = () => {
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    if (scanStepTimerRef.current) {
      clearTimeout(scanStepTimerRef.current);
      scanStepTimerRef.current = null;
    }
    if (scanSymbolTimeoutRef.current) {
      clearTimeout(scanSymbolTimeoutRef.current);
      scanSymbolTimeoutRef.current = null;
    }
    if (signalTimeout.current) {
      clearTimeout(signalTimeout.current);
      signalTimeout.current = null;
    }
    if (countdownInterval.current) {
      clearInterval(countdownInterval.current);
      countdownInterval.current = null;
    }
  };

  const getRankedSignals = useCallback(() => (
    Object.keys(latestDataRef.current)
      .map(key => ({
        symbol: key,
        name: symbolNames[key],
        ...latestDataRef.current[key],
      }))
      .sort((a, b) => b.deviation - a.deviation)
  ), []);

  const maybeFinalizeScan = (sessionId, { force = false } = {}) => {
    if (sessionId !== scanSessionRef.current || scanFinalizedRef.current) return;
    if (!force && scannedSymbolsRef.current.size < volatilityList.length) return;

    scanFinalizedRef.current = true;
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    if (scanStepTimerRef.current) {
      clearTimeout(scanStepTimerRef.current);
      scanStepTimerRef.current = null;
    }
    if (scanSymbolTimeoutRef.current) {
      clearTimeout(scanSymbolTimeoutRef.current);
      scanSymbolTimeoutRef.current = null;
    }
    pendingScanSymbolRef.current = null;
    finalizeBestSignal(sessionId);
  };

  const queueNextScan = (sessionId, scanType) => {
    if (sessionId !== scanSessionRef.current || scanFinalizedRef.current) return;

    if (!scanQueueRef.current.length) {
      maybeFinalizeScan(sessionId, { force: true });
      return;
    }

    if (!scanSocketRef.current || scanSocketRef.current.readyState !== WebSocket.OPEN) return;

    const symbol = scanQueueRef.current.shift();
    pendingScanSymbolRef.current = symbol;
    setCurrentScanSymbol(symbolNames[symbol] || symbol);
    scanSocketRef.current.send(JSON.stringify({
      ticks_history: symbol,
      style: 'ticks',
      count: SCAN_HISTORY_COUNT,
      end: 'latest',
    }));

    if (scanSymbolTimeoutRef.current) {
      clearTimeout(scanSymbolTimeoutRef.current);
    }
    scanSymbolTimeoutRef.current = window.setTimeout(() => {
      if (sessionId !== scanSessionRef.current || pendingScanSymbolRef.current !== symbol) return;
      pendingScanSymbolRef.current = null;
      queueNextScan(sessionId, scanType);
    }, SCAN_SYMBOL_TIMEOUT_MS);
  };

  const continueScanQueue = (sessionId, scanType) => {
    if (scanStepTimerRef.current) {
      clearTimeout(scanStepTimerRef.current);
    }
    scanStepTimerRef.current = window.setTimeout(() => {
      queueNextScan(sessionId, scanType);
    }, SCAN_STEP_DELAY_MS);
  };

  const startScan = () => {
    scanSessionRef.current += 1;
    const currentSession = scanSessionRef.current;
    const scanType = tradeTypeRef.current;
    activeScanTypeRef.current = scanType;
    scanFinalizedRef.current = false;

    closeScanSockets();
    clearScanTimers();

    setAnalysisStarted(true);
    setCurrentScanSymbol(symbolNames[volatilityList[0]] || volatilityList[0]);
    setTopScanResult(null);
    setScannedMarketsCount(0);
    scannedSymbolsRef.current = new Set();
    latestDataRef.current = {};
    setStrongestSignal(null);
    scanQueueRef.current = [...volatilityList];
    pendingScanSymbolRef.current = null;

    volatilityList.forEach(v => {
      tickData.current[v] = [];
    });
    connectWS(currentSession, scanType);
    scanTimeoutRef.current = window.setTimeout(
      () => maybeFinalizeScan(currentSession, { force: true }),
      SCAN_TIMEOUT_MS
    );
  };

  const stopAll = () => {
    scanSessionRef.current += 1;
    scanFinalizedRef.current = false;
    closeScanSockets();
    clearScanTimers();
    setAnalysisStarted(false);
    setCurrentScanSymbol('');
    setTopScanResult(null);
    setScannedMarketsCount(0);
    setStrongestSignal(null);
    setSignalTimeLeft(0);
    scannedSymbolsRef.current = new Set();
    latestDataRef.current = {};
    scanQueueRef.current = [];
    pendingScanSymbolRef.current = null;
    setPredictionDigit(null);
    predictionDigitRef.current = null;
  };

  const connectWS = (sessionId, scanType) => {
    const ws = new WebSocket(SCAN_WS_URL);
    scanSocketRef.current = ws;

    ws.onopen = () => {
      if (sessionId !== scanSessionRef.current) return;
      queueNextScan(sessionId, scanType);
    };

    ws.onmessage = (msg) => {
      if (sessionId !== scanSessionRef.current) return;
      const data = JSON.parse(msg.data);
      if (data.error) return;

      const symbol = data.echo_req?.ticks_history || data.echo_req?.ticks || data.tick?.symbol;
      if (!symbol || !data.history?.prices) return;

      tickData.current[symbol] = data.history.prices;

      const isPendingSymbol = pendingScanSymbolRef.current === symbol;
      if (isPendingSymbol) {
        pendingScanSymbolRef.current = null;
        if (scanSymbolTimeoutRef.current) {
          clearTimeout(scanSymbolTimeoutRef.current);
          scanSymbolTimeoutRef.current = null;
        }
      }

      if (!scannedSymbolsRef.current.has(symbol)) {
        scannedSymbolsRef.current.add(symbol);
        setScannedMarketsCount(scannedSymbolsRef.current.size);
      }

      updateUI(symbol, scanType);
      if (isPendingSymbol) {
        continueScanQueue(sessionId, scanType);
      }
      maybeFinalizeScan(sessionId);
    };

    ws.onclose = () => {
      if (sessionId === scanSessionRef.current && !scanFinalizedRef.current) {
        maybeFinalizeScan(sessionId, { force: true });
      }
    };
  };

  const extractDigit = (symbol, price) => {
    const dec = (symbol.startsWith('1HZ') || symbol === 'R_100') ? 2 : (symbol === 'R_75' || symbol === 'R_50') ? 4 : 3;
    const fixed = Number(price).toFixed(dec);
    return parseInt(fixed.split('.')[1]?.slice(-1) || fixed.slice(-1));
  };

  const updateUI = (symbol, scanType = activeScanTypeRef.current) => {
    const stats = calculateStats(symbol, scanType);
    latestDataRef.current[symbol] = stats;
    setTopScanResult(getRankedSignals()[0] || null);
  };

  const calculateStats = (symbol, scanType = activeScanTypeRef.current) => {
    const prices = tickData.current[symbol];
    if (!prices || prices.length < 10) return { contractType: '--', deviation: 0 };
    
    let contractType = '--', deviation = 0;
    const total = prices.length;

    if (scanType === 'EVEN/ODD') {
      const digits = prices.map(p => extractDigit(symbol, p));
      const even = digits.filter(d => d % 2 === 0).length;
      const odd = total - even;
      contractType = even > odd ? 'ODD' : 'EVEN';
      deviation = (Math.abs(even - odd) / total) * 100;
    } 
    
    else if (scanType === 'RISE/FALL') {
      let rise = 0, fall = 0;
      for (let i = 1; i < prices.length; i++) {
        if (Number(prices[i]) > Number(prices[i-1])) rise++;
        else if (Number(prices[i]) < Number(prices[i-1])) fall++;
      }
      contractType = rise > fall ? 'RISE' : 'FALL';
      deviation = (Math.abs(rise - fall) / (rise + fall || 1)) * 100;
    }

    else if (scanType === 'OVER/UNDER') {
      const digits = prices.map(p => extractDigit(symbol, p));
      const over = digits.filter(d => d >= 5).length;
      const under = total - over;
      contractType = over > under ? 'UNDER' : 'OVER';
      deviation = (Math.abs(over - under) / total) * 100;
    }

    else if (scanType === 'DIFFERS') {
      const digits = prices.map(p => extractDigit(symbol, p));
      const last = digits[digits.length - 1];
      const matches = digits.filter(d => d === last).length;
      // We assume deviation is how much it differs from expected 10% frequency
      contractType = matches > (total * 0.1) ? 'DIFFERS' : 'DIFFERS';
      deviation = (Math.abs(matches - (total * 0.1)) / total) * 100;
    }

    return { contractType, deviation };
  };


const syncSignalToBot = (signal) => {
  // Symbol
  setSymbol(signal.symbol);
  symbolRef.current = signal.symbol;

  // Contract type
  setContractType(signal.contractType);
  contractTypeRef.current = signal.contractType;

  // Prediction digit (only when needed)
 if (['OVER', 'UNDER', 'DIFFERS'].includes(signal.contractType)) {
  predictionDigitRef.current = signal.predictionDigit;
}

};

  void syncSignalToBot;

  // ===================== FINALIZE BEST SIGNAL =====================
const finalizeBestSignal = (sessionId = scanSessionRef.current) => {
  if (sessionId !== scanSessionRef.current) return;

  const sorted = getRankedSignals();

  if (!sorted.length) {
    stopAll();
    return;
  }

  const best = sorted[0];
  closeScanSockets();
  setAnalysisStarted(false);
  setCurrentScanSymbol('');
  setStrongestSignal(best);
  setSignalTimeLeft(60);

  let generatedDigit = null;

  // ------------------ PREDICTION DIGIT LOGIC ------------------
  if (best.contractType === 'OVER') {
    generatedDigit = Math.floor(Math.random() * 4) + 1; // 1â€“4
  } else if (best.contractType === 'UNDER') {
    generatedDigit = Math.floor(Math.random() * 4) + 5; // 5â€“8
  }
   else if (best.contractType === 'DIFFERS') {
    generatedDigit = Math.floor(Math.random() * 4) + 5; // 5â€“8
  }

  // ------------------ SYNC SIGNAL â†’ BOT (CRITICAL FIX) ------------------
  symbolRef.current = best.symbol;
  contractTypeRef.current = best.contractType;

  if (generatedDigit !== null) {
    predictionDigitRef.current = generatedDigit;
    setPredictionDigit(generatedDigit); // UI only
  } else {
    predictionDigitRef.current = null;
    setPredictionDigit(null);
  }

  setSymbol(best.symbol);
  setContractType(best.contractType);

  try {
    alertSound.play().catch(() => null);
  } catch (error) {
    console.debug("Signal alert playback skipped.", error);
  }

  if (countdownInterval.current) clearInterval(countdownInterval.current);
  countdownInterval.current = setInterval(
    () => setSignalTimeLeft(p => (p <= 1 ? 0 : p - 1)),
    1000
  );

  if (signalTimeout.current) clearTimeout(signalTimeout.current);
  signalTimeout.current = setTimeout(() => {
    setStrongestSignal(null);
    setPredictionDigit(null);
    predictionDigitRef.current = null;
    setAnalysisStarted(false);
    closeScanSockets();
    if (countdownInterval.current) {
      clearInterval(countdownInterval.current);
      countdownInterval.current = null;
    }
  }, 60000);
};

  const signalConfidence = strongestSignal
    ? Math.min(99.8, Math.max(80.1, 80 + (Number(strongestSignal.deviation || 0) * 0.2)))
    : 0;
  const scanProgress = Math.min(100, (scannedMarketsCount / volatilityList.length) * 100);
  const topScanSymbol = topScanResult?.name || "--";
  const topScanDeviation = topScanResult?.deviation ?? 0;
  void topScanSymbol;

  const signalContractClass = strongestSignal
    ? `shub-contract-${strongestSignal.contractType.toLowerCase()}`
    : '';

  return (
    
      <div className="shub-shell">
        <div className="shub-header">
          <div className="shub-brand">
           
            <h2>THE <span className='brand-span'>ORACLE </span></h2>
            <span className='shub-steps'>Choose Preferred Trade Type, Scan & Execute. </span>
          </div>
          <div className={`shub-status ${analysisStarted && !strongestSignal ? 'shub-status--active' : ''}`}>
            {strongestSignal ? 'SIGNAL READY' : analysisStarted ? 'SCANNING LIVE' : 'SYSTEM IDLE'}
          </div>
        </div>

        <div className="shub-tabs" role="tablist" aria-label="Trade type">
          {TRADE_TYPE_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`shub-tab ${tradeType === tab.id ? 'shub-tab--active' : ''}`}
              onClick={() => {
                tradeTypeRef.current = tab.id;
                setTradeType(tab.id);
                if (analysisStarted) stopAll();
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        

        <div className="shub-display">
          {strongestSignal ? (
            <div className="shub-signal-card shub-pop">
              <div className="shub-signal-col shub-signal-col--left">
                <span className="shub-signal-tag">Signal Found</span>
                <div className="shub-signal-list">
                  <div className="shub-signal-row">
                    <span className="shub-signal-label">Market</span>
                    <strong className="shub-signal-value shub-signal-market">{symbolNames[strongestSignal.symbol]}</strong>
                  </div>
                  <div className="shub-signal-row">
                    <span className="shub-signal-label">Contract Type</span>
                    <strong className={`shub-signal-value shub-signal-type ${signalContractClass}`}>
                      {strongestSignal.contractType} {predictionDigit !== null && (
                    
                      <strong className="shub-signal-digit">{predictionDigit}</strong>
                    
                  )}
                    </strong>
                    
                  </div>
                  
                </div>
               
              </div>
              <div className="shub-signal-col shub-signal-col--right">
                 <div className="shub-confidence-box" >
                  <span className="shub-confidence-label">Confidence</span>
                  <span className="shub-confidence-value">{signalConfidence.toFixed(1)}%</span>
                  <span className="shub-confidence-bar">
                    <span style={{ width: `${signalConfidence}%` }} />
                  </span>
                </div>
                <div className="shub-time-box">
                  <p className="shub-time-value"><span className="shub-time-label">VALID FOR: </span> {signalTimeLeft}s </p>
                  
                </div>
              </div>
            </div>
          ) : (
            <div className="shub-analysis-card shub-pop">
              <div className="shub-analysis-col shub-analysis-col--left">
                <span className="shub-analysis-title">
                  {analysisStarted ? 'ANALYZING MARKET CONDITIONS' : 'ANALYSIS STANDBY'}
                </span>
                <div className="shub-analysis-stats">
                  <div className="shub-analysis-row">
                    <span>Markets scanned</span>
                    <strong>{analysisStarted ? `${scannedMarketsCount}/${volatilityList.length}` : '--'}</strong>
                  </div>
                  <div className="shub-analysis-row">
                    <span>Scanning now</span>
                    <strong>{analysisStarted ? currentScanSymbol || '--' : '--'}</strong>
                  </div>
                  
                  <div className="shub-analysis-row">
                    <span>Best deviation</span>
                    <strong>{analysisStarted ? `${topScanDeviation.toFixed(1)}%` : '--'}</strong>
                  </div>
                </div>
                <div className="shub-analysis-progress">
                  <span style={{ width: `${analysisStarted ? scanProgress : 0}%` }} />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="shub-actions">
          <div className="shub-actions-row">
            <button
              className={`shub-btn ${analysisStarted ? 'shub-btn--scan-stop' : 'shub-btn--scan'}`}
              onClick={handleToggleAnalysis}
            >
              {analysisStarted ? 'STOP SCAN' : 'SCAN MARKET'}
            </button>
            <button
              onClick={handleBotStart}
              className={`shub-btn ${isRunning ? 'shub-btn--run-stop' : 'shub-btn--run'}`}
            >
              {isRunning ? <FaStop /> : <FaPlay />} {isRunning ? "STOP BOT" : "RUN BOT"}
            </button>
          </div>
        </div>


        <div className="shub-controls">
          <div className="shub-settings">
            <div className="shub-settings-grid">
              <label>
                Stake
                <input type="number" value={initialStake} onChange={(e) => setInitialStake(e.target.value)} />
              </label>
              <label>
                Target Profit
                <input type="number" value={targetProfit} onChange={(e) => setTargetProfit(e.target.value)} />
              </label>
              <label>
                Stop Loss
                <input type="number" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
              </label>
            </div>

            <div className="shub-martingale-row">
              <label className="shub-toggle">
                <input type="checkbox" checked={useMartingale} onChange={(e) => setUseMartingale(e.target.checked)} />
                <span className="shub-toggle-track"></span>
              </label>
              <label className={`shub-multiplier-field ${useMartingale ? '' : 'shub-multiplier-field--disabled'}`}>
               Martingale
                <input
                  type="number"
                  step="0.1"
                  min="1"
                  value={martingaleMultiplier}
                  onChange={(e) => setMartingaleMultiplier(e.target.value)}
                  disabled={!useMartingale}
                />
              </label>
            </div>
          </div>
        </div>

        {proposalError && (
          <div className="shub-error">
            <strong>Error:</strong> {proposalError}
          </div>
        )}
      </div>
    
  );
};

export default Oracle;
