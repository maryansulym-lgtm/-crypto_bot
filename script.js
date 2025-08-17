(function () {
  // Elements for tab navigation
  const tabSwap = document.getElementById('tab-swap');
  const tabPrediction = document.getElementById('tab-prediction');
  const sectionSwap = document.getElementById('section-swap');
  const sectionPerp = document.getElementById('section-perp');
  const sectionPrediction = document.getElementById('section-prediction');

  function showSwap() {
    tabSwap.classList.add('active');
    tabPrediction.classList.remove('active');
    sectionSwap.classList.add('active');
    sectionPerp.classList.remove('active');
    sectionPrediction.classList.remove('active');
  }

  function showPerp() {
    tabPerp.classList.add('active');
    tabSwap.classList.remove('active');
    tabPrediction.classList.remove('active');
    sectionPerp.classList.add('active');
    sectionSwap.classList.remove('active');
    sectionPrediction.classList.remove('active');
  }

  function showPrediction() {
    tabPrediction.classList.add('active');
    tabSwap.classList.remove('active');
    if (tabPerp) tabPerp.classList.remove('active');
    sectionPrediction.classList.add('active');
    sectionSwap.classList.remove('active');
    if (sectionPerp) sectionPerp.classList.remove('active');
    // Load current market cap and predictions when switching to this tab
    refreshMarketCap();
    fetchPredictions();
  }

  tabSwap.addEventListener('click', showSwap);
  tabPerp.addEventListener('click', showPerp);
  if (tabPrediction) {
    tabPrediction.addEventListener('click', showPrediction);
  }

  // Theme toggling
  const themeToggle = document.getElementById('theme-toggle');
  const body = document.body;

  function applyTheme(theme) {
    body.classList.toggle('dark', theme === 'dark');
    // Update icon
    themeToggle.textContent = theme === 'dark' ? '🌞' : '🌙';
  }

  // Load saved theme from localStorage (default light)
  const savedTheme = localStorage.getItem('tsx-theme') || 'light';
  applyTheme(savedTheme);

  themeToggle.addEventListener('click', () => {
    const currentTheme = body.classList.contains('dark') ? 'dark' : 'light';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
    localStorage.setItem('tsx-theme', newTheme);
  });

  // Integrate with Telegram Web App theme if available
  // If the Telegram Web App SDK is present, synchronise the app's theme with
  // Telegram's color scheme. When the user changes their Telegram theme,
  // update the UI accordingly. This ensures the mini app respects the
  // appearance settings on all devices and versions of Telegram.
  if (window.Telegram && Telegram.WebApp) {
    try {
      Telegram.WebApp.ready();
      // Determine initial theme from Telegram's color scheme
      const scheme = Telegram.WebApp.colorScheme;
      if (scheme === 'dark') {
        applyTheme('dark');
        localStorage.setItem('tsx-theme', 'dark');
      } else if (scheme === 'light') {
        applyTheme('light');
        localStorage.setItem('tsx-theme', 'light');
      }
      Telegram.WebApp.onEvent('themeChanged', () => {
        const updatedScheme = Telegram.WebApp.colorScheme;
        if (updatedScheme === 'dark') {
          applyTheme('dark');
          localStorage.setItem('tsx-theme', 'dark');
        } else {
          applyTheme('light');
          localStorage.setItem('tsx-theme', 'light');
        }
      });
    } catch (e) {
      console.warn('Telegram Web App integration failed', e);
    }
  }

  // Swap functionality
  const swapFrom = document.getElementById('swap-from');
  const swapTo = document.getElementById('swap-to');
  const swapAmount = document.getElementById('swap-amount');
  const swapEstimate = document.getElementById('swap-estimate');
  const swapButton = document.getElementById('swap-button');
  const swapResult = document.getElementById('swap-result');

  // Token decimal mapping used for converting human‑readable amounts to
  // smallest units when requesting quotes from the server. These values
  // correspond to common token standards: ETH (18), BTC (8), TON (9).
  const tokenDecimals = {
    ETH: 18,
    BTC: 8,
    TON: 9,
    GIFT: 9,
    STICKER: 9,
  };
  // Fallback conversion rates for offline estimation. Used if the server
  // cannot return a quote. These values approximate real market prices and
  // allow the UI to remain functional without a network connection.
  const fallbackRates = {
    ETH: { ETH: 1, BTC: 0.065, TON: 300, GIFT: 4000, STICKER: 5000 },
    BTC: { ETH: 15.4, BTC: 1, TON: 4600, GIFT: 60000, STICKER: 80000 },
    TON: { ETH: 0.0033, BTC: 0.00022, TON: 1, GIFT: 13, STICKER: 16 },
    GIFT: { ETH: 0.00025, BTC: 0.0000167, TON: 0.077, GIFT: 1, STICKER: 1.2 },
    STICKER: { ETH: 0.0002, BTC: 0.0000125, TON: 0.062, GIFT: 0.8, STICKER: 1 },
  };

  // Platform fee applied to swaps into TON. Represented as a decimal
  // fraction (0.003 = 0.3%). When the user selects TON as the output token,
  // this fee will be subtracted from the estimated amount.
  const swapFeeRateTon = 0.003;

  // Reference to the fee info element in the swap card
  const swapFeeInfo = document.getElementById('swap-fee-info');

  // Withdrawal fee rate (5%) applied to all user withdrawals
  const withdrawFeeRate = 0.05;

  // Elements for showing withdrawal details (fee and limits)
  const withdrawDetails = document.getElementById('withdraw-details');
  const withdrawFeeInfo = document.getElementById('withdraw-fee-info');
  const withdrawLimitInfo = document.getElementById('withdraw-limit-info');

  /**
   * Update the estimated output amount shown in the swap panel. This function
   * attempts to fetch a live quote from the server’s `/api/quote` endpoint.
   * The amount entered by the user is converted into the smallest unit of
   * the source token before being sent. If the quote cannot be retrieved
   * (for example due to missing API key or network issues), a fallback
   * estimate is calculated using predefined rates.
   */
  async function updateEstimate() {
    const from = swapFrom.value;
    const to = swapTo.value;
    const amountStr = swapAmount.value;
    const amountNum = parseFloat(amountStr);
    if (!from || !to || isNaN(amountNum)) {
      swapEstimate.value = '';
      return;
    }
    // Convert to smallest units using the known decimals; fall back to 0 decimals
    const decimals = tokenDecimals[from] ?? 0;
    // Use BigInt for safe integer arithmetic
    let rawAmount;
    try {
      const multiplier = 10 ** decimals;
      rawAmount = BigInt(Math.round(amountNum * multiplier)).toString();
    } catch (err) {
      rawAmount = (amountNum * (10 ** decimals)).toString();
    }
    try {
      const res = await fetch(
        `/api/quote?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&amount=${rawAmount}`
      );
      const data = await res.json();
      if (data && typeof data.estimated === 'number') {
        // If swapping into TON, display fee info and set net estimate
        if (to === 'TON') {
          // Show fee note and update its content if feeRate present
          swapFeeInfo.style.display = 'block';
          const feeRate = data.feeRate ?? swapFeeRateTon;
          // Show both gross and net amounts for transparency when gross is provided
          if (typeof data.gross === 'number') {
            swapFeeInfo.textContent = `Platform fee: ${(feeRate * 100).toFixed(2)}% on TON swaps (gross: ${data.gross.toFixed(6)}, net: ${data.estimated.toFixed(6)})`;
          } else {
            swapFeeInfo.textContent = `Platform fee: ${(feeRate * 100).toFixed(2)}% on TON swaps`;
          }
        } else {
          swapFeeInfo.style.display = 'none';
        }
        swapEstimate.value = data.estimated.toFixed(6);
        return;
      }
      // If no estimate returned, fall through to fallback below
    } catch (err) {
      // Network or server error, will fall back
    }
    // Fallback using static rates
    const rate =
      fallbackRates[from] && fallbackRates[from][to] ? fallbackRates[from][to] : 1;
    let estimated = amountNum * rate;
    if (to === 'TON') {
      // Apply fee on fallback and show fee note
      const net = estimated * (1 - swapFeeRateTon);
      swapFeeInfo.style.display = 'block';
      swapFeeInfo.textContent = `Platform fee: ${(swapFeeRateTon * 100).toFixed(2)}% on TON swaps (gross: ${estimated.toFixed(6)}, net: ${net.toFixed(6)})`;
      swapEstimate.value = net ? net.toFixed(6) : '';
    } else {
      swapFeeInfo.style.display = 'none';
      swapEstimate.value = estimated ? estimated.toFixed(6) : '';
    }
  }

  swapAmount.addEventListener('input', updateEstimate);
  swapFrom.addEventListener('change', updateEstimate);
  swapTo.addEventListener('change', updateEstimate);

  swapButton.addEventListener('click', async () => {
    const from = swapFrom.value;
    const to = swapTo.value;
    const amountNum = parseFloat(swapAmount.value);
    if (!from || !to || isNaN(amountNum) || amountNum <= 0) {
      swapResult.textContent = 'Enter a valid amount.';
      return;
    }
    // Convert to smallest units using decimals mapping
    const decimals = tokenDecimals[from] ?? 0;
    let rawAmount;
    try {
      const multiplier = 10 ** decimals;
      rawAmount = BigInt(Math.round(amountNum * multiplier)).toString();
    } catch (err) {
      rawAmount = (amountNum * (10 ** decimals)).toString();
    }
    const payload = {
      from,
      to,
      amount: rawAmount,
      slippage: 1.0,
      // Addresses can be provided here once wallet integration is added
      fromAddress: '',
      toAddress: '',
    };
    swapButton.disabled = true;
    swapResult.textContent = 'Processing...';
    try {
      const res = await fetch('/api/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data && data.success) {
        // Use estimated amount if available
        if (typeof data.estimated === 'number') {
          const toToken = payload.to;
          if (toToken === 'TON') {
            const feeRate = data.feeRate ?? swapFeeRateTon;
            if (typeof data.gross === 'number') {
              swapResult.textContent = `Swap prepared. Gross: ${data.gross.toFixed(6)}, Net after ${(feeRate * 100).toFixed(2)}% fee: ${data.estimated.toFixed(6)}`;
            } else {
              swapResult.textContent = `Swap prepared. Estimated output: ${data.estimated.toFixed(6)} (after ${(feeRate * 100).toFixed(2)}% fee)`;
            }
          } else {
            swapResult.textContent = `Swap prepared. Estimated output: ${data.estimated.toFixed(6)}`;
          }
        } else {
          swapResult.textContent = data.message || 'Swap prepared.';
        }
      } else {
        swapResult.textContent = data && data.message ? data.message : 'Swap failed.';
      }
    } catch (err) {
      swapResult.textContent = 'Error connecting to server.';
    } finally {
      swapButton.disabled = false;
    }
  });

  // Perp functionality removed. The application no longer supports
  // perpetual trading. All related UI elements, event handlers and
  // charts have been removed. Only swap and prediction markets remain.
  // updateEstimate(); is still called at the end of the script.

  // --------------------------------------------------------------------------
  // Wallet connection and balance handling
  let tonWalletAddress = null;
  let evmWalletAddress = null;

  const walletStatus = document.getElementById('wallet-status');
  const balanceDisplay = document.getElementById('balance-display');
  const withdrawArea = document.getElementById('withdraw-area');
  const connectTonBtn = document.getElementById('connect-ton');
  const connectEvmBtn = document.getElementById('connect-evm');
  const withdrawAmount = document.getElementById('withdraw-amount');
  const withdrawAddress = document.getElementById('withdraw-address');
  const withdrawButton = document.getElementById('withdraw-button');

  // Deposit address elements
  const depositInfo = document.getElementById('deposit-info');
  const depositAddressSpan = document.getElementById('deposit-address');
  const copyDepositButton = document.getElementById('copy-deposit');
  let mainDepositAddress = '';

  // Fallback deposit address. This should mirror the MAIN_WALLET_ADDRESS on the
  // server. If the app is running in file:// mode or cannot reach the
  // server to query /api/deposit_address, this address will be used.
  const fallbackDepositAddress = 'UQDSvn65kPkE4XP40QE9icGdllYbyOA2EtJr08yiaqWB5O9-';

  // Show fee and net calculations as user enters withdrawal amount
  if (withdrawAmount) {
    withdrawAmount.addEventListener('input', () => {
      const amt = parseFloat(withdrawAmount.value);
      if (amt && amt > 0) {
        const fee = amt * withdrawFeeRate;
        const net = amt - fee;
        if (withdrawFeeInfo) {
          withdrawFeeInfo.textContent = `Fee: ${(withdrawFeeRate * 100).toFixed(0)}% (${fee.toFixed(4)} TON), you will receive: ${net.toFixed(4)} TON`;
        }
        if (withdrawDetails) withdrawDetails.style.display = 'block';
      } else {
        if (withdrawFeeInfo) withdrawFeeInfo.textContent = '';
      }
    });
  }

  function updateWalletUI() {
    if (tonWalletAddress || evmWalletAddress) {
      let statusText = '';
      if (tonWalletAddress) {
        statusText += `TON wallet: ${tonWalletAddress}`;
      }
      if (evmWalletAddress) {
        if (statusText) statusText += ' | ';
        statusText += `EVM wallet: ${evmWalletAddress}`;
      }
      walletStatus.textContent = statusText;
    } else {
      walletStatus.textContent = 'No wallet connected.';
    }
    // Display balance and withdraw area only if TON wallet is connected
    if (tonWalletAddress) {
      withdrawArea.style.display = 'flex';
      fetchTonBalance();
      // When a TON wallet is connected, load withdrawal limits
      fetchWithdrawLimits();
    } else {
      withdrawArea.style.display = 'none';
      balanceDisplay.textContent = '';
      // Hide withdrawal info when no TON wallet
      if (withdrawDetails) withdrawDetails.style.display = 'none';
    }

    // Show deposit address if loaded
    if (mainDepositAddress) {
      depositAddressSpan.textContent = mainDepositAddress;
      depositInfo.style.display = 'block';
    }
  }

  async function fetchTonBalance() {
    if (!tonWalletAddress) return;
    try {
      const res = await fetch(`/api/balance?address=${encodeURIComponent(tonWalletAddress)}`);
      const data = await res.json();
      if (data && typeof data.balance === 'number') {
        balanceDisplay.textContent = `Balance: ${data.balance.toFixed(4)} TON`;
      } else {
        balanceDisplay.textContent = 'Balance: -- TON';
      }
    } catch (err) {
      balanceDisplay.textContent = 'Balance: -- TON';
    }
  }

  /**
   * Fetch the withdrawal limits for the current user. Displays how much
   * TON the user has withdrawn in the last day and month and how much
   * remains. Hides the information if no user is connected.
   */
  async function fetchWithdrawLimits() {
    if (!tonWalletAddress || !currentUserId) {
      if (withdrawDetails) withdrawDetails.style.display = 'none';
      return;
    }
    try {
      const res = await fetch(`/api/wallet/limits?userId=${encodeURIComponent(currentUserId)}`);
      const data = await res.json();
      if (data && data.daily && data.monthly) {
        const dailyRem = data.daily.remaining ?? 0;
        const dailyLimit = data.daily.limit ?? 0;
        const monthlyRem = data.monthly.remaining ?? 0;
        const monthlyLimit = data.monthly.limit ?? 0;
        if (withdrawLimitInfo) {
          withdrawLimitInfo.textContent = `Remaining today: ${dailyRem.toFixed(4)} / ${dailyLimit} TON · This month: ${monthlyRem.toFixed(4)} / ${monthlyLimit} TON`;
        }
        if (withdrawDetails) withdrawDetails.style.display = 'block';
      }
    } catch (err) {
      // On error hide the details
      if (withdrawDetails) withdrawDetails.style.display = 'none';
    }
  }

  // Simple TON wallet connection: prompt the user for their wallet address
  if (connectTonBtn) {
    connectTonBtn.addEventListener('click', () => {
      const addr = prompt('Enter your TON wallet address (beginning with EQ...)');
      if (addr) {
        tonWalletAddress = addr.trim();
        updateWalletUI();
        // Credit an initial demo balance on first connection
        ensureInitialBalance();
      }
    });
  }

  // EVM wallet connection using MetaMask if available, otherwise prompt for address
  if (connectEvmBtn) {
    connectEvmBtn.addEventListener('click', async () => {
      if (window.ethereum && window.ethereum.request) {
        try {
          const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
          if (accounts && accounts.length > 0) {
            evmWalletAddress = accounts[0];
            updateWalletUI();
            return;
          }
        } catch (err) {
          // fall through to manual entry
        }
      }
      const addr = prompt('Enter your EVM wallet address (e.g. 0x...)');
      if (addr) {
        evmWalletAddress = addr.trim();
        updateWalletUI();
      }
    });
  }

  // Withdraw TON handler: sends request to server
  if (withdrawButton) {
    withdrawButton.addEventListener('click', async () => {
      const amount = parseFloat(withdrawAmount.value);
      const to = withdrawAddress.value.trim();
      if (!tonWalletAddress) {
        alert('Connect a TON wallet first.');
        return;
      }
      if (!to) {
        alert('Enter a destination address.');
        return;
      }
      if (!amount || amount <= 0) {
        alert('Enter a valid amount.');
        return;
      }
      withdrawButton.disabled = true;
      try {
        // Withdraw from internal ledger. Debits immediately and enqueues onchain transfer.
        const payload = { userId: currentUserId, to, amountTon: amount };
        const res = await fetch('/api/wallet/withdraw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data && data.success) {
          // Clear input fields
          withdrawAmount.value = '';
          withdrawAddress.value = '';
          // Show detailed message including fee and net amounts if provided
          if (typeof data.feeTon === 'number' && typeof data.netTon === 'number') {
            alert(`Withdrawal queued. Gross: ${data.amountTon.toFixed(4)} TON, Fee: ${data.feeTon.toFixed(4)} TON, Net: ${data.netTon.toFixed(4)} TON → ${data.to}`);
          } else {
            alert(`Withdrawal queued: ${data.amountTon} TON to ${data.to}`);
          }
          // Refresh internal balance and limits
          await fetchInternalBalance();
          await fetchWithdrawLimits();
        } else {
          alert(data && data.message ? data.message : 'Withdrawal failed.');
        }
      } catch (err) {
        alert('Error connecting to server.');
      } finally {
        withdrawButton.disabled = false;
      }
    });
  }

  // Initialise wallet UI on page load
  updateWalletUI();

  /**
   * Fetch the platform's deposit address from the server. The address
   * identifies the wallet to which users should send TON in order to
   * deposit funds. Once retrieved, the address is stored and displayed
   * in the wallet section with a copy button.
   */
  async function fetchDepositAddress() {
    try {
      const res = await fetch('/api/deposit_address');
      const data = await res.json();
      if (data && data.address) {
        mainDepositAddress = data.address;
        // If wallet UI has already been initialised, show deposit info
        depositAddressSpan.textContent = mainDepositAddress;
        depositInfo.style.display = 'block';
      }
    } catch (err) {
      console.warn('Failed to fetch deposit address', err);
      // Use fallback if fetch fails
      mainDepositAddress = fallbackDepositAddress;
      depositAddressSpan.textContent = mainDepositAddress;
      depositInfo.style.display = 'block';
    }
  }

  // Copy the deposit address to clipboard when button is clicked
  if (copyDepositButton) {
    copyDepositButton.addEventListener('click', () => {
      if (mainDepositAddress) {
        navigator.clipboard.writeText(mainDepositAddress).then(() => {
          copyDepositButton.textContent = 'Copied!';
          setTimeout(() => {
            copyDepositButton.textContent = 'Copy';
          }, 1500);
        }).catch(() => {
          alert('Failed to copy address.');
        });
      }
    });
  }

  // Fetch deposit address on initial load
  fetchDepositAddress();

  // --------------------------------------------------------------------------
  // Prediction market functionality
  // Elements for prediction market panel
  const predAsset = document.getElementById('pred-asset');
  const predDirection = document.getElementById('pred-direction');
  const predExpiry = document.getElementById('pred-expiry');
  const predAmount = document.getElementById('pred-amount');
  const predRefresh = document.getElementById('pred-refresh');
  const predCapValue = document.getElementById('pred-cap-value');
  const predOpenButton = document.getElementById('pred-open-button');
  const predictionsList = document.getElementById('predictions-list');

  /**
   * Fetch the current market capitalisation for the selected asset and
   * display it in the UI. If the request fails, the cap is shown as --.
   */
  async function refreshMarketCap() {
    const asset = predAsset.value;
    if (!asset) {
      predCapValue.textContent = 'Market cap: --';
      return;
    }
    try {
      const res = await fetch(`/api/market_cap?asset=${encodeURIComponent(asset)}`);
      const data = await res.json();
      if (data && typeof data.capTon === 'number' && isFinite(data.capTon)) {
        // For TON we display the price in USD; for other assets the cap is in TON
        if (asset === 'TON') {
          predCapValue.textContent = `Price: $${data.capTon.toFixed(4)}`;
        } else {
          predCapValue.textContent = `Market cap: ${data.capTon.toFixed(2)} TON`;
        }
      } else {
        if (asset === 'TON') {
          predCapValue.textContent = 'Price: --';
        } else {
          predCapValue.textContent = 'Market cap: --';
        }
      }
    } catch (err) {
      predCapValue.textContent = 'Market cap: --';
    }
  }

  // Event listener to refresh market cap
  if (predRefresh) {
    predRefresh.addEventListener('click', refreshMarketCap);
  }

  /**
   * Open a new prediction. Sends the selected asset, direction, stake and
   * expiry to the server. On success, reloads the predictions list.
   */
  async function openPredictionHandler() {
    const asset = predAsset.value;
    const direction = predDirection.value;
    const amount = parseFloat(predAmount.value);
    const expiry = parseInt(predExpiry.value, 10);
    if (!asset || !direction || !amount || amount <= 0 || !expiry || expiry <= 0) {
      alert('Enter valid prediction details.');
      return;
    }
    // Require TON wallet connected for prediction staking
    if (!tonWalletAddress) {
      alert('Connect a TON wallet first.');
      return;
    }
    predOpenButton.disabled = true;
    try {
      const payload = { userId: currentUserId, asset, direction, amount, expiryMinutes: expiry };
      const res = await fetch('/api/prediction/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data && data.success) {
        // Clear stake and refresh lists and balance
        predAmount.value = '';
        await fetchPredictions();
        await fetchInternalBalance();
      } else {
        alert(data && data.message ? data.message : 'Failed to open prediction.');
      }
    } catch (err) {
      alert('Error connecting to server.');
    } finally {
      predOpenButton.disabled = false;
    }
  }

  if (predOpenButton) {
    predOpenButton.addEventListener('click', openPredictionHandler);
  }

  /**
   * Fetch the list of predictions from the server and render them in the UI.
   */
  async function fetchPredictions() {
    try {
      const res = await fetch(`/api/prediction?userId=${encodeURIComponent(currentUserId)}`);
      const data = await res.json();
      renderPredictions(data);
    } catch (err) {
      console.error('Failed to fetch predictions', err);
    }
  }

  /**
   * Render the prediction list. Each prediction shows its id, asset,
   * direction, stake, entry cap, expiry time and status. If the
   * prediction is open and expired, a "Settle" button is shown to allow
   * settlement. Closed predictions show whether they won or lost.
   * @param {Array} list
   */
  function renderPredictions(list) {
    predictionsList.innerHTML = '';
    // If no markets, show a placeholder
    if (!Array.isArray(list) || list.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No predictions yet.';
      predictionsList.appendChild(li);
      return;
    }
    // For each market, list the user's bets
    list.forEach(market => {
      const myBets = (market.bets || []).filter(b => b.userId === currentUserId);
      if (myBets.length === 0) return;
      myBets.forEach(bet => {
        const li = document.createElement('li');
        const date = new Date(market.expiry);
        const expired = Date.now() > market.expiry;
        let html = `<strong>Market #${market.id}</strong> ${market.asset}`;
        html += ` · Expiry: ${date.toLocaleString()}`;
        html += `<br>Stake: ${bet.stakeTon} TON · Side: ${bet.direction}`;
        html += `<br>Strike: ${typeof market.strike === 'number' ? market.strike.toFixed(2) : '--'} TON`;
        if (market.status === 'settled') {
          // Determine final outcome relative to strike
          let outcome;
          const strike = market.strike || 0;
          const settleCap = market.settleCap || 0;
          const eps = 0.002;
          if (strike === 0 || Math.abs(settleCap - strike) / strike < eps) {
            outcome = 'draw';
          } else {
            outcome = settleCap > strike ? 'above' : 'below';
          }
          const result = outcome === 'draw' ? 'draw' : (bet.direction === outcome ? 'win' : 'lose');
          html += `<br>Status: settled · Result: ${result} · Final cap: ${settleCap.toFixed(2)} TON`;
        } else {
          html += `<br>Status: open`;
        }
        li.innerHTML = html;
        // Show a settle button if market is open, expired and not yet settled
        if (market.status === 'open' && expired) {
          const btn = document.createElement('button');
          btn.textContent = 'Settle';
          btn.addEventListener('click', async () => {
            try {
              const res = await fetch('/api/prediction/settle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ marketId: market.id }),
              });
              const data = await res.json();
              if (data && data.success) {
                await fetchPredictions();
                await fetchInternalBalance();
              } else {
                alert(data && data.message ? data.message : 'Failed to settle market.');
              }
            } catch (err) {
              alert('Error connecting to server.');
            }
          });
          li.appendChild(btn);
        }
        predictionsList.appendChild(li);
      });
    });
  }

  /**
   * Settle a prediction via the server. After settlement, reload the list.
   * @param {number} id
   */
  async function settlePredictionHandler(id) {
    try {
      const res = await fetch('/api/prediction/settle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId: id }),
      });
      const data = await res.json();
      if (data && data.success) {
        await fetchPredictions();
        await fetchInternalBalance();
      } else {
        alert(data && data.message ? data.message : 'Failed to settle market.');
      }
    } catch (err) {
      alert('Error connecting to server.');
    }
  }

  // Refresh market cap when asset selection changes
  if (predAsset) {
    predAsset.addEventListener('change', refreshMarketCap);
  }

  /**
   * Price and futures charts
   * Uses Chart.js to render line charts based on Binance candlestick data.
   * Charts are recreated each time to update their data. If network calls
   * fail (for example in restricted environments), the function will
   * silently fail and leave charts empty.
   */
  let priceChart;
  let futuresChart;

  async function loadCharts(asset) {
    const upperAsset = asset.toUpperCase();
    // Build the trading pair symbol (e.g. TONUSDT)
    const symbol = `${upperAsset}USDT`;
    try {
      // Fetch spot market candles
      const candlesRes = await fetch(`/api/candles?symbol=${symbol}&interval=1d&limit=30`);
      const candlesData = await candlesRes.json();
      if (!Array.isArray(candlesData)) throw new Error('Invalid spot data');
      const labels = candlesData.map(c => new Date(c[0]).toLocaleDateString());
      const closes = candlesData.map(c => parseFloat(c[4]));
      // Destroy existing chart if present
      if (priceChart) priceChart.destroy();
      const ctx1 = document.getElementById('price-chart').getContext('2d');
      priceChart = new Chart(ctx1, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: `${upperAsset}/USDT (Spot)`,
              data: closes,
              tension: 0.3,
              borderWidth: 2,
              pointRadius: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { display: true, title: { display: true, text: 'Date' } },
            y: { display: true, title: { display: true, text: 'Price (USDT)' } },
          },
          plugins: {
            legend: { display: true },
            title: { display: true, text: `${upperAsset} Spot Price` },
          },
        },
      });
    } catch (err) {
      console.error('Failed to load spot chart', err);
    }
    try {
      // Fetch futures market candles
      const futuresRes = await fetch(`/api/futures_candles?symbol=${symbol}&interval=1d&limit=30`);
      const futuresData = await futuresRes.json();
      if (!Array.isArray(futuresData)) throw new Error('Invalid futures data');
      const labels = futuresData.map(c => new Date(c[0]).toLocaleDateString());
      const closes = futuresData.map(c => parseFloat(c[4]));
      // Destroy existing futures chart if present
      if (futuresChart) futuresChart.destroy();
      const ctx2 = document.getElementById('futures-chart').getContext('2d');
      futuresChart = new Chart(ctx2, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: `${upperAsset}/USDT (Futures)`,
              data: closes,
              tension: 0.3,
              borderWidth: 2,
              pointRadius: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { display: true, title: { display: true, text: 'Date' } },
            y: { display: true, title: { display: true, text: 'Price (USDT)' } },
          },
          plugins: {
            legend: { display: true },
            title: { display: true, text: `${upperAsset} Futures Price` },
          },
        },
      });
    } catch (err) {
      console.error('Failed to load futures chart', err);
    }
  }
})();
