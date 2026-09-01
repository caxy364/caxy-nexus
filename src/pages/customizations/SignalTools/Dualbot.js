import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Swal from "sweetalert2";
import { FaPlay, FaStop } from "react-icons/fa";
import { WS_SERVERS, isProduction } from "@/components/shared";
import { contract_stages } from "@/constants/contract-stage";
import { run_panel as run_panel_tabs } from "@/constants/run-panel";
import { observer } from "@/external/bot-skeleton";
import { useStore } from "@/hooks/useStore";
import "./Dualbot.css";

const TRIGGER_MIN_DIGIT = 4;
const TRIGGER_MAX_DIGIT = 5;
const OVER_BARRIER = 5;
const UNDER_BARRIER = 4;
const JOURNAL_SLOT_ID = "db-journal-custom-slot";
const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, "");
const ALL_SYMBOLS = ["1HZ10V", "R_10", "1HZ25V", "R_25", "1HZ50V", "R_50", "1HZ75V", "R_75", "1HZ100V", "R_100"];

const Dualbot = () => {
  const store = useStore();
  const { transactions, journal, summary_card, run_panel, client } = store || {};
  const [isRunning, setIsRunning] = useState(false);
  const [, setResults] = useState([]);
  const [, setWins] = useState(0);
  const [, setLosses] = useState(0);
  const [, setTotalRuns] = useState(0);
  const [, setTotalProfit] = useState(0);
  const [liveDigits, setLiveDigits] = useState({});
  const [lastTriggeredSymbol, setLastTriggeredSymbol] = useState(null);
  const [journalMonitorTarget, setJournalMonitorTarget] = useState(null);
  const [proposalError, setProposalError] = useState("");

  const [stake, setStake] = useState("1");
  const [targetProfit, setTargetProfit] = useState("100");
  const [stopLoss, setStopLoss] = useState("100");
  const [martingaleMode, setMartingaleMode] = useState("net");
  const [mFactor, setMFactor] = useState("2.1");
  const [checkDigits, setCheckDigits] = useState(4);

  const stakeRef = useRef("1");
  const targetProfitRef = useRef("100");
  const stopLossRef = useRef("100");
  const mFactorRef = useRef("2.1");
  const mModeRef = useRef("net");
  const checkDigitsRef = useRef(4);

  const nextStakeRef = useRef({ OVER: 1, UNDER: 1 });
  const wsRef = useRef(null);
  const totalProfitRef = useRef(0);
  const isRunningRef = useRef(false);
  const isAuthorizedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const shouldReconnectRef = useRef(true);
  const skipReconnectRef = useRef(false);
  const socketRequiresAuthRef = useRef(false);
  const reconnectTimeoutRef = useRef(null);
  const activeContractsRef = useRef(new Set());
  const completedContractsRef = useRef(new Set());
  const isProcessingRef = useRef(false);
  const pendingProposalRef = useRef(false);
  const digitHistoryRef = useRef({});
  const contractMetaRef = useRef({});
  const tradeGroupRef = useRef({});
  const loggedContractResultsRef = useRef(new Set());
  const pendingTradeContextsRef = useRef([]);
  const transactionRecoveryTimeoutsRef = useRef(new Map());

  useEffect(() => { stakeRef.current = stake; }, [stake]);
  useEffect(() => { targetProfitRef.current = targetProfit; }, [targetProfit]);
  useEffect(() => { stopLossRef.current = stopLoss; }, [stopLoss]);
  useEffect(() => { mFactorRef.current = mFactor; }, [mFactor]);
  useEffect(() => { mModeRef.current = martingaleMode; }, [martingaleMode]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { checkDigitsRef.current = checkDigits; }, [checkDigits]);
  useEffect(() => {
    run_panel?.setIsRunning?.(isRunning);
    if (!isRunning && activeContractsRef.current.size === 0) {
      run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
    }
  }, [isRunning, run_panel]);

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
    const isWon = contractData.result ? contractData.result === "won" : contractData.profit > 0;
    const normalizedCurrency = contractData?.currency || client?.currency || "USD";
    const normalizedProfit = Number.isFinite(Number(contractData?.profit)) ? Number(contractData.profit) : 0;

    if (journal?.onLogSuccess) {
      journal.onLogSuccess({
        log_type: isWon ? "profit" : "lost",
        extra: {
          currency: normalizedCurrency,
          profit: normalizedProfit,
        },
      });
    }
  }, [client?.currency, journal]);

  const formatSymbolDisplay = (sym) => {
    if (!sym) return "";
    if (sym.startsWith("1HZ")) return sym.replace("1HZ", "").replace("V", "") + "(1s)";
    if (sym.startsWith("R_")) return sym.replace("R_", "V");
    return sym;
  };

  const getStoredAuthContext = useCallback(() => {
    try {
      const authRaw = sessionStorage.getItem("auth_info");
      const accountsRaw = sessionStorage.getItem("deriv_accounts");

      if (!authRaw || !accountsRaw) return null;

      const { access_token } = JSON.parse(authRaw);
      const accounts = JSON.parse(accountsRaw);

      if (!access_token || !Array.isArray(accounts) || accounts.length === 0) {
        return null;
      }

      const activeLoginId = localStorage.getItem("active_loginid");
      const activeAccount =
        accounts.find(acc => acc.account_id === activeLoginId) ||
        accounts.find(acc => acc.account_id?.startsWith("DOT")) ||
        accounts[0];

      if (!activeAccount?.account_id) return null;

      return {
        accessToken: access_token,
        activeAccount,
      };
    } catch (error) {
      console.error("[Dualbot] Failed to parse Deriv session storage:", error);
      return null;
    }
  }, []);

  const getAuthenticatedUrl = useCallback(async () => {
    try {
      const authContext = getStoredAuthContext();
      if (!authContext) throw new Error("Session Missing");

      const { accessToken, activeAccount } = authContext;
      const res = await fetch(`${DERIV_OPTIONS_API_URL}accounts/${activeAccount.account_id}/otp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!res.ok) throw new Error("OTP Request Failed");

      const json = await res.json();
      const authenticatedUrl = json?.data?.url;

      if (!authenticatedUrl) throw new Error("Authenticated URL Missing");

      return authenticatedUrl;
    } catch (error) {
      setProposalError(error.message);
      return null;
    }
  }, [getStoredAuthContext]);

  const clearTradingState = useCallback((preserveOpenContract = false) => {
    if (!preserveOpenContract) {
      activeContractsRef.current.clear();
      completedContractsRef.current.clear();
      contractMetaRef.current = {};
      tradeGroupRef.current = {};
      loggedContractResultsRef.current = new Set();
      isProcessingRef.current = false;
    }

    pendingProposalRef.current = false;
    pendingTradeContextsRef.current = [];
    transactionRecoveryTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
    transactionRecoveryTimeoutsRef.current.clear();
  }, []);

  const stopTradingBot = useCallback((reason = "Bot stopped.", options = {}) => {
    const { preserveOpenContract = activeContractsRef.current.size > 0 || run_panel?.has_open_contract } = options;

    setIsRunning(false);
    isRunningRef.current = false;
    clearTradingState(preserveOpenContract);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ forget_all: "proposal" }));
      if (!preserveOpenContract) {
        wsRef.current.send(JSON.stringify({ forget_all: "proposal_open_contract" }));
      }
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

    console.log(reason);
  }, [clearTradingState, run_panel]);

  const handleStop = useCallback(() => {
    stopTradingBot("Bot stopped.");
  }, [stopTradingBot]);

  const syncTradeGroupOutcome = useCallback((groupId) => {
    if (!groupId) return;

    const group = tradeGroupRef.current[groupId];
    if (!group) return;

    const settledContracts = Object.values(group.contracts || {});
    if (!settledContracts.length) return;

    const hasWinningContract = settledContracts.some(contract => parseFloat(contract.profit ?? 0) > 0);
    const isResolved = settledContracts.length >= 2;

    if (!hasWinningContract && !isResolved) return;

    const pairStatus = hasWinningContract ? "won" : "lost";
    const pairLabel = pairStatus === "won" ? "WIN" : "LOSS";

    settledContracts.forEach(contract => {
      const pairedContract = {
        ...contract,
        result: pairStatus,
        status: pairStatus,
      };

      publishNativeContract(pairedContract);

      if (!loggedContractResultsRef.current.has(contract.contract_id)) {
        publishNativeResult(pairedContract);
        loggedContractResultsRef.current.add(contract.contract_id);
      }
    });

    setResults(prev => prev.map(item => (
      group.contracts[item.id]
        ? { ...item, status: pairLabel }
        : item
    )));
  }, [publishNativeContract, publishNativeResult]);

  useEffect(() => {
    const updatedLiveDigits = { ...liveDigits };
    let hasChanged = false;

    Object.keys(digitHistoryRef.current).forEach(symbol => {
      const history = Array.isArray(digitHistoryRef.current[symbol]) ? digitHistoryRef.current[symbol] : [];

      if (history.length > checkDigits) {
        const trimmed = history.slice(-checkDigits);
        digitHistoryRef.current[symbol] = trimmed;
        updatedLiveDigits[symbol] = trimmed;
        hasChanged = true;
      } else if (!Array.isArray(digitHistoryRef.current[symbol])) {
        digitHistoryRef.current[symbol] = history;
        updatedLiveDigits[symbol] = history;
        hasChanged = true;
      }
    });

    if (hasChanged) {
      setLiveDigits(updatedLiveDigits);
    }
  }, [checkDigits, liveDigits]);

  useEffect(() => {
    if (!isRunning) {
      const base = Number(parseFloat(stakeRef.current).toFixed(2)) || 1;
      nextStakeRef.current = { OVER: base, UNDER: base };
    }
  }, [stake, isRunning]);

  const renderCompactMonitor = () => (
    <div className="compact-monitor-row">
      {ALL_SYMBOLS.map(sym => (
        <div key={sym} className={`mini-card ${lastTriggeredSymbol === sym ? "mini-pop" : ""}`}>
          <span className="mini-symbol">{formatSymbolDisplay(sym)}</span>
          <div className="mini-digits">
            {(Array.isArray(liveDigits?.[sym]) ? liveDigits[sym] : []).map((d, i) => (
              <span key={i} className={`mini-digit ${d >= TRIGGER_MIN_DIGIT && d <= TRIGGER_MAX_DIGIT ? "mid" : ""}`}>{d}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  const handleContractCompletion = useCallback((c) => {
    const profit = parseFloat(c.profit);
    const contractId = c.contract_id;
    const contractKey = String(contractId);
    const factor = parseFloat(mFactorRef.current);
    const baseStake = Number(parseFloat(stakeRef.current).toFixed(2));
    const side = c.contract_type === "DIGITOVER" ? "OVER" : "UNDER";
    const groupId = contractMetaRef.current[contractKey]?.group_id;

    if (mModeRef.current === "split") {
      if (profit < 0) {
        const nextVal = nextStakeRef.current[side] * factor;
        nextStakeRef.current[side] = Number(nextVal.toFixed(2));
      } else {
        nextStakeRef.current[side] = baseStake;
      }
    }

    totalProfitRef.current += profit;
    activeContractsRef.current.delete(contractKey);
    completedContractsRef.current.add(contractKey);

    const nativeContract = {
      ...(contractMetaRef.current[contractKey] || {}),
      ...c,
      id: contractId,
      contract_id: contractId,
      buy_price: c.buy_price ?? contractMetaRef.current[contractKey]?.buy_price ?? 0,
      currency: c.currency || client?.currency || "USD",
      display_name: c.display_name || formatSymbolDisplay(c.underlying_symbol || c.underlying || contractMetaRef.current[contractKey]?.underlying_symbol),
      underlying_symbol: c.underlying_symbol || c.underlying || contractMetaRef.current[contractKey]?.underlying_symbol,
      underlying: c.underlying || contractMetaRef.current[contractKey]?.underlying_symbol,
      transaction_ids: contractMetaRef.current[contractKey]?.transaction_ids || c.transaction_ids,
      entry_spot: c.entry_spot_display_value ?? c.entry_spot ?? "-",
      exit_spot: c.exit_tick_display_value ?? c.exit_spot_display_value ?? c.exit_tick ?? c.exit_spot ?? "-",
      result: profit > 0 ? "won" : "lost",
      status: profit > 0 ? "won" : "lost",
      is_sold: true,
    };

    if (groupId) {
      tradeGroupRef.current[groupId] = tradeGroupRef.current[groupId] || { contracts: {} };
      tradeGroupRef.current[groupId].contracts[contractId] = nativeContract;
    } else {
      publishNativeContract(nativeContract);
      publishNativeResult(nativeContract);
    }

    setResults(prev => prev.map(r => r.id === contractId ? {
      ...r,
      entry_spot: c.entry_spot_display_value ?? r.entry_spot,
      exit_spot: c.exit_tick_display_value ?? c.exit_spot_display_value ?? r.exit_spot,
      profit: profit,
      status: profit > 0 ? "WIN" : "LOSS"
    } : r));

    if (groupId) {
      syncTradeGroupOutcome(groupId);
    }

    setTotalProfit(totalProfitRef.current.toFixed(2));
    if (profit > 0) setWins(p => p + 1); else setLosses(p => p + 1);
    setTotalRuns(p => p + 1);

    if (activeContractsRef.current.size === 0) {
      isProcessingRef.current = false;
      pendingProposalRef.current = false;

      if (mModeRef.current === "net") {
        setResults(currentResults => {
          const lastTwo = currentResults.slice(0, 2);
          const combinedProfit = lastTwo.reduce((acc, r) => acc + (parseFloat(r.profit) || 0), 0);
          if (combinedProfit < 0) {
            const nOver = nextStakeRef.current.OVER * factor;
            const nUnder = nextStakeRef.current.UNDER * factor;
            nextStakeRef.current.OVER = Number(nOver.toFixed(2));
            nextStakeRef.current.UNDER = Number(nUnder.toFixed(2));
          } else {
            nextStakeRef.current = { OVER: baseStake, UNDER: baseStake };
          }
          return currentResults;
        });
      }

      const isLimitHit = totalProfitRef.current >= parseFloat(targetProfitRef.current) ||
                         totalProfitRef.current <= -parseFloat(stopLossRef.current);

      if (isLimitHit) {
        stopTradingBot("Session ended by target/stop loss.", { preserveOpenContract: false });
        Swal.fire("Session Ended", `Final P/L: ${totalProfitRef.current.toFixed(2)} USD`, "info");
      } else {
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(isRunningRef.current ? contract_stages.CONTRACT_CLOSED : contract_stages.NOT_RUNNING);
      }
    }
  }, [client?.currency, publishNativeContract, publishNativeResult, run_panel, stopTradingBot, syncTradeGroupOutcome]);

  const handleBuy = useCallback((data) => {
    if (data.error) {
      isProcessingRef.current = false;
      pendingProposalRef.current = false;
      activeContractsRef.current.clear();
      run_panel?.setHasOpenContract?.(false);
      run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
      publishNativeError(data.error.message);
      return;
    }

    const { contract_id, transaction_id, buy_price, longcode } = data.buy;
    const tradeContext = pendingTradeContextsRef.current.shift() || {};
    const { symbol, custom_type, sent_stake, group_id, deriv_contract_type } = tradeContext;
    const contractKey = String(contract_id);
    activeContractsRef.current.add(contractKey);

    const transactionPayload = {
      id: contract_id,
      contract_id,
      transaction_ids: { buy: transaction_id },
      buy_price: buy_price ?? parseFloat(sent_stake),
      currency: client?.currency || "USD",
      display_name: formatSymbolDisplay(symbol),
      underlying: symbol,
      underlying_symbol: symbol,
      contract_type: deriv_contract_type || custom_type,
      longcode,
      date_start: Math.floor(Date.now() / 1000),
      group_id,
    };

    contractMetaRef.current[contractKey] = transactionPayload;
    publishNativeContract(transactionPayload);
    run_panel?.setHasOpenContract?.(true);
    run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);

    setResults(prev => [{
      id: contract_id,
      symbol,
      contract_type: custom_type,
      entry_spot: "-",
      exit_spot: "-",
      profit: 0,
      stake: parseFloat(sent_stake).toFixed(2),
      status: "PENDING",
    }, ...prev]);

    wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id, subscribe: 1 }));
  }, [client?.currency, publishNativeContract, publishNativeError, run_panel]);

  const handleProposal = useCallback((data) => {
    run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);
    if (data.proposal?.passthrough) {
      pendingTradeContextsRef.current.push(data.proposal.passthrough);
    } else if (data.echo_req?.passthrough) {
      pendingTradeContextsRef.current.push(data.echo_req.passthrough);
    }
    wsRef.current.send(JSON.stringify({
      buy: data.proposal.id,
      price: data.proposal.ask_price,
    }));
  }, [run_panel]);

  const executeDualTrade = useCallback((symbol) => {
    const sOver = Number(nextStakeRef.current.OVER.toFixed(2));
    const sUnder = Number(nextStakeRef.current.UNDER.toFixed(2));
    const groupId = `pair-${symbol}-${Date.now()}`;
    const common = {
      proposal: 1,
      basis: "stake",
      currency: client?.currency || "USD",
      underlying_symbol: symbol,
      duration: 1,
      duration_unit: "t",
    };

    pendingProposalRef.current = true;

    wsRef.current.send(JSON.stringify({
      ...common,
      amount: sOver,
      contract_type: "DIGITOVER",
      barrier: OVER_BARRIER,
      passthrough: {
        custom_type: "OVER",
        deriv_contract_type: "DIGITOVER",
        symbol,
        sent_stake: sOver,
        group_id: groupId,
      }
    }));
    wsRef.current.send(JSON.stringify({
      ...common,
      amount: sUnder,
      contract_type: "DIGITUNDER",
      barrier: UNDER_BARRIER,
      passthrough: {
        custom_type: "UNDER",
        deriv_contract_type: "DIGITUNDER",
        symbol,
        sent_stake: sUnder,
        group_id: groupId,
      }
    }));
  }, [client?.currency]);

  const handleTick = useCallback((tick) => {
    const { symbol, quote } = tick;
    const currentDigit = parseInt(quote.toString().slice(-1));
    const limit = checkDigitsRef.current;

    if (!digitHistoryRef.current[symbol]) digitHistoryRef.current[symbol] = [];
    digitHistoryRef.current[symbol].push(currentDigit);

    if (digitHistoryRef.current[symbol].length > limit) {
      digitHistoryRef.current[symbol].shift();
    }

    const history = [...digitHistoryRef.current[symbol]];
    setLiveDigits(prev => ({ ...prev, [symbol]: history }));

    if (!isRunningRef.current || activeContractsRef.current.size > 0 || isProcessingRef.current || pendingProposalRef.current) return;

    if (
      history.length === limit &&
      history.every(d => d >= TRIGGER_MIN_DIGIT && d <= TRIGGER_MAX_DIGIT)
    ) {
      isProcessingRef.current = true;
      setLastTriggeredSymbol(symbol);
      digitHistoryRef.current[symbol] = [];
      executeDualTrade(symbol);
      setTimeout(() => setLastTriggeredSymbol(null), 2000);
    }
  }, [executeDualTrade]);

  const handleSocketMessage = useCallback((event) => {
    const data = JSON.parse(event.data);

    if (data.msg_type === "tick") {
      handleTick(data.tick);
      return;
    }

    if (data.msg_type === "authorize") {
      isAuthorizedRef.current = true;
      return;
    }

    if (data.msg_type === "proposal" && data.proposal) {
      if (isRunningRef.current) handleProposal(data);
      return;
    }

    if (data.msg_type === "buy") {
      if (isRunningRef.current || activeContractsRef.current.size > 0) handleBuy(data);
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

    if (data.msg_type === "proposal_open_contract") {
      const c = data.proposal_open_contract;
      const contractKey = String(c?.contract_id ?? "");
      if (!c) return;

      const normalizedStatus = String(c.status || "").toLowerCase();
      const hasClosedStatus = Boolean(normalizedStatus) && normalizedStatus !== "open";
      const isExpired = c.is_expired === 1 || c.is_expired === true || c.is_expired === "1";
      const isSettleable = c.is_settleable === 1 || c.is_settleable === true || c.is_settleable === "1";
      const isSold = c.is_sold === 1 || c.is_sold === true || c.is_sold === "1" || hasClosedStatus || isExpired || isSettleable;

      const nativeContract = {
        ...(contractMetaRef.current[contractKey] || {}),
        ...c,
        id: c.contract_id,
        contract_id: c.contract_id,
        buy_price: c.buy_price ?? contractMetaRef.current[contractKey]?.buy_price ?? 0,
        currency: c.currency || client?.currency || "USD",
        display_name: c.display_name || formatSymbolDisplay(c.underlying_symbol || c.underlying || contractMetaRef.current[contractKey]?.underlying_symbol),
        underlying_symbol: c.underlying_symbol || c.underlying || contractMetaRef.current[contractKey]?.underlying_symbol,
        underlying: c.underlying || contractMetaRef.current[contractKey]?.underlying_symbol,
        transaction_ids: contractMetaRef.current[contractKey]?.transaction_ids || c.transaction_ids,
        entry_spot: c.entry_spot_display_value ?? c.entry_spot ?? "-",
        exit_spot: isSold ? (c.exit_tick_display_value ?? c.exit_spot_display_value ?? c.exit_tick ?? c.exit_spot ?? "-") : undefined,
        is_sold: isSold,
        status: isSold ? (parseFloat(c.profit ?? 0) > 0 ? "won" : "lost") : c.status || "open",
        result: isSold ? (parseFloat(c.profit ?? 0) > 0 ? "won" : "lost") : undefined,
      };

      publishNativeContract(nativeContract);

      if (isSold && activeContractsRef.current.has(contractKey) && !completedContractsRef.current.has(contractKey)) {
        handleContractCompletion(c);
      }
      return;
    }

    if (data.error) {
      setProposalError(data.error.message || "Unknown Deriv API error");
      publishNativeError(data.error.message);
      pendingProposalRef.current = false;
      isProcessingRef.current = false;
      pendingTradeContextsRef.current = [];
    }
  }, [client?.currency, handleBuy, handleContractCompletion, handleProposal, handleTick, publishNativeContract, publishNativeError]);

  const connectTradingSocket = useCallback(async (options = {}) => {
    const { requireAuth = false, forceReconnect = false } = options;
    const wsReady = wsRef.current?.readyState;

    if (!forceReconnect && (wsReady === WebSocket.OPEN || wsReady === WebSocket.CONNECTING || isConnectingRef.current)) {
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
        console.error("[Dualbot] Failed to close existing socket:", error);
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
        setProposalError("");
        isAuthorizedRef.current = isAuthenticatedSocket;

        ALL_SYMBOLS.forEach(sym => wsRef.current.send(JSON.stringify({ ticks: sym, subscribe: 1 })));

        if (isAuthenticatedSocket) {
          wsRef.current.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
          activeContractsRef.current.forEach(activeContractId => {
            wsRef.current.send(JSON.stringify({
              proposal_open_contract: 1,
              contract_id: Number(activeContractId),
              subscribe: 1,
            }));
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
  }, [getAuthenticatedUrl, handleSocketMessage]);

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
      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      window.clearInterval(watchdogId);
      if (wsRef.current) {
        skipReconnectRef.current = true;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectTradingSocket, getStoredAuthContext]);

  const handleStart = useCallback(async () => {
    if (!getStoredAuthContext()) return Swal.fire("Error", "Login Required", "error");

    if (isRunning) {
      handleStop();
      return;
    }

    totalProfitRef.current = 0;
    clearTradingState(false);
    setResults([]);
    setWins(0);
    setLosses(0);
    setTotalRuns(0);
    setTotalProfit(0);
    setProposalError("");
    if (transactions?.clear) transactions.clear();
    if (summary_card?.clear) summary_card.clear();
    run_panel?.setIsRunning?.(true);
    run_panel?.setHasOpenContract?.(false);
    run_panel?.setContractStage?.(contract_stages.STARTING);
    if (run_panel) {
      run_panel.run_id = `dualbot-${Date.now()}`;
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
  }, [clearTradingState, connectTradingSocket, getStoredAuthContext, handleStop, isRunning, run_panel, summary_card, transactions]);

  useEffect(() => {
    const handleExternalStop = () => {
      if (!isRunningRef.current && activeContractsRef.current.size === 0 && !run_panel?.has_open_contract) return;

      stopTradingBot("Bot stopped from the Deriv run panel.", {
        preserveOpenContract: Boolean(activeContractsRef.current.size > 0 || run_panel?.has_open_contract),
      });
    };

    observer.register("bot.click_stop", handleExternalStop);

    return () => {
      if (observer.isRegistered("bot.click_stop")) {
        observer.unregister("bot.click_stop", handleExternalStop);
      }
    };
  }, [run_panel?.has_open_contract, stopTradingBot]);

  useEffect(() => {
    observer.register("dualbot.start", handleStart);
    observer.register("dualbot.stop", handleStop);

    return () => {
      if (observer.isRegistered("dualbot.start")) {
        observer.unregister("dualbot.start", handleStart);
      }
      if (observer.isRegistered("dualbot.stop")) {
        observer.unregister("dualbot.stop", handleStop);
      }
    };
  }, [handleStart, handleStop]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    if (run_panel?.active_index !== run_panel_tabs.JOURNAL) {
      setJournalMonitorTarget(null);
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const target = document.getElementById(JOURNAL_SLOT_ID);
      setJournalMonitorTarget(target || null);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [run_panel?.active_index]);

  return (
    <div className="speedbot-general-container">
      {journalMonitorTarget ? createPortal(renderCompactMonitor(), journalMonitorTarget) : null}
      <div className="dual-bot-header">
        <h1>Over5/Under4 EXECUTOR</h1>
        <p className="dual-bot-description">It scans through all Volatilities and Executes Trades
          in a volatility where {checkDigits} consecutive last digits stay between 4 and 5.</p>
      </div>

      <div className="bot-settings-arena">
        <div className="input-group">
          <label>Stake (USD)</label>
          <input type="number" step="0.01" value={stake} onChange={(e) => setStake(e.target.value)} disabled={isRunning} />
        </div>

        <div className="input-group-martingale">
          <label>Digits to Check</label>
          <select
            value={checkDigits}
            onChange={(e) => setCheckDigits(parseInt(e.target.value))}
            disabled={isRunning}
            className="digit-select"
          >
            <option value={2}>Last 2 Digits</option>
            <option value={3}>Last 3 Digits</option>
            <option value={4}>Last 4 Digits</option>
            <option value={5}>Last 5 Digits</option>
          </select>
        </div>

        <div className="input-group">
          <label>Target Profit</label>
          <input type="number" value={targetProfit} onChange={(e) => setTargetProfit(e.target.value)} disabled={isRunning} />
        </div>
        <div className="input-group">
          <label>Stop Loss</label>
          <input type="number" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} disabled={isRunning} />
        </div>
        <div className="input-group-martingale">
          <label>Martingale Mode</label>
          <select value={martingaleMode} onChange={(e) => setMartingaleMode(e.target.value)} disabled={isRunning}>
            <option value="net">When BOTH loose</option>
            <option value="split">On every loss</option>
          </select>
        </div>
        <div className="input-group">
          <label>Multiplier</label>
          <input type="number" step="0.1" value={mFactor} onChange={(e) => setMFactor(e.target.value)} disabled={isRunning} />
        </div>
      </div>

      <div className="execute-front-btn">
        <button onClick={handleStart} className={isRunning ? "scan-stop-button" : "scan-start-button"}>
          {isRunning ? <FaStop /> : <FaPlay />} {isRunning ? " STOP BOT" : " EXECUTE TRADES"}
        </button>
      </div>
      {renderCompactMonitor()}
      {proposalError && <div style={{ color: "#ff8080", marginTop: "12px", fontSize: "12px" }}><strong>Error:</strong> {proposalError}</div>}
    </div>
  );
};

export default Dualbot;
