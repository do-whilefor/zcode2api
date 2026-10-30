function claimablePlans(preview) {
  const plans = new Map();
  for (const plan of preview.plans || []) {
    if (plan.plan_id && !plans.has(plan.plan_id)) plans.set(plan.plan_id, plan);
  }
  return [...plans.values()];
}

function claimAccountMarkup(preview, account = {}) {
  const plans = claimablePlans(preview), pending = account.pending_buckets || [];
  const name = account.platform_name || account.label || preview.label || '未命名账号';
  const taskNames = { login_device: '登录客户端', referral_bind_code: '绑定邀请码', send_message: '发送消息' };
  const rewards = preview.incentives?.active ? preview.incentives.rewards || [] : [];
  return `<article class="claim-account">
    <header class="claim-account-header"><div class="cell-name"><span class="avatar">${esc((name || '?').slice(0, 1))}</span><div><h2>${esc(name)}</h2><p>${account.family === 'zai' ? 'Z.ai' : account.family === 'bigmodel' ? 'BigModel' : 'ZCode'}${account.platform_name && account.label !== name ? ` · ${esc(account.label)}` : ''}</p></div></div>
      <div class="claim-account-heading-actions">${plans.length ? `<span class="badge ok">${plans.length} 项可领取</span>` : pending.length ? '<span class="badge pending">有额度待生效</span>' : preview.error ? '<span class="badge err">查询失败</span>' : preview.warning ? '<span class="badge pending">清单不完整</span>' : '<span class="badge">暂无可领</span>'}<button type="button" class="text-action" data-view-account="${esc(preview.account_id)}">查看账号 ↗</button></div>
    </header>
    ${preview.error ? `<div class="inline-notice error" role="alert">可领额度查询失败：${esc(preview.error)}</div>` : ''}
    ${preview.warning ? `<div class="inline-notice muted">部分领取来源暂不可用：${esc(preview.warning)}。已查询到的卡片仍可领取。</div>` : ''}
    ${plans.map(plan => `<section class="claim-plan"><div><span class="section-kicker">可领取</span><h3>${esc(plan.name || plan.plan_id)}</h3></div><div class="claim-grants">${(plan.entitlements || []).map(entitlement => `<div><span>${esc(entitlement.show_name || entitlement.meter || '额度')}</span><strong title="${esc(fmtInt(entitlement.grant_units))}">${fmtQuota(entitlement.grant_units)}<small> ${esc(entitlement.unit_type || 'token')}</small></strong></div>`).join('') || '<p class="quiet-message">额度以领取结果为准</p>'}</div><button type="button" class="btn primary" data-claim="${esc(preview.account_id)}" data-plan="${esc(plan.plan_id)}">领取额度</button></section>`).join('')}
    ${pending.length ? `<section class="claim-pending"><div class="section-heading"><h3>${icon('timer', 14)} 已领取 · 待生效</h3><span>不计入当前可用余额</span></div>${pending.map(bucket => `<div class="claim-pending-row"><div><strong>${esc(bucket.name)}</strong><span>${esc(bucket.plan_name || '已领取额度')}</span></div><strong title="${esc(fmtInt(bucket.total))} ${esc(bucket.unit || 'token')}">${fmtQuota(bucket.total)}<small> ${esc(bucket.unit || 'token')}</small></strong><time title="${esc(fmtTime(bucket.effective_at))}">${bucket.effective_at > Date.now() ? `${esc(fmtCompactTime(bucket.effective_at))} 生效` : '等待余额刷新'}</time></div>`).join('')}</section>` : ''}
    ${preview.incentives_error ? `<div class="inline-notice muted">客户端任务暂不可用：${esc(preview.incentives_error)}</div>` : rewards.length ? `<details class="claim-tasks" ${!plans.length && !pending.length ? 'open' : ''}><summary><span>客户端奖励任务</span><span class="muted">${rewards.length} 项 · 查看进度</span></summary><div class="claim-task-list">${rewards.map(reward => {
      const target = Number(reward.target) || 0, current = Math.max(0, Number(reward.current) || 0);
      const progress = target > 0 ? Math.max(0, Math.min(1, current / target)) : 0;
      return `<div class="claim-task"><div class="section-heading"><h3>${esc(reward.title)}</h3><span>${reward.issued > 0 ? '已发放' : target > 0 ? `${fmtInt(current)} / ${fmtInt(target)}` : '等待任务更新'}</span></div>${reward.description ? `<p>${esc(reward.description)}</p>` : ''}${target > 0 ? `<div class="task-track" role="progressbar" aria-label="${esc(reward.title)}" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${Math.min(current, target)}"><i style="transform:scaleX(${progress})"></i></div>` : ''}${(reward.plan?.entitlements || []).map(item => `<span class="quota-meta">${esc(item.show_name || '奖励额度')} · ${fmtQuota(item.grant_units)} ${esc(item.unit_type || 'token')}</span>`).join('')}</div>`;
    }).join('')}${preview.incentives.tasks?.length ? `<div class="task-checklist">${preview.incentives.tasks.map(task => `<span class="${task.completed ? 'ok-text' : 'muted'}">${task.completed ? '✓' : '○'} ${esc(taskNames[task.key] || task.key)}</span>`).join('')}</div>` : ''}<a class="reward-link" href="https://zcode.z.ai/cn/rewards" target="_blank" rel="noopener noreferrer">前往 ZCode 完成任务 ↗</a><p class="quiet-message">请使用对应账号登录，任务奖励由 ZCode 发放。</p></div></details>` : ''}
  </article>`;
}

