/* Ward Board — firebase-sync.js — v2.1
   Firebase Auth (email/password + Google) + Approval system + FCM
*/

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, onValue, goOnline, remove }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut, updateProfile,
  sendPasswordResetEmail,
  GoogleAuthProvider, signInWithPopup,
  deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getMessaging, getToken, onMessage }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const FCM_VAPID_KEY = ""; // ← paste VAPID key after generating in Firebase console

const firebaseConfig = {
  apiKey:            "AIzaSyC7RoEpdCWOYfxnKyTykmhVV9xgnbeH3bE",
  authDomain:        "wardboard-e7035.firebaseapp.com",
  databaseURL:       "https://wardboard-e7035-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "wardboard-e7035",
  storageBucket:     "wardboard-e7035.firebasestorage.app",
  messagingSenderId: "480376138159",
  appId:             "1:480376138159:web:b0b6fe7c43168b49bee75a"
};

const statusEl = document.getElementById("cloudStatus");

try {
  const app      = initializeApp(firebaseConfig);
  const db       = getDatabase(app, firebaseConfig.databaseURL);
  const auth     = getAuth(app);
  const provider = new GoogleAuthProvider();

  /* ── Auth state observer ─────────────────────────────────── */
  onAuthStateChanged(auth, function(user) {
    if(user){
      checkApprovalStatus(user);
    } else {
      if(window.showLoginModal) window.showLoginModal();
      if(statusEl){ statusEl.textContent = "🔒 Not signed in"; }
      if(window.setCloudDot) window.setCloudDot("error");
    }
  });

  /* ── Check if user is approved ───────────────────────────── */
  function checkApprovalStatus(user){
    const staffRef = ref(db, "staff/" + user.uid);
    get(staffRef).then(function(snap){
      const data = snap.val();
      if(data && data.status === "approved"){
        // Fully approved — start app
        if(window.onAuthReady) window.onAuthReady(user, data);
        startDatabaseSync(db, user);
      } else if(data && data.status === "rejected"){
        // Rejected — sign them out
        signOut(auth);
        if(window.showLoginModal) window.showLoginModal();
        if(window.showAuthError) window.showAuthError("Your access request was not approved. Contact the Ward Lead.");
      } else if(data && data.status === "inactive"){
        // Removed by Lead
        signOut(auth);
        if(window.showLoginModal) window.showLoginModal();
        if(window.showAuthError) window.showAuthError("Your account has been deactivated. Contact the Ward Lead.");
      } else {
        // Pending or new — write pending record if doesn't exist
        if(!data){
          set(staffRef, {
            uid:         user.uid,
            name:        user.displayName || user.email.split("@")[0],
            email:       user.email,
            status:      "pending",
            requestedAt: new Date().toISOString(),
            provider:    user.providerData[0] ? user.providerData[0].providerId : "email"
          });
        }
        // Show pending screen
        if(window.showPendingScreen) window.showPendingScreen(user);
        if(statusEl){ statusEl.textContent = "⏳ Awaiting approval"; }
        // Poll every 8 seconds for approval
        var pollInterval = setInterval(function(){
          get(staffRef).then(function(s){
            var d = s.val();
            if(d && d.status === "approved"){
              clearInterval(pollInterval);
              if(window.onAuthReady) window.onAuthReady(user, d);
              startDatabaseSync(db, user);
            } else if(d && (d.status === "rejected" || d.status === "inactive")){
              clearInterval(pollInterval);
              signOut(auth);
              if(window.showLoginModal) window.showLoginModal();
              if(window.showAuthError) window.showAuthError("Your access request was not approved.");
            }
          });
        }, 8000);
        // Store interval so it can be cleared
        window._approvalPoll = pollInterval;
      }
    }).catch(function(err){
      console.error("Approval check error:", err);
      // If rules block reading staff (shouldn't happen) — show pending
      if(window.showPendingScreen) window.showPendingScreen(user);
    });
  }

  /* ── Database sync ───────────────────────────────────────── */
  function startDatabaseSync(db, user){
    const boardRef = ref(db, "wardBoardState/v3");
    window.firebaseSync = {
      save: function(stateData){
        if(!auth.currentUser) return;
        const clean = JSON.parse(JSON.stringify(stateData));
        set(boardRef, clean).then(function(){
          if(statusEl){ statusEl.textContent = "⚡ Live"; statusEl.style.color = "#a2f2c8"; }
          if(window.setCloudDot) window.setCloudDot("live");
          if(window.hideSaveFailBanner) window.hideSaveFailBanner();
        }).catch(function(err){
          if(statusEl){ statusEl.textContent = "❌ Save error"; statusEl.style.color = "#ffb3b3"; }
          if(window.setCloudDot) window.setCloudDot("error");
          if(window.showSaveFailBanner) window.showSaveFailBanner();
        });
      }
    };

    onValue(boardRef, function(snapshot){
      if(statusEl){ statusEl.textContent = "⚡ Live"; statusEl.style.color = "#a2f2c8"; }
      if(window.setCloudDot) window.setCloudDot("live");
      if(window.setOfflineBanner) window.setOfflineBanner(false);
      if(window.hideSaveFailBanner) window.hideSaveFailBanner();
      if(window.handleRemoteState) window.handleRemoteState(snapshot.val());
    }, function(err){
      if(statusEl){ statusEl.textContent = "❌ Sync error"; statusEl.style.color = "#ffb3b3"; }
      if(window.setCloudDot) window.setCloudDot("error");
      if(window.setOfflineBanner) window.setOfflineBanner(true);
    });

    document.addEventListener("visibilitychange", function(){
      if(document.visibilityState === "visible") goOnline(db);
    });

    // Start FCM if available
    if(FCM_VAPID_KEY) initFCM(user);
  }

  /* ── Auth actions exposed to app.js ─────────────────────── */
  window.firebaseAuth = {
    signIn: function(email, password){
      return signInWithEmailAndPassword(auth, email, password);
    },
    signInWithGoogle: function(){
      return signInWithPopup(auth, provider);
    },
    register: function(email, password, displayName){
      return createUserWithEmailAndPassword(auth, email, password)
        .then(function(cred){
          return updateProfile(cred.user, { displayName: displayName })
            .then(function(){ return cred; });
        });
    },
    signOut: function(){
      if(window._approvalPoll) clearInterval(window._approvalPoll);
      return signOut(auth);
    },
    currentUser: function(){ return auth.currentUser; },
    updateDisplayName: function(name){
      if(!auth.currentUser) return Promise.reject("Not signed in");
      return updateProfile(auth.currentUser, { displayName: name });
    },
    resetPassword: function(email){
      return sendPasswordResetEmail(auth, email);
    },
    getUID: function(){ return auth.currentUser ? auth.currentUser.uid : null; },

    /* Lead: load all staff records */
    loadAllStaff: function(){
      return get(ref(db, "staff")).then(function(snap){ return snap.val() || {}; });
    },
    /* Lead: approve a staff member */
    approveStaff: function(uid){
      return set(ref(db, "staff/" + uid + "/status"), "approved")
        .then(function(){
          return set(ref(db, "staff/" + uid + "/approvedAt"), new Date().toISOString());
        })
        .then(function(){
          return set(ref(db, "staff/" + uid + "/approvedBy"),
            auth.currentUser ? (auth.currentUser.displayName || auth.currentUser.email) : "Lead");
        });
    },
    /* Lead: reject a pending request */
    rejectStaff: function(uid){
      return set(ref(db, "staff/" + uid + "/status"), "rejected");
    },
    /* Lead: deactivate an existing staff member */
    deactivateStaff: function(uid, name){
      return set(ref(db, "staff/" + uid + "/status"), "inactive")
        .then(function(){
          return set(ref(db, "staff/" + uid + "/deactivatedAt"), new Date().toISOString());
        })
        .then(function(){
          return set(ref(db, "staff/" + uid + "/deactivatedBy"),
            auth.currentUser ? (auth.currentUser.displayName || auth.currentUser.email) : "Lead");
        });
    },
    /* Lead: watch for pending approvals in real time */
    watchPendingStaff: function(cb){
      onValue(ref(db, "staff"), function(snap){
        var all = snap.val() || {};
        var pending = Object.values(all).filter(function(s){ return s.status === "pending"; });
        cb(pending.length);
      });
    }
  };

  /* ── FCM Push ────────────────────────────────────────────── */
  function initFCM(user){
    try {
      const messaging = getMessaging(app);
      window.requestFCMToken = function(){
        return navigator.serviceWorker.ready.then(function(reg){
          return getToken(messaging, { vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: reg });
        }).then(function(token){
          if(token && user){
            set(ref(db, "fcmTokens/" + user.uid), {
              token: token, updatedAt: new Date().toISOString(),
              name: user.displayName || "?"
            });
          }
          return token;
        });
      };
      onMessage(messaging, function(payload){
        if(payload.notification && window.showToast){
          window.showToast((payload.notification.title||"Ward Board")+" — "+(payload.notification.body||""));
        }
      });
    } catch(e){ console.warn("[FCM]", e.message); }
  }

} catch(e) {
  console.error("Firebase init error:", e);
  if(statusEl){ statusEl.textContent = "❌ Init error"; statusEl.style.color = "#ffb3b3"; }
}
