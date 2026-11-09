/* Ward Board — firebase-sync.js — v1.1 */

  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
  import { getDatabase, ref, set, onValue, goOnline, goOffline } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

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
