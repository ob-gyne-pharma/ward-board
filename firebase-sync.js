
/* Ward Board — firebase-sync.js — v2.0
   Firebase Auth (email/password) + Realtime Database + FCM push
*/

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, onValue, goOnline }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut, updateProfile,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getMessaging, getToken, onMessage }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey:            "AIzaSyC7RoEpdCWOYfxnKyTykmhVV9xgnbeH3bE",
  authDomain:        "wardboard-e7035.firebaseapp.com",
  databaseURL:       "https://wardboard-e7035-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "wardboard-e7035",
  storageBucket:     "wardboard-e7035.firebasestorage.app",
  messagingSenderId: "480376138159",
  appId:             "1:480376138159:web:b0b6fe7c43168b49bee75a"
};

/* ── VAPID key for FCM web push ──────────────────────────────
   Generate in Firebase Console → Project Settings → Cloud Messaging
   → Web Push certificates → Generate key pair → copy the key below */
const FCM_VAPID_KEY = ""; // ← paste your VAPID key here after generating it

const statusEl = document.getElementById("cloudStatus");

try {
  const app  = initializeApp(firebaseConfig);
  const db   = getDatabase(app, firebaseConfig.databaseURL);
  const auth = getAuth(app);

  /* ── Auth state observer ─────────────────────────────────── */
  onAuthStateChanged(auth, function(user) {
    if(user){
      // Logged in — start syncing
      if(window.onAuthReady) window.onAuthReady(user);
      startDatabaseSync(db);
    } else {
      // Not logged in — show login modal
      if(window.showLoginModal) window.showLoginModal();
      if(statusEl){ statusEl.textContent = "🔒 Not signed in"; }
      if(window.setCloudDot) window.setCloudDot("error");
    }
  });

  /* ── Auth actions exposed to app.js ─────────────────────── */
  window.firebaseAuth = {
    signIn: function(email, password){
      return signInWithEmailAndPassword(auth, email, password);
    },
    register: function(email, password, displayName){
      return createUserWithEmailAndPassword(auth, email, password)
        .then(function(cred){
          return updateProfile(cred.user, { displayName: displayName })
            .then(function(){ return cred; });
        });
    },
    signOut: function(){
      return signOut(auth);
    },
    currentUser: function(){
      return auth.currentUser;
    },
    updateDisplayName: function(name){
      if(!auth.currentUser) return Promise.reject("Not signed in");
      return updateProfile(auth.currentUser, { displayName: name });
    },
    resetPassword: function(email){
      return sendPasswordResetEmail(auth, email);
    },
    getUID: function(){
      return auth.currentUser ? auth.currentUser.uid : null;
    }
  };

  /* ── Database sync (only after auth) ────────────────────── */
  function startDatabaseSync(db){
    const boardRef = ref(db, "wardBoardState/v3");

    window.firebaseSync = {
      save: function(stateData){
        if(!auth.currentUser){ console.warn("Not authenticated — save skipped"); return; }
        if(statusEl){ statusEl.textContent = "📤 Saving…"; }
        const clean = JSON.parse(JSON.stringify(stateData));
        set(boardRef, clean).then(function(){
          if(statusEl){ statusEl.textContent = "⚡ Live"; statusEl.style.color = "#a2f2c8"; }
          if(window.setCloudDot) window.setCloudDot("live");
          if(window.hideSaveFailBanner) window.hideSaveFailBanner();
        }).catch(function(err){
          console.error("Save error:", err);
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
      console.error("DB read error:", err);
      if(statusEl){ statusEl.textContent = "❌ Sync error"; statusEl.style.color = "#ffb3b3"; }
      if(window.setCloudDot) window.setCloudDot("error");
      if(window.setOfflineBanner) window.setOfflineBanner(true);
    });

    document.addEventListener("visibilitychange", function(){
      if(document.visibilityState === "visible") goOnline(db);
    });
  }

  /* ── FCM Push Notifications ──────────────────────────────── */
  if("serviceWorker" in navigator && FCM_VAPID_KEY){
    try {
      const messaging = getMessaging(app);

      /* Request FCM token when notifications are granted */
      window.requestFCMToken = function(){
        return navigator.serviceWorker.ready.then(function(reg){
          return getToken(messaging, {
            vapidKey: FCM_VAPID_KEY,
            serviceWorkerRegistration: reg
          });
        }).then(function(token){
          if(token){
            console.log("[FCM] Token:", token.slice(0,20)+"…");
            /* Store token in Firebase under the user's UID
               so the server can send targeted pushes */
            if(auth.currentUser){
              const tokenRef = ref(db,
                "fcmTokens/" + auth.currentUser.uid + "/token");
              set(tokenRef, {
                token:     token,
                updatedAt: new Date().toISOString(),
                name:      auth.currentUser.displayName || "?"
              });
            }
          }
          return token;
        });
      };

      /* Handle foreground FCM messages (app is open) */
      onMessage(messaging, function(payload){
        console.log("[FCM] Foreground message:", payload);
        if(payload.notification){
          if(window.showToast) window.showToast(
            (payload.notification.title || "Ward Board") +
            " — " + (payload.notification.body || "")
          );
        }
      });

    } catch(fcmErr){
      console.warn("[FCM] Not available:", fcmErr.message);
    }
  }

} catch(e) {
  console.error("Firebase init error:", e);
  if(statusEl){ statusEl.textContent = "❌ Init error"; statusEl.style.color = "#ffb3b3"; }
}

  const firebaseConfig = {
    apiKey: "AIzaSyC7RoEpdCWOYfxnKyTykmhVV9xgnbeH3bE",
    authDomain: "wardboard-e7035.firebaseapp.com",
    databaseURL: "https://wardboard-e7035-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "wardboard-e7035",
    storageBucket: "wardboard-e7035.firebasestorage.app",
    messagingSenderId: "480376138159",
    appId: "1:480376138159:web:b0b6fe7c43168b49bee75a"
  };

  const statusEl = document.getElementById("cloudStatus");

  try {
    const app = initializeApp(firebaseConfig);
    const db = getDatabase(app, firebaseConfig.databaseURL);
    const boardRef = ref(db, 'wardBoardState/v3');

    window.firebaseSync = {
      save: function(stateData) {
        if(statusEl) {
          statusEl.textContent = "📤 Saving...";
          statusEl.style.color = "#fbeae9";
        }
        const cleanPayload = JSON.parse(JSON.stringify(stateData));
        set(boardRef, cleanPayload).then(function(){
          if(statusEl){ statusEl.textContent = "⚡ Live Sync Active"; statusEl.style.color = "#a2f2c8"; }
          if(window.setCloudDot) window.setCloudDot("live");
          if(window.hideSaveFailBanner) window.hideSaveFailBanner();
        }).catch(function(err){
          console.error("Firebase save error:", err);
          if(statusEl){ statusEl.textContent = "❌ Save Error"; statusEl.style.color = "#ffb3b3"; }
          if(window.setCloudDot) window.setCloudDot("error");
          if(window.showSaveFailBanner) window.showSaveFailBanner();
        });
      }
    };

    // Start listening immediately when module loads
    onValue(boardRef, function(snapshot){
      if(statusEl){ statusEl.textContent = "⚡ Live Sync Active"; statusEl.style.color = "#a2f2c8"; }
      if(window.setCloudDot) window.setCloudDot("live");
      if(window.setOfflineBanner) window.setOfflineBanner(false);
      if(window.hideSaveFailBanner) window.hideSaveFailBanner();
      if(window.handleRemoteState){ window.handleRemoteState(snapshot.val()); }
    }, function(err){
      console.error("Firebase read error:", err);
      if(statusEl){ statusEl.textContent = "❌ Sync Error"; statusEl.style.color = "#ffb3b3"; }
      if(window.setCloudDot) window.setCloudDot("error");
      if(window.setOfflineBanner) window.setOfflineBanner(true);
    });

    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "visible") {
        goOnline(db);
      }
    });

  } catch(e) {
    console.error("Firebase init error:", e);
    if(statusEl) {
      statusEl.textContent = "❌ Init Error";
      statusEl.style.color = "#ffb3b3";
    }
  }
