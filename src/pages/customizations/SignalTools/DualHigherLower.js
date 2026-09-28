import React, { useCallback, useEffect, useRef, useState } from 'react';
import Swal from 'sweetalert2';
import { FaPlay, FaStop } from 'react-icons/fa';
import { WS_SERVERS, isProduction } from '@/components/shared';
import { contract_stages } from '@/constants/contract-stage';
import { run_panel as run_panel_tabs } from '@/constants/run-panel';
import { observer } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import './DualHigherLower.css';

const DERIV_PUBLIC_WS_URL = isProduction() ? WS_SERVERS.PRODUCTION : WS_SERVERS.STAGING;
const DERIV_OPTIONS_API_URL = DERIV_PUBLIC_WS_URL.replace(/ws\/public$/, '');
const SYMBOL_OPTIONS = ['1HZ10V', 'R_10', '1HZ25V', 'R_25', '1HZ50V', 'R_50', '1HZ75V', 'R_75', '1HZ100V', 'R_100'];

const formatSymbolDisplay = (symbol) => {
  if (!symbol) return '';
  if (symbol.startsWith('1HZ')) return `${symbol.replace('1HZ', '').replace('V', '')}(1s)`;
  if (symbol.startsWith('R_')) return symbol.replace('R_', 'V');
  return symbol;
};

const getStoredAuthContext = () => {
  try {
    const authRaw = sessionStorage.getItem('auth_info');
    const accountsRaw = sessionStorage.getItem('deriv_accounts');

    if (!authRaw || !accountsRaw) return null;

    const { access_token } = JSON.parse(authRaw);
    const accounts = JSON.parse(accountsRaw);

    if (!access_token || !Array.isArray(accounts) || accounts.length === 0) return null;

    const activeLoginId = localStorage.getItem('active_loginid');
    const activeAccount =
      accounts.find((acc) => acc.account_id === activeLoginId) ||
      accounts.find((acc) => acc.account_id?.startsWith('DOT')) ||
      accounts[0];

    if (!activeAccount?.account_id) return null;

    return { accessToken: access_token, activeAccount };
  } catch (error) {
    console.error('[DualHigherLower] Failed to parse auth storage:', error);
    return null;
  }
};