async function pageClaims(main) {
  const filter = window._claimsFilter || (window._claimsFilter = { account: 'all', view: 'all', historyPage: 1 });
  let previews = [], accounts = [], history = [], historyError = '', accountsError = '', busy = false, loading = false;
  main.innerHTML = `${pagehead('领卡中心', '查看可领取额度、奖励任务与生效时间。', '<button type="button" class="btn" id="claims-refresh">' + icon('refresh', 14) + '刷新</button><button type="button" class="btn primary" id="claims-all" disabled>领取全部可领卡</button>')}
    <section class="overview-strip claims-overview" id="claims-overview" aria-label="领卡概览"><div class="skeleton-block"></div><div class="skeleton-block"></div><div class="skeleton-block"></div></section>
    <div class="management-toolbar"><nav class="status-pills" id="claims-filters" aria-label="按领取状态筛选"></nav><select id="claims-account" class="round" aria-label="筛选领卡账号"><option value="all">全部账号</option></select><span class="result-count" id="claims-update" aria-live="polite">正在查询…</span></div>
    <section id="claims-content" class="claim-account-list" aria-busy="true"><div class="claim-account skeleton-block"></div></section>
    <section class="claim-history-section"><div class="section-heading"><h2>领取记录</h2><span id="claims-history-count"></span></div><div id="claims-history"></div></section>`;
  const content = $('#claims-content', main);
  const active = () => main.contains(content);
  const pendingFor = id => accounts.find(account => account.id === id)?.pending_buckets || [];
  const syncBusy = () => {
    if (!active()) return;
    $('#claims-refresh', main).disabled = busy || loading;
    $('#claims-all', main).disabled = busy || loading || !previews.some(preview => claimablePlans(preview).length);
    $$('button[data-claim]', content).forEach(button => { button.disabled = busy || loading; });
  };
  function paintAccounts() {
    const counts = { all: previews.length, ready: 0, pending: 0, error: 0 };
    for (const preview of previews) {
      if (claimablePlans(preview).length) counts.ready++;
      if (pendingFor(preview.account_id).length) counts.pending++;
      if (preview.error || preview.warning || preview.incentives_error) counts.error++;
    }
    $('#claims-filters', main).innerHTML = [['all', '全部'], ['ready', '可领取'], ['pending', '待生效'], ['error', '查询异常']].map(([id, label]) => `<button type="button" data-claim-view="${id}" aria-pressed="${filter.view === id}" class="${filter.view === id ? 'active' : ''}">${label}<span class="cnt">${counts[id]}</span></button>`).join('');
    const selected = previews.filter(preview => (filter.account === 'all' || preview.account_id === filter.account) && (filter.view === 'all' || filter.view === 'ready' && claimablePlans(preview).length || filter.view === 'pending' && pendingFor(preview.account_id).length || filter.view === 'error' && (preview.error || preview.warning || preview.incentives_error)));
    content.innerHTML = `${accountsError ? `<div class="inline-notice error" role="alert">账户额度同步失败：${esc(accountsError)}。刷新后重试。</div>` : ''}${selected.length ? selected.map(preview => claimAccountMarkup(preview, accounts.find(account => account.id === preview.account_id))).join('') : `<div class="management-empty">${icon('gift', 26)}<h3>${previews.length ? '当前筛选下没有记录' : '还没有可领取额度的账号'}</h3><p>${previews.length ? '切换到全部账号，查看其他奖励与生效进度。' : '先添加有客户端凭据的账号，再刷新可领取清单。'}</p>${!previews.length ? '<button type="button" class="btn" data-open-accounts>前往账号管理</button>' : ''}</div>`}`;
    syncBusy();
  }
  function paintHistory() {
    const totalPages = Math.max(1, Math.ceil(history.length / 10));
    filter.historyPage = Math.max(1, Math.min(filter.historyPage || 1, totalPages));
    $('#claims-history-count', main).textContent = historyError ? '查询失败' : `最近 ${history.length} 条`;
    $('#claims-history', main).innerHTML = historyError ? `<div class="inline-notice error" role="alert">领取记录查询失败：${esc(historyError)}</div>` : history.length ? `<div class="tablecard claim-history-table"><table><thead><tr><th>领取时间</th><th>账号</th><th>额度卡</th><th>结果</th><th>领取方式</th></tr></thead><tbody>${history.slice((filter.historyPage - 1) * 10, filter.historyPage * 10).map(record => `<tr><td class="mono">${esc(fmtCompactTime(record.ts))}</td><td>${esc(record.account_label || record.account_id)}</td><td class="claim-history-plan">${esc(record.plan_id)}</td><td><span class="badge ${record.ok ? 'ok' : 'err'}">${record.ok ? '已领取' : '未领取'}</span>${!record.ok && (record.message || record.code) ? `<p class="quiet-message error">${esc(record.message || `错误 ${record.code}`)}</p>` : ''}</td><td class="muted">${record.trigger === 'auto' ? '自动巡检' : record.trigger === 'manual' ? '手动领取' : esc(record.trigger)}</td></tr>`).join('')}</tbody></table></div><div class="pager claims-pager"><button type="button" data-claim-history="-1" aria-label="上一页领取记录" ${filter.historyPage === 1 ? 'disabled' : ''}>‹</button><span>${filter.historyPage} / ${totalPages}</span><button type="button" data-claim-history="1" aria-label="下一页领取记录" ${filter.historyPage === totalPages ? 'disabled' : ''}>›</button></div>` : '<div class="management-empty compact"><p>暂无领取记录。领取成功后会显示在这里。</p></div>';
  }
  async function load() {
    if (loading) return;
    loading = true; syncBusy(); content.setAttribute('aria-busy', 'true');
    $('#claims-update', main).textContent = '正在同步…';
    try {
      const [discovery, accountResult, historyResult] = await Promise.allSettled([api('/api/claims/discover'), api('/api/accounts'), api('/api/claims/history')]);
      if (!active()) return;
      accounts = accountResult.status === 'fulfilled' ? accountResult.value : [];
      accountsError = accountResult.status === 'rejected' ? accountResult.reason.message : '';
      history = historyResult.status === 'fulfilled' ? historyResult.value : [];
      historyError = historyResult.status === 'rejected' ? historyResult.reason.message : '';
      paintHistory();
      if (discovery.status === 'rejected') throw discovery.reason;
      previews = discovery.value.previews || [];
      const ready = previews.reduce((sum, preview) => sum + claimablePlans(preview).length, 0);
      const pending = accounts.reduce((sum, account) => sum + (Number(account.pending_total) || 0), 0);
      const errors = previews.filter(preview => preview.error || preview.incentives_error).length;
      const warnings = previews.filter(preview => preview.warning).length;
      $('#claims-overview', main).innerHTML = `<div><span>可领取额度卡</span><strong>${ready}<small> 项</small></strong><p>${previews.length} 个账号已查询</p></div><div><span>已领取 · 待生效</span><strong title="${esc(fmtInt(pending))} token">${accountsError ? '—' : fmtQuota(pending)}<small> token</small></strong><p>到达生效时间后可使用</p></div><div><span>查询状态</span><strong>${errors || accountsError ? '需重试' : warnings ? '部分同步' : '已同步'}</strong><p>${errors ? `${errors} 个账号存在查询异常` : accountsError ? '账号余额暂不可用' : warnings ? `${warnings} 个账号的部分领取来源不可用` : '领取与任务分别查询'}</p></div>`;
      if (filter.account !== 'all' && !previews.some(preview => preview.account_id === filter.account)) filter.account = 'all';
      const accountSelect = $('#claims-account', main);
      accountSelect.innerHTML = '<option value="all">全部账号</option>' + previews.map(preview => `<option value="${esc(preview.account_id)}">${esc(accounts.find(account => account.id === preview.account_id)?.platform_name || preview.label)}</option>`).join('');
      accountSelect.value = filter.account; syncSelect(accountSelect);
      paintAccounts();
      $('#claims-update', main).textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    } catch (error) {
      if (active()) {
        previews = [];
        $('#claims-overview', main).innerHTML = '<div class="overview-unavailable"><span>领取清单暂不可用</span><p>请刷新重试，已领取的额度不受影响。</p></div>';
        $('#claims-filters', main).innerHTML = '';
        content.innerHTML = `<div class="inline-notice error" role="alert">查询失败：${esc(error.message)}</div>`;
        $('#claims-update', main).textContent = '同步失败';
      }
    } finally { loading = false; if (active()) { content.setAttribute('aria-busy', 'false'); syncBusy(); } }
  }
  async function act(callback) {
    if (busy || loading) return;
    busy = true; syncBusy();
    try { await callback(); if (active()) await load(); }
    catch (error) { toast(error.message, 'err'); }
    finally { busy = false; syncBusy(); }
  }
  $('#claims-refresh', main).addEventListener('click', load);
  $('#claims-account', main).addEventListener('change', event => { filter.account = event.target.value; paintAccounts(); syncRoute(); });
  $('#claims-filters', main).addEventListener('click', event => {
    const button = event.target.closest('[data-claim-view]');
    if (button) { filter.view = button.dataset.claimView; paintAccounts(); syncRoute(); $('#claims-filters [aria-pressed="true"]', main)?.focus(); }
  });
  content.addEventListener('click', event => {
    const accountLink = event.target.closest('[data-view-account]');
    if (accountLink) { viewAccount(accountLink.dataset.viewAccount); return; }
    if (event.target.closest('[data-open-accounts]')) { navigateTo('accounts'); return; }
    const button = event.target.closest('[data-claim]');
    if (!button || button.disabled) return;
    act(async () => {
      const result = await api('/api/claims/claim', { method: 'POST', body: { account_id: button.dataset.claim, plan_id: button.dataset.plan } });
      toast(result.ok ? '额度已领取，余额与生效时间已同步' : `领取失败：${result.message || result.code || '请稍后重试'}`, result.ok ? 'ok' : 'err');
    });
  });
  $('#claims-all', main).addEventListener('click', () => act(async () => {
    const jobs = previews.flatMap(preview => claimablePlans(preview).map(plan => ({ account_id: preview.account_id, plan_id: plan.plan_id })));
    let claimed = 0;
    for (const job of jobs) {
      try {
        const result = await api('/api/claims/claim', { method: 'POST', body: job });
        if (result.ok) claimed++;
      } catch { }
    }
    const failed = jobs.length - claimed;
    toast(`领取 ${claimed} 张${failed ? `，${failed} 项失败，请查看领取记录或刷新重试` : ''}`, failed ? 'err' : 'ok');
  }));
  $('#claims-history', main).addEventListener('click', event => {
    const button = event.target.closest('[data-claim-history]');
    if (button && !button.disabled) { filter.historyPage += Number(button.dataset.claimHistory); paintHistory(); enhanceTables(main); syncRoute(); }
  });
  await load();
}
