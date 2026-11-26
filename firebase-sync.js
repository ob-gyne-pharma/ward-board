/* Ward Board — firebase-sync.js — v2.1
   Firebase Auth (email/password + Google) + Approval system + FCM
*/
import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, set, get, onValue, goOnline }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updateProfile, sendPasswordResetEmail,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getMessaging, getToken, onMessage }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const FCM_VAPID_KEY = ""; // ← paste VAPID key here after generating in Firebase console

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
    if(window._hideLoading) window._hideLoading();
    if(user){
      checkApprovalStatus(user);
    } else {
      if(window.showLoginModal) window.showLoginModal();
      if(statusEl) statusEl.textContent = "🔒 Not signed in";
      if(window.setCloudDot) window.setCloudDot("error");
    }
  });

  /* ── Approval check ──────────────────────────────────────── */
  function checkApprovalStatus(user){
    const staffRef = ref(db, "staff/" + user.uid);
    get(staffRef).then(function(snap){
      const data = snap.val();
      if(data && data.status === "approved"){
        if(window.onAuthReady) window.onAuthReady(user, data);
        startDatabaseSync(db, user);
      } else if(data && data.status === "rejected"){
        signOut(auth);
        if(window.showLoginModal) window.showLoginModal();
        if(window.showAuthError) window.showAuthError("Your access request was not approved. Contact the Ward Lead.");
      } else if(data && data.status === "inactive"){
        signOut(auth);
        if(window.showLoginModal) window.showLoginModal();
        if(window.showAuthError) window.showAuthError("Your account has been deactivated. Contact the Ward Lead.");
      } else {
        if(!data){
          set(staffRef, {
            uid: user.uid, name: user.displayName || user.email.split("@")[0],
            email: user.email, status: "pending",
            requestedAt: new Date().toISOString(),
            provider: user.providerData[0] ? user.providerData[0].providerId : "email"
          });
        }
        if(window.showPendingScreen) window.showPendingScreen(user);
        if(statusEl) statusEl.textContent = "⏳ Awaiting approval";
        var poll = setInterval(function(){
          get(staffRef).then(function(s){
            var d = s.val();
            if(d && d.status === "approved"){
              clearInterval(poll);
              if(window.onAuthReady) window.onAuthReady(user, d);
              startDatabaseSync(db, user);
            } else if(d && (d.status === "rejected" || d.status === "inactive")){
              clearInterval(poll);
              signOut(auth);
              if(window.showLoginModal) window.showLoginModal();
              if(window.showAuthError) window.showAuthError("Your access request was not approved.");
            }
          });
        }, 8000);
        window._approvalPoll = poll;
      }
    }).catch(function(err){
      console.error("Approval check error:", err);
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
    if(FCM_VAPID_KEY) initFCM(user);
  }

  /* ── Auth actions ────────────────────────────────────────── */
  window.firebaseAuth = {
    signIn:            function(e,p){ return signInWithEmailAndPassword(auth,e,p); },
    signInWithGoogle:  function(){ return signInWithPopup(auth, provider); },
    register:          function(e,p,n){ return createUserWithEmailAndPassword(auth,e,p).then(function(c){ return updateProfile(c.user,{displayName:n}).then(function(){ return c; }); }); },
    signOut:           function(){ if(window._approvalPoll) clearInterval(window._approvalPoll); return signOut(auth); },
    currentUser:       function(){ return auth.currentUser; },
    updateDisplayName: function(n){ return auth.currentUser ? updateProfile(auth.currentUser,{displayName:n}) : Promise.reject("Not signed in"); },
    resetPassword:     function(e){ return sendPasswordResetEmail(auth,e); },
    getUID:            function(){ return auth.currentUser ? auth.currentUser.uid : null; },
    loadAllStaff:      function(){ return get(ref(db,"staff")).then(function(s){ return s.val()||{}; }); },
    approveStaff:      function(uid){ return set(ref(db,"staff/"+uid+"/status"),"approved").then(function(){ return set(ref(db,"staff/"+uid+"/approvedAt"),new Date().toISOString()); }).then(function(){ return set(ref(db,"staff/"+uid+"/approvedBy"), auth.currentUser?(auth.currentUser.displayName||auth.currentUser.email):"Lead"); }); },
    rejectStaff:       function(uid){ return set(ref(db,"staff/"+uid+"/status"),"rejected"); },
    deactivateStaff:   function(uid){ return set(ref(db,"staff/"+uid+"/status"),"inactive").then(function(){ return set(ref(db,"staff/"+uid+"/deactivatedAt"),new Date().toISOString()); }).then(function(){ return set(ref(db,"staff/"+uid+"/deactivatedBy"), auth.currentUser?(auth.currentUser.displayName||auth.currentUser.email):"Lead"); }); },
    watchPendingStaff: function(cb){ onValue(ref(db,"staff"),function(snap){ var all=snap.val()||{}; cb(Object.values(all).filter(function(s){ return s.status==="pending"; }).length); }); }
  };

  /* ── FCM ─────────────────────────────────────────────────── */
  function initFCM(user){
    try {
      const messaging = getMessaging(app);
      window.requestFCMToken = function(){
        return navigator.serviceWorker.ready.then(function(reg){
          return getToken(messaging,{vapidKey:FCM_VAPID_KEY,serviceWorkerRegistration:reg});
        }).then(function(token){
          if(token && user) set(ref(db,"fcmTokens/"+user.uid),{token:token,updatedAt:new Date().toISOString(),name:user.displayName||"?"});
          return token;
        });
      };
      onMessage(messaging,function(payload){
        if(payload.notification && window.showToast) window.showToast((payload.notification.title||"Ward Board")+" — "+(payload.notification.body||""));
      });
    } catch(e){ console.warn("[FCM]",e.message); }
  }

} catch(e) {
  console.error("Firebase init error:", e);
  if(window._hideLoading) window._hideLoading();
  if(window.showLoginModal) window.showLoginModal();
  if(statusEl){ statusEl.textContent = "❌ Init error"; statusEl.style.color = "#ffb3b3"; }
}