const DualHigherLower = () => {
  const store = useStore();
  const { transactions, journal, summary_card, run_panel, client } = store || {};

  const [isRunning, setIsRunning] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState('R_10');
  const [barrierOffset, setBarrierOffset] = useState('0.10');
  const [barrierSide, setBarrierSide] = useState('+');
  const [duration, setDuration] = useState('1');
  const [durationUnit, setDurationUnit] = useState('t');
  const [stake, setStake] = useState('1');
  const [targetProfit, setTargetProfit] = useState('100');
  const [stopLoss, setStopLoss] = useState('100');
  const [martingaleMode, setMartingaleMode] = useState('net');
  const [mFactor, setMFactor] = useState('2.1');
  const [error, setError] = useState('');
  const [lastTickQuote, setLastTickQuote] = useState('-');

  const wsRef = useRef(null);
  const isRunningRef = useRef(false);
  const isAuthorizedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const shouldReconnectRef = useRef(true);
  const skipReconnectRef = useRef(false);
  const reconnectTimeoutRef = useRef(null);
  const isProcessingRef = useRef(false);
  const totalProfitRef = useRef(0);
  const activeContractsRef = useRef(new Set());
  const completedContractsRef = useRef(new Set());
  const contractMetaRef = useRef({});
  const pendingTradeContextsRef = useRef([]);
  const pendingProposalContextsRef = useRef(new Map());
  const nextStakeRef = useRef({ HIGHER: 1, LOWER: 1 });
  const transactionRecoveryTimeoutsRef = useRef(new Map());

  const publishNativeContract = useCallback((contractData) => {
    if (!transactions || !summary_card) return;
    transactions.onBotContractEvent(contractData);
    summary_card.onBotContractEvent(contractData);
  }, [summary_card, transactions]);

  const publishNativeError = useCallback((message) => {
    if (journal?.onError) journal.onError(message);
  }, [journal]);

  const publishNativeResult = useCallback((contractData) => {
    const isWon = contractData.result ? contractData.result === 'won' : contractData.profit > 0;
    const currency = contractData?.currency || client?.currency || 'USD';
    const profitValue = Number.isFinite(Number(contractData?.profit)) ? Number(contractData.profit) : 0;

    if (journal?.onLogSuccess) {
      journal.onLogSuccess({
        log_type: isWon ? 'profit' : 'lost',
        extra: { currency, profit: profitValue },
      });
    }
  }, [client?.currency, journal]);

  const stopTradingBot = useCallback((reason = 'Bot stopped.', options = {}) => {
    const preserveOpenContract = Boolean(options.preserveOpenContract || activeContractsRef.current.size > 0);

    setIsRunning(false);
    isRunningRef.current = false;
    isProcessingRef.current = false;
    pendingTradeContextsRef.current = [];
    pendingProposalContextsRef.current.clear();
    transactionRecoveryTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
    transactionRecoveryTimeoutsRef.current.clear();

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ forget_all: 'proposal' }));
      if (!preserveOpenContract) {
        wsRef.current.send(JSON.stringify({ forget_all: 'proposal_open_contract' }));
      }
    }

    run_panel?.setIsRunning?.(false);
    run_panel?.toggleDrawer?.(true);
    run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);
    run_panel?.setContractStage?.(preserveOpenContract ? contract_stages.IS_STOPPING : contract_stages.NOT_RUNNING);
    if (!preserveOpenContract) run_panel?.setHasOpenContract?.(false);

    if (reason && reason !== 'Bot stopped.') {
      setError(reason);
    } else {
      setError('');
    }
  }, [run_panel]);

  const getAuthenticatedUrl = useCallback(async () => {
    try {
      const authContext = getStoredAuthContext();
      if (!authContext) throw new Error('Session Missing');

      const { accessToken, activeAccount } = authContext;
      const res = await fetch(`${DERIV_OPTIONS_API_URL}accounts/${activeAccount.account_id}/otp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) throw new Error('OTP Request Failed');

      const json = await res.json();
      const authenticatedUrl = json?.data?.url;
      if (!authenticatedUrl) throw new Error('Authenticated URL Missing');
      return authenticatedUrl;
    } catch (error) {
      setError(error.message || 'Authentication error');
      return null;
    }
  }, []);

  const executeTradePair = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const barrierValue = `${barrierSide}${barrierOffset}`;
    const higherStake = Number(nextStakeRef.current.HIGHER.toFixed(2));
    const lowerStake = Number(nextStakeRef.current.LOWER.toFixed(2));
    const groupId = `dualhl-${selectedSymbol}-${Date.now()}`;
    const common = {
      proposal: 1,
      basis: 'stake',
      currency: client?.currency || 'USD',
      underlying_symbol: selectedSymbol,
      duration: Number(duration),
      duration_unit: durationUnit,
    };

    wsRef.current.send(JSON.stringify({
      ...common,
      amount: higherStake,
      contract_type: 'HIGHER',
      barrier: barrierValue,
      passthrough: {
        symbol: selectedSymbol,
        custom_type: 'HIGHER',
        sent_stake: higherStake,
        barrier: barrierValue,
        group_id: groupId,
      },
    }));

    wsRef.current.send(JSON.stringify({
      ...common,
      amount: lowerStake,
      contract_type: 'LOWER',
      barrier: barrierValue,
      passthrough: {
        symbol: selectedSymbol,
        custom_type: 'LOWER',
        sent_stake: lowerStake,
        barrier: barrierValue,
        group_id: groupId,
      },
    }));
  }, [barrierOffset, barrierSide, client?.currency, duration, durationUnit, selectedSymbol]);

  const handleProposal = useCallback((data) => {
    const proposalId = data.proposal?.id;
    const askPrice = data.proposal?.ask_price;
    const passthrough = data.proposal?.passthrough || data.echo_req?.passthrough;

    if (!proposalId || askPrice === undefined) {
      publishNativeError('Proposal without valid id or ask price');
      isProcessingRef.current = false;
      return;
    }

    run_panel?.setContractStage?.(contract_stages.PURCHASE_SENT);

    if (passthrough) {
      pendingTradeContextsRef.current.push(passthrough);
      pendingProposalContextsRef.current.set(String(proposalId), passthrough);
    }

    wsRef.current?.send(JSON.stringify({ buy: proposalId, price: askPrice }));
  }, [publishNativeError, run_panel]);

  const handleBuy = useCallback((data) => {
    if (data.error) {
      isProcessingRef.current = false;
      activeContractsRef.current.clear();
      run_panel?.setHasOpenContract?.(false);
      run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
      publishNativeError(data.error.message);
      return;
    }

    const { contract_id, transaction_id, buy_price, longcode } = data.buy;
    const proposalId = data.echo_req?.buy;
    const proposalKey = String(proposalId || '');
    const passthrough =
      (proposalId ? pendingProposalContextsRef.current.get(proposalKey) : null) ||
      pendingTradeContextsRef.current.shift() ||
      {};

    if (proposalId) pendingProposalContextsRef.current.delete(proposalKey);

    const { symbol, custom_type, sent_stake, barrier, group_id } = passthrough;
    if (!contract_id || !symbol || !custom_type) return;

    activeContractsRef.current.add(String(contract_id));

    const contractPayload = {
      id: contract_id,
      contract_id,
      transaction_ids: { buy: transaction_id },
      buy_price: buy_price ?? parseFloat(sent_stake),
      currency: client?.currency || 'USD',
      display_name: formatSymbolDisplay(symbol),
      underlying: symbol,
      underlying_symbol: symbol,
      contract_type: custom_type,
      barrier,
      longcode,
      date_start: Math.floor(Date.now() / 1000),
      group_id,
      status: 'open',
      is_sold: false,
    };

    contractMetaRef.current[String(contract_id)] = contractPayload;
    publishNativeContract(contractPayload);
    run_panel?.setHasOpenContract?.(true);
    run_panel?.setContractStage?.(contract_stages.PURCHASE_RECEIVED);
    wsRef.current?.send(JSON.stringify({ proposal_open_contract: 1, contract_id, subscribe: 1 }));
  }, [client?.currency, publishNativeContract, publishNativeError, run_panel]);

  const handleContractCompletion = useCallback((contract) => {
    const contractKey = String(contract.contract_id ?? '');
    if (!contractKey) return;

    const rawProfit = Number(contract.profit ?? 0);
    const item = {
      ...(contractMetaRef.current[contractKey] || {}),
      ...contract,
      id: contract.contract_id,
      contract_id: contract.contract_id,
      currency: contract.currency || client?.currency || 'USD',
      display_name: contract.display_name || formatSymbolDisplay(contract.underlying || contractMetaRef.current[contractKey]?.underlying_symbol),
      underlying: contract.underlying || contractMetaRef.current[contractKey]?.underlying_symbol,
      underlying_symbol: contract.underlying_symbol || contractMetaRef.current[contractKey]?.underlying_symbol,
      transaction_ids: contractMetaRef.current[contractKey]?.transaction_ids || contract.transaction_ids,
      result: rawProfit > 0 ? 'won' : 'lost',
      status: rawProfit > 0 ? 'won' : 'lost',
      is_sold: true,
    };

    totalProfitRef.current += rawProfit;
    activeContractsRef.current.delete(contractKey);
    completedContractsRef.current.add(contractKey);

    const side = contractMetaRef.current[contractKey]?.contract_type === 'HIGHER' ? 'HIGHER' : 'LOWER';
    if (martingaleMode === 'split') {
      if (rawProfit < 0) {
        nextStakeRef.current[side] = Number((nextStakeRef.current[side] * Number(mFactor || 1)).toFixed(2));
      } else {
        nextStakeRef.current[side] = Number(parseFloat(stake || '1').toFixed(2));
      }
    }

    publishNativeContract(item);
    publishNativeResult(item);

    if (activeContractsRef.current.size === 0) {
      isProcessingRef.current = false;
      if (martingaleMode === 'net') {
        if (totalProfitRef.current < 0) {
          nextStakeRef.current.HIGHER = Number((nextStakeRef.current.HIGHER * Number(mFactor || 1)).toFixed(2));
          nextStakeRef.current.LOWER = Number((nextStakeRef.current.LOWER * Number(mFactor || 1)).toFixed(2));
        } else {
          nextStakeRef.current = {
            HIGHER: Number(parseFloat(stake || '1').toFixed(2)),
            LOWER: Number(parseFloat(stake || '1').toFixed(2)),
          };
        }
      }

      const limitHit = totalProfitRef.current >= Number(targetProfit || 0) || totalProfitRef.current <= -Number(stopLoss || 0);
      if (limitHit) {
        stopTradingBot('Session ended by target/stop loss.', { preserveOpenContract: false });
        Swal.fire('Session Ended', `Final P/L: ${totalProfitRef.current.toFixed(2)} USD`, 'info');
      } else {
        run_panel?.setHasOpenContract?.(false);
        run_panel?.setContractStage?.(contract_stages.CONTRACT_CLOSED);
      }
    }
  }, [client?.currency, martingaleMode, mFactor, publishNativeContract, publishNativeResult, run_panel, stake, stopLoss, stopTradingBot, targetProfit]);

  const handleSocketMessage = useCallback((event) => {
    const data = JSON.parse(event.data);

    if (data.error) {
      setError(data.error.message || 'Unknown Deriv API error');
      publishNativeError(data.error.message || 'Unknown Deriv API error');
      isProcessingRef.current = false;
      return;
    }

    if (data.msg_type === 'authorize') {
      isAuthorizedRef.current = true;
      return;
    }

    if (data.msg_type === 'tick') {
      const quote = Number(data.tick?.quote);
      if (Number.isFinite(quote)) setLastTickQuote(quote.toString());

      if (!isRunningRef.current || activeContractsRef.current.size > 0 || isProcessingRef.current) return;
      isProcessingRef.current = true;
      executeTradePair();
      return;
    }

    if (data.msg_type === 'proposal') {
      if (isRunningRef.current) handleProposal(data);
      return;
    }

    if (data.msg_type === 'buy') {
      if (isRunningRef.current || activeContractsRef.current.size > 0) handleBuy(data);
      return;
    }

    if (data.msg_type === 'transaction') {
      const action = data.transaction?.action;
      const sellContractId = data.transaction?.contract_id;
      const contractKey = String(sellContractId ?? '');

      if (action !== 'sell' || !sellContractId || !activeContractsRef.current.has(contractKey)) return;
      if (completedContractsRef.current.has(contractKey)) return;

      if (transactionRecoveryTimeoutsRef.current.has(contractKey)) {
        clearTimeout(transactionRecoveryTimeoutsRef.current.get(contractKey));
      }

      const recoveryTimeoutId = setTimeout(() => {
        transactionRecoveryTimeoutsRef.current.delete(contractKey);
        if (!activeContractsRef.current.has(contractKey) || completedContractsRef.current.has(contractKey) || wsRef.current?.readyState !== WebSocket.OPEN) {
          return;
        }
        wsRef.current.send(JSON.stringify({ proposal_open_contract: 1, contract_id: sellContractId }));
      }, 1500);

      transactionRecoveryTimeoutsRef.current.set(contractKey, recoveryTimeoutId);
      return;
    }

    if (data.msg_type === 'proposal_open_contract') {
      const proposalOpenContract = data.proposal_open_contract;
      if (!proposalOpenContract) return;

      const contractKey = String(proposalOpenContract.contract_id ?? '');
      const normalizedStatus = String(proposalOpenContract.status || '').toLowerCase();
      const hasClosedStatus = Boolean(normalizedStatus) && normalizedStatus !== 'open';
      const isExpired = proposalOpenContract.is_expired === 1 || proposalOpenContract.is_expired === true || proposalOpenContract.is_expired === '1';
      const isSettleable = proposalOpenContract.is_settleable === 1 || proposalOpenContract.is_settleable === true || proposalOpenContract.is_settleable === '1';
      const isSold = proposalOpenContract.is_sold === 1 || proposalOpenContract.is_sold === true || proposalOpenContract.is_sold === '1' || hasClosedStatus || isExpired || isSettleable;

      const nativeContract = {
        ...(contractMetaRef.current[contractKey] || {}),
        ...proposalOpenContract,
        id: proposalOpenContract.contract_id,
        contract_id: proposalOpenContract.contract_id,
        buy_price: proposalOpenContract.buy_price ?? contractMetaRef.current[contractKey]?.buy_price ?? 0,
        currency: proposalOpenContract.currency || client?.currency || 'USD',
        display_name: proposalOpenContract.display_name || formatSymbolDisplay(proposalOpenContract.underlying_symbol || proposalOpenContract.underlying || contractMetaRef.current[contractKey]?.underlying_symbol),
        underlying_symbol: proposalOpenContract.underlying_symbol || proposalOpenContract.underlying || contractMetaRef.current[contractKey]?.underlying_symbol,
        underlying: proposalOpenContract.underlying || contractMetaRef.current[contractKey]?.underlying_symbol,
        transaction_ids: contractMetaRef.current[contractKey]?.transaction_ids || proposalOpenContract.transaction_ids,
        entry_spot: proposalOpenContract.entry_spot_display_value ?? proposalOpenContract.entry_spot ?? '-',
        exit_spot: isSold ? (proposalOpenContract.exit_tick_display_value ?? proposalOpenContract.exit_spot_display_value ?? proposalOpenContract.exit_tick ?? proposalOpenContract.exit_spot ?? '-') : undefined,
        is_sold: isSold,
        status: isSold ? (Number(proposalOpenContract.profit ?? 0) > 0 ? 'won' : 'lost') : proposalOpenContract.status || 'open',
        result: isSold ? (Number(proposalOpenContract.profit ?? 0) > 0 ? 'won' : 'lost') : undefined,
      };

      publishNativeContract(nativeContract);

      if (isSold && activeContractsRef.current.has(contractKey) && !completedContractsRef.current.has(contractKey)) {
        handleContractCompletion(proposalOpenContract);
      }
    }
  }, [client?.currency, executeTradePair, handleBuy, handleContractCompletion, handleProposal, publishNativeContract, publishNativeError]);

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
      try { existingSocket.close(); } catch (error) { console.error('[DualHigherLower] close error', error); }
    }

    isConnectingRef.current = true;

    try {
      const authenticatedUrl = requireAuth ? await getAuthenticatedUrl() : null;
      if (requireAuth && !authenticatedUrl) return false;

      const socketUrl = authenticatedUrl || DERIV_PUBLIC_WS_URL;
      const isAuthenticatedSocket = Boolean(authenticatedUrl);

      wsRef.current = new WebSocket(socketUrl);
      wsRef.current.onopen = () => {
        setError('');
        isAuthorizedRef.current = isAuthenticatedSocket;
        wsRef.current.send(JSON.stringify({ ticks: selectedSymbol, subscribe: 1 }));

        if (isAuthenticatedSocket) {
          wsRef.current.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
          activeContractsRef.current.forEach((activeContractId) => {
            wsRef.current.send(JSON.stringify({
              proposal_open_contract: 1,
              contract_id: Number(activeContractId),
              subscribe: 1,
            }));
          });
        }
      };
      wsRef.current.onmessage = handleSocketMessage;
      wsRef.current.onerror = () => setError('WebSocket connection error');
      wsRef.current.onclose = () => {
        isAuthorizedRef.current = false;
        wsRef.current = null;
        const shouldReconnect = shouldReconnectRef.current && !skipReconnectRef.current;
        skipReconnectRef.current = false;

        if (shouldReconnect) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connectTradingSocket({ requireAuth: true, forceReconnect: true });
          }, 1000);
        }
      };
      return true;
    } finally {
      isConnectingRef.current = false;
    }
  }, [getAuthenticatedUrl, handleSocketMessage, selectedSymbol]);

  const startBot = useCallback(async () => {
    if (!getStoredAuthContext()) {
      Swal.fire('Error', 'Login Required', 'error');
      return;
    }

    if (isRunning) {
      stopTradingBot('Bot stopped.');
      return;
    }

    totalProfitRef.current = 0;
    activeContractsRef.current.clear();
    completedContractsRef.current.clear();
    contractMetaRef.current = {};
    pendingTradeContextsRef.current = [];
    pendingProposalContextsRef.current.clear();
    nextStakeRef.current = {
      HIGHER: Number(parseFloat(stake || '1').toFixed(2)),
      LOWER: Number(parseFloat(stake || '1').toFixed(2)),
    };
    isProcessingRef.current = false;

    if (transactions?.clear) transactions.clear();
    if (summary_card?.clear) summary_card.clear();

    setError('');
    setIsRunning(true);
    isRunningRef.current = true;
    run_panel?.setIsRunning?.(true);
    run_panel?.setHasOpenContract?.(false);
    run_panel?.setContractStage?.(contract_stages.STARTING);
    if (run_panel) run_panel.run_id = `dualhigherlower-${Date.now()}`;
    run_panel?.toggleDrawer?.(true);
    run_panel?.setActiveTabIndex?.(run_panel_tabs.TRANSACTIONS);

    const didConnect = await connectTradingSocket({ requireAuth: true, forceReconnect: Boolean(wsRef.current && !isAuthorizedRef.current) });
    if (!didConnect) {
      setIsRunning(false);
      isRunningRef.current = false;
      run_panel?.setIsRunning?.(false);
      run_panel?.setHasOpenContract?.(false);
      run_panel?.setContractStage?.(contract_stages.NOT_RUNNING);
    }
  }, [connectTradingSocket, isRunning, run_panel, stake, stopTradingBot, summary_card, transactions]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    const shouldRequireAuth = Boolean(getStoredAuthContext());
    connectTradingSocket({ requireAuth: shouldRequireAuth });

    const watchdogId = setInterval(() => {
      if (!shouldReconnectRef.current) return;
      connectTradingSocket({ requireAuth: true });
    }, 1500);

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      clearInterval(watchdogId);
      if (wsRef.current) {
        skipReconnectRef.current = true;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectTradingSocket]);

  useEffect(() => {
    const handleExternalStop = () => {
      if (!isRunningRef.current && activeContractsRef.current.size === 0) return;
      stopTradingBot('Bot stopped from the Deriv run panel.', { preserveOpenContract: activeContractsRef.current.size > 0 });
    };

    observer.register('bot.click_stop', handleExternalStop);
    return () => {
      if (observer.isRegistered('bot.click_stop')) observer.unregister('bot.click_stop', handleExternalStop);
    };
  }, [stopTradingBot]);

  useEffect(() => {
    observer.register('dualhigherlower.start', startBot);
    observer.register('dualhigherlower.stop', stopTradingBot);

    return () => {
      if (observer.isRegistered('dualhigherlower.start')) observer.unregister('dualhigherlower.start', startBot);
      if (observer.isRegistered('dualhigherlower.stop')) observer.unregister('dualhigherlower.stop', stopTradingBot);
    };
  }, [startBot, stopTradingBot]);

  return (
    <div className='dhl-tool'>
      <header>
        <h1>Dual Higher/Lower</h1>
        <p>Manual execution bot for one selected volatility. Press Execute Trades, then it keeps opening the paired HIGHER/LOWER contract until you stop.</p>
      </header>

      <div className='dhl-settings'>
        <label>
          Volatility
          <select value={selectedSymbol} onChange={(e) => setSelectedSymbol(e.target.value)} disabled={isRunning}>
            {SYMBOL_OPTIONS.map((symbol) => (
              <option key={symbol} value={symbol}>{formatSymbolDisplay(symbol)}</option>
            ))}
          </select>
        </label>

        <label>
          Offset Barrier
          <input type='number' step='0.01' value={barrierOffset} onChange={(e) => setBarrierOffset(e.target.value)} disabled={isRunning} />
        </label>

        <label>
          Barrier Side
          <select value={barrierSide} onChange={(e) => setBarrierSide(e.target.value)} disabled={isRunning}>
            <option value='+'>+</option>
            <option value='-'>-</option>
          </select>
        </label>

        <label>
          Duration
          <input type='number' min='1' value={duration} onChange={(e) => setDuration(e.target.value)} disabled={isRunning} />
        </label>

        <label>
          Unit
          <select value={durationUnit} onChange={(e) => setDurationUnit(e.target.value)} disabled={isRunning}>
            <option value='t'>Ticks</option>
            <option value='s'>Seconds</option>
            <option value='m'>Minutes</option>
          </select>
        </label>

        <label>
          Stake (USD)
          <input type='number' step='0.01' value={stake} onChange={(e) => setStake(e.target.value)} disabled={isRunning} />
        </label>

        <label>
          Target Profit
          <input type='number' value={targetProfit} onChange={(e) => setTargetProfit(e.target.value)} disabled={isRunning} />
        </label>

        <label>
          Stop Loss
          <input type='number' value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} disabled={isRunning} />
        </label>

        <label>
          Martingale Mode
          <select value={martingaleMode} onChange={(e) => setMartingaleMode(e.target.value)} disabled={isRunning}>
            <option value='net'>When BOTH lose</option>
            <option value='split'>On every loss</option>
          </select>
        </label>

        <label>
          Multiplier
          <input type='number' step='0.1' value={mFactor} onChange={(e) => setMFactor(e.target.value)} disabled={isRunning} />
        </label>
      </div>

      <button type='button' className={isRunning ? 'stop' : ''} onClick={startBot}>
        {isRunning ? <FaStop /> : <FaPlay />} {isRunning ? ' STOP BOT' : ' EXECUTE TRADES'}
      </button>

      <div className='dhl-live-box'>
        <div>
          <span>Selected market</span>
          <strong>{formatSymbolDisplay(selectedSymbol)}</strong>
        </div>
        <div>
          <span>Barrier</span>
          <strong>{barrierSide}{barrierOffset}</strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>{duration} {durationUnit}</strong>
        </div>
        <div>
          <span>Last tick</span>
          <strong>{lastTickQuote}</strong>
        </div>
      </div>

      {error && <p className='dhl-error'>{error}</p>}
    </div>
  );
};

export default DualHigherLower;
