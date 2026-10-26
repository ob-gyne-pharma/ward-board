/* OB-GYN Pharma Ward Board — Training Centre
 * Self-contained add-on for the existing vanilla-JS index.html.
 * All interactive practice state is in memory only: no Firebase calls,
 * no localStorage/sessionStorage, and no calls to the live ward-board actions.
 */
(() => {
  'use strict';
  if (window.__wardBoardTrainingLoaded) return;
  window.__wardBoardTrainingLoaded = true;

  const videos = [
    {
      title: '1. Getting started with Ward Board',
      duration: '2 min',
      description: 'Understand the board, patient categories, filters and dashboard.',
      src: 'assets/training/01-getting-started.mp4'
    },
    {
      title: '2. Updating a patient card',
      duration: '3 min',
      description: 'See how staff document a progress update and set the next review.',
      src: 'assets/training/02-update-patient.mp4'
    },
    {
      title: '3. Acuity, filters and review times',
      duration: '2 min',
      description: 'Use the board’s status indicators and filtering tools appropriately.',
      src: 'assets/training/03-acuity-and-filters.mp4'
    },
    {
      title: '4. Preparing a shift handover',
      duration: '3 min',
      description: 'Generate, review and print a handover summary.',
      src: 'assets/training/04-handover.mp4'
    },
    {
      title: '5. Full simulated shift',
      duration: '4 min',
      description: 'Follow a fictional case from board review to handover.',
      src: 'assets/training/05-simulated-shift.mp4'
    }
  ];

  const scenarios = [
    {
      id: 'update',
      title: 'Update a fictional patient',
      brief: 'A fictional postnatal patient needs a progress note and a planned review time.',
      steps: [
        { title: 'Review the training patient', detail: 'Read DEMO-001’s fictional summary. Do not use real patient information.', check: 'reviewed' },
        { title: 'Enter a progress note', detail: 'Use the practice note field below. Example: “Training note: comfortable on review; continue the scenario plan.”', check: 'note' },
        { title: 'Set a next-review time', detail: 'Choose a practice review time. This is only a learning exercise, not a clinical instruction.', check: 'reviewTime' },
        { title: 'Confirm the practice update', detail: 'Review the simulated card and select “Complete step” to finish this exercise.', check: 'confirm' }
      ]
    },
    {
      id: 'handover',
      title: 'Prepare a shift handover',
      brief: 'Practise identifying the key information that should be carried into a handover.',
      steps: [
        { title: 'Identify the patient', detail: 'Use the fictional identifier DEMO-002, not a real name or hospital number.', check: 'reviewed' },
        { title: 'Summarise the situation', detail: 'Enter a concise training summary in your own words.', check: 'note' },
        { title: 'Record the outstanding task', detail: 'Choose a fictional follow-up task from the list.', check: 'task' },
        { title: 'Check the receiver’s understanding', detail: 'Read the generated practice handover and mark the step complete.', check: 'confirm' }
      ]
    }
  ];

  const state = {
    tab: 'start',
    scenarioId: 'update',
    step: 0,
    reviewed: false,
    note: '',
    reviewTime: '',
    task: '',
    confirm: false,
    videoIndex: 0
  };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  function addStyles() {
    if (document.getElementById('wbTrainingStyles')) return;
    const style = document.createElement('style');
    style.id = 'wbTrainingStyles';
    style.textContent = `
      #wbTrainingNavBtn { white-space:nowrap; }
      .wb-training-card { margin:12px 0; padding:16px; border:1px solid var(--line,#dbe3ea);
        border-radius:16px; background:var(--card,#fff); color:var(--ink,#17212b); }
      .wb-training-card h3 { margin:0 0 6px; font-size:1rem; }
      .wb-training-card p { margin:0 0 12px; color:var(--ink-soft,#526170); font-size:.86rem; line-height:1.5; }
      .wb-training-actions { display:flex; gap:8px; flex-wrap:wrap; }
      .wb-training-primary, .wb-training-secondary { border-radius:10px; padding:10px 13px;
        font:inherit; font-weight:700; cursor:pointer; border:1px solid var(--line,#dbe3ea); }
      .wb-training-primary { background:var(--accent,#176b87); color:#fff; border-color:transparent; }
      .wb-training-secondary { background:var(--card,#fff); color:var(--ink,#17212b); }
      #wbTrainingOverlay { position:fixed; inset:0; z-index:9999; background:rgba(7,17,28,.72);
        display:none; align-items:center; justify-content:center; padding:16px; }
      #wbTrainingOverlay.wbt-open { display:flex; }
      .wbt-modal { width:min(900px,100%); max-height:92dvh; overflow:auto; border-radius:18px;
        background:var(--card,#fff); color:var(--ink,#17212b); box-shadow:0 20px 60px #0004; }
      .wbt-head { position:sticky; top:0; z-index:2; display:flex; gap:12px; align-items:center;
        justify-content:space-between; padding:16px 18px; border-bottom:1px solid var(--line,#dbe3ea);
        background:var(--card,#fff); }
      .wbt-head h2 { font-size:1.12rem; margin:0; }
      .wbt-close { border:0; border-radius:9px; padding:8px 11px; cursor:pointer; background:var(--paper,#f2f5f7); color:inherit; }
      .wbt-body { padding:16px 18px 22px; }
      .wbt-warning { border-radius:10px; padding:10px 12px; background:#fff4d6; color:#6e4c00;
        font-size:.82rem; font-weight:700; margin-bottom:14px; }
      .wbt-tabs { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:16px; }
      .wbt-tab { border:1px solid var(--line,#dbe3ea); background:transparent; color:inherit;
        padding:9px 12px; border-radius:999px; cursor:pointer; font-weight:700; }
      .wbt-tab[aria-selected="true"] { background:var(--accent,#176b87); color:#fff; border-color:transparent; }
      .wbt-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
      .wbt-video-card, .wbt-panel { border:1px solid var(--line,#dbe3ea); border-radius:13px; padding:13px; min-width:0; }
      .wbt-video-card h3, .wbt-panel h3 { font-size:.95rem; margin:0 0 6px; }
      .wbt-video-card p, .wbt-panel p { font-size:.85rem; line-height:1.5; color:var(--ink-soft,#526170); }
      .wbt-video-card video { width:100%; display:block; background:#101820; border-radius:9px; aspect-ratio:16/9; margin:10px 0; }
      /* Keep unavailable video players hidden; display:block otherwise overrides the HTML hidden attribute. */
      .wbt-video-card video[hidden] { display:none !important; }
      .wbt-video-placeholder { aspect-ratio:16/9; border-radius:9px; background:var(--paper,#f2f5f7);
        display:flex; align-items:center; justify-content:center; text-align:center; padding:14px; color:var(--ink-soft,#526170); font-size:.84rem; }
      .wbt-field { display:grid; gap:5px; margin:12px 0; }
      .wbt-field label { font-weight:700; font-size:.84rem; }
      .wbt-field input, .wbt-field textarea, .wbt-field select { width:100%; border:1px solid var(--line,#dbe3ea);
        border-radius:9px; padding:10px; font:inherit; background:var(--card,#fff); color:inherit; }
      .wbt-progress { height:7px; border-radius:9px; background:var(--paper,#eef2f5); overflow:hidden; margin:10px 0 16px; }
      .wbt-progress span { display:block; height:100%; background:var(--accent,#176b87); transition:width .2s; }
      .wbt-step { padding:12px; border-radius:12px; background:var(--paper,#f2f5f7); margin:10px 0; }
      .wbt-muted { font-size:.82rem; color:var(--ink-soft,#526170); line-height:1.5; }
      .wbt-preview { white-space:pre-wrap; border:1px dashed var(--line,#bdc8d2); border-radius:10px; padding:12px; margin-top:12px; font-size:.86rem; }
      @media(max-width:600px) { #wbTrainingOverlay { padding:0; align-items:flex-end; }
        .wbt-modal { border-radius:18px 18px 0 0; max-height:95dvh; }
        .wbt-body { padding:13px; } .wbt-head { padding:13px; } }
    `;
    document.head.appendChild(style);
  }

  function ensureOverlay() {
    if (document.getElementById('wbTrainingOverlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'wbTrainingOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'wbtTitle');
    overlay.innerHTML = `
      <section class="wbt-modal">
        <header class="wbt-head">
          <h2 id="wbtTitle">🎓 Ward Board Training &amp; Help</h2>
          <button type="button" class="wbt-close" id="wbtClose" aria-label="Exit training">Exit training ✕</button>
        </header>
        <div class="wbt-body">
          <div class="wbt-warning">TRAINING MODE · FICTIONAL DATA ONLY · NOT FOR CLINICAL USE</div>
          <nav class="wbt-tabs" aria-label="Training sections">
            <button class="wbt-tab" data-wbt-tab="start">Start here</button>
            <button class="wbt-tab" data-wbt-tab="videos">Video tutorials</button>
            <button class="wbt-tab" data-wbt-tab="practice">Try it yourself</button>
            <button class="wbt-tab" data-wbt-tab="help">Quick help</button>
          </nav>
          <div id="wbtContent"></div>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeTraining();
    });
    overlay.querySelector('#wbtClose').addEventListener('click', closeTraining);
    overlay.querySelectorAll('[data-wbt-tab]').forEach(button => {
      button.addEventListener('click', () => {
        state.tab = button.dataset.wbtTab;
        render();
      });
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeTraining();
    });
  }

  function openTraining(tab = 'start') {
    state.tab = tab;
    ensureOverlay();
    render();
    document.getElementById('wbTrainingOverlay').classList.add('wbt-open');
    document.body.style.overflow = 'hidden';
    const close = document.getElementById('wbtClose');
    if (close) close.focus();
  }

  function closeTraining() {
    const overlay = document.getElementById('wbTrainingOverlay');
    if (overlay) overlay.classList.remove('wbt-open');
    document.body.style.overflow = '';
  }

  function renderVideos() {
    return `<div class="wbt-grid">${videos.map((video, i) => `
      <article class="wbt-video-card">
        <h3>${esc(video.title)}</h3>
        <span class="wbt-muted">${esc(video.duration)}</span>
        <p>${esc(video.description)}</p>
        <div class="wbt-video-placeholder" data-video-placeholder="${i}">
          Screen-recording video not added yet.<br>Place the MP4 at:<br><code>${esc(video.src)}</code>
        </div>
        <video controls playsinline preload="none" hidden data-video="${i}" aria-label="${esc(video.title)}">
          <source src="${esc(video.src)}" type="video/mp4">
          Your browser does not support HTML video.
        </video>
      </article>`).join('')}</div>`;
  }

  function currentScenario() {
    return scenarios.find(s => s.id === state.scenarioId) || scenarios[0];
  }

  function stepDone(check) {
    if (check === 'reviewed') return state.reviewed;
    if (check === 'note') return state.note.trim().length >= 8;
    if (check === 'reviewTime') return Boolean(state.reviewTime);
    if (check === 'task') return Boolean(state.task);
    if (check === 'confirm') return state.confirm;
    return false;
  }

  function renderPractice() {
    const scenario = currentScenario();
    const step = scenario.steps[state.step];
    const completeCount = scenario.steps.filter(s => stepDone(s.check)).length;
    return `
      <div class="wbt-panel">
        <div class="wbt-grid">
          <div>
            <h3>Guided practice</h3>
            <p>${esc(scenario.brief)}</p>
            <label class="wbt-field"><span>Choose exercise</span>
              <select id="wbtScenario">
                ${scenarios.map(s => `<option value="${s.id}" ${s.id === state.scenarioId ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="wbt-step">
            <div class="wbt-muted">SIMULATED PATIENT</div>
            <h3>${state.scenarioId === 'update' ? 'DEMO-001 · Postnatal' : 'DEMO-002 · Antenatal'}</h3>
            <p class="wbt-muted">Fictional training case. This is isolated from the live ward board and is not saved.</p>
            <div class="wbt-muted">Practice status: <strong>${completeCount}/${scenario.steps.length} steps completed</strong></div>
          </div>
        </div>
        <div class="wbt-progress"><span style="width:${Math.round((state.step + 1) / scenario.steps.length * 100)}%"></span></div>
        <div class="wbt-step">
          <div class="wbt-muted">STEP ${state.step + 1} OF ${scenario.steps.length}</div>
          <h3>${esc(step.title)}</h3>
          <p>${esc(step.detail)}</p>
          ${step.check === 'reviewed' ? `<button class="wbt-secondary" id="wbtReviewed">${state.reviewed ? '✓ Patient reviewed' : 'Mark patient reviewed'}</button>` : ''}
          ${step.check === 'note' ? `<label class="wbt-field"><span>Practice note / handover summary</span><textarea id="wbtNote" rows="3" placeholder="Enter fictional training text only…">${esc(state.note)}</textarea></label>` : ''}
          ${step.check === 'reviewTime' ? `<label class="wbt-field"><span>Practice review time</span><select id="wbtReviewTime"><option value="">Choose a practice time</option><option ${state.reviewTime==='30 minutes'?'selected':''}>30 minutes</option><option ${state.reviewTime==='2 hours'?'selected':''}>2 hours</option><option ${state.reviewTime==='next round'?'selected':''}>Next round</option></select></label>` : ''}
          ${step.check === 'task' ? `<label class="wbt-field"><span>Outstanding practice task</span><select id="wbtTask"><option value="">Choose a fictional task</option><option ${state.task==='Review pending results'?'selected':''}>Review pending results</option><option ${state.task==='Recheck observations'?'selected':''}>Recheck observations</option><option ${state.task==='Confirm team review'?'selected':''}>Confirm team review</option></select></label>` : ''}
          ${step.check === 'confirm' ? `<div class="wbt-preview">${esc(state.scenarioId === 'update' ? `DEMO-001 — Practice update\\nNote: ${state.note || '(not entered)'}\\nNext review: ${state.reviewTime || '(not selected)'}` : `DEMO-002 — Practice handover\\nSummary: ${state.note || '(not entered)'}\\nOutstanding task: ${state.task || '(not selected)'}`)}</div><p class="wbt-muted">This preview exists only in this page's memory. It is not sent to Firebase or stored in the browser.</p><button class="wbt-secondary" id="wbtConfirm">${state.confirm ? '✓ Practice confirmed' : 'Confirm practice summary'}</button>` : ''}
          <div class="wb-training-actions" style="margin-top:12px;">
            <button class="wbt-training-secondary" id="wbtReset">Reset exercise</button>
            <button class="wbt-training-primary" id="wbtNext" ${stepDone(step.check) ? '' : 'disabled'}>${state.step === scenario.steps.length - 1 ? 'Finish exercise' : 'Complete step →'}</button>
          </div>
          <p class="wbt-muted" id="wbtFeedback" aria-live="polite">${stepDone(step.check) ? 'Step complete. Continue when ready.' : 'Complete the action above to enable the next step.'}</p>
        </div>
      </div>`;
  }

  function renderHelp() {
    return `<div class="wbt-grid">
      <article class="wbt-panel"><h3>🧭 Finding a patient</h3><p>Use the patient categories, unit filter and search field to locate a fictional training card.</p></article>
      <article class="wbt-panel"><h3>📝 Updating progress</h3><p>Open the relevant card, use the progress/update control, enter a concise note and check the result.</p></article>
      <article class="wbt-panel"><h3>📋 Handover</h3><p>Generate the handover, review it for omissions and use the print/copy controls as needed.</p></article>
      <article class="wbt-panel"><h3>⚠️ Urgency and timers</h3><p>In this prototype, indicators and timers are training aids only. They are not a reliable clinical alarm system and must not replace local escalation policy.</p></article>
      <article class="wbt-panel"><h3>🔄 Demo reset</h3><p>Training exercises reset only their own fictional state. They do not reset or modify the shared ward board.</p></article>
      <article class="wbt-panel"><h3>🆘 Something is not working?</h3><p>Note the device, browser, action attempted and what happened. Do not include patient-identifiable information in feedback.</p></article>
    </div>`;
  }

  function renderStart() {
    return `<div class="wbt-panel">
      <h3>Welcome to Ward Board Training &amp; Help</h3>
      <p>This section is optional support for learning Ward Board. Use it when you are new to the system, want to practise a workflow, or need a reminder. It is not a clinical task and does not replace your hospital’s policies or clinical judgement.</p>
      <div class="wbt-grid">
        <article class="wbt-video-card"><h3>▶ Learn the basics</h3><p>See how the board is organised and how common features work. Video recordings will appear here as they are added.</p><button class="wbt-training-primary" data-wbt-open-tab="videos">View video tutorials</button></article>
        <article class="wbt-video-card"><h3>🖱 Practise with a fictional case</h3><p>Walk through a sample workflow using fictional information. Practice is separate from normal ward work.</p><button class="wbt-training-primary" data-wbt-open-tab="practice">Start optional practice</button></article>
        <article class="wbt-video-card"><h3>📖 Get help with a task</h3><p>Look up reminders for finding a patient, preparing a handover, and understanding prototype limitations.</p><button class="wbt-training-primary" data-wbt-open-tab="help">Open quick help</button></article>
      </div>
      <p class="wbt-muted" style="margin-top:14px;"><strong>How to use this section:</strong> Choose only what you need. New to Ward Board? Start with the basics. Need to rehearse a workflow? Try a fictional case. Forgot where to find something? Open Quick Help. You do not need to complete every exercise.</p>
      <p class="wbt-muted">Training exercises are for familiarisation only. Use fictional data in practice and follow your hospital’s approved procedures for real ward work.</p>
    </div>`;
  }

  function render() {
    const content = document.getElementById('wbtContent');
    if (!content) return;
    document.querySelectorAll('[data-wbt-tab]').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.wbtTab === state.tab));
    });
    content.innerHTML = state.tab === 'videos' ? renderVideos()
      : state.tab === 'practice' ? renderPractice()
      : state.tab === 'help' ? renderHelp() : renderStart();

    content.querySelectorAll('[data-wbt-open-tab]').forEach(button => {
      button.addEventListener('click', () => { state.tab = button.dataset.wbtOpenTab; render(); });
    });

    videos.forEach((video, i) => {
      const player = content.querySelector(`[data-video="${i}"]`);
      const placeholder = content.querySelector(`[data-video-placeholder="${i}"]`);
      if (!player || !placeholder) return;
      player.addEventListener('loadedmetadata', () => {
        player.hidden = false;
        placeholder.hidden = true;
      }, { once: true });
      player.addEventListener('error', () => {
        player.hidden = true;
        placeholder.hidden = false;
      });
      // A player is shown only if its file actually exists and loads.
      player.load();
    });

    const scenarioSelect = content.querySelector('#wbtScenario');
    if (scenarioSelect) scenarioSelect.addEventListener('change', () => {
      state.scenarioId = scenarioSelect.value;
      resetExercise();
      render();
    });
    const reviewed = content.querySelector('#wbtReviewed');
    if (reviewed) reviewed.addEventListener('click', () => { state.reviewed = true; render(); });
    const note = content.querySelector('#wbtNote');
    if (note) note.addEventListener('input', () => {
      state.note = note.value;
      const next = content.querySelector('#wbtNext');
      if (next) next.disabled = !stepDone(currentScenario().steps[state.step].check);
    });
    const reviewTime = content.querySelector('#wbtReviewTime');
    if (reviewTime) reviewTime.addEventListener('change', () => {
      state.reviewTime = reviewTime.value;
      const next = content.querySelector('#wbtNext');
      if (next) next.disabled = !stepDone(currentScenario().steps[state.step].check);
    });
    const task = content.querySelector('#wbtTask');
    if (task) task.addEventListener('change', () => {
      state.task = task.value;
      const next = content.querySelector('#wbtNext');
      if (next) next.disabled = !stepDone(currentScenario().steps[state.step].check);
    });
    const confirm = content.querySelector('#wbtConfirm');
    if (confirm) confirm.addEventListener('click', () => { state.confirm = true; render(); });
    const reset = content.querySelector('#wbtReset');
    if (reset) reset.addEventListener('click', () => { resetExercise(); render(); });
    const next = content.querySelector('#wbtNext');
    if (next) next.addEventListener('click', () => {
      const scenario = currentScenario();
      if (!stepDone(scenario.steps[state.step].check)) return;
      if (state.step < scenario.steps.length - 1) {
        state.step += 1;
        render();
      } else {
        const content = document.getElementById('wbtContent');
        content.innerHTML = `<div class="wbt-panel"><h3>✓ Practice completed</h3><p>You completed the ${esc(scenario.title.toLowerCase())} exercise using fictional data.</p><p class="wbt-muted">No patient records were changed and no training data was saved.</p><button class="wbt-training-primary" id="wbtAgain">Repeat exercise</button></div>`;
        content.querySelector('#wbtAgain').addEventListener('click', () => { resetExercise(); render(); });
      }
    });
  }

  function resetExercise() {
    state.step = 0;
    state.reviewed = false;
    state.note = '';
    state.reviewTime = '';
    state.task = '';
    state.confirm = false;
  }

  function addEntryPoints() {
    // Header navigation button (desktop).
    const headerActions = document.querySelector('.header-actions');
    if (headerActions && !document.getElementById('wbTrainingNavBtn')) {
      const button = document.createElement('button');
      button.id = 'wbTrainingNavBtn';
      button.type = 'button';
      button.className = 'btn-ghost btn-small';
      button.textContent = '🎓 Training & Help';
      button.addEventListener('click', () => openTraining());
      const settings = document.getElementById('settingsBtn');
      headerActions.insertBefore(button, settings || null);
    }

    // Bottom navigation button (mobile).
    const bottomNav = document.querySelector('.bottom-nav-inner');
    if (bottomNav && !document.getElementById('wbTrainingBottomBtn')) {
      const button = document.createElement('button');
      button.id = 'wbTrainingBottomBtn';
      button.type = 'button';
      button.className = 'nav-btn';
      button.innerHTML = '<span class="nav-icon">🎓</span>Training & Help';
      button.addEventListener('click', () => openTraining());
      bottomNav.appendChild(button);
    }

    // Dashboard training card, appended to the existing consultant dashboard.
    const dashboardBody = document.getElementById('dashboardBody');
    if (dashboardBody && !document.getElementById('wbTrainingDashboardCard')) {
      const card = document.createElement('section');
      card.id = 'wbTrainingDashboardCard';
      card.className = 'wb-training-card';
      card.innerHTML = `
        <h3>🎓 Training & Help</h3>
        <p>Optional support for learning the Ward Board, practising workflows with fictional cases, or finding a reminder when you need one. This is not a clinical task.</p>
        <div class="wb-training-actions">
          <button type="button" class="wb-training-primary" id="wbDashboardStartPractice">Practise with a fictional case</button>
          <button type="button" class="wb-training-secondary" id="wbDashboardVideos">View video tutorials</button>
        </div>`;
      dashboardBody.appendChild(card);
      card.querySelector('#wbDashboardStartPractice').addEventListener('click', () => openTraining('practice'));
      card.querySelector('#wbDashboardVideos').addEventListener('click', () => openTraining('videos'));
    }
  }

  function boot() {
    addStyles();
    ensureOverlay();
    addEntryPoints();
    // Dashboard content may be rebuilt when the existing dashboard opens.
    const dashboardBody = document.getElementById('dashboardBody');
    if (dashboardBody) {
      new MutationObserver(() => addEntryPoints()).observe(dashboardBody, { childList: true, subtree: false });
    }
    // Setup screen users can access training before entering the board.
    const setupCard = document.querySelector('#setupScreen .setup-card');
    if (setupCard && !document.getElementById('wbTrainingSetupBtn')) {
      const button = document.createElement('button');
      button.id = 'wbTrainingSetupBtn';
      button.type = 'button';
      button.className = 'btn-ghost';
      button.style.cssText = 'width:100%;margin-top:10px;padding:11px;';
      button.textContent = '🎓 Training & Help — learn Ward Board';
      button.addEventListener('click', () => openTraining());
      setupCard.appendChild(button);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
