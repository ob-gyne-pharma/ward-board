/* Ward Board — firebase-sync.js — v3.0
   Multi-org: Hospital → Department → Ward → Room
   Auth + Approval chain: Hospital Head → Dept Lead → Staff
   Server-side PIN (SHA-256 stored in Firebase, never localStorage)
*/
import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, update, onValue, goOnline, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updateProfile, sendPasswordResetEmail,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getMessaging, getToken, onMessage }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const FCM_VAPID_KEY = "";

const firebaseConfig = {
  apiKey:            "AIzaSyC7RoEpdCWOYfxnKyTykmhVV9xgnbeH3bE",
  authDomain:        "wardboard-e7035.firebaseapp.com",
  databaseURL:       "https://wardboard-e7035-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "wardboard-e7035",
  storageBucket:     "wardboard-e7035.firebasestorage.app",
  messagingSenderId: "480376138159",
  appId:             "1:480376138159:web:b0b6fe7c43168b49bee75a"
};

/* ── SHA-256 helper (Web Crypto API — available in all modern browsers) ── */
async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

const statusEl = document.getElementById("cloudStatus");

try {
  const app      = initializeApp(firebaseConfig);
  const db       = getDatabase(app, firebaseConfig.databaseURL);
  const auth     = getAuth(app);
  const provider = new GoogleAuthProvider();

  /* ── Current context (set after org selection) ── */
  let _hospitalId = null;
  let _deptId     = null;
  let _boardRef   = null;
  let _unsubBoard = null;

  /* ── Auth state observer ── */
  onAuthStateChanged(auth, function(user) {
    if(window._hideLoading) window._hideLoading();
    if(user) {
      checkUserProfile(user);
    } else {
      if(window.showLoginModal) window.showLoginModal();
      if(statusEl) statusEl.textContent = "🔒 Not signed in";
      if(window.setCloudDot) window.setCloudDot("error");
    }
  });

  /* ── Step 1: Check if user has a saved hospital + dept preference ── */
  function checkUserProfile(user) {
    // First check localStorage cache for speed
    var cachedHospId = localStorage.getItem("wb_hosp_id");
    var cachedDeptId = localStorage.getItem("wb_dept_id");

    const profileRef = ref(db, "users/" + user.uid + "/profile");
    get(profileRef).then(function(snap) {
      const profile = snap.val();
      if(profile && profile.hospitalId && profile.deptId) {
        _hospitalId = profile.hospitalId;
        _deptId     = profile.deptId;
        // Cache locally for speed
        localStorage.setItem("wb_hosp_id", _hospitalId);
        localStorage.setItem("wb_dept_id", _deptId);
        checkApprovalStatus(user);
      } else if(cachedHospId && cachedDeptId) {
        // Use localStorage cache if Firebase profile not set yet
        _hospitalId = cachedHospId;
        _deptId     = cachedDeptId;
        checkApprovalStatus(user);
      } else {
        // New user — load hospital list now that user is authenticated
        loadHospitalsForSelection(user);
      }
    }).catch(function() {
      if(cachedHospId && cachedDeptId) {
        _hospitalId = cachedHospId;
        _deptId     = cachedDeptId;
        checkApprovalStatus(user);
      } else {
        loadHospitalsForSelection(user);
      }
    });
  }

  /* ── Step 2a: Load hospital list → show selection screen ── */
  function loadHospitalsForSelection(user, attempt) {
    attempt = attempt || 1;
    // Show org selection immediately with loading state
    if(attempt === 1 && window.showOrgSelection) {
      window.showOrgSelection(user, null); // null = loading state
    }
    get(ref(db, "hospitals")).then(function(snap) {
      const hospitals = snap.val() || {};
      if(window.showOrgSelection) window.showOrgSelection(user, hospitals);
    }).catch(function(err) {
      console.error("[Firebase] Could not load hospitals (attempt " + attempt + "):", err);
      if(attempt < 3) {
        // Retry after delay — auth token may not be ready yet
        setTimeout(function() { loadHospitalsForSelection(user, attempt + 1); }, 1500 * attempt);
      } else {
        // Show empty with error message after 3 attempts
        if(window.showOrgSelection) window.showOrgSelection(user, {}, "Could not load hospital list. Check your connection and try signing out and back in.");
      }
    });
  }

  /* ── Step 2b: User picked hospital — load its departments ── */
  window.firebaseLoadDepts = function(hospitalId) {
    return get(ref(db, "hospitals/" + hospitalId + "/depts")).then(function(snap) {
      return snap.val() || {};
    });
  };

  /* ── Step 2c: User confirmed hospital + dept — save to profile ── */
  window.firebaseSetOrgContext = function(user, hospitalId, deptId) {
    _hospitalId = hospitalId;
    _deptId     = deptId;
    // Cache in localStorage so returning users skip selection instantly
    localStorage.setItem("wb_hosp_id", hospitalId);
    localStorage.setItem("wb_dept_id", deptId);
    return set(ref(db, "users/" + user.uid + "/profile"), {
      hospitalId: hospitalId,
      deptId:     deptId,
      updatedAt:  new Date().toISOString()
    }).then(function() {
      checkApprovalStatus(user);
    }).catch(function() {
      // Even if Firebase write fails, proceed with cached values
      checkApprovalStatus(user);
    });
  };

  /* ── Step 3: Check approval at dept level ── */
  function checkApprovalStatus(user, attempt) {
    attempt = attempt || 1;

    // Hide the board while we verify — show a neutral loading state
    var appContent = document.getElementById("appContent");
    if(appContent && attempt === 1) appContent.style.display = "none";

    // ── Hospital Head fast-path ──
    // If this user is the headUid of the hospital, they are always approved
    // as dept_head. No staff record needed.
    get(ref(db, "hospitals/" + _hospitalId + "/headUid")).then(function(snap) {
      if(snap.val() === user.uid) {
        console.log("[Auth] Hospital Head detected — bypassing staff record check");
        localStorage.setItem("wb_approved_" + user.uid, "1");
        localStorage.setItem("wb_role_" + user.uid, "dept_head");
        if(window.onAuthReady) window.onAuthReady(user, {
          role: "dept_head", status: "approved",
          name: user.displayName || "Hospital Head",
          email: user.email
        });
        startDatabaseSync(user);
      } else {
        // Not the head — do normal staff record check
        doStaffCheck(user, attempt);
      }
    }).catch(function() {
      // Can't read headUid — fall through to normal check
      doStaffCheck(user, attempt);
    });
  }

  function doStaffCheck(user, attempt) {

    const staffRef = ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff/" + user.uid);
    get(staffRef).then(function(snap) {
      const data = snap.val();

      if(data && data.status === "approved") {
        // ✅ Approved — show board
        if(window.onAuthReady) window.onAuthReady(user, data);
        startDatabaseSync(user);

      } else if(data && (data.status === "rejected" || data.status === "inactive")) {
        // ❌ Rejected
        signOut(auth);
        if(window.showLoginModal) window.showLoginModal();
        if(window.showAuthError) window.showAuthError("Your access was not approved for this department.");

      } else if(!data) {
        // 🆕 Brand new user — no record yet — register as pending
        var newStaffName = user.displayName || user.email.split("@")[0];
        set(staffRef, {
          uid: user.uid,
          name: newStaffName,
          email: user.email,
          status: "pending",
          role: "staff",
          requestedAt: new Date().toISOString(),
          hospitalId: _hospitalId,
          deptId: _deptId
        }).then(function() {
          // Fire notification to alert dept lead
          if(window.fireNotif) window.fireNotif(
            "staffApproval",
            "New staff awaiting approval",
            newStaffName + " (" + user.email + ") has requested access",
            {}
          );
        });
        if(window.showPendingScreen) window.showPendingScreen(user);
        if(statusEl) statusEl.textContent = "⏳ Awaiting approval";
        startApprovalPoll(user, staffRef);

      } else {
        // ⏳ Record exists but status is pending
        if(window.showPendingScreen) window.showPendingScreen(user);
        if(statusEl) statusEl.textContent = "⏳ Awaiting approval";
        startApprovalPoll(user, staffRef);
      }

    }).catch(function(err) {
      console.error("[Approval] Read failed (attempt " + attempt + "):", err.code, err.message);

      if(attempt < 4) {
        // Retry — transient Firebase error or rules race condition
        setTimeout(function() {
          checkApprovalStatus(user, attempt + 1);
        }, 1000 * attempt);
      } else {
        // After 4 attempts, check localStorage for a known-approved flag
        var knownApproved = localStorage.getItem("wb_approved_" + user.uid);
        if(knownApproved === "1") {
          // Trust the cache — start the board with a minimal data object
          console.warn("[Approval] Using cached approval status for", user.uid);
          if(window.onAuthReady) window.onAuthReady(user, { role: localStorage.getItem("wb_role_" + user.uid) || "staff", status: "approved" });
          startDatabaseSync(user);
        } else {
          // Unknown state — show pending screen, don't lock them out permanently
          if(window.showPendingScreen) window.showPendingScreen(user);
          if(statusEl) statusEl.textContent = "⚠️ Connection issue — retrying…";
          // Keep retrying silently every 10s
          setTimeout(function() { checkApprovalStatus(user, 1); }, 10000);
        }
      }
    });
  }

  function startApprovalPoll(user, staffRef) {
    if(window._approvalPoll) clearInterval(window._approvalPoll);
    var poll = setInterval(function() {
      get(staffRef).then(function(s) {
        var d = s.val();
        if(d && d.status === "approved") {
          clearInterval(poll);
          window._approvalPoll = null;
          localStorage.setItem("wb_approved_" + user.uid, "1");
          localStorage.setItem("wb_role_" + user.uid, d.role || "staff");
          if(window.onAuthReady) window.onAuthReady(user, d);
          startDatabaseSync(user);
        } else if(d && (d.status === "rejected" || d.status === "inactive")) {
          clearInterval(poll);
          window._approvalPoll = null;
          signOut(auth);
          if(window.showLoginModal) window.showLoginModal();
          if(window.showAuthError) window.showAuthError("Your access request was not approved.");
        }
      }).catch(function() { /* silent — keep polling */ });
    }, 8000);
    window._approvalPoll = poll;
  }

  /* ── Step 4: Start syncing the ward board for this dept ── */
  function startDatabaseSync(user) {
    // Cache approval so we survive transient read failures next time
    localStorage.setItem("wb_approved_" + user.uid, "1");

    if(_unsubBoard) _unsubBoard(); // Detach any old listener
    _boardRef = ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/boardState");

    window.firebaseSync = {
      save: function(stateData) {
        if(!auth.currentUser || !_boardRef) return;
        const clean = JSON.parse(JSON.stringify(stateData));
        set(_boardRef, clean).then(function() {
          if(statusEl) { statusEl.textContent = "⚡ Live"; statusEl.style.color = "#a2f2c8"; }
          if(window.setCloudDot) window.setCloudDot("live");
          if(window.hideSaveFailBanner) window.hideSaveFailBanner();
        }).catch(function() {
          if(statusEl) { statusEl.textContent = "❌ Save error"; statusEl.style.color = "#ffb3b3"; }
          if(window.setCloudDot) window.setCloudDot("error");
          if(window.showSaveFailBanner) window.showSaveFailBanner();
        });
      },
      getContext: function() { return { hospitalId: _hospitalId, deptId: _deptId }; }
    };

    _unsubBoard = onValue(_boardRef, function(snapshot) {
      if(statusEl) { statusEl.textContent = "⚡ Live"; statusEl.style.color = "#a2f2c8"; }
      if(window.setCloudDot) window.setCloudDot("live");
      if(window.setOfflineBanner) window.setOfflineBanner(false);
      if(window.hideSaveFailBanner) window.hideSaveFailBanner();
      if(window.handleRemoteState) window.handleRemoteState(snapshot.val());
    }, function() {
      if(statusEl) { statusEl.textContent = "❌ Sync error"; statusEl.style.color = "#ffb3b3"; }
      if(window.setCloudDot) window.setCloudDot("error");
      if(window.setOfflineBanner) window.setOfflineBanner(true);
    });

    document.addEventListener("visibilitychange", function() {
      if(document.visibilityState === "visible") goOnline(db);
    });
    if(FCM_VAPID_KEY) initFCM(user);
  }

  /* ── Auth actions ── */
  window.firebaseAuth = {
    signIn:            function(e,p){ return signInWithEmailAndPassword(auth,e,p); },
    signInWithGoogle:  function(){ return signInWithPopup(auth, provider); },
    register:          function(e,p,n){ return createUserWithEmailAndPassword(auth,e,p).then(function(c){ return updateProfile(c.user,{displayName:n}).then(function(){ return c; }); }); },
    signOut:           function(){
      if(window._approvalPoll) clearInterval(window._approvalPoll);
      var uid = auth.currentUser ? auth.currentUser.uid : null;
      if(uid) {
        localStorage.removeItem("wb_approved_" + uid);
        localStorage.removeItem("wb_role_" + uid);
      }
      return signOut(auth);
    },
    currentUser:       function(){ return auth.currentUser; },
    updateDisplayName: function(n){ return auth.currentUser ? updateProfile(auth.currentUser,{displayName:n}) : Promise.reject("Not signed in"); },
    resetPassword:     function(e){ return sendPasswordResetEmail(auth,e); },
    getUID:            function(){ return auth.currentUser ? auth.currentUser.uid : null; },

    /* ── Staff management (dept-scoped) ── */
    loadAllStaff: function() {
      if(!_hospitalId || !_deptId) return Promise.resolve({});
      return get(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff")).then(function(s){ return s.val()||{}; });
    },
    approveStaff: function(uid) {
      const r = ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff/" + uid);
      return set(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff/" + uid + "/status"), "approved")
        .then(function(){ return set(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff/" + uid + "/approvedAt"), new Date().toISOString()); })
        .then(function(){ return set(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff/" + uid + "/approvedBy"), auth.currentUser ? (auth.currentUser.displayName||auth.currentUser.email) : "Lead"); });
    },
    rejectStaff: function(uid) {
      return set(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff/" + uid + "/status"), "rejected");
    },
    deactivateStaff: function(uid) {
      return set(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff/" + uid + "/status"), "inactive")
        .then(function(){ return set(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff/" + uid + "/deactivatedAt"), new Date().toISOString()); });
    },
    watchPendingStaff: function(cb) {
      if(!_hospitalId || !_deptId) return;
      onValue(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff"), function(snap) {
        var all = snap.val()||{};
        cb(Object.values(all).filter(function(s){ return s.status === "pending"; }).length);
      });
    },

    /* ── Multi-dept: add self to another dept ── */
    joinDept: function(hospitalId, deptId) {
      var user = auth.currentUser;
      if(!user) return Promise.reject("Not signed in");
      return set(ref(db, "hospitals/" + hospitalId + "/depts/" + deptId + "/staff/" + user.uid), {
        uid: user.uid,
        name: user.displayName || user.email.split("@")[0],
        email: user.email,
        status: "pending",
        role: "staff",
        requestedAt: new Date().toISOString(),
        hospitalId: hospitalId,
        deptId: deptId
      });
    },

    /* ── Switch active dept (saves to profile) ── */
    switchDept: function(hospitalId, deptId) {
      var user = auth.currentUser;
      if(!user) return Promise.reject("Not signed in");
      _hospitalId = hospitalId;
      _deptId     = deptId;
      localStorage.setItem("wb_hosp_id", hospitalId);
      localStorage.setItem("wb_dept_id", deptId);
      return set(ref(db, "users/" + user.uid + "/profile"), {
        hospitalId: hospitalId,
        deptId: deptId,
        updatedAt: new Date().toISOString()
      }).then(function() {
        startDatabaseSync(user);
      });
    },

    /* ── Hospital Head: manage hospitals + dept leads ── */
    createHospital: function(hospitalId, hospitalName, headUid, headName) {
      return set(ref(db, "hospitals/" + hospitalId), {
        name: hospitalName,
        createdAt: new Date().toISOString(),
        headUid: headUid,
        headName: headName
      });
    },
    createDept: function(hospitalId, deptId, deptName) {
      return set(ref(db, "hospitals/" + hospitalId + "/depts/" + deptId), {
        name: deptName,
        createdAt: new Date().toISOString()
      });
    },
    approveDeptLead: function(hospitalId, deptId, uid) {
      return set(ref(db, "hospitals/" + hospitalId + "/depts/" + deptId + "/staff/" + uid + "/role"), "lead")
        .then(function(){ return set(ref(db, "hospitals/" + hospitalId + "/depts/" + deptId + "/staff/" + uid + "/status"), "approved"); });
    },
    loadHospitals: function() {
      return get(ref(db, "hospitals")).then(function(s){ return s.val()||{}; });
    }
  };

  /* ── Server-side PIN (SHA-256 stored in Firebase per dept) ── */
  window.firebasePin = {
    /* Verify PIN: hash it, compare against Firebase value */
    verify: function(pin) {
      if(!_hospitalId || !_deptId) return Promise.resolve(false);
      return sha256(pin).then(function(hash) {
        return get(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/config/leadPinHash")).then(function(snap) {
          const stored = snap.val();
          if(!stored) {
            // No PIN set yet — accept default "1234" and set it
            return sha256("1234").then(function(defaultHash) {
              if(hash === defaultHash) {
                return set(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/config/leadPinHash"), defaultHash).then(function(){ return true; });
              }
              return false;
            });
          }
          return hash === stored;
        });
      });
    },
    /* Change PIN: hash and store in Firebase */
    change: function(newPin) {
      if(!_hospitalId || !_deptId) return Promise.reject("No context");
      return sha256(newPin).then(function(hash) {
        return set(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/config/leadPinHash"), hash);
      });
    },
    /* Legacy migration: if old FNV hash in localStorage, migrate it (prompt user to reset PIN) */
    hasLegacyPin: function() {
      return !!localStorage.getItem("ward_board_lead_pin");
    },
    clearLegacy: function() {
      localStorage.removeItem("ward_board_lead_pin");
    }
  };

  /* ── Backup export helper ── */
  window.firebaseBackup = {
    exportFull: function() {
      if(!_hospitalId || !_deptId) return Promise.reject("No context");
      return Promise.all([
        get(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/boardState")),
        get(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/staff")),
        get(ref(db, "hospitals/" + _hospitalId + "/depts/" + _deptId + "/config"))
      ]).then(function(snaps) {
        return {
          exportedAt: new Date().toISOString(),
          hospitalId: _hospitalId,
          deptId: _deptId,
          boardState: snaps[0].val() || {},
          staff: snaps[1].val() || {},
          config: snaps[2].val() || {}
        };
      });
    }
  };

  /* ── FCM ── */
  function initFCM(user) {
    try {
      const messaging = getMessaging(app);
      window.requestFCMToken = function() {
        return navigator.serviceWorker.ready.then(function(reg) {
          return getToken(messaging, { vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: reg });
        }).then(function(token) {
          if(token && user) set(ref(db, "fcmTokens/" + user.uid), { token: token, updatedAt: new Date().toISOString(), name: user.displayName||"?" });
          return token;
        });
      };
      onMessage(messaging, function(payload) {
        if(payload.notification && window.showToast) window.showToast((payload.notification.title||"Ward Board") + " — " + (payload.notification.body||""));
      });
    } catch(e) { console.warn("[FCM]", e.message); }
  }

} catch(e) {
  console.error("Firebase init error:", e);
  if(window._hideLoading) window._hideLoading();
  if(window.showLoginModal) window.showLoginModal();
  if(statusEl) { statusEl.textContent = "❌ Init error"; statusEl.style.color = "#ffb3b3"; }
}
