/* Ward Board — app.js — v1.1 */
(function(){
  "use strict";

  var STORAGE_KEY = "ward_board_v3";
  var STAFF_NAME_KEY = "ward_board_staff_name";
  var ROOMS_PER_WARD = 24;

  var state = { wardOrder: [], wards: {} };
  var activeWardId = null;
  var activeAcuityFilter = "";
  var isRemoteUpdate = false;

  function uid(){ return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

  // Reconstructs empty objects that Firebase Realtime Database strips out
  function normalizeState(s){
    if(!s || typeof s !== "object") s = {};
    if(!Array.isArray(s.wardOrder)) s.wardOrder = [];
    if(!s.wards || typeof s.wards !== "object") s.wards = {};

    s.wardOrder = s.wardOrder.filter(function(id){ return !!s.wards[id]; });

    if(s.wardOrder.length === 0){
      var defaults = [
        { id: "ward_a", name: "Ward A" },
        { id: "ward_b", name: "Ward B" },
        { id: "ward_c", name: "Ward C" },
        { id: "ward_d", name: "Ward D" },
        { id: "ward_e", name: "Ward E" }
      ];
      defaults.forEach(function(d){
        s.wardOrder.push(d.id);
        s.wards[d.id] = { name: d.name, rooms: {}, roomConfig: {} };
      });
    }

    if(!Array.isArray(s.consultants)) s.consultants = [];
    if(!Array.isArray(s.onCallStaff)) s.onCallStaff = [];
    s.wardOrder.forEach(function(id){
      var w = s.wards[id];
      if(!w.rooms || typeof w.rooms !== "object") w.rooms = {};
      if(!w.roomConfig || typeof w.roomConfig !== "object") w.roomConfig = {};
      Object.keys(w.rooms).forEach(function(bKey){
        var p = w.rooms[bKey];
        if(p){
          if(!Array.isArray(p.history)) p.history = [];
          if(!p.checklist || typeof p.checklist !== "object") p.checklist = {};
        }
      });
    });

    if(!activeWardId || !s.wards[activeWardId]){
      activeWardId = s.wardOrder[0];
    }
    return s;
  }

  function loadState(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(raw){
        var parsed = JSON.parse(raw);
        if(parsed && parsed.wards && parsed.wardOrder){ state = parsed; }
      }
    }catch(e){ localStorage.removeItem(STORAGE_KEY); }

    state = normalizeState(state);
    var titleEl = document.getElementById("appTitle");
    if(titleEl && state.appTitle) titleEl.textContent = state.appTitle;
  }

  function saveState(){
    try{
      state = normalizeState(state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if(!isRemoteUpdate && window.firebaseSync && window.firebaseSync.save){
        window.firebaseSync.save(state);
      }
      return true;
    }catch(e){ return false; }
  }

  function currentWard(){
    var w = state.wards[activeWardId] || state.wards[state.wardOrder[0]];
    if(!w.rooms) w.rooms = {};
    if(!w.roomConfig) w.roomConfig = {};
    return w;
  }

  function bedKey(room, bed){ return room + bed; }
  function nowISO(){ return new Date().toISOString(); }

  /* Calculate gestation string from EDD — e.g. "34+2 weeks" */
  function calcGestationFromEDD(eddStr){
    if(!eddStr) return "";
    var edd = new Date(eddStr);
    if(isNaN(edd.getTime())) return "";
    // EDD = LMP + 280 days, so LMP = EDD - 280 days
    var lmp = new Date(edd.getTime() - 280 * 86400000);
    var today = new Date();
    today.setHours(0,0,0,0);
    var daysPregnant = Math.floor((today - lmp) / 86400000);
    if(daysPregnant < 0 || daysPregnant > 300) return "";
    var weeks = Math.floor(daysPregnant / 7);
    var days  = daysPregnant % 7;
    return weeks + "+" + days + " weeks";
  }

  /* Length of stay string from admission ISO timestamp */
  function calcLengthOfStay(admittedIso){
    if(!admittedIso) return "";
    var admitted = new Date(admittedIso);
    if(isNaN(admitted.getTime())) return "";
    var days = Math.floor((Date.now() - admitted.getTime()) / 86400000);
    if(days === 0) return "Admitted today";
    if(days === 1) return "Day 1";
    return "Day " + days;
  }
  function fmtTime(iso){ return new Date(iso).toLocaleString([], {weekday:'short', hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short'}); }
  function fmtTimeShort(iso){ return new Date(iso).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
  function fmtDateShort(iso){ return new Date(iso).toLocaleDateString([], {day:'2-digit', month:'short'}); }
  function escapeHtml(str){
    if(!str) return "";
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  function getStaffName(){
    return (localStorage.getItem(STAFF_NAME_KEY) || state.staffName || "").trim();
  }
  function setStaffName(name){
    var clean = (name || "").trim();
    localStorage.setItem(STAFF_NAME_KEY, clean);
    var staffBtn = document.getElementById("staffNameBtn");
    if(staffBtn) staffBtn.textContent = clean ? ("👤 " + clean) : "👤 Set name";
  }

  /* ============================================================
     LEAD ACCESS CONTROL
     Default PIN: 1234  (Lead should change it on first use)
     PIN is stored hashed (simple FNV-32) in localStorage.
     Session unlocked flag lives only in memory — resets on reload.
  ============================================================ */
  var LEAD_PIN_KEY  = "ward_board_lead_pin";
  var LEAD_DEFAULT  = "1234";
  var hodUnlocked  = false;

  function fnv32(str){
    var h = 0x811c9dc5;
    for(var i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h.toString(16);
  }
  function getStoredPinHash(){
    return localStorage.getItem(LEAD_PIN_KEY) || fnv32(LEAD_DEFAULT);
  }
  function checkPin(pin){
    return fnv32(pin) === getStoredPinHash();
  }
  function savePin(pin){
    localStorage.setItem(LEAD_PIN_KEY, fnv32(pin));
  }

  /* Log an event to state.hodLog (last 30 days rolling) */
  function hodLog(type, detail, wardName){
    if(!state.hodLog) state.hodLog = [];
    var cutoff = Date.now() - 30*24*60*60*1000;
    state.hodLog = state.hodLog.filter(function(e){ return new Date(e.time).getTime() > cutoff; });
    state.hodLog.push({
      type: type,           // admit | discharge | progress | handover
      time: nowISO(),
      by:   getStaffName() || "?",
      ward: wardName || (state.wards[activeWardId] ? state.wards[activeWardId].name : ""),
      detail: detail
    });
    // Don't call saveState here — callers will do it
  }

  /* Unlock / Lock */
  function unlockHod(){
    hodUnlocked = true;
    var btn = document.getElementById("hodBtn");
    if(btn){ btn.style.display = ""; btn.textContent = "🔑 Lead ✓"; }
  }
  function lockHod(){
    hodUnlocked = false;
    var btn = document.getElementById("hodBtn");
    if(btn){ btn.style.display = ""; btn.textContent = "🔑 Lead"; }
    var panel = document.getElementById("hodPanelOverlay");
    if(panel) panel.classList.remove("show");
  }

  /* Always show Lead button — clicking opens PIN if locked, panel if unlocked */
  (function(){
    var btn = document.getElementById("hodBtn");
    if(btn){
      btn.style.display = "";
      btn.onclick = function(){
        if(hodUnlocked){ openHodPanel(); }
        else { openHodPin(); }
      };
    }
  })();

  /* PIN modal */
  function openHodPin(){
    var ov = document.getElementById("hodPinOverlay");
    var inp = document.getElementById("hodPinInput");
    var err = document.getElementById("hodPinError");
    if(inp){ inp.value = ""; }
    if(err){ err.style.display="none"; err.textContent=""; }
    if(ov) ov.classList.add("show");
    setTimeout(function(){ if(inp) inp.focus(); }, 120);
  }
  function closeHodPin(){
    var ov = document.getElementById("hodPinOverlay");
    if(ov) ov.classList.remove("show");
  }
  document.getElementById("closeHodPinModal").onclick = closeHodPin;
  document.getElementById("cancelHodPin").onclick    = closeHodPin;
  document.getElementById("hodPinInput").addEventListener("keydown", function(e){
    if(e.key==="Enter") document.getElementById("submitHodPin").click();
  });
  document.getElementById("submitHodPin").onclick = function(){
    var pin = (document.getElementById("hodPinInput").value || "").trim();
    var err = document.getElementById("hodPinError");
    if(!pin){ err.textContent="Please enter the PIN."; err.style.display="block"; return; }
    if(checkPin(pin)){
      closeHodPin();
      unlockHod();
      openHodPanel();
    } else {
      err.textContent = "❌ Incorrect PIN. Try again.";
      err.style.display = "block";
      document.getElementById("hodPinInput").value = "";
      document.getElementById("hodPinInput").focus();
    }
  };

  /* Lead Panel */
  function openHodPanel(){
    var ov = document.getElementById("hodPanelOverlay");
    if(!ov) return;
    var ti = document.getElementById("hod_appTitle");
    if(ti) ti.value = state.appTitle || "Ward Board";
    renderHodWardList();
    renderHodBedCounts();
    renderHodConsultantList();
    renderLeadWardDeleteList();
    renderHodHistWardFilter();
    renderHodHistory();
    ov.classList.add("show");
  }

  document.getElementById("closeHodPanel").onclick  = function(){ document.getElementById("hodPanelOverlay").classList.remove("show"); };
  document.getElementById("hod_lockBtn").onclick    = lockHod;

  /* Save app title */
  document.getElementById("hod_saveTitle").onclick = function(){
    var val = (document.getElementById("hod_appTitle").value || "").trim() || "Ward Board";
    state.appTitle = val;
    var el = document.getElementById("appTitle");
    if(el) el.textContent = val;
    saveState();
    var btn = document.getElementById("hod_saveTitle");
    btn.textContent = "✓ Saved"; setTimeout(function(){ btn.textContent = "Save title"; }, 1500);
  };

  /* Bed count per ward */
  function renderHodBedCounts(){
    var container = document.getElementById("hod_bedCountList");
    if(!container) return;
    container.innerHTML = "";
    state.wardOrder.forEach(function(id){
      var w = state.wards[id]; if(!w) return;
      var row = document.createElement("div");
      row.className = "hod-ward-row";
      var lbl = document.createElement("span");
      lbl.textContent = w.name;
      lbl.style.cssText = "font-size:0.84rem;font-weight:600;flex:1;min-width:100px;";
      var inp = document.createElement("input");
      inp.type = "number"; inp.min = "1"; inp.max = "30";
      inp.value = w.roomCount || ROOMS_PER_WARD;
      inp.style.cssText = "width:70px;text-align:center;";
      var saveBtn = document.createElement("button");
      saveBtn.className = "btn-outline"; saveBtn.textContent = "Save";
      saveBtn.onclick = function(){
        var val = parseInt(inp.value,10);
        if(!val || val < 1 || val > 30) return;
        w.roomCount = val;
        saveState(); render();
        saveBtn.textContent = "✓"; setTimeout(function(){ saveBtn.textContent = "Save"; }, 1200);
      };
      row.appendChild(lbl); row.appendChild(inp); row.appendChild(saveBtn);
      container.appendChild(row);
    });
  }

  /* Consultant / team list */
  function renderHodConsultantList(){
    var container = document.getElementById("hod_consultantList");
    if(!container) return;
    container.innerHTML = "";
    var list = getConsultants();
    if(!list.length){
      container.innerHTML = '<div style="font-size:0.8rem;color:var(--ink-mute);">No consultants defined yet.</div>';
      return;
    }
    list.forEach(function(c, i){
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;align-items:center;";
      var lbl = document.createElement("span");
      lbl.textContent = c; lbl.style.cssText = "flex:1;font-size:0.84rem;";
      var del = document.createElement("button");
      del.className = "btn-danger-outline btn-small"; del.textContent = "Remove";
      del.onclick = function(){
        state.consultants.splice(i, 1);
        saveState();
        renderHodConsultantList();
      };
      row.appendChild(lbl); row.appendChild(del);
      container.appendChild(row);
    });
  }

  document.getElementById("hod_addConsultant").onclick = function(){
    var inp = document.getElementById("hod_newConsultant");
    var val = (inp.value||"").trim();
    if(!val) return;
    if(!state.consultants) state.consultants = [];
    if(!state.consultants.includes(val)) state.consultants.push(val);
    inp.value = "";
    saveState();
    renderHodConsultantList();
  };
  document.getElementById("hod_newConsultant").addEventListener("keydown", function(e){
    if(e.key==="Enter") document.getElementById("hod_addConsultant").click();
  });

  /* Ward rename list */
  function renderHodWardList(){
    var container = document.getElementById("hod_wardList");
    if(!container) return;
    container.innerHTML = "";
    state.wardOrder.forEach(function(id){
      var w = state.wards[id];
      if(!w) return;
      var row = document.createElement("div");
      row.className = "hod-ward-row";
      var inp = document.createElement("input");
      inp.type = "text"; inp.value = w.name; inp.placeholder = "Ward name";
      var saveBtn = document.createElement("button");
      saveBtn.className = "btn-outline"; saveBtn.textContent = "Save";
      saveBtn.onclick = function(){
        var newName = inp.value.trim();
        if(!newName) return;
        w.name = newName;
        saveState();
        renderWardTabs();
        saveBtn.textContent = "✓"; setTimeout(function(){ saveBtn.textContent = "Save"; }, 1200);
      };
      row.appendChild(inp); row.appendChild(saveBtn);
      container.appendChild(row);
    });
  }

  /* History ward filter */
  function renderHodHistWardFilter(){
    var sel = document.getElementById("hod_histWard");
    if(!sel) return;
    sel.innerHTML = '<option value="">All wards</option>';
    state.wardOrder.forEach(function(id){
      var w = state.wards[id]; if(!w) return;
      var o = document.createElement("option"); o.value = w.name; o.textContent = w.name;
      sel.appendChild(o);
    });
  }

  /* History rendering */
  function renderHodHistory(){
    var container = document.getElementById("hod_histLog");
    if(!container) return;
    var wardFilter = (document.getElementById("hod_histWard")||{}).value || "";
    var typeFilter = (document.getElementById("hod_histType")||{}).value || "";

    // Gather all events: patient history entries + hodLog events
    var events = [];
    var cutoff = Date.now() - 30*24*60*60*1000;

    // From hodLog (admit, discharge, handover)
    if(state.hodLog){
      state.hodLog.forEach(function(e){
        if(new Date(e.time).getTime() < cutoff) return;
        if(wardFilter && e.ward !== wardFilter) return;
        if(typeFilter && e.type !== typeFilter) return;
        events.push(e);
      });
    }

    // From patient progress histories across all wards
    if(!typeFilter || typeFilter === "progress"){
      state.wardOrder.forEach(function(id){
        var w = state.wards[id]; if(!w||!w.rooms) return;
        if(wardFilter && w.name !== wardFilter) return;
        Object.keys(w.rooms).forEach(function(bKey){
          var p = w.rooms[bKey]; if(!p||!Array.isArray(p.history)) return;
          p.history.forEach(function(h){
            if(!h.time || new Date(h.time).getTime() < cutoff) return;
            events.push({
              type:"progress", time:h.time, by:h.updatedBy||"?",
              ward:w.name,
              detail: (p.name||bKey) + " — Acuity: " + (h.acuity||"?") +
                      (h.situation ? " | " + h.situation.slice(0,80) : "") +
                      (h.plan      ? " | Plan: " + h.plan.slice(0,60) : "")
            });
          });
        });
      });
    }

    // Sort newest first
    events.sort(function(a,b){ return new Date(b.time) - new Date(a.time); });

    if(events.length === 0){
      container.innerHTML = '<div class="hist-empty">No entries found in the last 30 days.</div>';
      return;
    }

    var html = "";
    events.forEach(function(e){
      html += '<div class="hist-entry">' +
        '<div class="hist-entry-top">' +
          '<span><span class="hist-entry-type '+e.type+'">'+e.type+'</span> ' +
          '<span class="hist-entry-who">'+escapeHtml(e.by)+'</span></span>' +
          '<span class="hist-entry-time">'+fmtTime(e.time)+'</span>' +
        '</div>' +
        '<div class="hist-entry-top" style="margin-top:2px;">' +
          '<span class="hist-entry-ward">'+escapeHtml(e.ward||"")+'</span>' +
        '</div>' +
        (e.detail ? '<div class="hist-entry-body">'+escapeHtml(e.detail)+'</div>' : '') +
        '</div>';
    });
    container.innerHTML = html;
  }

  // Re-render history when filters change
  document.getElementById("hod_histWard").addEventListener("change", renderHodHistory);
  document.getElementById("hod_histType").addEventListener("change", renderHodHistory);

  /* Change PIN */
  document.getElementById("hod_savePin").onclick = function(){
    var np  = (document.getElementById("hod_newPin").value  ||"").trim();
    var cp  = (document.getElementById("hod_confirmPin").value||"").trim();
    var msg = document.getElementById("hod_pinMsg");
    if(!np || np.length < 4){ msg.textContent="PIN must be at least 4 digits."; msg.style.color=var_red(); msg.style.display="block"; return; }
    if(np !== cp){ msg.textContent="PINs do not match."; msg.style.color=var_red(); msg.style.display="block"; return; }
    savePin(np);
    document.getElementById("hod_newPin").value = "";
    document.getElementById("hod_confirmPin").value = "";
    msg.textContent = "✓ PIN updated successfully."; msg.style.color="var(--accent)"; msg.style.display="block";
    setTimeout(function(){ msg.style.display="none"; }, 2500);
  };
  function var_red(){ return "var(--red)"; }

  /* ============================================================ */

  /* ============================================================
     OVERFLOW MENU
  ============================================================ */
  var overflowBtn  = document.getElementById("overflowBtn");
  var overflowMenu = document.getElementById("overflowMenu");
  if(overflowBtn){
    overflowBtn.onclick = function(e){
      e.stopPropagation();
      var open = overflowMenu.style.display !== "none";
      if(!open){
        var rect = overflowBtn.getBoundingClientRect();
        overflowMenu.style.top  = (rect.bottom + 6) + "px";
        overflowMenu.style.right = (window.innerWidth - rect.right) + "px";
      }
      overflowMenu.style.display = open ? "none" : "block";
    };
  }
  document.addEventListener("click", function(e){
    if(overflowMenu && !overflowMenu.contains(e.target) && e.target !== overflowBtn){
      overflowMenu.style.display = "none";
    }
    // Also close any bed more menus
    if(!e.target.closest(".bed-more-menu") && !e.target.textContent.includes("⋯")){
      document.querySelectorAll(".bed-more-menu").forEach(function(m){ m.style.display="none"; });
    }
  });
  // Wire overflow menu items to close menu after click
  if(overflowMenu){
    overflowMenu.querySelectorAll("button").forEach(function(btn){
      btn.addEventListener("click", function(){ overflowMenu.style.display = "none"; });
    });
  }

  /* ============================================================
     CLOUD DOT STATUS
  ============================================================ */
  function setCloudDot(status){ // 'connecting' | 'live' | 'error'
    var dot = document.getElementById("cloudDot");
    var statusEl = document.getElementById("cloudStatus");
    if(!dot) return;
    if(status === "live"){
      dot.style.background = "#4ade80";
      dot.title = "Live sync active";
      if(statusEl) statusEl.textContent = "⚡ Live sync active";
    } else if(status === "error"){
      dot.style.background = "#f87171";
      dot.title = "Sync error";
      if(statusEl) statusEl.textContent = "❌ Sync error";
    } else {
      dot.style.background = "rgba(255,255,255,0.3)";
      dot.title = "Connecting…";
      if(statusEl) statusEl.textContent = "☁️ Connecting…";
    }
  }
  window.setCloudDot = setCloudDot;

  /* ============================================================
     SKELETON LOADER
  ============================================================ */
  var _firstLoad = true;
  document.body.classList.add("first-load");
  function showSkeleton(){ if(_firstLoad){ document.getElementById("skeletonLoader").style.display="grid"; document.getElementById("grid").style.display="none"; } }
  function hideSkeleton(){
    _firstLoad=false;
    document.getElementById("skeletonLoader").style.display="none";
    document.getElementById("grid").style.display="";
    // Remove first-load class after animation completes
    setTimeout(function(){ document.body.classList.remove("first-load"); }, 500);
  }
  showSkeleton();

  /* ============================================================
     ACUITY SUMMARY BAR
  ============================================================ */
  function renderAcuitySummaryBar(urgentCount, reviewCount, stableCount){
    var bar = document.getElementById("acuitySummaryBar");
    if(!bar) return;
    var total = urgentCount + reviewCount + stableCount;
    bar.innerHTML =
      '<div class="acuity-seg seg-total'+(activeAcuityFilter===''?' active':'')+'" id="segTotal">' +
        '<span class="seg-n">'+total+'</span><span class="seg-l">Total</span>' +
      '</div>' +
      '<div class="acuity-seg seg-urgent'+(activeAcuityFilter==="urgent"?" active":"")+'" id="segUrgent">' +
        '<span class="seg-n">'+urgentCount+'</span><span class="seg-l">🔴 Urgent</span>' +
      '</div>' +
      '<div class="acuity-seg seg-review'+(activeAcuityFilter==="review"?" active":"")+'" id="segReview">' +
        '<span class="seg-n">'+reviewCount+'</span><span class="seg-l">🟡 Review</span>' +
      '</div>' +
      '<div class="acuity-seg seg-stable'+(activeAcuityFilter==="stable"?" active":"")+'" id="segStable">' +
        '<span class="seg-n">'+stableCount+'</span><span class="seg-l">🟢 Stable</span>' +
      '</div>';
    var acts = {segTotal:"", segUrgent:"urgent", segReview:"review", segStable:"stable"};
    Object.keys(acts).forEach(function(id){
      var el = document.getElementById(id);
      if(el) el.onclick = function(){
        activeAcuityFilter = (activeAcuityFilter === acts[id]) ? "" : acts[id];
        render();
      };
    });
  }

  /* ============================================================
     COMPACT / FULL VIEW TOGGLE
  ============================================================ */
  var VIEW_KEY = "wb_view";
  function applyView(v){
    document.body.classList.toggle("view-compact", v==="compact");
    localStorage.setItem(VIEW_KEY, v);
    var fb = document.getElementById("viewFull");
    var cb = document.getElementById("viewCompact");
    if(fb){ fb.classList.toggle("active", v!=="compact"); }
    if(cb){ cb.classList.toggle("active", v==="compact"); }
  }
  applyView(localStorage.getItem(VIEW_KEY)||"full");
  document.getElementById("viewFull").onclick    = function(){ applyView("full"); };
  document.getElementById("viewCompact").onclick = function(){ applyView("compact"); };

  /* ============================================================
     WARD TAB FADE TRANSITION
  ============================================================ */
  var _origSwitchWard = function(id){
    var grid = document.getElementById("grid");
    if(grid) grid.classList.add("fading");
    setTimeout(function(){
      activeWardId = id;
      render();
      if(grid){ grid.classList.remove("fading"); }
    }, 120);
  };

  /* ============================================================
     HAPTIC FEEDBACK
  ============================================================ */
  function haptic(type){
    if(!navigator.vibrate) return;
    if(type === "success") navigator.vibrate(10);
    else if(type === "urgent") navigator.vibrate([10,40,10]);
    else if(type === "error") navigator.vibrate([40,20,40]);
  }
  window.haptic = haptic;

  /* ============================================================
     SAVE SUCCESS FLASH on bed card
  ============================================================ */
  function flashCard(room, bed){
    var cards = document.querySelectorAll("[data-room='"+room+"'][data-bed='"+bed+"']");
    cards.forEach(function(c){
      c.classList.remove("save-flash");
      void c.offsetWidth; // reflow to restart animation
      c.classList.add("save-flash");
      setTimeout(function(){ c.classList.remove("save-flash"); }, 700);
    });
    haptic("success");
  }
  window.flashCard = flashCard;

  /* ============================================================
     SWIPE TO DISMISS MODALS
  ============================================================ */
  (function(){
    var startY = 0, startX = 0, swipeTarget = null;
    document.addEventListener("touchstart", function(e){
      // Only trigger swipe from the modal-swipe-bar or modal-head (not scrollable body)
      var bar = e.target.closest(".modal-swipe-bar, .modal-head");
      if(!bar) return;
      swipeTarget = e.target.closest(".overlay");
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
    }, {passive: true});
    document.addEventListener("touchend", function(e){
      if(!swipeTarget) return;
      var dy = e.changedTouches[0].clientY - startY;
      var dx = Math.abs(e.changedTouches[0].clientX - startX);
      if(dy > 50 && dx < 50 && swipeTarget.classList.contains("show")){
        swipeTarget.classList.remove("show");
      }
      swipeTarget = null;
    }, {passive: true});
  })();

  /* ============================================================
     DARK MODE TOGGLE
  ============================================================ */
  var THEME_KEY = "wb_theme";
  function getEffectiveTheme(){
    var stored = localStorage.getItem(THEME_KEY);
    if(stored) return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyTheme(theme){
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
    var btn = document.getElementById("darkModeBtn");
    if(btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
    btn && (btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  }
  // Apply on load
  applyTheme(getEffectiveTheme());
  document.getElementById("darkModeBtn").onclick = function(){
    var current = document.documentElement.getAttribute("data-theme") || getEffectiveTheme();
    applyTheme(current === "dark" ? "light" : "dark");
  };

  /* ============================================================
     PATIENT FLAGS
  ============================================================ */
  var FLAG_DEFS = [
    {key:"NBM",           cls:"flag-nbm",       icon:"💧"},
    {key:"THEATRE",       cls:"flag-theatre",   icon:"🔪"},
    {key:"SCAN",          cls:"flag-scan",       icon:"🔬"},
    {key:"ISOLATION",     cls:"flag-isolation",  icon:"🚫"},
    {key:"FAMILY MTG",    cls:"flag-family",    icon:"👥"},
    {key:"SENIOR REVIEW", cls:"flag-review",    icon:"👨‍⚕️"},
  ];
  function getFlagDef(key){ return FLAG_DEFS.find(function(f){ return f.key===key; })||{key:key,cls:"flag-custom",icon:"🏷️"}; }

  // Wire flag selector buttons in patient modal
  document.querySelectorAll(".flag-sel-btn").forEach(function(btn){
    btn.onclick = function(){
      btn.classList.toggle("selected");
    };
  });

  function getSelectedFlags(){
    var flags = [];
    document.querySelectorAll(".flag-sel-btn.selected").forEach(function(b){ flags.push(b.dataset.flag); });
    return flags;
  }
  function setSelectedFlags(flags){
    document.querySelectorAll(".flag-sel-btn").forEach(function(b){
      b.classList.toggle("selected", flags && flags.indexOf(b.dataset.flag) > -1);
    });
  }

  /* ============================================================
     ON-CALL BOARD
  ============================================================ */
  var DEFAULT_ONCALL_ROLES = ["Consultant","Registrar","SHO","Midwife in charge","Anaesthetist"];

  function renderOnCallBar(){
    var bar = document.getElementById("onCallBar");
    if(!bar) return;
    var staff = state.onCallStaff || [];
    var editBtn = document.createElement("button");
    editBtn.id = "onCallEditBtn"; editBtn.textContent = "✏️ Edit";
    editBtn.onclick = openOnCallModal;

    bar.innerHTML = "";
    if(!staff.length || !staff.some(function(s){ return s.name && s.name.trim(); })){
      var empty = document.createElement("span");
      empty.className = "oncall-empty";
      empty.textContent = "No on-call staff set";
      bar.appendChild(empty);
    } else {
      staff.forEach(function(s){
        if(!s.name) return;
        var seg = document.createElement("span");
        seg.style.cssText = "display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap;";
        seg.innerHTML =
          '<span class="oncall-label">'+escapeHtml(s.role||"")+'</span>' +
          '<span class="oncall-name">'+escapeHtml(s.name||"—")+'</span>' +
          (s.ward ? '<span class="oncall-ward">&nbsp;('+escapeHtml(s.ward)+')</span>' : '');
        bar.appendChild(seg);
      });
    }
    bar.appendChild(editBtn);
  }

  function openOnCallModal(){
    if(!state.onCallStaff || !state.onCallStaff.length){
      state.onCallStaff = DEFAULT_ONCALL_ROLES.map(function(r){ return {role:r,name:"",ward:""}; });
    }
    renderOnCallFields();
    document.getElementById("onCallOverlay").classList.add("show");
  }

  function renderOnCallFields(){
    var container = document.getElementById("onCallFields");
    if(!container) return;
    container.innerHTML = "";
    (state.onCallStaff||[]).forEach(function(s, i){
      var row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1.2fr auto;gap:6px;align-items:center;";
      row.innerHTML =
        '<input type="text" placeholder="Role (e.g. Registrar)" value="'+escapeHtml(s.role||"")+'" data-idx="'+i+'" data-field="role" style="font-size:0.8rem;">' +
        '<input type="text" placeholder="Name / Initials" value="'+escapeHtml(s.name||"")+'" data-idx="'+i+'" data-field="name" style="font-size:0.8rem;" maxlength="30">' +
        '<input type="text" placeholder="Ward / Rooms (e.g. Ward A, 1-12)" value="'+escapeHtml(s.ward||"")+'" data-idx="'+i+'" data-field="ward" style="font-size:0.8rem;" maxlength="40">' +
        '<button class="btn-danger-outline btn-small oncall-del" data-idx="'+i+'" style="white-space:nowrap;padding:6px 8px;">✕</button>';
      container.appendChild(row);
    });
    // Wire inputs
    container.querySelectorAll("input[data-field]").forEach(function(inp){
      inp.addEventListener("input", function(){
        var idx = parseInt(inp.dataset.idx,10);
        state.onCallStaff[idx][inp.dataset.field] = inp.value;
      });
    });
    container.querySelectorAll(".oncall-del").forEach(function(btn){
      btn.onclick = function(){
        var idx = parseInt(btn.dataset.idx,10);
        state.onCallStaff.splice(idx,1);
        renderOnCallFields();
      };
    });
  }

  document.getElementById("addOnCallRole").onclick = function(){
    if(!state.onCallStaff) state.onCallStaff = [];
    state.onCallStaff.push({role:"",name:"",ward:""});
    renderOnCallFields();
  };
  document.getElementById("closeOnCall").onclick  = function(){ document.getElementById("onCallOverlay").classList.remove("show"); };
  document.getElementById("cancelOnCall").onclick = function(){ document.getElementById("onCallOverlay").classList.remove("show"); };
  document.getElementById("saveOnCall").onclick   = function(){
    saveState();
    renderOnCallBar();
    document.getElementById("onCallOverlay").classList.remove("show");
  };
  document.getElementById("onCallEditBtn").onclick = openOnCallModal;

  /* ============================================================
     ACTIVITY FEED
  ============================================================ */
  var _feedOpen = false;
  var _lastFeedCount = 0;

  function renderActivityFeed(){
    var list = document.getElementById("feedList");
    if(!list) return;
    var entries = (state.hodLog||[]).slice().reverse().slice(0,40);
    if(!entries.length){
      list.innerHTML = '<div class="feed-empty">No activity recorded yet.<br>Progress updates, admissions, and discharges will appear here.</div>';
      return;
    }
    list.innerHTML = entries.map(function(e){
      var typeLabels = {
        progress:"Progress note", admit:"Admitted", discharge:"Discharged",
        transfer:"Transferred", handover:"Handover", edit:"Updated"
      };
      var timeAgo = relativeTime(e.time);
      var detail = e.detail ? ' — <span style="color:var(--ink-soft);">'+escapeHtml(e.detail.slice(0,60))+'</span>' : '';
      return '<div class="feed-item">' +
        '<div class="feed-dot '+(e.type||"edit")+'"></div>' +
        '<div class="feed-body">' +
          '<div class="feed-action"><strong>'+escapeHtml(e.by||"Staff")+'</strong> · '+(typeLabels[e.type]||e.type)+detail+'</div>' +
          '<div class="feed-meta">'+escapeHtml(e.ward||"")+(e.ward?" · ":"")+timeAgo+'</div>' +
        '</div></div>';
    }).join("");
  }

  function relativeTime(iso){
    if(!iso) return "";
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff/60000);
    if(mins < 1) return "just now";
    if(mins < 60) return mins+"m ago";
    var hrs = Math.floor(mins/60);
    if(hrs < 24) return hrs+"h ago";
    return Math.floor(hrs/24)+"d ago";
  }

  function updateFeedBadge(){
    var badge = document.getElementById("feedBadge");
    if(!badge) return;
    var count = (state.hodLog||[]).length;
    var newCount = count - _lastFeedCount;
    if(newCount > 0 && !_feedOpen){
      badge.textContent = newCount > 9 ? "9+" : newCount;
      badge.style.display = "flex";
    } else {
      badge.style.display = "none";
    }
  }

  document.getElementById("activityFeedBtn").onclick = function(){
    _feedOpen = !_feedOpen;
    document.getElementById("activityFeedPanel").classList.toggle("open", _feedOpen);
    if(_feedOpen){
      renderActivityFeed();
      _lastFeedCount = (state.hodLog||[]).length;
      updateFeedBadge();
    }
  };
  document.getElementById("closeFeedPanel").onclick = function(){
    _feedOpen = false;
    document.getElementById("activityFeedPanel").classList.remove("open");
  };

  // Swipe down to close feed panel
  (function(){
    var sy = 0;
    var feedPanel = document.getElementById("activityFeedPanel");
    if(!feedPanel) return;
    feedPanel.addEventListener("touchstart", function(e){ sy = e.touches[0].clientY; }, {passive:true});
    feedPanel.addEventListener("touchend", function(e){
      if(e.changedTouches[0].clientY - sy > 60){
        _feedOpen = false;
        feedPanel.classList.remove("open");
      }
    }, {passive:true});
  })();

  /* ============================================================
     SAVE FAILURE BANNER
  ============================================================ */
  function showSaveFailBanner(){ document.getElementById("saveFailBanner").style.display = "flex"; }
  function hideSaveFailBanner(){ document.getElementById("saveFailBanner").style.display = "none"; }
  window.showSaveFailBanner = showSaveFailBanner;
  window.hideSaveFailBanner = hideSaveFailBanner;

  /* ============================================================
     CONSULTANT DROPDOWN — population helpers
  ============================================================ */
  function getConsultants(){
    return state.consultants && state.consultants.length ? state.consultants : [];
  }
  function populateConsultantDropdown(currentVal){
    var sel = document.getElementById("f_unit");
    if(!sel) return;
    var consultants = getConsultants();
    sel.innerHTML = '<option value="">— Select —</option>';
    consultants.forEach(function(c){
      var opt = document.createElement("option");
      opt.value = c; opt.textContent = c;
      if(c === currentVal) opt.selected = true;
      sel.appendChild(opt);
    });
    // If current value isn't in list (legacy free-text), add it
    if(currentVal && !consultants.includes(currentVal)){
      var opt = document.createElement("option");
      opt.value = currentVal; opt.textContent = currentVal + " (custom)";
      opt.selected = true;
      sel.appendChild(opt);
    }
  }

  /* Returns the staff name, or null if not set (callers must handle null) */
  function ensureStaffName(){
    return getStaffName() || null;
  }

  function showSaveError(elementId, msg){
    var el = document.getElementById(elementId);
    if(!el) return;
    el.textContent = msg;
    el.style.display = "block";
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function hideSaveError(elementId){
    var el = document.getElementById(elementId);
    if(el){ el.style.display = "none"; el.textContent = ""; }
  }

  /* ============================================================
     MODAL HELPERS — replace all browser prompt/alert/confirm
  ============================================================ */

  /* Generic confirm modal */
  var _confirmCallback = null;
  function showConfirm(title, msg, okLabel, okClass, cb){
    document.getElementById("confirmTitle").textContent = title;
    document.getElementById("confirmMsg").textContent   = msg;
    var okBtn = document.getElementById("okConfirm");
    okBtn.textContent  = okLabel || "Confirm";
    okBtn.className    = okClass || "btn-danger-outline";
    _confirmCallback   = cb;
    document.getElementById("confirmOverlay").classList.add("show");
  }
  function closeConfirmModal(){ document.getElementById("confirmOverlay").classList.remove("show"); _confirmCallback = null; }
  document.getElementById("closeConfirm").onclick  = closeConfirmModal;
  document.getElementById("cancelConfirm").onclick = closeConfirmModal;
  document.getElementById("okConfirm").onclick = function(){
    closeConfirmModal();
    if(_confirmCallback) _confirmCallback();
  };

  /* Notification info modal (replaces alert) */
  function showNotifInfo(title, msg){
    document.getElementById("notifInfoTitle").textContent = title;
    document.getElementById("notifInfoMsg").textContent   = msg;
    document.getElementById("notifInfoOverlay").classList.add("show");
  }
  document.getElementById("closeNotifInfo").onclick = function(){ document.getElementById("notifInfoOverlay").classList.remove("show"); };
  document.getElementById("okNotifInfo").onclick    = function(){ document.getElementById("notifInfoOverlay").classList.remove("show"); };

  /* Set Name Modal */
  function openSetNameModal(){
    var inp = document.getElementById("setNameInput");
    var err = document.getElementById("setNameError");
    if(inp) inp.value = getStaffName() || "";
    if(err){ err.style.display="none"; err.textContent=""; }
    document.getElementById("setNameOverlay").classList.add("show");
    setTimeout(function(){ if(inp) inp.focus(); }, 120);
  }
  function closeSetNameModal(){ document.getElementById("setNameOverlay").classList.remove("show"); }
  document.getElementById("closeSetName").onclick  = closeSetNameModal;
  document.getElementById("cancelSetName").onclick = closeSetNameModal;
  document.getElementById("setNameInput").addEventListener("keydown", function(e){ if(e.key==="Enter") document.getElementById("confirmSetName").click(); });
  document.getElementById("confirmSetName").onclick = function(){
    var inp = document.getElementById("setNameInput");
    var err = document.getElementById("setNameError");
    var clean = (inp.value||"").trim();
    if(!clean){
      err.textContent = "Name cannot be blank.";
      err.style.display = "block";
      inp.focus();
      return;
    }
    setStaffName(clean);
    var btn = document.getElementById("staffNameBtn");
    if(btn) btn.textContent = "👤 " + clean;
    hideSaveError("patientSaveError");
    hideSaveError("progressSaveError");
    closeSetNameModal();
  };

  /* Add Ward Modal */
  function openAddWardModal(){
    var inp = document.getElementById("addWardInput");
    var err = document.getElementById("addWardError");
    if(inp){ inp.value = "Ward " + String.fromCharCode(65 + state.wardOrder.length); inp.select(); }
    if(err){ err.style.display="none"; err.textContent=""; }
    document.getElementById("addWardOverlay").classList.add("show");
    setTimeout(function(){ if(inp) inp.focus(); inp && inp.select(); }, 120);
  }
  function closeAddWardModal(){ document.getElementById("addWardOverlay").classList.remove("show"); }
  document.getElementById("closeAddWard").onclick  = closeAddWardModal;
  document.getElementById("cancelAddWard").onclick = closeAddWardModal;
  document.getElementById("addWardInput").addEventListener("keydown", function(e){ if(e.key==="Enter") document.getElementById("confirmAddWard").click(); });
  document.getElementById("confirmAddWard").onclick = function(){
    var inp = document.getElementById("addWardInput");
    var err = document.getElementById("addWardError");
    var name = (inp.value||"").trim();
    if(!name){ err.textContent="Ward name cannot be blank."; err.style.display="block"; return; }
    var id = uid();
    state.wards[id] = { name: name, rooms: {}, roomConfig: {} };
    state.wardOrder.push(id);
    activeWardId = id;
    saveState(); render();
    closeAddWardModal();
  };

  var staffBtn = document.getElementById("staffNameBtn");
  if(staffBtn){
    staffBtn.onclick = openSetNameModal;
  }

  var titleEl = document.getElementById("appTitle");
  if(titleEl){
    // Double-click to unlock and rename
    titleEl.addEventListener("dblclick", function(){
      titleEl.contentEditable = "true";
      titleEl.focus();
      // Select all text so user can type immediately
      var range = document.createRange();
      range.selectNodeContents(titleEl);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      titleEl.title = "Press Enter or click away to save";
    });
    // Save and lock on blur
    titleEl.addEventListener("blur", function(){
      titleEl.contentEditable = "false";
      titleEl.title = "Double-click to rename";
      state.appTitle = titleEl.textContent.trim() || "Ward Board";
      titleEl.textContent = state.appTitle;
      saveState();
    });
    // Also save on Enter key
    titleEl.addEventListener("keydown", function(e){
      if(e.key === "Enter"){ e.preventDefault(); titleEl.blur(); }
      if(e.key === "Escape"){ titleEl.textContent = state.appTitle || "Ward Board"; titleEl.blur(); }
    });
  }

  /* Ward Tabs */
  /* Overdue: returns true if nextReview time has passed */
  function isOverdue(patient){
    if(!patient || !patient.nextReview) return false;
    var d = new Date(patient.nextReview);
    if(isNaN(d.getTime())) return false;
    return new Date() > d;
  }

  /* Track urgent patients to fire push notifications */
  var _prevUrgentKeys = {};

  function getWardOccupancy(wardId){
    var w = state.wards[wardId]; if(!w||!w.rooms) return {occ:0,total:0};
    var occ=0, total=0;
    var rc = w.roomCount || ROOMS_PER_WARD;
    for(var r=1;r<=rc;r++){
      var hasB = (w.roomConfig&&w.roomConfig[r]&&w.roomConfig[r].hasB)||!!w.rooms[r+"B"];
      var beds = hasB?["A","B"]:["A"];
      beds.forEach(function(b){ total++; if(w.rooms[r+b]) occ++; });
    }
    return {occ:occ,total:total};
  }

  function renderWardTabs(){
    var wardTabsEl = document.getElementById("wardTabs");
    if(!wardTabsEl) return;
    wardTabsEl.innerHTML = "";
    state.wardOrder.forEach(function(id){
      var w = state.wards[id];
      if(!w) return;
      var occ = getWardOccupancy(id);
      var tab = document.createElement("div");
      tab.className = "ward-tab" + (id===activeWardId ? " active" : "");
      tab.innerHTML = escapeHtml(w.name) + '<span class="ward-tab-count">'+occ.occ+'/'+occ.total+'</span>';
      tab.onclick = (function(wid){ return function(){ _origSwitchWard(wid); }; })(id);
      wardTabsEl.appendChild(tab);
    });
    var addTab = document.createElement("div");
    addTab.className = "ward-tab add-ward";
    addTab.textContent = "+ Add ward";
    addTab.onclick = function(){ openAddWardModal(); };
    wardTabsEl.appendChild(addTab);
  }

  /* Floor Map Bar */
  function renderFloorMapBar(){
    var bar = document.getElementById("floorMapBar");
    if(!bar) return;
    bar.innerHTML = '<span class="floor-map-label">Quick Jump:</span>';
    var w = currentWard();

    var fmrc = (currentWard().roomCount||ROOMS_PER_WARD); for(var r=1; r<=fmrc; r++){
      var pill = document.createElement("a");
      pill.className = "room-pill";
      pill.textContent = r;
      pill.href = "#room_" + r;

      var pA = w.rooms[r+"A"];
      var pB = w.rooms[r+"B"];
      var targetP = (pA && pA.acuity === "urgent") ? pA : ((pB && pB.acuity === "urgent") ? pB : (pA || pB));
      if(targetP){
        pill.classList.add("occ-" + (targetP.acuity || "stable"));
      }
      bar.appendChild(pill);
    }
  }

  var TYPE_LABEL = { antenatal:"Antenatal", postnatal:"Postnatal", gynae:"Gynae" };
  var ACUITY_LABEL = { stable:"Stable", review:"Needs Review", urgent:"Urgent" };

  function render(){
    try {
    state = normalizeState(state);
    renderWardTabs();
    renderFloorMapBar();
    var grid = document.getElementById("grid");
    if(!grid) return;
    grid.innerHTML = "";

    var searchBox = document.getElementById("searchBox");
    var unitFilter = document.getElementById("unitFilter");
    var typeFilter = document.getElementById("typeFilter");

    var query = searchBox ? searchBox.value.trim().toLowerCase() : "";
    var unitQ = unitFilter ? unitFilter.value : "";
    var typeQ = typeFilter ? typeFilter.value : "";

    var occCount=0, urgentCount=0, reviewCount=0, stableCount=0;
    var w = currentWard();
    var _rc = w.roomCount || ROOMS_PER_WARD;

    for(var r=1; r<=_rc; r++){
      var hasB = (w.roomConfig && w.roomConfig[r] && w.roomConfig[r].hasB) || !!w.rooms[r+"B"];
      var beds = hasB ? ["A", "B"] : ["A"];
      beds.forEach(function(bed){
        var p = w.rooms[bedKey(r, bed)] || null;
        if(p){
          occCount++;
          if(p.acuity==="urgent") urgentCount++;
          else if(p.acuity==="review") reviewCount++;
          else stableCount++;
        }
      });
    }

    var statPills = document.getElementById("statPills");
    if(statPills){
      statPills.innerHTML =
        '<span class="pill occ"><span class="n">'+occCount+'</span> occupied</span>';
    }
    // Update acuity summary bar
    renderAcuitySummaryBar(urgentCount, reviewCount, stableCount);
    // Hide skeleton on first render
    hideSkeleton();

    var _wrc = w.roomCount || ROOMS_PER_WARD;
    for(var room=1; room<=_wrc; room++){
      if(!w.roomConfig[room]) w.roomConfig[room] = { hasB: !!w.rooms[room+"B"] };
      if(w.rooms[room+"B"]) w.roomConfig[room].hasB = true;

      var activeBeds = ["A"];
      if(w.roomConfig[room].hasB) activeBeds.push("B");

      var anyVisible = false;
      var groupWrap = document.createElement("div");
      groupWrap.className = "room-group";

      activeBeds.forEach(function(bed){
        var key = bedKey(room, bed);
        var patient = w.rooms[key] || null;

        if(patient){
          if(unitQ && patient.unit !== unitQ) return;
          if(typeQ && patient.type !== typeQ) return;
          if(activeAcuityFilter && patient.acuity !== activeAcuityFilter) return;
          if(query){
            var hay = [patient.name, patient.diagnosis, patient.situation, patient.plan, room+bed].join(" ").toLowerCase();
            if(hay.indexOf(query) === -1) return;
          }
        } else {
          if(unitQ || typeQ || activeAcuityFilter) return;
          if(query && (room+bed).toLowerCase().indexOf(query)===-1) return;
        }
        anyVisible = true;
        groupWrap.appendChild(renderBedCard(room, bed, patient));
      });

      if(anyVisible){
        var headerRow = document.createElement("div");
        headerRow.className = "room-header-row";
        headerRow.id = "room_" + room;
        
        var label = document.createElement("div");
        label.className = "room-group-label";
        label.textContent = "Room " + room;
        headerRow.appendChild(label);

        if(!w.roomConfig[room].hasB){
          var addBBtn = document.createElement("button");
          addBBtn.className = "add-bedb-btn";
          addBBtn.textContent = "+ Add Bed B";
          addBBtn.onclick = (function(rNum){
            return function(){
              w.roomConfig[rNum] = { hasB: true };
              saveState(); render();
            };
          })(room);
          headerRow.appendChild(addBBtn);
        } else {
          var removeBBtn = document.createElement("button");
          removeBBtn.className = "add-bedb-btn";
          removeBBtn.style.color = "var(--red)";
          removeBBtn.textContent = "Remove Bed B";
          removeBBtn.onclick = (function(rNum){
            return function(){
              if(w.rooms[rNum+"B"]){
                showConfirm("Remove Bed B", "Bed "+rNum+"B is occupied. Removing it will discharge this patient from the board. Are you sure?", "Remove anyway", "btn-danger-outline", function(){
                  delete w.rooms[rNum+"B"];
                  w.roomConfig[rNum] = { hasB: false };
                  saveState(); render();
                });
              } else {
                delete w.rooms[rNum+"B"];
                w.roomConfig[rNum] = { hasB: false };
                saveState(); render();
              }
            };
          })(room);
          headerRow.appendChild(removeBBtn);
        }

        grid.appendChild(headerRow);
        grid.appendChild(groupWrap);
      }
    } // end for loop
    } catch(err) {
      console.error("Ward Board render error:", err);
      var grid2 = document.getElementById("grid");
      if(grid2) grid2.innerHTML =
        '<div style="grid-column:1/-1;padding:40px 24px;text-align:center;color:var(--red);">'+
        '<div style="font-size:1.5rem;margin-bottom:12px;">⚠️</div>'+
        '<div style="font-weight:700;margin-bottom:8px;">Display error — your data is safe</div>'+
        '<div style="font-size:0.84rem;color:var(--ink-soft);margin-bottom:16px;">'+escapeHtml(err.message)+'</div>'+
        '<button onclick="location.reload()" class="btn-primary">Reload</button>'+
        '</div>';
    }
  }

  /* Parse a lab string like "Hb 10.2 · WBC 12.1" into key-value pairs */
  function parseLabString(str){
    if(!str) return {};
    var result = {};
    // Match patterns like "Hb 10.2", "WBC 12.1", "Plt 180", "Cr 85"
    var matches = str.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:?\s*(\d+\.?\d*)/g);
    for(var m of matches){ result[m[1].toUpperCase()] = parseFloat(m[2]); }
    return result;
  }

  /* Build a trend object: {Hb: [10.2, 9.8, 9.1], WBC: [12, 11]} from history */
  function buildLabTrend(patient){
    if(!patient || !patient.history || patient.history.length < 2) return {};
    var trend = {};
    // Oldest first
    patient.history.forEach(function(entry){
      if(!entry.labs && !entry.situation) return;
      var parsed = parseLabString(entry.labs || "");
      Object.keys(parsed).forEach(function(key){
        if(!trend[key]) trend[key] = [];
        trend[key].push(parsed[key]);
      });
    });
    // Also include current patient labs
    if(patient.labs){
      var cur = parseLabString(patient.labs);
      Object.keys(cur).forEach(function(key){
        if(!trend[key]) trend[key] = [];
        // Only add if different from last value
        var last = trend[key][trend[key].length-1];
        if(last !== cur[key]) trend[key].push(cur[key]);
      });
    }
    // Keep only keys with at least 2 values (a trend)
    Object.keys(trend).forEach(function(k){ if(trend[k].length < 2) delete trend[k]; });
    return trend;
  }

  /* Format a trend array as "10.2 → 9.8 → 9.1 ↓" */
  function formatTrend(values){
    if(!values || values.length < 2) return "";
    var arrow = "";
    var last  = values[values.length-1];
    var prev  = values[values.length-2];
    if(last < prev)      arrow = ' <span style="color:var(--red);">↓</span>';
    else if(last > prev) arrow = ' <span style="color:var(--accent);">↑</span>';
    else                 arrow = ' <span style="color:var(--ink-mute);">→</span>';
    return values.join(" → ") + arrow;
  }

  function renderBedCard(room, bed, patient){
    var card = document.createElement("div");
    card.className = "bed-card " + (patient ? "occupied acuity-" + patient.acuity : "empty");
    card.dataset.room = room; card.dataset.bed = bed;

    var top = document.createElement("div");
    top.className = "bed-top";

    if(!patient){
      // Collapsed empty bed
      top.innerHTML =
        '<div class="bed-num">Bed '+room+bed+'</div>' +
        '<div class="empty-hint">+ Admit patient</div>';
      top.onclick = function(){ openPatientModal(room, bed, null); };
      card.appendChild(top);
      return card;
    }

    // Occupied card — tags LEFT-aligned under bed number
    var overdueBadge = isOverdue(patient) ? '<span class="overdue-badge">⏰ Overdue</span>' : '';
    var losTag = patient.admitted ? '<span class="tag" style="background:var(--amber-soft);color:var(--amber);">'+calcLengthOfStay(patient.admitted)+'</span>' : '';
    top.innerHTML =
      '<div class="bed-top-left">' +
        '<div class="bed-num">Bed '+room+bed+'</div>' +
        '<div class="tag-row">' +
          '<span class="tag acuity-'+patient.acuity+'">'+(ACUITY_LABEL[patient.acuity]||"Stable")+'</span>' +
          '<span class="tag type-'+patient.type+'">'+(TYPE_LABEL[patient.type]||"Antenatal")+'</span>' +
          (patient.unit?'<span class="tag unit-tag">'+escapeHtml(patient.unit)+'</span>':'') +
          losTag +
        '</div>' +
        (overdueBadge||'') +
      '</div>';
    card.appendChild(top);

    var body = document.createElement("div");
    body.className = "bed-body";

    if(!patient){
      body.innerHTML = '<div class="empty-state"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/></svg><div style="font-size:0.82rem;font-weight:600;">Empty bed</div><div class="hint">Tap to admit a patient</div></div>';
      card.appendChild(body);
      var actionsEmpty = document.createElement("div");
      actionsEmpty.className = "bed-actions";
      var addBtn = document.createElement("button");
      addBtn.className = "btn-primary";
      addBtn.textContent = "Add Patient";
      addBtn.onclick = function(){ openPatientModal(room, bed, null); };
      actionsEmpty.appendChild(addBtn);
      card.appendChild(actionsEmpty);
      return card;
    }

    var lastEntry = patient.history && patient.history.length ? patient.history[patient.history.length-1] : null;
    var displaySituation = lastEntry ? lastEntry.situation : patient.situation;
    var displayPlan = lastEntry ? lastEntry.plan : patient.plan;

    var html = '';

    // Allergy banner — most prominent, safety critical
    if(patient.allergy){
      html += '<div class="allergy-banner"><span class="al-icon">⚠️</span><span>ALLERGY: '+escapeHtml(patient.allergy)+'</span></div>';
    }

    // Flag chips
    if(patient.flags && patient.flags.length){
      html += '<div class="flag-strip">';
      patient.flags.forEach(function(f){
        var def = getFlagDef(f);
        html += '<span class="flag-chip '+def.cls+'">'+def.icon+' '+escapeHtml(f)+'</span>';
      });
      html += '</div>';
    }

    // Transfer badge
    if(patient.transferredFrom){
      var txTime = patient.transferredAt ? ' · '+fmtTimeShort(patient.transferredAt) : '';
      var txBy   = patient.transferredBy ? ' by '+escapeHtml(patient.transferredBy) : '';
      html += '<div style="font-size:0.7rem;background:var(--purple-soft);color:var(--purple);border-radius:6px;padding:3px 9px;margin-bottom:4px;font-weight:600;">🔀 Transferred from '+escapeHtml(patient.transferredFrom)+txTime+txBy+'</div>';
    }
    // Next review due
    var displayNextReview = lastEntry ? lastEntry.nextReview : patient.nextReview;
    if(displayNextReview){
      var nrDate = new Date(displayNextReview);
      var nrStr = !isNaN(nrDate.getTime()) ? nrDate.toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'short'}) : escapeHtml(displayNextReview);
      var nrOverdue = isOverdue(patient);
      html += '<div style="font-size:0.7rem;padding:3px 9px;border-radius:6px;margin-bottom:4px;font-weight:600;background:'+(nrOverdue?'var(--red-soft)':'var(--amber-soft)')+';color:'+(nrOverdue?'var(--red)':'var(--amber)')+';">⏰ Review: '+nrStr+'</div>';
    }
    html += '<div class="patient-name-row compact-show"><span class="pname">'+escapeHtml(patient.name || "Unnamed")+'</span>'+(patient.age?'<span class="meta">'+escapeHtml(patient.age)+'</span>':'')+'</div>';
    html += '<div class="field compact-show"><label>Diagnosis</label><div class="value">'+(patient.diagnosis?escapeHtml(patient.diagnosis):'<span class="empty-val">Not recorded</span>')+'</div></div>';

    // EDD + Gestation for antenatal patients
    if(patient.type === "antenatal" && (patient.gestation || patient.edd)){
      var gestParts = [];
      var gestDisplay = patient.gestation || calcGestationFromEDD(patient.edd);
      if(gestDisplay) gestParts.push(escapeHtml(gestDisplay));
      if(patient.edd){
        var eddD = new Date(patient.edd);
        if(!isNaN(eddD.getTime())){
          var eddStr = eddD.toLocaleDateString([],{day:'2-digit',month:'short',year:'numeric'});
          var daysToEdd = Math.ceil((eddD.setHours(0,0,0,0) - new Date().setHours(0,0,0,0)) / 86400000);
          var daysLabel = daysToEdd === 0 ? ' 🔴 today' : daysToEdd > 0 ? ' ('+daysToEdd+'d)' : ' <span style="color:var(--red);">('+Math.abs(daysToEdd)+'d overdue)</span>';
          gestParts.push('EDD: <strong>'+eddStr+'</strong>'+daysLabel);
        }
      }
      html += '<div class="field"><label>Gestation / EDD</label><div class="value" style="font-size:0.82rem;">'+gestParts.join(' &nbsp;·&nbsp; ')+'</div></div>';
    }

    html += '<div class="field"><label>Current situation</label><div class="value">'+(displaySituation?escapeHtml(displaySituation):'<span class="empty-val">Not recorded</span>')+'</div></div>';
    html += '<div class="field"><label>Plan</label><div class="value">'+(displayPlan?escapeHtml(displayPlan):'<span class="empty-val">Not recorded</span>')+'</div></div>';
    if(patient.general) html += '<div class="field"><label>Notes</label><div class="value" style="font-size:0.8rem;">'+escapeHtml(patient.general)+'</div></div>';
    if(patient.labs)    html += '<div class="field"><label>Labs / investigations</label><div class="value" style="font-size:0.8rem;font-family:monospace;">'+escapeHtml(patient.labs)+'</div></div>';
    
    var chk = patient.checklist || {};
    html += '<div class="checklist-display">' +
      '<span class="chk-badge '+(chk.vte?'checked':'')+'">✓ VTE</span>' +
      '<span class="chk-badge '+(chk.edd?'checked':'')+'">✓ EDD</span>' +
      '<span class="chk-badge '+(chk.consult?'checked':'')+'">✓ Consultant</span>' +
      '</div>';

    var admittedByStr = patient.addedBy ? escapeHtml(patient.addedBy) : "Staff";
    var updatedByStr = (lastEntry && lastEntry.updatedBy) ? escapeHtml(lastEntry.updatedBy) : (patient.lastUpdatedBy ? escapeHtml(patient.lastUpdatedBy) : admittedByStr);
    var updateTimeIso = lastEntry ? lastEntry.time : (patient.lastUpdated || patient.admitted);

    html += '<div class="admit-row">' +
      '<span>Admitted: '+fmtDateShort(patient.admitted)+' at '+fmtTimeShort(patient.admitted)+' by <strong>'+admittedByStr+'</strong>' +
        (patient.admitted ? ' &nbsp;·&nbsp; <strong style="color:var(--amber);">'+calcLengthOfStay(patient.admitted)+'</strong>' : '') +
      '</span>' +
      '<span>Last updated: <strong>'+updatedByStr+'</strong> at '+fmtTimeShort(updateTimeIso)+'</span>' +
      '</div>';

    body.innerHTML = html;

    if(patient.history && patient.history.length > 0){
      var toggle = document.createElement("button");
      toggle.className = "history-toggle";
      toggle.textContent = "▸ Show history ("+patient.history.length+")";
      var histList = document.createElement("div");
      histList.className = "history-list";
      histList.style.display = "none";
      toggle.onclick = function(){
        var open = histList.style.display !== "none";
        histList.style.display = open ? "none" : "flex";
        toggle.textContent = (open ? "▸ Show history (" : "▾ Hide history (") + patient.history.length + ")";
      };
      // Build lab trend across all history entries
      var labTrend = buildLabTrend(patient);
      var trendKeys = Object.keys(labTrend);
      if(trendKeys.length){
        var trendDiv = document.createElement("div");
        trendDiv.style.cssText = "background:var(--paper);border:1px solid var(--line-soft);border-radius:var(--r-sm);padding:7px 10px;margin-bottom:8px;font-size:0.74rem;";
        trendDiv.innerHTML = '<div style="font-size:0.62rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-mute);margin-bottom:5px;">📈 Lab trends</div>' +
          trendKeys.map(function(k){
            return '<div style="display:flex;gap:6px;align-items:baseline;margin-bottom:3px;">'+
              '<span style="font-weight:700;color:var(--ink-soft);min-width:36px;">'+escapeHtml(k)+'</span>'+
              '<span style="font-family:monospace;">'+formatTrend(labTrend[k])+'</span>'+
            '</div>';
          }).join("");
        historyList.appendChild(trendDiv);
      }

      patient.history.slice().reverse().forEach(function(entry, idxRev){
        var realIdx = patient.history.length - 1 - idxRev;
        var he = document.createElement("div");
        he.className = "history-entry";
        he.innerHTML = '<div class="h-time"><span>'+fmtTime(entry.time)+' · '+(ACUITY_LABEL[entry.acuity]||"Stable")+' · <strong>'+escapeHtml(entry.updatedBy||"Staff")+'</strong></span><span class="del" data-idx="'+realIdx+'">Delete</span></div>'+
          (entry.situation?'<div class="h-row"><span class="h-label">Situation:</span> '+escapeHtml(entry.situation)+'</div>':'')+
          (entry.plan?'<div class="h-row"><span class="h-label">Plan:</span> '+escapeHtml(entry.plan)+'</div>':'')+
          (entry.labs?'<div class="h-row"><span class="h-label">Labs:</span> <span style="font-family:monospace;font-size:0.78rem;">'+escapeHtml(entry.labs)+'</span></div>':'');
        he.querySelector(".del").onclick = function(){
          showConfirm("Delete entry", "Delete this history entry? This cannot be undone.", "Delete", "btn-danger-outline", function(){ patient.history.splice(realIdx,1); saveState(); render(); });
        };
        histList.appendChild(he);
      });
      body.appendChild(toggle);
      body.appendChild(histList);
    }

    card.appendChild(body);

    var actions = document.createElement("div");
    actions.className = "bed-actions";
    actions.style.cssText = "display:flex;gap:6px;padding:10px 12px;border-top:1px solid var(--line-soft);background:var(--paper);align-items:center;";

    // Dominant primary action
    var updateBtn = document.createElement("button");
    updateBtn.className = "btn-primary";
    updateBtn.style.cssText = "flex:1;font-size:0.82rem;padding:9px 12px;";
    updateBtn.textContent = "✚ Progress update";
    updateBtn.onclick = function(){ openProgressModal(room, bed); };

    // ⋯ More menu
    var moreWrap = document.createElement("div");
    moreWrap.style.cssText = "position:relative;";
    var moreBtn = document.createElement("button");
    moreBtn.className = "btn-outline";
    moreBtn.style.cssText = "padding:9px 12px;font-size:0.82rem;white-space:nowrap;";
    moreBtn.textContent = "⋯";
    moreBtn.title = "More actions";

    var moreMenu = document.createElement("div");
    moreMenu.style.cssText = "display:none;position:absolute;bottom:calc(100% + 6px);right:0;background:var(--card);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:0 8px 24px rgba(0,0,0,0.15);min-width:160px;z-index:50;overflow:hidden;";
    moreMenu.innerHTML =
      '<button class="overflow-item" id="moreEdit_'+room+bed+'">✏️ Edit patient</button>' +
      '<button class="overflow-item" id="moreTx_'+room+bed+'">🔀 Transfer</button>' +
      '<button class="overflow-item" id="moreShare_'+room+bed+'">📤 Share summary</button>' +
      '<button class="overflow-item" id="morePrint_'+room+bed+'">🖨️ Print card</button>' +
      '<div class="overflow-divider"></div>' +
      '<button class="overflow-item" style="color:var(--red);" id="moreDisch_'+room+bed+'">↩ Discharge</button>';

    moreBtn.onclick = function(e){
      e.stopPropagation();
      var open = moreMenu.style.display !== "none";
      document.querySelectorAll(".bed-more-menu").forEach(function(m){ m.style.display="none"; });
      if(!open){
        // Position using fixed coords so it doesn't clip on iPhone
        var rect = moreBtn.getBoundingClientRect();
        moreMenu.style.position = "fixed";
        moreMenu.style.bottom = "auto";
        moreMenu.style.top = (rect.bottom + 6) + "px";
        moreMenu.style.right = (window.innerWidth - rect.right) + "px";
        moreMenu.style.left = "auto";
        moreMenu.style.display = "block";
      }
    };
    moreMenu.className = "bed-more-menu";

    // Wire more menu items
    setTimeout(function(){
      var eBtn  = document.getElementById("moreEdit_"+room+bed);
      var tBtn  = document.getElementById("moreTx_"+room+bed);
      var sBtn  = document.getElementById("moreShare_"+room+bed);
      var pBtn  = document.getElementById("morePrint_"+room+bed);
      var dBtn  = document.getElementById("moreDisch_"+room+bed);
      if(eBtn) eBtn.onclick = function(){ moreMenu.style.display="none"; openPatientModal(room, bed, patient); };
      if(tBtn) tBtn.onclick = function(){ moreMenu.style.display="none"; openTransferModal(room, bed); };
      if(sBtn) sBtn.onclick = function(){ moreMenu.style.display="none"; sharePatientSummary(room, bed); };
      if(pBtn) pBtn.onclick = function(){ moreMenu.style.display="none"; printPatientCard(room, bed); };
      if(dBtn) dBtn.onclick = function(){ moreMenu.style.display="none"; openDischargeSummary(room, bed); };
    }, 0);

    moreWrap.appendChild(moreBtn);
    moreWrap.appendChild(moreMenu);
    actions.appendChild(updateBtn);
    actions.appendChild(moreWrap);
    card.appendChild(actions);

    return card;
  }

  /* Modals */
  var patientOverlay = document.getElementById("patientOverlay");
  var currentBedForModal = null;
  var selectedType = "antenatal";
  var selectedAcuity = "stable";

  function setTypeUI(type){
    selectedType = type;
    document.querySelectorAll("#typeToggle .type-btn").forEach(function(b){ b.classList.toggle("active", b.dataset.type === type); });
    var fa = document.getElementById("fieldsAntenatal");
    var fp = document.getElementById("fieldsPostnatal");
    var fg = document.getElementById("fieldsGynae");
    if(fa) fa.style.display = type==="antenatal" ? "block" : "none";
    if(fp) fp.style.display = type==="postnatal" ? "block" : "none";
    if(fg) fg.style.display = type==="gynae" ? "block" : "none";
  }
  document.querySelectorAll("#typeToggle .type-btn").forEach(function(b){
    b.onclick = function(){ setTypeUI(b.dataset.type); };
  });

  function setAcuityUI(acuity){
    selectedAcuity = acuity;
    document.querySelectorAll("#acuityToggle .acuity-btn").forEach(function(b){ b.classList.toggle("active", b.dataset.acuity === acuity); });
  }
  document.querySelectorAll("#acuityToggle .acuity-btn").forEach(function(b){
    b.onclick = function(){ setAcuityUI(b.dataset.acuity); };
  });

  function openPatientModal(room, bed, patient){
    currentBedForModal = {room:room, bed:bed};
    document.getElementById("modalTitle").textContent = room + bed + (patient ? " — Edit" : " — New Patient");
    setTypeUI(patient ? patient.type : "antenatal");
    setAcuityUI(patient ? patient.acuity : "stable");

    var chk = patient && patient.checklist ? patient.checklist : {};
    document.getElementById("chk_vte").checked = !!chk.vte;
    document.getElementById("chk_edd").checked = !!chk.edd;
    document.getElementById("chk_consult").checked = !!chk.consult;

    function setVal(id, v){ var el = document.getElementById(id); if(el) el.value = v || ""; }
    setVal("f_name", patient ? patient.name : "");
    setVal("f_age", patient ? patient.age : "");
    setVal("f_unit", patient ? patient.unit : "");
    setVal("f_diagnosis", patient ? patient.diagnosis : "");
    setVal("f_situation", patient ? patient.situation : "");
    setVal("f_plan", patient ? patient.plan : "");
    // Populate consultant dropdown
    populateConsultantDropdown(patient ? patient.unit : "");
    // Load allergy and flags
    var allergyEl = document.getElementById("f_allergy");
    if(allergyEl) allergyEl.value = patient && patient.allergy ? patient.allergy : "";
    setSelectedFlags(patient && patient.flags ? patient.flags : []);
    // Load nextReview into time picker
    var rv = parseReviewISO(patient ? patient.nextReview : "");
    var fNR = document.getElementById("f_nextReview");
    var fNRD = document.getElementById("f_nextReviewDay");
    if(fNR) fNR.value = rv.time;
    if(fNRD) fNRD.value = rv.day;
    updateReviewPreview("f_nextReview","f_nextReviewDay","f_reviewPreview");
    setVal("f_gestation", patient ? patient.gestation : "");
    setVal("f_indication", patient ? patient.indication : "");
    // EDD — stored as YYYY-MM-DD
    var eddEl = document.getElementById("f_edd");
    if(eddEl){
      eddEl.value = patient && patient.edd ? patient.edd : "";
      eddEl.onchange = function(){
        var calc = calcGestationFromEDD(eddEl.value);
        var gestEl = document.getElementById("f_gestation");
        if(calc && gestEl && !gestEl.value) gestEl.value = calc;
        // Show preview
        var prev = document.getElementById("f_edd_preview");
        if(prev) prev.textContent = calc ? "→ Gestation: " + calc : "";
      };
    }
    setVal("f_fetal", patient ? patient.fetal : "");
    setVal("f_modeDelivery", patient ? patient.modeDelivery : "");
    setVal("f_dayPostDelivery", patient ? patient.dayPostDelivery : "");
    setVal("f_baby", patient ? patient.baby : "");
    setVal("f_vte", patient ? patient.vte : "");
    setVal("f_procedure", patient ? patient.procedure : "");
    setVal("f_drains", patient ? patient.drains : "");
    setVal("f_mobilisation", patient ? patient.mobilisation : "");
    setVal("f_labs", patient ? patient.labs : "");
    setVal("f_labs_general", patient ? patient.labs : "");

    if(patientOverlay) patientOverlay.classList.add("show");
  }

  function closePatientModal(){
    if(patientOverlay) patientOverlay.classList.remove("show");
    currentBedForModal = null;
    hideSaveError("patientSaveError");
  }

  var cPat = document.getElementById("closePatientModal");
  var canPat = document.getElementById("cancelPatientModal");
  if(cPat) cPat.onclick = closePatientModal;
  if(canPat) canPat.onclick = closePatientModal;

  var savePat = document.getElementById("savePatientModal");
  if(savePat){
    savePat.onclick = function(){
      if(!currentBedForModal) return;
      hideSaveError("patientSaveError");
      var staffName = ensureStaffName();
      if(!staffName){
        showSaveError("patientSaveError", "⚠️ Please set your name before saving. Tap \"👤 Set name\" in the top bar.");
        return;
      }
      var key = bedKey(currentBedForModal.room, currentBedForModal.bed);
      var w = currentWard();
      var existing = w.rooms[key];

      function getVal(id){ var el = document.getElementById(id); return el ? el.value.trim() : ""; }

      w.rooms[key] = {
        type: selectedType,
        acuity: selectedAcuity,
        checklist: {
          vte: document.getElementById("chk_vte").checked,
          edd: document.getElementById("chk_edd").checked,
          consult: document.getElementById("chk_consult").checked
        },
        name: getVal("f_name"),
        age: getVal("f_age"),
        unit: getVal("f_unit"),
        diagnosis: getVal("f_diagnosis"),
        situation: getVal("f_situation"),
        plan: getVal("f_plan"),
        nextReview: buildReviewISO(getVal("f_nextReview"), document.getElementById("f_nextReviewDay").value),
        gestation: getVal("f_gestation"),
        edd: (document.getElementById("f_edd")||{}).value || "",
        indication: getVal("f_indication"),
        fetal: getVal("f_fetal"),
        modeDelivery: getVal("f_modeDelivery"),
        dayPostDelivery: getVal("f_dayPostDelivery"),
        baby: getVal("f_baby"),
        vte: getVal("f_vte"),
        procedure: getVal("f_procedure"),
        drains: getVal("f_drains"),
        mobilisation: getVal("f_mobilisation"),
        general: getVal("f_general"),
        labs: getVal("f_labs_general") || getVal("f_labs"), // unified field
        allergy: (getVal("f_allergy")||"").toUpperCase().trim(),
        flags: getSelectedFlags(),
        admitted: existing ? existing.admitted : nowISO(),
        addedBy: existing ? existing.addedBy : staffName,
        lastUpdated: nowISO(),
        lastUpdatedBy: staffName,
        history: existing && existing.history ? existing.history : []
      };

      var isNew = !existing;
      hodLog(isNew ? "admit" : "edit",
        (isNew ? "Admitted: " : "Updated: ") + (w.rooms[key].name || key) +
        (w.rooms[key].diagnosis ? " — " + w.rooms[key].diagnosis : ""),
        currentWard().name
      );
      var _pr = currentBedForModal.room, _pb = currentBedForModal.bed;
      saveState();
      closePatientModal();
      render();
      setTimeout(function(){ if(window.flashCard) window.flashCard(_pr, _pb); }, 50);
    };
  }

  /* Progress Update Modal */
  var progressOverlay = document.getElementById("progressOverlay");
  var currentBedForProgress = null;
  var progressAcuity = "stable";

  function setProgressAcuityUI(acuity){
    progressAcuity = acuity;
    document.querySelectorAll("#acuityToggleProgress .acuity-btn").forEach(function(b){ b.classList.toggle("active", b.dataset.acuity === acuity); });
  }
  document.querySelectorAll("#acuityToggleProgress .acuity-btn").forEach(function(b){
    b.onclick = function(){ setProgressAcuityUI(b.dataset.acuity); };
  });

  function openProgressModal(room, bed){
    currentBedForProgress = {room:room, bed:bed};
    var patient = currentWard().rooms[bedKey(room, bed)];
    document.getElementById("progressModalTitle").textContent = "Progress Update — " + room + bed;
    var lastEntry = patient.history && patient.history.length ? patient.history[patient.history.length-1] : null;

    setProgressAcuityUI(patient.acuity || "stable");
    var ps = document.getElementById("p_situation");
    var pp = document.getElementById("p_plan");
    var pn = document.getElementById("p_nextReview");
    if(ps) ps.value = lastEntry ? lastEntry.situation : patient.situation || "";
    if(pp) pp.value = lastEntry ? lastEntry.plan : patient.plan || "";
    var plabs = document.getElementById("p_labs");
    if(plabs) plabs.value = "";
    // Load nextReview into time picker
    var prv = parseReviewISO((lastEntry && lastEntry.nextReview) ? lastEntry.nextReview : patient.nextReview || "");
    var pNR = document.getElementById("p_nextReview");
    var pNRD = document.getElementById("p_nextReviewDay");
    if(pNR) pNR.value = prv.time;
    if(pNRD) pNRD.value = prv.day;
    updateReviewPreview("p_nextReview","p_nextReviewDay","p_reviewPreview");

    if(progressOverlay) progressOverlay.classList.add("show");
  }

  function closeProgressModal(){
    if(progressOverlay) progressOverlay.classList.remove("show");
    currentBedForProgress = null;
    hideSaveError("progressSaveError");
  }

  var cProg = document.getElementById("closeProgressModal");
  var canProg = document.getElementById("cancelProgressModal");
  if(cProg) cProg.onclick = closeProgressModal;
  if(canProg) canProg.onclick = closeProgressModal;

  var saveProg = document.getElementById("saveProgressModal");
  if(saveProg){
    saveProg.onclick = function(){
      if(!currentBedForProgress) return;
      hideSaveError("progressSaveError");
      var staffName = ensureStaffName();
      if(!staffName){
        showSaveError("progressSaveError", "⚠️ Please set your name before saving. Tap \"👤 Set name\" in the top bar.");
        return;
      }
      var patient = currentWard().rooms[bedKey(currentBedForProgress.room, currentBedForProgress.bed)];
      var ps = document.getElementById("p_situation");
      var pp = document.getElementById("p_plan");
      var pn = document.getElementById("p_nextReview");

      var pLabs = document.getElementById("p_labs");
      var entry = {
        time: nowISO(),
        acuity: progressAcuity,
        situation: ps ? ps.value.trim() : "",
        plan: pp ? pp.value.trim() : "",
        labs: pLabs ? pLabs.value.trim() : "",
        nextReview: buildReviewISO((document.getElementById("p_nextReview")||{}).value||"", (document.getElementById("p_nextReviewDay")||{}).value||"today"),
        updatedBy: staffName
      };
      patient.acuity = progressAcuity;
      patient.lastUpdated = entry.time;
      patient.lastUpdatedBy = staffName;
      if(!patient.history) patient.history = [];
      patient.history.push(entry);
      hodLog("progress",
        (patient.name || currentBedForProgress.room + currentBedForProgress.bed) +
        " — " + progressAcuity +
        (entry.situation ? " | " + entry.situation.slice(0,80) : "") +
        (entry.plan ? " | Plan: " + entry.plan.slice(0,60) : ""),
        currentWard().name
      );
      saveState();
      var _flashRoom = currentBedForProgress.room, _flashBed = currentBedForProgress.bed;
      closeProgressModal();
      render();
      setTimeout(function(){ if(window.flashCard) window.flashCard(_flashRoom, _flashBed); }, 50);
    };
  }

  /* Handover Summary Export */
  function buildSummaryHtml(onlyWardId){
    var html = '<div class="summary-page">';
    var titleSuffix = onlyWardId ? (' — ' + escapeHtml(state.wards[onlyWardId].name)) : '';
    html += '<div class="summary-header"><h1>'+escapeHtml(state.appTitle||"Ward Board")+' — Handover Summary'+titleSuffix+'</h1>' +
      '<span class="meta">'+fmtTime(nowISO())+'</span></div>';

    var wardIds = onlyWardId ? [onlyWardId] : state.wardOrder;

    wardIds.forEach(function(wardId){
      var w = state.wards[wardId];
      if(!w || !w.rooms) return;
      var rows = [];
      var _hrc = w.roomCount || ROOMS_PER_WARD;
      for(var r=1; r<=_hrc; r++){
        var hasB = (w.roomConfig && w.roomConfig[r] && w.roomConfig[r].hasB) || !!w.rooms[r+"B"];
        var beds = hasB ? ["A", "B"] : ["A"];
        beds.forEach(function(bed){
          var p = w.rooms[bedKey(r,bed)];
          if(p) rows.push({room:r, bed:bed, patient:p});
        });
      }
      if(rows.length===0) return;

      html += '<div class="summary-ward-block"><div class="summary-ward-title">'+escapeHtml(w.name)+' ('+rows.length+' patients)</div>';
      html += '<table class="summary-table"><thead><tr>' +
        '<th>Bed</th><th>Name / Age</th><th>Type</th><th>Consultant</th><th>Diagnosis</th><th>Alerts</th><th>Situation / Plan</th><th>Next review</th><th>Acuity</th>' +
        '</tr></thead><tbody>';

      rows.forEach(function(row){
        var p = row.patient;
        var lastEntry = p.history && p.history.length ? p.history[p.history.length-1] : null;
        var situation = lastEntry ? lastEntry.situation : p.situation;
        var plan = lastEntry ? lastEntry.plan : p.plan;
        var nextReview = lastEntry && lastEntry.nextReview !== undefined ? lastEntry.nextReview : p.nextReview;
        var combined = [situation, plan].filter(Boolean).join(" — ");

        // Format next review
        var nrFormatted = "—";
        if(nextReview){
          var nrD = new Date(nextReview);
          nrFormatted = !isNaN(nrD.getTime())
            ? nrD.toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit',day:'2-digit',month:'short'})
            : escapeHtml(nextReview);
          if(isOverdue(p)) nrFormatted = '⏰ ' + nrFormatted + ' (OVERDUE)';
        }

        // Transfer indicator
        var txNote = p.transferredFrom ? ' <span style="color:#6243a0;font-size:7.5px;">⟵ '+escapeHtml(p.transferredFrom)+'</span>' : '';

        html += '<tr>' +
          '<td><span class="acuity-dot '+p.acuity+'"></span>'+row.room+row.bed+'</td>' +
          '<td>'+escapeHtml(p.name||"—")+txNote+(p.age?' <span style="color:#777;">'+escapeHtml(p.age)+'</span>':'')+'</td>' +
          '<td>'+(TYPE_LABEL[p.type]||"—")+'</td>' +
          '<td>'+escapeHtml(p.unit||"—")+'</td>' +
          '<td>'+escapeHtml(p.diagnosis||"—")+'</td>' +
          '<td style="'+(p.allergy?'color:#991b1b;font-weight:700;':'')+'">'+(p.allergy?'⚠️ '+escapeHtml(p.allergy):'')+((p.flags&&p.flags.length)?(p.allergy?' | ':'')+p.flags.join(', '):"")+'</td>' +
          '<td>'+escapeHtml(combined||"—")+'</td>' +
          '<td style="'+(isOverdue(p)?'color:#c0291f;font-weight:700;':'')+'">'+nrFormatted+'</td>' +
          '<td><span class="acuity-dot '+p.acuity+'"></span>'+(ACUITY_LABEL[p.acuity]||"Stable")+'</td>' +
          '</tr>';
      });
      html += '</tbody></table></div>';
    });

    html += '</div>';
    return html;
  }

  function runSummaryPrint(onlyWardId){
    var spv = document.getElementById("summaryPrintView");
    if(spv) spv.innerHTML = buildSummaryHtml(onlyWardId);
    document.body.classList.add("printing-summary");
    window.print();
    setTimeout(function(){ document.body.classList.remove("printing-summary"); }, 500);
  }

  var expSumBtn = document.getElementById("exportSummaryBtn");
  var handoverOverlay = document.getElementById("handoverOverlay");
  function closeHandoverModal(){ if(handoverOverlay) handoverOverlay.classList.remove("show"); }
  if(expSumBtn){
    expSumBtn.onclick = function(){
      var currentName = currentWard().name;
      var lbl = document.getElementById("handoverCurrentLabel");
      if(lbl) lbl.textContent = currentName;
      if(handoverOverlay) handoverOverlay.classList.add("show");
    };
  }
  var closeHO = document.getElementById("closeHandoverModal");
  if(closeHO) closeHO.onclick = closeHandoverModal;
  var hoCurrent = document.getElementById("handoverCurrentBtn");
  if(hoCurrent) hoCurrent.onclick = function(){
    closeHandoverModal();
    hodLog("handover", "Handover exported — " + currentWard().name + " only", currentWard().name);
    saveState();
    runSummaryPrint(activeWardId);
  };
  var hoAll = document.getElementById("handoverAllBtn");
  if(hoAll) hoAll.onclick = function(){
    closeHandoverModal();
    hodLog("handover", "Handover exported — all wards", "All");
    saveState();
    runSummaryPrint(null);
  };

  /* Full Print Generator */
  function buildFullPrintHtml(){
    var w = currentWard();
    var html = '<div class="summary-page">';
    html += '<div class="summary-header"><h1>'+escapeHtml(state.appTitle||"Ward Board")+' — ' + escapeHtml(w.name) + ' (Full Ward Board)</h1>' +
      '<span class="meta">'+fmtTime(nowISO())+'</span></div>';

    html += '<table class="summary-table"><thead><tr>' +
      '<th>Room / Bed</th><th>Status / Patient</th><th>Type / Unit</th><th>Acuity</th><th>Diagnosis & Situation</th><th>Plan & Next Review</th>' +
      '</tr></thead><tbody>';

    var _fprc = w.roomCount || ROOMS_PER_WARD;
    for(var r=1; r<=_fprc; r++){
      var hasB = (w.roomConfig && w.roomConfig[r] && w.roomConfig[r].hasB) || !!w.rooms[r+"B"];
      var beds = hasB ? ["A", "B"] : ["A"];
      beds.forEach(function(bed){
        var key = bedKey(r, bed);
        var p = w.rooms[key];
        html += '<tr>';
        html += '<td class="bed-col" style="font-size:11px;">Room ' + r + bed + '</td>';
        if(p){
          var lastEntry = p.history && p.history.length ? p.history[p.history.length-1] : null;
          var situation = lastEntry ? lastEntry.situation : p.situation;
          var plan = lastEntry ? lastEntry.plan : p.plan;
          var nextReview = lastEntry && lastEntry.nextReview !== undefined ? lastEntry.nextReview : p.nextReview;
          
          html += '<td><strong>'+escapeHtml(p.name||"Unnamed")+'</strong>'+(p.age?' ('+escapeHtml(p.age)+')':'')+'</td>';
          html += '<td>'+(TYPE_LABEL[p.type]||"—")+(p.unit?' / Unit '+escapeHtml(p.unit):'')+'</td>';
          html += '<td><span class="acuity-dot '+p.acuity+'"></span>'+(ACUITY_LABEL[p.acuity]||"Stable")+'</td>';
          html += '<td><strong>Dx:</strong> '+escapeHtml(p.diagnosis||"—")+'<br><strong>Sit:</strong> '+escapeHtml(situation||"—")+'</td>';
          html += '<td><strong>Plan:</strong> '+escapeHtml(plan||"—")+(nextReview?'<br><strong>Review:</strong> '+escapeHtml(nextReview):'')+'</td>';
        } else {
          html += '<td colspan="5" style="color:#777; font-style:italic;">Empty Bed</td>';
        }
        html += '</tr>';
      });
    }
    html += '</tbody></table></div>';
    return html;
  }

  var printBtn = document.getElementById("printBtn");
  if(printBtn){
    printBtn.onclick = function(){
      var fpv = document.getElementById("fullPrintView");
      if(fpv) fpv.innerHTML = buildFullPrintHtml();
      document.body.classList.add("printing-full");
      window.print();
      setTimeout(function(){ document.body.classList.remove("printing-full"); }, 500);
    };
  }

  /* Add empty ward message if no occupied patients visible */
  function checkEmptyWard(){
    var grid = document.getElementById("grid");
    if(!grid) return;
    var existingMsg = grid.querySelector(".empty-ward-msg");
    if(existingMsg) existingMsg.remove();
    var w = currentWard();
    var hasPatients = w && w.rooms && Object.values(w.rooms).some(Boolean);
    if(!hasPatients){
      var msg = document.createElement("div");
      msg.className = "empty-ward-msg";
      msg.innerHTML =
        '<div class="ewm-icon">🛏️</div>' +
        '<div class="ewm-title">Ward is clear</div>' +
        '<div class="ewm-sub">Tap any bed card to admit a patient</div>';
      grid.appendChild(msg);
    }
  }

  /* Hook urgent notification check and empty ward message into every render */
  var _origRender = render;
  render = function(){
    _origRender();
    checkEmptyWard();
    checkUrgentNotifications();
    renderOnCallBar();
    updateFeedBadge();
  };

  var searchBox = document.getElementById("searchBox");
  var unitFilter = document.getElementById("unitFilter");
  var typeFilter = document.getElementById("typeFilter");
  if(searchBox) searchBox.addEventListener("input", function(){
    render();
    renderCrossWardSearch(searchBox.value.trim());
    if(!searchBox.value.trim()){
      var hint = document.getElementById("crossWardHint");
      if(hint) hint.style.display = "none";
    }
  });
  if(unitFilter) unitFilter.addEventListener("change", render);
  if(typeFilter) typeFilter.addEventListener("change", render);

  function tickClock(){
    var el = document.getElementById("clock");
    if(el){
      el.textContent = new Date().toLocaleString([], {weekday:'short', hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short'});
    }
  }
  tickClock();
  setInterval(tickClock, 1000*30);

  // Global callback invoked directly by the Firebase module whenever cloud data arrives
  window.handleRemoteState = function(remoteState){
    if(remoteState && (remoteState.wards || remoteState.wardOrder)){
      isRemoteUpdate = true;
      var previousWardName = (state.wards && state.wards[activeWardId]) ? state.wards[activeWardId].name : null;
      state = normalizeState(remoteState);

      // Keep the user on the same ward tab by name even if ward IDs came from another device
      if(previousWardName && (!state.wards[activeWardId] || state.wards[activeWardId].name !== previousWardName)){
        state.wardOrder.forEach(function(id){
          if(state.wards[id] && state.wards[id].name === previousWardName){
            activeWardId = id;
          }
        });
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      var tEl = document.getElementById("appTitle");
      if(tEl && state.appTitle) tEl.textContent = state.appTitle;
      render();
      isRemoteUpdate = false;
    } else {
      // Cloud DB is empty — push initial state up to the cloud
      saveState();
    }
  };

  /* ============================================================
     NEXT REVIEW — time picker helpers
  ============================================================ */
  /* Build a full ISO datetime string from time (HH:MM) + day (today/tomorrow) */
  function buildReviewISO(timeVal, dayVal){
    if(!timeVal) return "";
    var parts = timeVal.split(":");
    if(parts.length < 2) return "";
    var h = parseInt(parts[0],10), m = parseInt(parts[1],10);
    var d = new Date();
    if(dayVal === "tomorrow") d.setDate(d.getDate()+1);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  }

  /* Parse a stored ISO or legacy free-text value back into {time, day} for the picker */
  function parseReviewISO(stored){
    if(!stored) return {time:"", day:"today"};
    var d = new Date(stored);
    if(!isNaN(d.getTime())){
      var now = new Date();
      var hh = String(d.getHours()).padStart(2,"0");
      var mm = String(d.getMinutes()).padStart(2,"0");
      var day = d.toDateString() === now.toDateString() ? "today" : "tomorrow";
      return {time: hh+":"+mm, day: day};
    }
    // Legacy free-text — just show it as a note
    return {time:"", day:"today", legacy: stored};
  }

  function updateReviewPreview(timeId, dayId, previewId){
    var t = (document.getElementById(timeId)||{}).value || "";
    var d = (document.getElementById(dayId)||{}).value || "today";
    var p = document.getElementById(previewId);
    if(!p) return;
    if(!t){ p.textContent=""; return; }
    var iso = buildReviewISO(t, d);
    if(!iso){ p.textContent=""; return; }
    var dt = new Date(iso);
    p.textContent = "⏰ Reviewing " + dt.toLocaleDateString([],{weekday:"short"}) + " at " + dt.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  }

  ["f_nextReview","f_nextReviewDay"].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.addEventListener("change", function(){ updateReviewPreview("f_nextReview","f_nextReviewDay","f_reviewPreview"); });
  });
  ["p_nextReview","p_nextReviewDay"].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.addEventListener("change", function(){ updateReviewPreview("p_nextReview","p_nextReviewDay","p_reviewPreview"); });
  });
  document.getElementById("f_clearReview").onclick = function(){ document.getElementById("f_nextReview").value=""; document.getElementById("f_nextReviewDay").value="today"; updateReviewPreview("f_nextReview","f_nextReviewDay","f_reviewPreview"); };
  document.getElementById("p_clearReview").onclick = function(){ document.getElementById("p_nextReview").value=""; document.getElementById("p_nextReviewDay").value="today"; updateReviewPreview("p_nextReview","p_nextReviewDay","p_reviewPreview"); };


  /* ============================================================
     FEATURE: PATIENT TRANSFER
  ============================================================ */
  var _pendingTransfer = null;

  function openTransferModal(room, bed){
    var w = currentWard();
    var patient = w.rooms[bedKey(room,bed)];
    if(!patient) return;
    _pendingTransfer = { fromWardId: activeWardId, room: room, bed: bed };

    var label = document.getElementById("transferPatientLabel");
    if(label) label.textContent = (patient.name||"Patient") + " — currently in " + w.name + ", Bed " + room + bed;

    // Populate ward select (exclude current ward)
    var wardSel = document.getElementById("transferWardSelect");
    wardSel.innerHTML = "";
    state.wardOrder.forEach(function(id){
      if(id === activeWardId) return;
      var opt = document.createElement("option");
      opt.value = id;
      opt.textContent = state.wards[id].name;
      wardSel.appendChild(opt);
    });
    if(!wardSel.options.length){
      document.getElementById("transferError").textContent = "No other wards available. Add another ward first.";
      document.getElementById("transferError").style.display = "block";
      document.getElementById("confirmTransfer").disabled = true;
    } else {
      document.getElementById("transferError").style.display = "none";
      document.getElementById("confirmTransfer").disabled = false;
      populateTransferBeds(wardSel.value);
    }
    document.getElementById("transferOverlay").classList.add("show");
  }

  function populateTransferBeds(wardId){
    var bedSel = document.getElementById("transferBedSelect");
    bedSel.innerHTML = "";
    var w = state.wards[wardId]; if(!w) return;
    var _trc = w.roomCount || ROOMS_PER_WARD;
    for(var r=1; r<=_trc; r++){
      ["A","B"].forEach(function(b){
        var key = r+b;
        if(b==="B" && !(w.roomConfig&&w.roomConfig[r]&&w.roomConfig[r].hasB) && !w.rooms[key]) return;
        if(!w.rooms[key]){
          var opt = document.createElement("option");
          opt.value = key;
          opt.textContent = "Bed " + key + " (empty)";
          bedSel.appendChild(opt);
        }
      });
    }
    if(!bedSel.options.length){
      var opt = document.createElement("option"); opt.value=""; opt.textContent="No empty beds"; bedSel.appendChild(opt);
      document.getElementById("confirmTransfer").disabled = true;
    } else {
      document.getElementById("confirmTransfer").disabled = false;
    }
  }

  document.getElementById("transferWardSelect").addEventListener("change", function(){ populateTransferBeds(this.value); });
  document.getElementById("closeTransfer").onclick  = function(){ document.getElementById("transferOverlay").classList.remove("show"); _pendingTransfer=null; };
  document.getElementById("cancelTransfer").onclick = function(){ document.getElementById("transferOverlay").classList.remove("show"); _pendingTransfer=null; };

  document.getElementById("confirmTransfer").onclick = function(){
    if(!_pendingTransfer) return;
    var toWardId = document.getElementById("transferWardSelect").value;
    var toBed    = document.getElementById("transferBedSelect").value;
    if(!toWardId || !toBed){ document.getElementById("transferError").textContent="Please select a destination bed."; document.getElementById("transferError").style.display="block"; return; }
    var fromW = state.wards[_pendingTransfer.fromWardId];
    var toW   = state.wards[toWardId];
    var key   = bedKey(_pendingTransfer.room, _pendingTransfer.bed);
    var patient = fromW.rooms[key];
    if(!patient) return;

    // Log the transfer
    hodLog("transfer", "Transferred: "+(patient.name||key)+" from "+fromW.name+" "+_pendingTransfer.room+_pendingTransfer.bed+" → "+toW.name+" "+toBed, fromW.name);

    // Move patient
    toW.rooms[toBed] = Object.assign({}, patient, {
      transferredFrom: fromW.name + " " + _pendingTransfer.room + _pendingTransfer.bed,
      transferredAt:   nowISO(),
      transferredBy:   getStaffName()||"Staff"
    });
    delete fromW.rooms[key];
    saveState();
    document.getElementById("transferOverlay").classList.remove("show");
    _pendingTransfer = null;
    render();
  };


  /* ============================================================
     FEATURE: DISCHARGE SUMMARY
  ============================================================ */
  var _pendingDischarge = null;

  function openDischargeSummary(room, bed){
    var w = currentWard();
    var patient = w.rooms[bedKey(room, bed)];
    if(!patient) return;
    _pendingDischarge = {room:room, bed:bed};

    var lastEntry = patient.history && patient.history.length ? patient.history[patient.history.length-1] : null;
    var situation = lastEntry ? lastEntry.situation : patient.situation;
    var plan      = lastEntry ? lastEntry.plan      : patient.plan;

    function row(label, value){
      return '<div class="ds-block"><div class="ds-label">'+label+'</div><div class="ds-value">'+(value ? escapeHtml(value) : '<em style="color:var(--ink-soft)">Not recorded</em>')+'</div></div>';
    }

    var html =
      '<div style="text-align:center;margin-bottom:16px;">' +
        '<div style="font-size:1rem;font-weight:600;">'+escapeHtml(w.name)+' — Bed '+room+bed+'</div>' +
        '<div style="font-size:0.78rem;color:var(--ink-soft);">Discharge note generated '+fmtTime(nowISO())+'</div>' +
      '</div>' +
      row("Patient name / initials", patient.name) +
      row("Age / gravida/parity", patient.age) +
      row("Patient type", TYPE_LABEL[patient.type] || patient.type) +
      row("Unit / consultant", patient.unit) +
      row("Diagnosis / indication", patient.diagnosis) +
      (patient.type==="antenatal" ? row("Gestation", patient.gestation) + row("Indication", patient.indication) + row("Fetal monitoring", patient.fetal) : "") +
      (patient.type==="postnatal" ? row("Mode of delivery", patient.modeDelivery) + row("Day post-delivery", patient.dayPostDelivery) + row("Baby", patient.baby) + row("VTE status", patient.vte) : "") +
      (patient.type==="gynae"     ? row("Procedure", patient.procedure) + row("Drains", patient.drains) + row("Mobilisation", patient.mobilisation) : "") +
      row("Final situation", situation) +
      row("Discharge plan", plan) +
      row("General notes", patient.general) +
      row("Labs / investigations", patient.labs) +
      row("Admitted", fmtTime(patient.admitted) + " by " + (patient.addedBy||"Staff")) +
      row("Admitted by", patient.addedBy) +
      row("Discharged by", getStaffName()||"Staff") +
      '<div class="ds-block"><div class="ds-label">Safety checklist at discharge</div><div class="ds-value">' +
        (patient.checklist ? [
          patient.checklist.vte  ? "✓ VTE assessed" : "✗ VTE not checked",
          patient.checklist.edd  ? "✓ EDD/Gestation confirmed" : "✗ EDD/Gestation not confirmed",
          patient.checklist.consult ? "✓ Consultant updated" : "✗ Consultant not updated"
        ].join(" &nbsp;·&nbsp; ") : "Not recorded") +
      '</div></div>';

    document.getElementById("dischargeSummaryContent").innerHTML = html;
    document.getElementById("dischargeSummaryOverlay").classList.add("show");
  }

  document.getElementById("closeDischargeSummary").onclick  = function(){ document.getElementById("dischargeSummaryOverlay").classList.remove("show"); _pendingDischarge=null; };
  document.getElementById("cancelDischargeSummary").onclick = function(){ document.getElementById("dischargeSummaryOverlay").classList.remove("show"); _pendingDischarge=null; };

  document.getElementById("printDischargeSummary").onclick = function(){
    var content = document.getElementById("dischargeSummaryContent").innerHTML;
    var win = window.open("","_blank","width=700,height=900");
    win.document.write('<html><head><title>Discharge Summary</title><style>body{font-family:sans-serif;padding:32px;font-size:11pt;line-height:1.6}.ds-label{font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:#666;margin-bottom:2px}.ds-value{font-size:11pt;margin-bottom:12px;border-bottom:1px solid #eee;padding-bottom:8px}</style></head><body>'+content+'</body></html>');
    win.document.close();
    win.focus();
    setTimeout(function(){ win.print(); }, 300);
  };

  document.getElementById("confirmDischargeBtn").onclick = function(){
    if(!_pendingDischarge) return;
    var room = _pendingDischarge.room, bed = _pendingDischarge.bed;
    var dischargedName = (currentWard().rooms[bedKey(room,bed)]||{}).name || (room+bed);
    hodLog("discharge","Discharged: "+dischargedName+" from "+room+bed, currentWard().name);
    delete currentWard().rooms[bedKey(room,bed)];
    saveState();
    document.getElementById("dischargeSummaryOverlay").classList.remove("show");
    _pendingDischarge = null;
    render();
  };


  /* ============================================================
     FEATURE: LEAD STATISTICS DASHBOARD
  ============================================================ */
  function openHodStats(){
    var sel = document.getElementById("statsWard");
    if(sel){
      sel.innerHTML = '<option value="">All wards</option>';
      state.wardOrder.forEach(function(id){
        var w = state.wards[id]; if(!w) return;
        var o = document.createElement("option"); o.value = id; o.textContent = w.name;
        sel.appendChild(o);
      });
    }
    renderStats();
    document.getElementById("hodStatsOverlay").classList.add("show");
  }

  document.getElementById("closeHodStats").onclick = function(){ document.getElementById("hodStatsOverlay").classList.remove("show"); };
  document.getElementById("statsPeriod").addEventListener("change", renderStats);
  document.getElementById("statsWard").addEventListener("change", renderStats);

  function renderStats(){
    var days    = parseInt(document.getElementById("statsPeriod").value||"30", 10);
    var wardId  = document.getElementById("statsWard").value || "";
    var cutoff  = Date.now() - days*24*60*60*1000;
    var log     = (state.hodLog||[]).filter(function(e){ return new Date(e.time).getTime() >= cutoff && (!wardId || (state.wards[wardId] && e.ward === state.wards[wardId].name)); });

    var admits    = log.filter(function(e){ return e.type==="admit"; }).length;
    var discharges= log.filter(function(e){ return e.type==="discharge"; }).length;
    var updates   = log.filter(function(e){ return e.type==="progress"; }).length;
    var handovers = log.filter(function(e){ return e.type==="handover"; }).length;

    // Current patients in chosen ward(s)
    var currentAntenatal=0, currentPostnatal=0, currentGynae=0, currentUrgent=0;
    var wards = wardId ? [wardId] : state.wardOrder;
    wards.forEach(function(id){
      var w = state.wards[id]; if(!w||!w.rooms) return;
      Object.values(w.rooms).forEach(function(p){
        if(!p) return;
        if(p.type==="antenatal") currentAntenatal++;
        else if(p.type==="postnatal") currentPostnatal++;
        else if(p.type==="gynae") currentGynae++;
        if(p.acuity==="urgent") currentUrgent++;
      });
    });
    var currentTotal = currentAntenatal + currentPostnatal + currentGynae;

    // Staff activity from log
    var staffCounts = {};
    log.forEach(function(e){ if(e.by){ staffCounts[e.by] = (staffCounts[e.by]||0)+1; } });
    var topStaff = Object.entries(staffCounts).sort(function(a,b){ return b[1]-a[1]; }).slice(0,5);

    function pct(n){ return currentTotal ? Math.round(n/currentTotal*100) : 0; }
    function bar(label, n, color){
      return '<div class="stat-bar-wrap"><div class="stat-bar-label"><span>'+escapeHtml(label)+'</span><span>'+n+'</span></div><div class="stat-bar-track"><div class="stat-bar-fill" style="width:'+pct(n)+'%;background:'+color+';"></div></div></div>';
    }

    var html =
      '<div class="stats-grid">' +
        '<div class="stat-box"><div class="sn">'+currentTotal+'</div><div class="sl">Current patients</div></div>' +
        '<div class="stat-box"><div class="sn" style="color:var(--accent)">'+admits+'</div><div class="sl">Admissions</div></div>' +
        '<div class="stat-box"><div class="sn" style="color:var(--red)">'+discharges+'</div><div class="sl">Discharges</div></div>' +
        '<div class="stat-box"><div class="sn" style="color:var(--amber)">'+currentUrgent+'</div><div class="sl">Urgent now</div></div>' +
        '<div class="stat-box"><div class="sn">'+updates+'</div><div class="sl">Progress notes</div></div>' +
        '<div class="stat-box"><div class="sn">'+handovers+'</div><div class="sl">Handovers</div></div>' +
      '</div>' +
      '<div style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-soft);margin-bottom:8px;">Current patient mix</div>' +
      bar("Antenatal", currentAntenatal, "var(--accent)") +
      bar("Postnatal",  currentPostnatal, "var(--purple)") +
      bar("Gynaecology", currentGynae, "#b5580d") +
      '<div style="font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--ink-soft);margin:14px 0 8px;">Most active staff (last '+days+' days)</div>';

    if(topStaff.length === 0){
      html += '<div style="color:var(--ink-soft);font-size:0.85rem;">No activity recorded yet.</div>';
    } else {
      var maxActivity = topStaff[0][1] || 1;
      topStaff.forEach(function(s){
        html += '<div class="stat-bar-wrap"><div class="stat-bar-label"><span>'+escapeHtml(s[0])+'</span><span>'+s[1]+' actions</span></div><div class="stat-bar-track"><div class="stat-bar-fill" style="width:'+Math.round(s[1]/maxActivity*100)+'%;background:var(--accent);"></div></div></div>';
      });
    }

    document.getElementById("statsContent").innerHTML = html;
  }

  // Wire Lead panel → stats button
  document.getElementById("hod_statsBtn").onclick = function(){
    document.getElementById("hodPanelOverlay").classList.remove("show");
    openHodStats();
  };


  /* ============================================================
     FEATURE: WARD DELETE (Lead panel)
  ============================================================ */
  function renderLeadWardDeleteList(){
    var container = document.getElementById("hod_wardDeleteList");
    if(!container) return;
    container.innerHTML = "";
    state.wardOrder.forEach(function(id){
      var w = state.wards[id]; if(!w) return;
      var occupied = Object.keys(w.rooms||{}).filter(function(k){ return !!w.rooms[k]; }).length;
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;align-items:center;";
      var lbl = document.createElement("span");
      lbl.style.cssText = "flex:1;font-size:0.84rem;font-weight:600;";
      lbl.textContent = w.name + (occupied ? " ("+occupied+" patient"+(occupied>1?"s":"")+")":"  — empty");
      var del = document.createElement("button");
      del.className = "btn-danger-outline btn-small";
      del.textContent = "Delete";
      del.disabled = occupied > 0;
      del.title = occupied > 0 ? "Discharge all patients before deleting" : "Delete this ward";
      del.onclick = (function(wid, wname){
        return function(){
          showConfirm("Delete ward", "Permanently delete \""+wname+"\"? This cannot be undone.", "Delete ward", "btn-danger-outline", function(){
            var idx = state.wardOrder.indexOf(wid);
            if(idx > -1) state.wardOrder.splice(idx,1);
            delete state.wards[wid];
            if(activeWardId === wid) activeWardId = state.wardOrder[0];
            saveState(); render();
            renderLeadWardDeleteList();
          });
        };
      })(id, w.name);
      row.appendChild(lbl); row.appendChild(del);
      container.appendChild(row);
    });
  }

  /* ============================================================
     FEATURE: CROSS-WARD PATIENT SEARCH
  ============================================================ */
  function renderCrossWardSearch(query){
    if(!query || query.length < 2) return; // only kick in with 2+ chars
    var q = query.toLowerCase();
    var results = [];
    state.wardOrder.forEach(function(id){
      var w = state.wards[id]; if(!w||!w.rooms) return;
      Object.keys(w.rooms).forEach(function(bKey){
        var p = w.rooms[bKey]; if(!p) return;
        var searchable = [p.name,p.diagnosis,p.unit,p.gestation,p.indication,p.procedure].filter(Boolean).join(" ").toLowerCase();
        if(searchable.includes(q)){
          results.push({wardId:id, wardName:w.name, bedKey:bKey, patient:p});
        }
      });
    });
    // If results are from other wards, show a cross-ward hint
    var otherWard = results.filter(function(r){ return r.wardId !== activeWardId; });
    var hint = document.getElementById("crossWardHint");
    if(!hint){
      hint = document.createElement("div");
      hint.id = "crossWardHint";
      hint.style.cssText = "font-size:0.78rem;padding:6px 16px 2px;color:var(--accent);font-weight:600;background:var(--accent-soft);";
      var toolbar = document.querySelector(".toolbar");
      if(toolbar) toolbar.parentNode.insertBefore(hint, toolbar.nextSibling);
    }
    if(otherWard.length){
      hint.style.display = "block";
      hint.innerHTML = "🔍 Also found in other wards: " + otherWard.map(function(r){
        return '<a href="#" style="color:var(--accent);font-weight:700;text-decoration:underline;" onclick="activeWardId=\''+r.wardId+'\';render();document.getElementById(\'searchBox\').value=\''+escapeHtml(query)+'\';render();event.preventDefault();">'+escapeHtml(r.wardName)+'</a>';
      }).join(", ");
    } else {
      hint.style.display = "none";
    }
  }

  /* ============================================================
     FEATURE: DATA BACKUP
  ============================================================ */
  document.getElementById("hod_backupBtn").onclick = function(){
    document.getElementById("hodPanelOverlay").classList.remove("show");
    openBackupModal();
  };

  function openBackupModal(){
    var info = document.getElementById("backupInfo");
    if(info){
      var totalPatients = 0;
      state.wardOrder.forEach(function(id){
        var w = state.wards[id]; if(!w||!w.rooms) return;
        totalPatients += Object.values(w.rooms).filter(Boolean).length;
      });
      info.innerHTML =
        "<strong>Wards:</strong> "+state.wardOrder.length+"<br>"+
        "<strong>Current patients:</strong> "+totalPatients+"<br>"+
        "<strong>History entries:</strong> "+((state.hodLog||[]).length)+"<br>"+
        "<strong>Backup time:</strong> "+new Date().toLocaleString();
    }
    document.getElementById("backupOverlay").classList.add("show");
  }

  document.getElementById("closeBackup").onclick   = function(){ document.getElementById("backupOverlay").classList.remove("show"); };
  document.getElementById("cancelBackup").onclick  = function(){ document.getElementById("backupOverlay").classList.remove("show"); };
  document.getElementById("downloadBackup").onclick = function(){
    var data = JSON.stringify({
      exportedAt: nowISO(),
      exportedBy: getStaffName()||"Lead",
      appVersion: "v1.1",
      state: state
    }, null, 2);
    var blob = new Blob([data], {type:"application/json"});
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement("a");
    a.href   = url;
    a.download = "ward-board-backup-"+new Date().toISOString().slice(0,10)+".json";
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    document.getElementById("backupOverlay").classList.remove("show");
  };

  /* ============================================================
     FEATURE: CENSUS REPORT (printable)
  ============================================================ */
  document.getElementById("hod_censusBtn").onclick = function(){
    document.getElementById("hodPanelOverlay").classList.remove("show");
    openCensusModal();
  };

  function openCensusModal(){
    // Populate ward selector
    var sel = document.getElementById("censusWardSel");
    sel.innerHTML = '<option value="">All wards</option>';
    state.wardOrder.forEach(function(id){
      var w = state.wards[id]; if(!w) return;
      var o = document.createElement("option"); o.value=id; o.textContent=w.name;
      sel.appendChild(o);
    });
    // Set today's date
    var dateEl = document.getElementById("censusDate");
    if(dateEl) dateEl.value = new Date().toISOString().slice(0,10);
    document.getElementById("censusOverlay").classList.add("show");
  }

  document.getElementById("closeCensus").onclick  = function(){ document.getElementById("censusOverlay").classList.remove("show"); };
  document.getElementById("cancelCensus").onclick = function(){ document.getElementById("censusOverlay").classList.remove("show"); };
  document.getElementById("printCensus").onclick  = function(){
    var wardId   = document.getElementById("censusWardSel").value;
    var dateStr  = document.getElementById("censusDate").value;
    var dateLabel= dateStr ? new Date(dateStr).toLocaleDateString([],{weekday:"long",day:"2-digit",month:"long",year:"numeric"}) : new Date().toLocaleDateString([],{weekday:"long",day:"2-digit",month:"long",year:"numeric"});
    var wardIds  = wardId ? [wardId] : state.wardOrder;

    var totalAnte=0, totalPost=0, totalGynae=0, totalUrgent=0, totalReview=0, totalStable=0;
    var consultantCounts = {};
    var rows = "";

    wardIds.forEach(function(id){
      var w = state.wards[id]; if(!w||!w.rooms) return;
      var wardTotal = 0;
      var wardHtml = "";
      var rc = w.roomCount || 24;
      for(var r=1; r<=rc; r++){
        ["A","B"].forEach(function(b){
          var p = w.rooms[r+b]; if(!p) return;
          wardTotal++;
          if(p.type==="antenatal") totalAnte++;
          else if(p.type==="postnatal") totalPost++;
          else if(p.type==="gynae") totalGynae++;
          if(p.acuity==="urgent") totalUrgent++;
          else if(p.acuity==="review") totalReview++;
          else totalStable++;
          if(p.unit){ consultantCounts[p.unit] = (consultantCounts[p.unit]||0)+1; }

          var lastE = p.history&&p.history.length ? p.history[p.history.length-1] : null;
          var sit = lastE ? lastE.situation : p.situation;
          var nr = lastE ? lastE.nextReview : p.nextReview;
          var nrFmt = "";
          if(nr){ var nd=new Date(nr); nrFmt=!isNaN(nd.getTime())?nd.toLocaleString([],{hour:"2-digit",minute:"2-digit",day:"2-digit",month:"short"}):""; }

          wardHtml += '<tr style="border-bottom:1px solid #eee;">' +
            '<td style="padding:4px 6px;font-weight:700;">'+r+b+'</td>'+
            '<td style="padding:4px 6px;">'+escapeHtml(p.name||"—")+(p.age?' <span style="color:#888;font-size:9px;">'+escapeHtml(p.age)+'</span>':'')+'</td>'+
            '<td style="padding:4px 6px;">'+(TYPE_LABEL[p.type]||"—").slice(0,4)+'</td>'+
            '<td style="padding:4px 6px;">'+escapeHtml(p.diagnosis||"—")+'</td>'+
            '<td style="padding:4px 6px;">'+escapeHtml(p.unit||"—")+'</td>'+
            '<td style="padding:4px 6px;color:'+(p.acuity==="urgent"?"#c0291f":p.acuity==="review"?"#9e5f06":"#1a5fa8")+';font-weight:700;">'+(ACUITY_LABEL[p.acuity]||"Stable")+'</td>'+
            '<td style="padding:4px 6px;font-size:9px;">'+(escapeHtml(sit||"").slice(0,60))+'</td>'+
            '<td style="padding:4px 6px;font-size:9px;">'+(nrFmt)+'</td>'+
            '</tr>';
        });
      }
      if(wardTotal > 0){
        rows += '<tr style="background:#f4f6f8;"><td colspan="8" style="padding:6px 8px;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">'+escapeHtml(w.name)+' — '+wardTotal+' patient'+(wardTotal>1?"s":"")+'</td></tr>';
        rows += wardHtml;
      }
    });

    var grandTotal = totalAnte+totalPost+totalGynae;
    var consultantRows = Object.entries(consultantCounts).sort(function(a,b){return b[1]-a[1];}).map(function(e){ return escapeHtml(e[0])+": "+e[1]; }).join(" &nbsp;|&nbsp; ");

    var html = '<html><head><title>Ward Census — '+dateLabel+'</title><style>'+
      'body{font-family:Arial,sans-serif;padding:20px 24px;color:#111;font-size:10pt;}'+
      'h1{font-size:14pt;margin:0 0 2px;}'+
      '.meta{font-size:9pt;color:#555;margin-bottom:12px;}'+
      '.summary-box{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;padding:10px 14px;background:#f4f6f8;border-radius:8px;border:1px solid #dde3e8;}'+
      '.s{text-align:center;min-width:60px;} .sn{font-size:16pt;font-weight:700;line-height:1;} .sl{font-size:7.5pt;color:#555;text-transform:uppercase;letter-spacing:0.04em;margin-top:2px;}'+
      'table{width:100%;border-collapse:collapse;font-size:9pt;}'+
      'th{text-align:left;font-size:7.5pt;text-transform:uppercase;color:#555;border-bottom:2px solid #222;padding:4px 6px;background:#f9fafb;}'+
      '@media print{button{display:none!important;}}'+
      '</style></head><body>'+
      '<div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:8px;">'+
        '<div><h1>Patient Census Report</h1><div class="meta">'+escapeHtml(state.appTitle||"Ward Board")+' &nbsp;·&nbsp; '+dateLabel+'</div></div>'+
        '<div style="font-size:9pt;color:#555;">Generated '+new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})+' by '+escapeHtml(getStaffName()||"Lead")+'</div>'+
      '</div>'+
      '<div class="summary-box">'+
        '<div class="s"><div class="sn">'+grandTotal+'</div><div class="sl">Total</div></div>'+
        '<div class="s"><div class="sn" style="color:#0d7a68;">'+totalAnte+'</div><div class="sl">Antenatal</div></div>'+
        '<div class="s"><div class="sn" style="color:#6243a0;">'+totalPost+'</div><div class="sl">Postnatal</div></div>'+
        '<div class="s"><div class="sn" style="color:#b05410;">'+totalGynae+'</div><div class="sl">Gynae</div></div>'+
        '<div class="s"><div class="sn" style="color:#c0291f;">'+totalUrgent+'</div><div class="sl">Urgent</div></div>'+
        '<div class="s"><div class="sn" style="color:#9e5f06;">'+totalReview+'</div><div class="sl">Review</div></div>'+
        '<div class="s"><div class="sn" style="color:#1a5fa8;">'+totalStable+'</div><div class="sl">Stable</div></div>'+
      '</div>'+
      (consultantRows ? '<div style="font-size:9pt;margin-bottom:12px;color:#444;"><strong>By consultant:</strong> '+consultantRows+'</div>' : '')+
      '<table><thead><tr>'+
        '<th>Bed</th><th>Name / Age</th><th>Type</th><th>Diagnosis</th><th>Consultant</th><th>Acuity</th><th>Situation</th><th>Next review</th>'+
      '</tr></thead><tbody>'+rows+'</tbody></table>'+
      '<div style="margin-top:16px;font-size:8pt;color:#888;border-top:1px solid #ddd;padding-top:8px;">Ward Board v1.1 · For clinical workflow use during duty · Not a substitute for the EHR</div>'+
      '</body></html>';

    document.getElementById("censusOverlay").classList.remove("show");
    var win = window.open("","_blank","width=900,height=700");
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(function(){ win.print(); }, 400);
  };

  /* ============================================================
     FEATURE: KEYBOARD SHORTCUTS
  ============================================================ */
  var SHORTCUTS = [
    {key:"N", desc:"New patient on selected bed / Add patient to empty bed"},
    {key:"P", desc:"Progress update on last active patient"},
    {key:"H", desc:"Open Handover Summary"},
    {key:"1–5", desc:"Switch to ward tab 1, 2, 3, 4, or 5"},
    {key:"Esc", desc:"Close any open modal"},
    {key:"?", desc:"Show this shortcuts guide"},
    {key:"Ctrl+D", desc:"Toggle dark / light mode"},
  ];

  function renderShortcutsList(){
    var el = document.getElementById("shortcutsList");
    if(!el) return;
    el.innerHTML = SHORTCUTS.map(function(s){
      return '<div style="display:flex;align-items:baseline;gap:12px;padding:7px 0;border-bottom:1px solid var(--line-soft);">'+
        '<span style="font-family:monospace;background:var(--paper);border:1px solid var(--line);border-radius:5px;padding:2px 9px;font-size:0.82rem;font-weight:700;white-space:nowrap;flex-shrink:0;">'+escapeHtml(s.key)+'</span>'+
        '<span style="font-size:0.84rem;color:var(--ink-2);">'+escapeHtml(s.desc)+'</span>'+
        '</div>';
    }).join("");
  }

  document.getElementById("closeShortcuts").onclick = function(){ document.getElementById("shortcutsOverlay").classList.remove("show"); };
  document.getElementById("okShortcuts").onclick    = function(){ document.getElementById("shortcutsOverlay").classList.remove("show"); };

  document.addEventListener("keydown", function(e){
    // Don't fire when typing in an input/textarea
    var tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
    var inInput = (tag === "input" || tag === "textarea" || tag === "select" || document.activeElement.isContentEditable);
    var anyModalOpen = document.querySelector(".overlay.show");

    // Escape — close any open modal
    if(e.key === "Escape"){
      var open = document.querySelector(".overlay.show");
      if(open) open.classList.remove("show");
      return;
    }
    // ? — shortcuts guide
    if(e.key === "?" && !inInput){
      renderShortcutsList();
      document.getElementById("shortcutsOverlay").classList.add("show");
      return;
    }
    // Ctrl+D — dark mode toggle
    if(e.key === "d" && (e.ctrlKey||e.metaKey)){
      e.preventDefault();
      document.getElementById("darkModeBtn").click();
      return;
    }
    // Don't fire alpha shortcuts when in input or modal open
    if(inInput || anyModalOpen) return;

    // H — handover
    if(e.key === "h" || e.key === "H"){ document.getElementById("exportSummaryBtn").click(); return; }

    // 1-5 — ward tabs
    var num = parseInt(e.key, 10);
    if(num >= 1 && num <= 5 && state.wardOrder[num-1]){
      activeWardId = state.wardOrder[num-1];
      render();
      return;
    }
  });

  /* ============================================================
     FEATURE: SHARE PATIENT SUMMARY
  ============================================================ */
  function buildPatientText(room, bed){
    var w = currentWard();
    var p = w.rooms[bedKey(room, bed)];
    if(!p) return "";
    var lastEntry = p.history && p.history.length ? p.history[p.history.length-1] : null;
    var situation = lastEntry ? lastEntry.situation : p.situation;
    var plan      = lastEntry ? lastEntry.plan      : p.plan;
    var nextRev   = lastEntry ? lastEntry.nextReview : p.nextReview;
    var nrStr = "";
    if(nextRev){ var nd = new Date(nextRev); nrStr = !isNaN(nd.getTime()) ? nd.toLocaleString([],{weekday:"short",hour:"2-digit",minute:"2-digit"}) : nextRev; }
    var lines = [
      "🏥 "+escapeHtml(w.name)+" — Bed "+room+bed,
      "👤 "+(p.name||"—")+(p.age?" ("+p.age+")":""),
      "📋 Type: "+(TYPE_LABEL[p.type]||p.type),
      "🩺 Diagnosis: "+(p.diagnosis||"—"),
      p.allergy ? "⚠️ ALLERGY: "+p.allergy : "",
      p.flags && p.flags.length ? "🚩 Flags: "+p.flags.join(", ") : "",
      "📊 Acuity: "+(ACUITY_LABEL[p.acuity]||"Stable"),
      p.unit ? "👨‍⚕️ Consultant: "+p.unit : "",
      situation ? "📝 Situation: "+situation : "",
      plan ? "✅ Plan: "+plan : "",
      nrStr ? "⏰ Next review: "+nrStr : "",
      p.labs ? "🔬 Labs: "+p.labs : "",
      "—",
      "Ward Board · "+new Date().toLocaleString([],{weekday:"short",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"short"})
    ].filter(Boolean).join("\n");
    return lines;
  }

  function sharePatientSummary(room, bed){
    var text = buildPatientText(room, bed);
    if(!text) return;
    if(navigator.share){
      navigator.share({ title: "Patient Summary", text: text })
        .catch(function(e){ if(e.name !== "AbortError") copyToClipboard(text); });
    } else {
      copyToClipboard(text);
    }
  }

  function copyToClipboard(text){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){
        showToast("✓ Copied to clipboard");
      });
    } else {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position="fixed"; ta.style.opacity="0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("✓ Copied to clipboard");
    }
  }

  /* ============================================================
     TOAST NOTIFICATION (lightweight feedback)
  ============================================================ */
  function showToast(msg, duration){
    var t = document.getElementById("wbToast");
    if(!t){
      t = document.createElement("div");
      t.id = "wbToast";
      t.style.cssText = "position:fixed;bottom:calc(80px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%) translateY(20px);background:var(--ink);color:#fff;padding:9px 18px;border-radius:20px;font-size:0.82rem;font-weight:600;z-index:999;opacity:0;transition:opacity 0.2s,transform 0.2s;pointer-events:none;white-space:nowrap;";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1"; t.style.transform = "translateX(-50%) translateY(0)";
    clearTimeout(t._timer);
    t._timer = setTimeout(function(){
      t.style.opacity="0"; t.style.transform="translateX(-50%) translateY(20px)";
    }, duration||2200);
  }
  window.showToast = showToast;

  /* ============================================================
     FEATURE: PRINT INDIVIDUAL CARD
  ============================================================ */
  function printPatientCard(room, bed){
    var w = currentWard();
    var p = w.rooms[bedKey(room, bed)];
    if(!p) return;
    var lastEntry = p.history && p.history.length ? p.history[p.history.length-1] : null;
    var situation = lastEntry ? lastEntry.situation : p.situation;
    var plan      = lastEntry ? lastEntry.plan      : p.plan;
    var nextRev   = lastEntry ? lastEntry.nextReview : p.nextReview;
    var nrStr = "";
    if(nextRev){ var nd=new Date(nextRev); nrStr=!isNaN(nd.getTime())?nd.toLocaleString([],{weekday:"short",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"short"}):nextRev; }

    function r(label, val){ return val ? '<tr><td style="padding:5px 8px;font-size:8pt;color:#555;white-space:nowrap;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;border-bottom:1px solid #eee;">'+label+'</td><td style="padding:5px 8px;font-size:10pt;border-bottom:1px solid #eee;">'+val+'</td></tr>' : ''; }

    var html = '<html><head><title>Patient Card — '+room+bed+'</title><style>'+
      'body{font-family:Arial,sans-serif;padding:20px;color:#111;}'+
      '.header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #111;padding-bottom:8px;margin-bottom:14px;}'+
      '.ward{font-size:9pt;color:#555;}'+
      '.bed{font-size:18pt;font-weight:700;}'+
      '.acuity{padding:3px 10px;border-radius:4px;font-size:9pt;font-weight:700;}'+
      '.urgent{background:#fbeae9;color:#b3261e;border:1px solid #e8b9b6;}'+
      '.review{background:#fbf0dd;color:#a8620a;border:1px solid #f0ce8a;}'+
      '.stable{background:#e5eff8;color:#1d5f9e;border:1px solid #93bcde;}'+
      '.allergy{background:#fef2f2;border:2px solid #fca5a5;padding:8px 12px;border-radius:6px;color:#991b1b;font-weight:700;margin-bottom:12px;font-size:11pt;}'+
      '.flags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}'+
      '.flag{padding:3px 10px;border-radius:12px;font-size:8pt;font-weight:700;color:#fff;}'+
      'table{width:100%;border-collapse:collapse;}'+
      '.footer{margin-top:16px;font-size:7.5pt;color:#888;border-top:1px solid #ddd;padding-top:8px;text-align:center;}'+
      '@media print{button{display:none!important;}}'+
      '</style></head><body>'+
      '<div class="header">'+
        '<div><div class="ward">'+escapeHtml(w.name)+'</div><div class="bed">Bed '+room+bed+'</div></div>'+
        '<div>'+
          '<span class="acuity '+(p.acuity||"stable")+'">'+(ACUITY_LABEL[p.acuity]||"Stable")+'</span>'+
          '<span style="font-size:9pt;color:#555;margin-left:10px;">'+new Date().toLocaleString([],{weekday:"short",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})+'</span>'+
        '</div>'+
      '</div>'+
      (p.allergy ? '<div class="allergy">⚠️ ALLERGY: '+escapeHtml(p.allergy)+'</div>' : '')+
      (p.flags && p.flags.length ? '<div class="flags">'+p.flags.map(function(f){ var d=getFlagDef(f); return '<span class="flag" style="background:'+(d.cls==="flag-nbm"?"#1a1a2e":d.cls==="flag-theatre"?"#6b21a8":d.cls==="flag-scan"?"#0369a1":d.cls==="flag-isolation"?"#b45309":d.cls==="flag-family"?"#065f46":"#9f1239")+'">'+(d.icon)+' '+escapeHtml(f)+'</span>'; }).join("")+'</div>' : '')+
      '<table>'+
        r("Patient", (p.name||"—")+(p.age?" ("+p.age+")":""))+
        r("Type", TYPE_LABEL[p.type]||p.type)+
        r("Diagnosis", p.diagnosis)+
        r("Consultant", p.unit)+
        (p.type==="antenatal" ? r("Gestation / EDD", (p.gestation||"")+(p.edd?" · EDD: "+new Date(p.edd).toLocaleDateString([],{day:"2-digit",month:"short",year:"numeric"}):"")) : "")+
        (p.type==="postnatal" ? r("Mode / Day", (p.modeDelivery||"")+(p.dayPostDelivery?" · "+p.dayPostDelivery:"")) : "")+
        (p.type==="gynae" ? r("Procedure", p.procedure) : "")+
        r("Situation", situation)+
        r("Plan", plan)+
        r("Next review", nrStr)+
        r("Labs", p.labs)+
        r("Notes", p.general)+
      '</table>'+
      '<div class="footer">Ward Board v1.0 · Printed '+new Date().toLocaleString()+(p.addedBy?' · Admitted by '+escapeHtml(p.addedBy):'')+'<br>CONFIDENTIAL — For clinical use only. Do not leave unattended.</div>'+
      '</body></html>';

    var win = window.open("","_blank","width=600,height=800");
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(function(){ win.print(); }, 300);
  }

  /* ============================================================
     FEATURE: RESTORE FROM BACKUP
  ============================================================ */
  document.getElementById("hod_restoreBtn").onclick = function(){
    document.getElementById("hod_restoreFile").click();
  };
  document.getElementById("hod_restoreFile").onchange = function(e){
    var file = e.target.files[0];
    if(!file) return;
    var msg = document.getElementById("hod_restoreMsg");
    var reader = new FileReader();
    reader.onload = function(ev){
      try {
        var data = JSON.parse(ev.target.result);
        // Validate it looks like a Ward Board backup
        if(!data.state || !data.state.wardOrder || !data.state.wards){
          throw new Error("This doesn't look like a Ward Board backup file.");
        }
        showConfirm(
          "Restore backup",
          "This will replace ALL current ward data with the backup from "+
          (data.exportedAt ? new Date(data.exportedAt).toLocaleString() : "unknown date")+
          ". This cannot be undone. Are you sure?",
          "Restore",
          "btn-danger-outline",
          function(){
            state = normalizeState(data.state);
            saveState();
            render();
            msg.textContent = "✓ Backup restored successfully from "+escapeHtml(file.name);
            msg.style.background = "var(--accent-soft)";
            msg.style.color = "var(--accent)";
            msg.style.border = "1px solid #bde3dc";
            msg.style.display = "block";
            hodLog("restore", "Restored from backup: "+escapeHtml(file.name), "All wards");
            setTimeout(function(){ msg.style.display="none"; }, 4000);
          }
        );
      } catch(err){
        msg.textContent = "❌ "+err.message;
        msg.style.background = "var(--red-soft)";
        msg.style.color = "var(--red)";
        msg.style.border = "1px solid var(--red-mid)";
        msg.style.display = "block";
      }
    };
    reader.readAsText(file);
    // Reset so same file can be re-selected
    e.target.value = "";
  };
  /* ============================================================
     FEATURE: PUSH NOTIFICATIONS — header bell for ALL staff
  ============================================================ */
  var INSTALL_DISMISSED_KEY = "wb_install_dismissed";
  var _deferredInstallPrompt = null;

  /* Capture the browser's native "install" event (Android Chrome) */
  window.addEventListener("beforeinstallprompt", function(e){
    e.preventDefault();
    _deferredInstallPrompt = e;
    var btn = document.getElementById("installAppBtn");
    if(btn) btn.style.display = "inline-block";
  });

  /* Update bell button appearance for all staff */
  function updateNotifStatus(){
    var headerBtn = document.getElementById("notifHeaderBtn");
    var hodEl  = document.getElementById("hod_notifStatus");
    var hodBtn = document.getElementById("hod_notifBtn");
    var supported = "Notification" in window;

    if(!supported){
      if(headerBtn){ headerBtn.className = "btn-ghost btn-small btn-notif notif-denied"; headerBtn.title = "Notifications not supported on this browser"; }
      if(hodEl) hodEl.textContent = "Not supported on this browser.";
      if(hodBtn){ hodBtn.disabled = true; hodBtn.textContent = "Not supported"; }
      return;
    }

    var perm = Notification.permission;
    if(headerBtn){
      headerBtn.classList.remove("notif-on","notif-off","notif-denied");
      if(perm === "granted"){
        headerBtn.classList.add("notif-on");
        headerBtn.title = "🔔 Urgent alerts ON — tap to manage";
      } else if(perm === "denied"){
        headerBtn.classList.add("notif-denied");
        headerBtn.title = "Notifications blocked — allow in browser settings";
      } else {
        headerBtn.classList.add("notif-off");
        headerBtn.title = "Tap to enable urgent patient alerts";
      }
    }
    if(hodEl) hodEl.textContent = perm==="granted" ? "✓ Enabled on this device" : perm==="denied" ? "Blocked — allow in browser settings" : "Not yet enabled";
    if(hodBtn) hodBtn.textContent = perm==="granted" ? "✓ Alerts enabled" : "Enable notifications on this device";
  }

  function requestNotifPermission(callback){
    if(!("Notification" in window)) return;
    if(Notification.permission === "granted"){ if(callback) callback("granted"); return; }
    if(Notification.permission === "denied"){
      showNotifInfo("🔔 Notifications blocked", "Notifications are blocked on this device.\n\nTo enable:\n• iPhone: Settings → Safari → [this site] → Notifications → Allow\n• Android: Browser menu → Settings → Notifications → Allow\n• Desktop: Click the 🔒 lock icon in the address bar");
      return;
    }
    Notification.requestPermission().then(function(perm){
      updateNotifStatus();
      if(perm === "granted"){
        new Notification("🔔 Ward Board", { body: "Urgent patient alerts are now active on this device.", tag:"wb-welcome" });
      }
      if(callback) callback(perm);
    });
  }

  /* Header bell — for ALL staff */
  var notifHeaderBtn = document.getElementById("notifHeaderBtn");
  if(notifHeaderBtn){
    notifHeaderBtn.onclick = function(){
      if(!("Notification" in window)){
        showNotifInfo("🔔 Not supported", "Push notifications are not supported on this browser.\n\nFor best results:\n• iPhone — add to Home Screen from Safari, then enable\n• Android — use Chrome browser");
        return;
      }
      if(Notification.permission === "granted"){
        showNotifInfo("🔔 Alerts active", "✓ Urgent patient alerts are active on this device.\n\nYou will be notified whenever a patient is marked Urgent.\n\nTo disable, go to your device or browser notification settings.");
        return;
      }
      requestNotifPermission(null);
    };
  }

  /* Lead panel button — same action */
  document.getElementById("hod_notifBtn").onclick = function(){
    requestNotifPermission(null);
  };

  /* ============================================================
     INSTALL PROMPT — Add to Home Screen guide
  ============================================================ */
  function isStandalone(){
    return window.navigator.standalone === true ||
           window.matchMedia("(display-mode: standalone)").matches;
  }
  function isIOS(){
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }

  function showInstallBanner(){
    var banner = document.getElementById("installBanner");
    if(!banner) return;
    // Adjust instructions for platform
    var steps = document.getElementById("installSteps");
    var note  = document.getElementById("installNote");
    var installBtn = document.getElementById("installAppBtn");
    if(isIOS()){
      if(steps) steps.innerHTML =
        "<li>Tap the <strong>Share ⬆️</strong> button at the bottom of Safari</li>" +
        "<li>Scroll down and tap <strong>\"Add to Home Screen\"</strong></li>" +
        "<li>Tap <strong>Add</strong> — done!</li>";
      if(note) note.textContent = "Requires iOS 16.4+ for push notifications";
    } else if(_deferredInstallPrompt){
      if(steps) steps.innerHTML = "<li>Tap <strong>Install App</strong> below</li><li>Confirm in the popup</li>";
      if(installBtn) installBtn.style.display = "inline-block";
    } else {
      if(steps) steps.innerHTML =
        "<li>Open the browser menu (⋮)</li>" +
        "<li>Tap <strong>\"Add to Home screen\"</strong> or <strong>\"Install app\"</strong></li>";
    }
    banner.style.display = "block";
  }

  function hideInstallBanner(){
    var b = document.getElementById("installBanner");
    if(b) b.style.display = "none";
  }

  document.getElementById("closeInstallBanner").onclick  = function(){ hideInstallBanner(); localStorage.setItem(INSTALL_DISMISSED_KEY,"1"); };
  document.getElementById("dismissInstallBanner").onclick = function(){ hideInstallBanner(); localStorage.setItem(INSTALL_DISMISSED_KEY,"1"); };
  document.getElementById("installAppBtn").onclick = function(){
    if(!_deferredInstallPrompt) return;
    _deferredInstallPrompt.prompt();
    _deferredInstallPrompt.userChoice.then(function(r){
      if(r.outcome === "accepted") hideInstallBanner();
      _deferredInstallPrompt = null;
    });
  };

  /* Show install banner once — if not already installed and not dismissed */
  (function(){
    if(isStandalone()) return;                                    // already installed
    if(localStorage.getItem(INSTALL_DISMISSED_KEY)) return;      // user dismissed
    // Show after 5 seconds so it doesn't interrupt first load
    setTimeout(showInstallBanner, 5000);
  })();

  /* Fire a notification when a patient transitions to Urgent */
  function checkUrgentNotifications(){
    if(!("Notification" in window) || Notification.permission !== "granted") return;
    var newUrgentKeys = {};
    state.wardOrder.forEach(function(id){
      var w = state.wards[id]; if(!w||!w.rooms) return;
      Object.keys(w.rooms).forEach(function(bKey){
        var p = w.rooms[bKey];
        if(p && p.acuity === "urgent"){
          var key = id + "_" + bKey;
          newUrgentKeys[key] = p.name || bKey;
          if(!_prevUrgentKeys[key]){
            new Notification("⚠️ Urgent patient — " + w.name, {
              body: (p.name||bKey) + " marked URGENT" + (p.diagnosis?" ("+p.diagnosis+")":""),
              tag: key
            });
          }
        }
      });
    });
    _prevUrgentKeys = newUrgentKeys;
  }


  /* ============================================================
     FEATURE: OFFLINE BANNER
  ============================================================ */
  window.setOfflineBanner = function(offline){
    var b = document.getElementById("offlineBanner");
    if(b) b.style.display = offline ? "block" : "none";
  };
  window.addEventListener("online",  function(){ window.setOfflineBanner(false); });
  window.addEventListener("offline", function(){ window.setOfflineBanner(true); });
  if(!navigator.onLine) setOfflineBanner(true);


  /* ============================================================
     OVERDUE: re-check every 60 seconds and re-render if needed
  ============================================================ */
  setInterval(function(){
    // Re-render every minute to update overdue badges, length of stay, and gestation
    render();
  }, 60000);


  loadState();
  if(getStaffName() && staffBtn){ staffBtn.textContent = "👤 " + getStaffName(); }
  updateNotifStatus();
  render();

})();
