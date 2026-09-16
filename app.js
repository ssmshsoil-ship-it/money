import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, doc, setDoc, onSnapshot, enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

(function () {
  'use strict';

  // ---------- Firebase setup ----------
  var firebaseConfig = {
    apiKey: "AIzaSyBxWEMC4vl6AsRsj2dgqnH_1-Pcvuky1dQ",
    authDomain: "money-55e41.firebaseapp.com",
    projectId: "money-55e41",
    storageBucket: "money-55e41.firebasestorage.app",
    messagingSenderId: "872412983238",
    appId: "1:872412983238:web:cdec86334a76378f570cc7"
  };

  var fbApp = initializeApp(firebaseConfig);
  var db = getFirestore(fbApp);
  var auth = getAuth(fbApp);

  // Everyone who opens this app writes to this one shared document.
  // Fine for "just the two of us" use - see README for how to change the doc name.
  var HOUSEHOLD_DOC = doc(db, 'households', 'main');

  try {
    enableIndexedDbPersistence(db).catch(function () { /* multiple tabs open - ignore */ });
  } catch (e) { /* older browser - ignore, app still works online */ }

  var STORAGE_KEY = 'budgetTrackerData_v1'; // local cache only, source of truth is Firestore
  var app = document.getElementById('app');
  var currentViewMonth = monthKeyOf(new Date());
  var isOnline = true;
  var unsubscribeSnapshot = null;
  var searchQuery = '';
  var homeView = 'expense'; // 'expense' | 'income'
  var addView = 'expense'; // 'expense' | 'income'

  // ---------- Unified navigation stack ----------
  // navStack[0] is always the root (home tab, nothing open). Every deeper
  // screen (a different tab, a modal, an edit form, an expanded category)
  // is one more entry. The physical/PWA back button pops exactly one entry
  // at a time; popping past the root lets the browser handle the exit.
  var navStack = [{ tab: 'home', modal: null, editingId: null, editingIncomeId: null, editingScheduleId: null, expandedCategoryId: null }];

  function currentNav() { return navStack[navStack.length - 1]; }
  function currentTabGet() { return currentNav().tab; }
  function currentModalView() { return currentNav().modal; }

  function pushNav(partial) {
    var next = Object.assign({}, currentNav(), partial);
    navStack.push(next);
    try { history.pushState({ depth: navStack.length }, ''); } catch (e) { /* ignore */ }
    applyNav(next);
  }
  function goBack() {
    try { history.back(); } catch (e) { if (navStack.length > 1) { navStack.pop(); applyNav(currentNav()); } }
  }
  function replaceNav(partial) {
    var next = Object.assign({}, currentNav(), partial);
    navStack[navStack.length - 1] = next;
    try { history.replaceState({ depth: navStack.length }, ''); } catch (e) { /* ignore */ }
    applyNav(next);
  }
  function applyNav(nav) {
    currentTab = nav.tab;
    editingId = nav.editingId;
    editingIncomeId = nav.editingIncomeId;
    editingScheduleId = nav.editingScheduleId;
    expandedCategoryId = nav.expandedCategoryId;
    render();
  }

  window.addEventListener('popstate', function () {
    if (navStack.length > 1) {
      navStack.pop();
      applyNav(currentNav());
    }
    // already at the root (home, nothing open): let the browser/OS handle the exit
  });

  var currentTab = 'home';
  var editingId = null;
  var editingIncomeId = null;
  var expandedCategoryId = null;
  var editingScheduleId = null;

  function defaultState() {
    return {
      savingsGoal: 500000,
      planStart: '2026-08',
      planMonths: 12,
      categories: [
        { id: 'mart', name: '마트/편의점', cap: 300000 },
        { id: 'dining', name: '배달/외식', cap: 390000 },
        { id: 'online', name: '온라인쇼핑', cap: 110000 },
        { id: 'cafe', name: '카페/커피', cap: 60000 },
        { id: 'subscription', name: '구독/디지털서비스', cap: 30000 },
        { id: 'transport', name: '교통/주유', cap: 65000 },
        { id: 'beauty', name: '미용/생활서비스', cap: 37000 },
        { id: 'shopping', name: '쇼핑(의류/잡화)', cap: 27000 },
        { id: 'leisure', name: '레저/여가', cap: 8000 }
      ],
      expenses: [],
      income: [],
      monthlySavings: {},
      schedules: [],
      trash: [],
      assets: { debt: 0, stock: 0 },
      debtItems: []
    };
  }

  var state = loadLocalCache();

  function loadLocalCache() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      return Object.assign({}, defaultState(), JSON.parse(raw));
    } catch (e) {
      return defaultState();
    }
  }

  function cacheLocally() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage full - ignore */ }
  }

  // Writes the current in-memory state up to Firestore. All connected
  // devices (onSnapshot below) will receive the update within ~1 second,
  // including this same device (which is how we re-render after edits).
  function pushState() {
    cacheLocally();
    render();
    setDoc(HOUSEHOLD_DOC, state).catch(function (err) {
      console.error('저장 실패:', err);
      showToast('저장 실패 - 인터넷 연결을 확인해주세요');
    });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- Auth + realtime subscription ----------

  signInAnonymously(auth).catch(function (err) {
    console.error('로그인 실패:', err);
    renderConnectionError();
  });

  onAuthStateChanged(auth, function (user) {
    if (user) subscribeToHousehold();
  });

  function subscribeToHousehold() {
    if (unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = onSnapshot(HOUSEHOLD_DOC, function (snap) {
      isOnline = !snap.metadata.fromCache;
      if (snap.exists()) {
        state = Object.assign({}, defaultState(), snap.data());
        cacheLocally();
        purgeOldTrash();
      } else {
        // first time ever - seed the shared doc with defaults
        state = defaultState();
        setDoc(HOUSEHOLD_DOC, state);
      }
      render();
    }, function (err) {
      console.error('동기화 오류:', err);
      isOnline = false;
      render();
    });
  }

  function purgeOldTrash() {
    var now = new Date();
    var before = state.trash.length;
    state.trash = state.trash.filter(function (t) {
      var deleted = new Date(t.deletedAt);
      var days = Math.floor((now - deleted) / 86400000);
      return days < 10;
    });
    if (state.trash.length !== before) pushState();
  }

  function renderConnectionError() {
    app.innerHTML = '<div class="empty-state">Firebase 연결에 문제가 있습니다.<br>인터넷 연결을 확인하거나 잠시 후 새로고침 해주세요.</div>';
  }

  // ---------- Helpers ----------

  function monthKeyOf(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    return y + '-' + m;
  }

  function monthLabel(mk) {
    var parts = mk.split('-');
    return parts[0] + '년 ' + parseInt(parts[1], 10) + '월';
  }

  function shiftMonth(mk, delta) {
    var parts = mk.split('-').map(Number);
    var d = new Date(parts[0], parts[1] - 1 + delta, 1);
    return monthKeyOf(d);
  }

  function formatWon(n) {
    n = Math.round(n || 0);
    return n.toLocaleString('ko-KR') + '원';
  }

  function getExpensesForMonth(mk) {
    return state.expenses.filter(function (e) { return e.date.slice(0, 7) === mk; });
  }

  function getCategoryTotal(mk, catId) {
    return getExpensesForMonth(mk)
      .filter(function (e) { return e.categoryId === catId; })
      .reduce(function (sum, e) { return sum + e.amount; }, 0);
  }

  function getIncomeForMonth(mk) {
    return state.income.filter(function (e) { return e.date.slice(0, 7) === mk; });
  }
  function totalIncomeForMonth(mk) {
    return getIncomeForMonth(mk).reduce(function (sum, e) { return sum + e.amount; }, 0);
  }

  function planMonthList() {
    var months = [];
    var mk = state.planStart;
    for (var i = 0; i < state.planMonths; i++) {
      months.push(mk);
      mk = shiftMonth(mk, 1);
    }
    return months;
  }

  function scrollAppToTop() {
    function doScroll() {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      if (app) app.scrollTop = 0;
    }
    doScroll();
    setTimeout(doScroll, 0);
    requestAnimationFrame(doScroll);
  }

  function todayStr() {
    var d = new Date();
    return monthKeyOf(d) + '-' + String(d.getDate()).padStart(2, '0');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var RAINBOW_COLORS = ['#e11d48', '#f97316', '#eab308', '#16a34a', '#0d9488', '#2563eb', '#4338ca', '#9333ea', '#db2777'];
  function categoryColor(index) {
    return RAINBOW_COLORS[index % RAINBOW_COLORS.length];
  }
  function hexToRgba(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  var toastTimer1 = null, toastTimer2 = null;
  function showToast(msg) {
    clearTimeout(toastTimer1); clearTimeout(toastTimer2);
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.remove('show');
    void el.offsetWidth; // force reflow so the transition restarts
    toastTimer1 = setTimeout(function () { el.classList.add('show'); }, 10);
    toastTimer2 = setTimeout(function () { el.classList.remove('show'); }, 1000);
  }

  // ---------- Rendering ----------

  function render() {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === currentTab);
    });
    if (currentTab === 'home') renderHome();
    else if (currentTab === 'add') renderAdd();
    else if (currentTab === 'plan') renderPlan();
    renderModal();
  }

  function upcomingSchedules() {
    var today = todayStr();
    return state.schedules
      .filter(function (s) { return s.date >= today; })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });
  }

  function topBar(title) {
    var badgeCount = upcomingSchedules().length;
    var badge = badgeCount > 0 ? '<span class="bell-badge">' + (badgeCount > 9 ? '9+' : badgeCount) + '</span>' : '';
    return '<div class="topbar">' +
      '<button class="topbar-icon-btn" data-action="refresh-app" aria-label="새로고침 (' + (isOnline ? '동기화됨' : '오프라인') + ')">' +
      '<span class="sync-dot' + (isOnline ? '' : ' offline') + '"></span>' +
      '</button>' +
      '<h1 class="topbar-title">' + escapeHtml(title) + '</h1>' +
      '<div class="topbar-actions">' +
      '<button class="topbar-icon-btn" data-action="open-search" aria-label="검색">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
      '</button>' +
      '<button class="topbar-icon-btn bell-btn" data-action="open-notifications" aria-label="알림">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>' +
      badge +
      '</button>' +
      '</div>' +
      '</div>';
  }

  function renderModal() {
    var root = document.getElementById('modalRoot');
    var view = currentModalView();
    if (!view) { root.innerHTML = ''; return; }
    var inner = '';
    if (view === 'search') inner = renderSearchModal();
    else if (view === 'notifications') inner = renderNotificationsModal();
    else if (view === 'menu') inner = renderMenuModal();
    else if (view === 'scheduler') inner = renderSchedulerModal();
    else if (view === 'trash') inner = renderTrashModal();
    else if (view === 'settings') inner = renderSettingsModal();
    root.innerHTML = '<div class="modal-overlay">' + inner + '</div>';
    if (view === 'search') {
      var input = document.getElementById('search-input');
      if (input) {
        input.focus();
        var len = input.value.length;
        input.setSelectionRange(len, len);
      }
    }
  }

  function renderSearchModal() {
    var q = searchQuery.trim().toLowerCase();
    var results = [];
    if (q) {
      results = state.expenses.filter(function (e) {
        var cat = state.categories.find(function (c) { return c.id === e.categoryId; });
        var hay = ((cat ? cat.name : '') + ' ' + (e.memo || '') + ' ' + e.date).toLowerCase();
        return hay.indexOf(q) > -1;
      }).sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 50);
    }
    var html = '<div class="modal-sheet">';
    html += '<div class="modal-header"><h2 class="modal-title">검색</h2><button class="modal-close" data-action="close-modal">✕</button></div>';
    html += '<input type="text" id="search-input" placeholder="카테고리, 메모로 검색" value="' + escapeHtml(searchQuery) + '">';
    html += '<div class="modal-body">';
    if (!q) {
      html += '<div class="empty-state">검색어를 입력해보세요.</div>';
    } else if (results.length === 0) {
      html += '<div class="empty-state">일치하는 내역이 없습니다.</div>';
    } else {
      results.forEach(function (e) {
        var idx = state.categories.findIndex(function (c) { return c.id === e.categoryId; });
        var cat = idx > -1 ? state.categories[idx] : null;
        var dotColor = idx > -1 ? categoryColor(idx) : '#9ca3af';
        html += '<div class="tx-row" style="grid-template-columns:1fr auto;">';
        html += '<div class="tx-main"><span class="tx-cat"><span class="tx-dot" style="background:' + dotColor + ';"></span>' + (cat ? escapeHtml(cat.name) : '기타') + '</span>';
        if (e.memo) html += '<span class="tx-memo">' + escapeHtml(e.memo) + '</span>';
        html += '<span class="tx-date">' + e.date + '</span></div>';
        html += '<span class="tx-amt">' + formatWon(e.amount) + '</span>';
        html += '</div>';
      });
    }
    html += '</div></div>';
    return html;
  }

  function renderNotificationsModal() {
    var items = upcomingSchedules();
    var html = '<div class="modal-sheet">';
    html += '<div class="modal-header"><h2 class="modal-title">알림</h2><button class="modal-close" data-action="close-modal">✕</button></div>';
    html += '<div class="modal-body">';
    if (items.length === 0) {
      html += '<div class="empty-state">예정된 일정이 없습니다.</div>';
    } else {
      items.forEach(function (s) {
        html += '<div class="notif-row">';
        html += '<span class="notif-date">' + s.date.slice(5).replace('-', '/') + '</span>';
        html += '<div class="notif-main"><span class="notif-title">' + escapeHtml(s.title) + '</span>';
        if (s.memo) html += '<span class="notif-memo">' + escapeHtml(s.memo) + '</span>';
        html += '</div></div>';
      });
    }
    html += '</div>';
    html += '<button class="btn secondary" style="margin-top:12px;" data-action="open-scheduler">일정 관리하기</button>';
    html += '</div>';
    return html;
  }

  function renderMenuModal() {
    var trashCount = state.trash.length;
    var html = '<div class="modal-sheet menu-sheet">';
    html += '<div class="modal-header"><h2 class="modal-title">메뉴</h2><button class="modal-close" data-action="close-modal">✕</button></div>';
    html += '<div class="menu-list">';
    html += '<button class="menu-item" data-action="open-scheduler">';
    html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
    html += '<span>스케줄러</span></button>';
    html += '<button class="menu-item" data-action="open-trash">';
    html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13"/></svg>';
    html += '<span>휴지통' + (trashCount > 0 ? ' (' + trashCount + ')' : '') + '</span></button>';
    html += '<button class="menu-item" data-action="open-settings">';
    html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1h.1a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>';
    html += '<span>설정</span></button>';
    html += '</div></div>';
    return html;
  }

  function renderSchedulerModal() {
    var editing = editingScheduleId ? state.schedules.find(function (s) { return s.id === editingScheduleId; }) : null;
    var html = '<div class="modal-sheet">';
    html += '<div class="modal-header"><h2 class="modal-title">스케줄러</h2><button class="modal-close" data-action="close-modal">✕</button></div>';
    html += '<div class="modal-body">';
    html += '<label>날짜</label><input type="date" id="sch-date" value="' + (editing ? editing.date : todayStr()) + '">';
    html += '<label>제목</label><input type="text" id="sch-title" placeholder="예: 카드값 결제일" value="' + (editing ? escapeHtml(editing.title) : '') + '">';
    html += '<label>메모 (선택)</label><input type="text" id="sch-memo" value="' + (editing ? escapeHtml(editing.memo || '') : '') + '">';
    html += '<div style="margin-top:12px;display:flex;gap:8px;">';
    html += '<button class="btn' + (editing ? ' editing' : '') + '" data-action="save-schedule">' + (editing ? '수정저장' : '등록') + '</button>';
    if (editing) html += '<button class="btn secondary" data-action="cancel-schedule-edit">취소</button>';
    if (editing) html += '<button class="btn danger" data-action="delete-schedule" data-id="' + editing.id + '">삭제</button>';
    html += '</div>';
    html += '<h2 style="margin-top:1.2rem;">등록된 일정</h2>';
    var sorted = state.schedules.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    if (sorted.length === 0) {
      html += '<div class="empty-state">등록된 일정이 없습니다.</div>';
    } else {
      sorted.forEach(function (s) {
        html += '<div class="tx-row" style="grid-template-columns:1fr auto;">';
        html += '<div class="tx-main"><span class="tx-cat">' + escapeHtml(s.title) + '</span>';
        if (s.memo) html += '<span class="tx-memo">' + escapeHtml(s.memo) + '</span>';
        html += '<span class="tx-date">' + s.date + '</span></div>';
        html += '<button class="tx-edit" data-action="edit-schedule" data-id="' + s.id + '">수정</button>';
        html += '</div>';
      });
    }
    html += '</div></div>';
    return html;
  }

  function renderTrashModal() {
    var sorted = state.trash.slice().sort(function (a, b) { return b.deletedAt.localeCompare(a.deletedAt); });
    var html = '<div class="modal-sheet">';
    html += '<div class="modal-header"><h2 class="modal-title">휴지통</h2><button class="modal-close" data-action="close-modal">✕</button></div>';
    html += '<p class="metric-sub" style="margin:-4px 0 10px;">삭제 후 10일이 지나면 자동으로 완전히 삭제됩니다.</p>';
    if (sorted.length > 0) {
      html += '<button class="btn danger small" data-action="empty-trash" style="margin-bottom:10px;">휴지통 비우기</button>';
    }
    html += '<div class="modal-body">';
    if (sorted.length === 0) {
      html += '<div class="empty-state">휴지통이 비어 있습니다.</div>';
    } else {
      var now = new Date();
      sorted.forEach(function (t) {
        var idx = state.categories.findIndex(function (c) { return c.id === t.categoryId; });
        var cat = idx > -1 ? state.categories[idx] : null;
        var daysLeft = 10 - Math.floor((now - new Date(t.deletedAt)) / 86400000);
        html += '<div class="trash-row">';
        html += '<div class="tx-main"><span class="tx-cat">' + (cat ? escapeHtml(cat.name) : '기타') + '</span>';
        if (t.memo) html += '<span class="tx-memo">' + escapeHtml(t.memo) + '</span>';
        html += '<span class="tx-date">' + t.date + ' · ' + formatWon(t.amount) + '</span>';
        html += '<span class="trash-days">' + Math.max(daysLeft, 0) + '일 후 자동삭제</span>';
        html += '</div>';
        html += '<div class="trash-actions">';
        html += '<button class="btn secondary small" data-action="restore-expense" data-id="' + t.id + '">복원</button>';
        html += '<button class="tx-del" data-action="delete-trash-item" data-id="' + t.id + '">×</button>';
        html += '</div></div>';
      });
    }
    html += '</div></div>';
    return html;
  }

  function buildPieChart(data) {
    var total = data.totalSpent;
    if (total <= 0) return '<div class="empty-state">이번달 지출 내역이 없습니다.</div>';
    var gradientParts = [];
    var cursor = 0;
    var legendHtml = '';
    state.categories.forEach(function (cat, i) {
      var spent = getCategoryTotal(currentViewMonth, cat.id);
      if (spent <= 0) return;
      var pct = spent / total * 100;
      var color = categoryColor(i);
      var start = cursor;
      var end = cursor + pct;
      gradientParts.push(color + ' ' + start.toFixed(2) + '% ' + end.toFixed(2) + '%');
      cursor = end;
      legendHtml += '<div class="pie-legend-row"><span class="pie-dot" style="background:' + color + ';"></span>' +
        '<span class="pie-legend-name">' + escapeHtml(cat.name) + '</span>' +
        '<span class="pie-legend-pct">' + pct.toFixed(1) + '%</span>' +
        '<span class="pie-legend-amt">' + formatWon(spent) + '</span></div>';
    });
    var gradient = 'conic-gradient(' + gradientParts.join(',') + ')';
    return '<div class="pie-wrap"><div class="pie-chart" style="background:' + gradient + ';"></div></div>' +
      '<div class="pie-legend">' + legendHtml + '</div>';
  }

  function renderHome() {
    var data = monthlyReportData(currentViewMonth);

    var html = '';
    html += topBar('가계부');
    html += '<div class="month-nav">';
    html += '<button data-action="prev-month">‹</button>';
    html += '<span class="month-label">' + monthLabel(currentViewMonth) + '</span>';
    html += '<button data-action="next-month">›</button>';
    html += '</div>';

    html += '<div class="view-toggle">';
    html += '<button class="view-toggle-btn' + (homeView === 'expense' ? ' active' : '') + '" data-action="set-home-view" data-view="expense">지출</button>';
    html += '<button class="view-toggle-btn' + (homeView === 'income' ? ' active' : '') + '" data-action="set-home-view" data-view="income">수입</button>';
    html += '</div>';

    if (homeView === 'income') {
      var incomeTotal = totalIncomeForMonth(currentViewMonth);
      html += '<div class="card">';
      html += '<p class="metric-label">이번달 합계수입</p>';
      html += '<p class="metric-value">' + formatWon(incomeTotal) + '</p>';
      html += '</div>';

      html += '<h2>수입 내역</h2>';
      var incomeItems = getIncomeForMonth(currentViewMonth).slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
      if (incomeItems.length === 0) {
        html += '<div class="empty-state">이번달 수입 내역이 없습니다.</div>';
      } else {
        html += '<div class="card" style="padding:0.4rem 1.1rem;">';
        incomeItems.forEach(function (e) {
          html += '<div class="tx-row" style="grid-template-columns:1fr auto auto;">';
          html += '<div class="tx-main"><span class="tx-cat">' + escapeHtml(e.source || '수입') + '</span>';
          if (e.memo) html += '<span class="tx-memo">' + escapeHtml(e.memo) + '</span>';
          html += '<span class="tx-date">' + e.date + '</span></div>';
          html += '<span class="tx-amt" style="color:#15803d;">+' + formatWon(e.amount) + '</span>';
          html += '<button class="tx-edit" data-action="edit-income" data-id="' + e.id + '">수정</button>';
          html += '</div>';
        });
        html += '</div>';
      }
      app.innerHTML = html;
      return;
    }

    html += '<div class="card">';
    html += '<p class="metric-label">이번달 합계소비액</p>';
    html += '<p class="metric-value">' + formatWon(data.totalSpent) + ' <span class="metric-sub">/ 상한 ' + formatWon(data.totalCap) + '</span></p>';
    html += '</div>';

    html += '<h2>카테고리별 비중</h2>';
    html += '<div class="card">' + buildPieChart(data) + '</div>';

    html += '<h2>카테고리별 상한</h2>';
    state.categories.forEach(function (cat, i) {
      var spent = getCategoryTotal(currentViewMonth, cat.id);
      var pct = Math.min(100, Math.round((spent / cat.cap) * 100));
      var over = spent > cat.cap;
      var color = categoryColor(i);
      var isOpen = expandedCategoryId === cat.id;
      html += '<div class="cat-row' + (isOpen ? ' open' : '') + '" data-action="toggle-category" data-id="' + cat.id + '">';
      var overAmt = over ? ' <span class="cat-over-badge">(+' + formatWon(spent - cat.cap) + ')</span>' : '';
      html += '<div class="cat-row-top"><span><span class="cat-chevron">' + (isOpen ? '▾' : '▸') + '</span>' + escapeHtml(cat.name) + overAmt + '</span><span class="amt"><span class="amt-spent' + (over ? ' over' : '') + '">' + formatWon(spent) + '</span> <span class="amt-sep">/</span> <span class="amt-cap">' + formatWon(cat.cap) + '</span></span></div>';
      html += '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>';
      if (isOpen) {
        var items = getExpensesForMonth(currentViewMonth)
          .filter(function (e) { return e.categoryId === cat.id; })
          .sort(function (a, b) { return b.date.localeCompare(a.date); });
        html += '<div class="cat-detail">';
        if (items.length === 0) {
          html += '<div class="cat-detail-empty">이 달에는 내역이 없습니다.</div>';
        } else {
          items.forEach(function (e) {
            html += '<div class="cat-detail-row">';
            html += '<span class="cat-detail-date">' + e.date.slice(5).replace('-', '/') + '</span>';
            html += '<span class="cat-detail-memo">' + (e.memo ? escapeHtml(e.memo) : '') + '</span>';
            html += '<span class="cat-detail-amt">' + formatWon(e.amount) + '</span>';
            html += '</div>';
          });
        }
        html += '</div>';
      }
      html += '</div>';
    });

    html += '<h2>월별 리포트 내보내기</h2>';
    html += '<div class="card">';
    html += '<p class="metric-sub">' + monthLabel(currentViewMonth) + ' 소비내역을 A4 한 장짜리 표로 내보냅니다.</p>';
    html += '<div class="export-row">';
    html += '<button class="btn secondary" data-action="export-monthly-excel">엑셀로 내보내기</button>';
    html += '<button class="btn secondary" data-action="export-monthly-pdf">PDF로 내보내기</button>';
    html += '</div>';
    html += '</div>';

    app.innerHTML = html;
  }

  function renderAdd() {
    var editingExpense = editingId ? state.expenses.find(function (e) { return e.id === editingId; }) : null;
    var editingIncome = editingIncomeId ? state.income.find(function (e) { return e.id === editingIncomeId; }) : null;
    var mode = editingExpense ? 'expense' : (editingIncome ? 'income' : addView);

    var html = '';
    var title = editingExpense ? '지출 수정' : (editingIncome ? '수입 수정' : (mode === 'income' ? '수입 추가' : '지출 추가'));
    html += topBar(title);

    if (!editingExpense && !editingIncome) {
      html += '<div class="view-toggle">';
      html += '<button class="view-toggle-btn' + (addView === 'expense' ? ' active' : '') + '" data-action="set-add-view" data-view="expense">지출</button>';
      html += '<button class="view-toggle-btn' + (addView === 'income' ? ' active' : '') + '" data-action="set-add-view" data-view="income">수입</button>';
      html += '</div>';
    }

    html += '<div class="card">';
    html += '<label>날짜</label>';
    html += '<input type="date" id="f-date" value="' + (editingExpense ? editingExpense.date : (editingIncome ? editingIncome.date : todayStr())) + '">';

    if (mode === 'expense') {
      html += '<label>카테고리</label>';
      html += '<div class="chip-group" id="f-cats">';
      var selectedIdx = 0;
      state.categories.forEach(function (cat, i) {
        var isSelected = editingExpense ? cat.id === editingExpense.categoryId : i === 0;
        if (isSelected) selectedIdx = i;
        var color = categoryColor(i);
        var style = isSelected
          ? 'background:' + color + ';border-color:' + color + ';color:#fff;'
          : 'background:' + hexToRgba(color, 0.14) + ';border-color:' + hexToRgba(color, 0.35) + ';color:var(--text);';
        html += '<div class="chip' + (isSelected ? ' selected' : '') + '" data-cat="' + cat.id + '" data-idx="' + i + '" style="' + style + '">' + escapeHtml(cat.name) + '</div>';
      });
      html += '</div>';
      html += '<p class="cat-pct-hint" id="cat-pct-hint">' + categoryPctHint(state.categories[selectedIdx]) + '</p>';
    } else {
      html += '<label>수입원</label>';
      html += '<input type="text" id="f-source" placeholder="예: 급여, 용돈" value="' + (editingIncome ? escapeHtml(editingIncome.source || '') : '') + '">';
    }

    html += '<label>금액</label>';
    html += '<input type="number" id="f-amount" placeholder="0" inputmode="numeric" value="' + (editingExpense ? editingExpense.amount : (editingIncome ? editingIncome.amount : '')) + '">';
    html += '<label>메모 (선택)</label>';
    html += '<input type="text" id="f-memo" placeholder="예: 더팜마트" value="' + (editingExpense ? escapeHtml(editingExpense.memo || '') : (editingIncome ? escapeHtml(editingIncome.memo || '') : '')) + '">';

    html += '<div style="margin-top:1rem;">';
    if (editingExpense) {
      html += '<div class="tx-edit-actions">';
      html += '<button class="btn editing" data-action="save-expense">수정저장</button>';
      html += '<button class="btn secondary" data-action="cancel-edit">취소</button>';
      html += '<button class="btn danger" data-action="delete-expense" data-id="' + editingExpense.id + '">삭제</button>';
      html += '</div>';
    } else if (editingIncome) {
      html += '<div class="tx-edit-actions">';
      html += '<button class="btn editing" data-action="save-income">수정저장</button>';
      html += '<button class="btn secondary" data-action="cancel-income-edit">취소</button>';
      html += '<button class="btn danger" data-action="delete-income" data-id="' + editingIncome.id + '">삭제</button>';
      html += '</div>';
    } else if (mode === 'income') {
      html += '<button class="btn" data-action="save-income">저장</button>';
    } else {
      html += '<button class="btn" data-action="save-expense">저장</button>';
    }
    html += '</div>';
    html += '</div>';

    if (mode === 'expense') {
      html += '<h2>최근 내역</h2>';
      var recent = state.expenses.slice().sort(function (a, b) { return b.date.localeCompare(a.date) || b.id.localeCompare(a.id); }).slice(0, 30);
      if (recent.length === 0) {
        html += '<div class="empty-state">아직 입력한 지출이 없습니다.</div>';
      } else {
        html += '<div class="card" style="padding:0.4rem 1.1rem;">';
        recent.forEach(function (e) {
          var catIndex = state.categories.findIndex(function (c) { return c.id === e.categoryId; });
          var cat = catIndex > -1 ? state.categories[catIndex] : null;
          var dotColor = catIndex > -1 ? categoryColor(catIndex) : '#9ca3af';
          html += '<div class="tx-row' + (e.id === editingId ? ' editing' : '') + '">';
          html += '<div class="tx-main">';
          html += '<span class="tx-cat"><span class="tx-dot" style="background:' + dotColor + ';"></span>' + (cat ? escapeHtml(cat.name) : '기타') + '</span>';
          if (e.memo) html += '<span class="tx-memo">' + escapeHtml(e.memo) + '</span>';
          html += '<span class="tx-date">' + e.date + '</span>';
          html += '</div>';
          html += '<span class="tx-amt">' + formatWon(e.amount) + '</span>';
          html += '<button class="tx-edit" data-action="edit-expense" data-id="' + e.id + '">수정</button>';
          html += '</div>';
        });
        html += '</div>';
      }
    } else {
      html += '<h2>최근 수입 내역</h2>';
      var recentIncome = state.income.slice().sort(function (a, b) { return b.date.localeCompare(a.date) || b.id.localeCompare(a.id); }).slice(0, 30);
      if (recentIncome.length === 0) {
        html += '<div class="empty-state">아직 입력한 수입이 없습니다.</div>';
      } else {
        html += '<div class="card" style="padding:0.4rem 1.1rem;">';
        recentIncome.forEach(function (e) {
          html += '<div class="tx-row' + (e.id === editingIncomeId ? ' editing' : '') + '">';
          html += '<div class="tx-main"><span class="tx-cat">' + escapeHtml(e.source || '수입') + '</span>';
          if (e.memo) html += '<span class="tx-memo">' + escapeHtml(e.memo) + '</span>';
          html += '<span class="tx-date">' + e.date + '</span></div>';
          html += '<span class="tx-amt" style="color:#15803d;">+' + formatWon(e.amount) + '</span>';
          html += '<button class="tx-edit" data-action="edit-income" data-id="' + e.id + '">수정</button>';
          html += '</div>';
        });
        html += '</div>';
      }
    }

    app.innerHTML = html;
  }

  function categoryPctHint(cat) {
    if (!cat) return '';
    var spent = getCategoryTotal(currentViewMonth, cat.id);
    var pct = Math.round((spent / cat.cap) * 100);
    return '이번달 "' + escapeHtml(cat.name) + '" ' + pct + '% 사용 중 (' + formatWon(spent) + ' / ' + formatWon(cat.cap) + ')';
  }

  function renderPlan() {
    var months = planMonthList();
    var cumTarget = 0, cumActual = 0;
    months.forEach(function (mk) {
      cumTarget += state.savingsGoal;
      cumActual += (state.monthlySavings[mk] || 0);
    });
    var netWorth = cumActual + state.assets.stock - state.assets.debt;

    var html = '';
    html += topBar('12개월 저축 플랜');

    html += '<h2>자산현황</h2>';
    html += '<div class="card">';
    html += '<p class="metric-label">순자산 (저축 + 주식 − 빚)</p>';
    html += '<p class="metric-value' + (netWorth < 0 ? ' negative' : '') + '">' + formatWon(netWorth) + '</p>';
    html += '</div>';
    html += '<div class="card">';
    html += '<div class="asset-row"><span class="asset-label"><span class="asset-dot savings"></span>저축</span><span class="asset-value">' + formatWon(cumActual) + '</span></div>';
    html += '<div class="asset-row"><span class="asset-label"><span class="asset-dot stock"></span>주식</span><input type="number" id="asset-stock" class="asset-input" value="' + state.assets.stock + '" inputmode="numeric"></div>';
    html += '<div class="asset-row"><span class="asset-label"><span class="asset-dot debt"></span>빚</span><input type="number" id="asset-debt" class="asset-input" value="' + state.assets.debt + '" inputmode="numeric"></div>';
    html += '<button class="btn secondary small" data-action="save-assets" style="margin-top:10px;">자산 저장</button>';
    html += '<p class="metric-sub" style="margin-top:8px;">주식·빚은 현재 잔액을 그때그때 직접 업데이트하는 방식입니다. 저축은 아래 저축플랜 표에서 자동 계산됩니다.</p>';
    html += '</div>';

    html += '<h2>저축누계</h2>';
    html += '<div class="card">';
    html += '<p class="metric-label">저축누계</p>';
    html += '<p class="metric-value">' + formatWon(cumActual) + ' <span class="metric-sub">/ ' + formatWon(cumTarget) + '</span></p>';
    html += '</div>';

    html += '<div class="card">';
    html += '<p class="metric-label">연간 목표</p>';
    html += '<p class="metric-value">' + formatWon(state.savingsGoal * state.planMonths) + '</p>';
    html += '</div>';

    html += '<table class="plan-table"><thead><tr><th>월</th><th>목표</th><th>실제</th><th>상태</th></tr></thead><tbody>';
    months.forEach(function (mk) {
      var actual = state.monthlySavings[mk] || 0;
      var achieved = actual >= state.savingsGoal;
      html += '<tr>';
      html += '<td>' + monthLabel(mk) + '</td>';
      html += '<td>' + formatWon(state.savingsGoal) + '</td>';
      html += '<td><input type="number" data-month="' + mk + '" class="savings-input" value="' + actual + '" inputmode="numeric"></td>';
      html += '<td><span class="status-pill ' + (achieved ? 'achieved' : 'pending') + '">' + (achieved ? '달성' : '미달') + '</span></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';

    app.innerHTML = html;
  }

  function renderSettingsModal() {
    var html = '<div class="modal-sheet">';
    html += '<div class="modal-header"><h2 class="modal-title">설정</h2><button class="modal-close" data-action="close-modal">✕</button></div>';
    html += '<div class="modal-body">';

    html += '<label>월 저축 목표액</label>';
    html += '<input type="number" id="s-goal" value="' + state.savingsGoal + '" inputmode="numeric">';

    html += '<h2>카테고리별 상한</h2>';
    html += '<div class="card" id="s-categories">';
    state.categories.forEach(function (cat) {
      html += '<div class="settings-row" data-cat-id="' + cat.id + '">';
      html += '<input type="text" class="s-cat-name" value="' + escapeHtml(cat.name) + '">';
      html += '<input type="number" class="s-cat-cap" value="' + cat.cap + '" inputmode="numeric">';
      html += '<button class="tx-del" data-action="delete-category" data-id="' + cat.id + '">×</button>';
      html += '</div>';
    });
    html += '<button class="btn secondary small" data-action="add-category" style="margin-top:6px;">+ 카테고리 추가</button>';
    html += '</div>';

    html += '<div style="margin-top:1rem;"><button class="btn" data-action="save-settings">설정 저장</button></div>';

    html += '<h2>대출 상환 고정일</h2>';
    html += '<div class="card" id="s-debtitems">';
    if (state.debtItems.length === 0) {
      html += '<p class="metric-sub" style="margin:0 0 8px;">매월 고정일에 상환되는 대출을 등록해두면 알림에서 챙기기 쉽습니다.</p>';
    }
    state.debtItems.forEach(function (d) {
      html += '<div class="settings-row" data-debt-id="' + d.id + '">';
      html += '<input type="text" class="s-debt-name" placeholder="예: 신한대출" value="' + escapeHtml(d.name) + '">';
      html += '<input type="number" class="s-debt-day" placeholder="일" min="1" max="31" value="' + d.day + '" inputmode="numeric" style="flex:0 0 60px;">';
      html += '<button class="tx-del" data-action="delete-debtitem" data-id="' + d.id + '">×</button>';
      html += '</div>';
    });
    html += '<button class="btn secondary small" data-action="add-debtitem" style="margin-top:6px;">+ 대출 항목 추가</button>';
    html += '</div>';
    html += '<div style="margin-top:0.8rem;"><button class="btn" data-action="save-debtitems">대출 상환일 저장</button></div>';

    html += '<h2>데이터 백업 (로컬 파일)</h2>';
    html += '<div class="card">';
    html += '<p class="metric-sub">데이터는 두 분 모두에게 실시간으로 공유됩니다(Firebase). 이 백업은 만약을 위한 추가 안전장치입니다.</p>';
    html += '<div class="export-row">';
    html += '<button class="btn secondary" data-action="export-data">내보내기</button>';
    html += '<button class="btn secondary" data-action="import-data">가져오기</button>';
    html += '</div>';
    html += '<input type="file" id="import-file" accept="application/json" style="display:none;">';
    html += '<div style="margin-top:8px;"><button class="btn danger small" data-action="reset-data">전체 초기화(둘 다 삭제됨)</button></div>';
    html += '</div>';

    html += '</div></div>';
    return html;
  }

  // ---------- Event handling ----------

  document.getElementById('tabbar').addEventListener('click', function (e) {
    var btn = e.target.closest('.tab-btn');
    if (!btn || !btn.dataset.tab) return;
    if (btn.dataset.tab === currentTab) return;
    pushNav({ tab: btn.dataset.tab, modal: null, editingId: null, editingIncomeId: null, editingScheduleId: null, expandedCategoryId: null });
  });

  document.body.addEventListener('click', function (e) {
    if (e.target.id === 'modalRoot' || e.target.classList.contains('modal-overlay')) {
      goBack();
      return;
    }

    var chip = e.target.closest('.chip');
    if (chip) {
      var chips = document.querySelectorAll('#f-cats .chip');
      chips.forEach(function (c, idx) {
        var color = categoryColor(idx);
        c.classList.remove('selected');
        c.style.background = hexToRgba(color, 0.14);
        c.style.borderColor = hexToRgba(color, 0.35);
        c.style.color = 'var(--text)';
      });
      var clickedIdx = Array.prototype.indexOf.call(chips, chip);
      var clickedColor = categoryColor(clickedIdx);
      chip.classList.add('selected');
      chip.style.background = clickedColor;
      chip.style.borderColor = clickedColor;
      chip.style.color = '#fff';
      var hintEl = document.getElementById('cat-pct-hint');
      if (hintEl) hintEl.innerHTML = categoryPctHint(state.categories[clickedIdx]);
      return;
    }

    var actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    var action = actionEl.dataset.action;

    if (action === 'prev-month') { currentViewMonth = shiftMonth(currentViewMonth, -1); render(); }
    else if (action === 'next-month') { currentViewMonth = shiftMonth(currentViewMonth, 1); render(); }
    else if (action === 'set-home-view') { homeView = actionEl.dataset.view; render(); }
    else if (action === 'set-add-view') { addView = actionEl.dataset.view; render(); }
    else if (action === 'save-assets') {
      var stockVal = parseInt(document.getElementById('asset-stock').value, 10);
      var debtVal = parseInt(document.getElementById('asset-debt').value, 10);
      state.assets.stock = isNaN(stockVal) ? 0 : stockVal;
      state.assets.debt = isNaN(debtVal) ? 0 : debtVal;
      pushState();
      showToast('자산이 저장되었습니다');
    }
    else if (action === 'save-income') { saveIncome(); }
    else if (action === 'edit-income') {
      pushNav({ editingIncomeId: actionEl.dataset.id });
      scrollAppToTop();
    }
    else if (action === 'cancel-income-edit') { goBack(); }
    else if (action === 'delete-income') {
      if (!confirm('이 수입 내역을 삭제할까요?')) return;
      var wasEditingIncome = actionEl.dataset.id === editingIncomeId;
      state.income = state.income.filter(function (e) { return e.id !== actionEl.dataset.id; });
      pushState();
      showToast('삭제되었습니다');
      if (wasEditingIncome) goBack();
    }
    else if (action === 'refresh-app') { window.location.reload(); }
    else if (action === 'toggle-category') {
      var catId = actionEl.dataset.id;
      if (expandedCategoryId === catId) goBack();
      else if (expandedCategoryId) replaceNav({ expandedCategoryId: catId });
      else pushNav({ expandedCategoryId: catId });
    }
    else if (action === 'save-expense') { saveExpense(); }
    else if (action === 'edit-expense') {
      pushNav({ editingId: actionEl.dataset.id });
      scrollAppToTop();
    }
    else if (action === 'cancel-edit') { goBack(); }
    else if (action === 'delete-expense') {
      if (!confirm('삭제할까요? (10일간 휴지통에 보관됩니다)')) return;
      var idToDelete = actionEl.dataset.id;
      var wasEditing = idToDelete === editingId;
      var idx = state.expenses.findIndex(function (ex) { return ex.id === idToDelete; });
      if (idx > -1) {
        var removed = state.expenses.splice(idx, 1)[0];
        removed.deletedAt = new Date().toISOString();
        state.trash.push(removed);
      }
      pushState();
      showToast('휴지통으로 이동했습니다');
      if (wasEditing) goBack();
    }
    else if (action === 'add-category') {
      state.categories.push({ id: uid(), name: '새 카테고리', cap: 50000 });
      pushState();
    }
    else if (action === 'delete-category') {
      if (confirm('이 카테고리를 삭제할까요? 관련 지출 내역은 남아있지만 홈 화면에는 더 이상 표시되지 않습니다.')) {
        state.categories = state.categories.filter(function (c) { return c.id !== actionEl.dataset.id; });
        pushState();
      }
    }
    else if (action === 'save-settings') { saveSettings(); }
    else if (action === 'export-data') { exportData(); }
    else if (action === 'import-data') { document.getElementById('import-file').click(); }
    else if (action === 'export-monthly-excel') { exportMonthlyExcel(currentViewMonth); }
    else if (action === 'export-monthly-pdf') { exportMonthlyPDF(currentViewMonth); }
    else if (action === 'reset-data') {
      if (confirm('모든 데이터를 삭제하고 초기 상태로 되돌립니다. 계속할까요? (두 분 모두에게 적용됩니다)')) {
        state = defaultState();
        pushState();
      }
    }
    else if (action === 'open-search') { searchQuery = ''; pushNav({ modal: 'search' }); }
    else if (action === 'open-notifications') { pushNav({ modal: 'notifications' }); }
    else if (action === 'open-menu') { pushNav({ modal: 'menu' }); }
    else if (action === 'open-scheduler') { pushNav({ modal: 'scheduler', editingScheduleId: null }); }
    else if (action === 'open-trash') { pushNav({ modal: 'trash' }); }
    else if (action === 'open-settings') { pushNav({ modal: 'settings' }); }
    else if (action === 'add-debtitem') {
      state.debtItems.push({ id: uid(), name: '', day: 25 });
      pushState();
    }
    else if (action === 'delete-debtitem') {
      state.debtItems = state.debtItems.filter(function (d) { return d.id !== actionEl.dataset.id; });
      pushState();
    }
    else if (action === 'save-debtitems') {
      document.querySelectorAll('#s-debtitems .settings-row').forEach(function (row) {
        var id = row.dataset.debtId;
        var item = state.debtItems.find(function (d) { return d.id === id; });
        if (!item) return;
        item.name = row.querySelector('.s-debt-name').value.trim() || item.name;
        var day = parseInt(row.querySelector('.s-debt-day').value, 10);
        item.day = (day >= 1 && day <= 31) ? day : item.day;
      });
      pushState();
      showToast('저장되었습니다');
    }
    else if (action === 'close-modal') { goBack(); }
    else if (action === 'edit-schedule') { pushNav({ editingScheduleId: actionEl.dataset.id }); }
    else if (action === 'cancel-schedule-edit') { goBack(); }
    else if (action === 'save-schedule') { saveSchedule(); }
    else if (action === 'delete-schedule') {
      if (!confirm('이 일정을 삭제할까요?')) return;
      var wasEditingSchedule = actionEl.dataset.id === editingScheduleId;
      state.schedules = state.schedules.filter(function (s) { return s.id !== actionEl.dataset.id; });
      pushState();
      if (wasEditingSchedule) goBack();
    }
    else if (action === 'restore-expense') {
      var tid = actionEl.dataset.id;
      var tidx = state.trash.findIndex(function (t) { return t.id === tid; });
      if (tidx > -1) {
        var restored = state.trash.splice(tidx, 1)[0];
        delete restored.deletedAt;
        state.expenses.push(restored);
        pushState();
        showToast('복원되었습니다');
      }
    }
    else if (action === 'delete-trash-item') {
      if (!confirm('휴지통에서 완전히 삭제할까요? 복구할 수 없습니다.')) return;
      state.trash = state.trash.filter(function (t) { return t.id !== actionEl.dataset.id; });
      pushState();
    }
    else if (action === 'empty-trash') {
      if (state.trash.length === 0) return;
      if (!confirm('휴지통을 비우면 복구할 수 없습니다. 계속할까요?')) return;
      state.trash = [];
      pushState();
      showToast('휴지통을 비웠습니다');
    }
  });

  document.body.addEventListener('change', function (e) {
    if (e.target.id === 'import-file') {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var imported = JSON.parse(reader.result);
          state = Object.assign({}, defaultState(), imported);
          pushState();
          alert('가져오기가 완료되었습니다.');
        } catch (err) {
          alert('파일을 읽을 수 없습니다. 올바른 백업 파일인지 확인해주세요.');
        }
      };
      reader.readAsText(file);
    }
    if (e.target.classList.contains('savings-input')) {
      var mk = e.target.dataset.month;
      var val = parseInt(e.target.value, 10) || 0;
      state.monthlySavings[mk] = val;
      pushState();
    }
  });

  document.body.addEventListener('input', function (e) {
    if (e.target.id === 'search-input') {
      searchQuery = e.target.value;
      renderModal();
    }
  });

  function saveExpense() {
    var date = document.getElementById('f-date').value || todayStr();
    var selectedChip = document.querySelector('#f-cats .chip.selected');
    var categoryId = selectedChip ? selectedChip.dataset.cat : state.categories[0].id;
    var amount = parseInt(document.getElementById('f-amount').value, 10);
    var memo = document.getElementById('f-memo').value.trim();
    if (!amount || amount <= 0) {
      alert('금액을 입력해주세요.');
      return;
    }
    var cat = state.categories.find(function (c) { return c.id === categoryId; });
    if (editingId) {
      var summary = '다음 내용으로 수정할까요?\n\n' +
        '카테고리: ' + (cat ? cat.name : '기타') + '\n' +
        '금액: ' + formatWon(amount) + '\n' +
        '날짜: ' + date +
        (memo ? '\n메모: ' + memo : '');
      if (!confirm(summary)) return;
      var existing = state.expenses.find(function (e) { return e.id === editingId; });
      if (existing) {
        existing.date = date;
        existing.categoryId = categoryId;
        existing.amount = amount;
        existing.memo = memo;
      }
      pushState();
      showToast('수정되었습니다');
      goBack();
    } else {
      var newSummary = '다음 내용으로 등록할까요?\n\n' +
        '카테고리: ' + (cat ? cat.name : '기타') + '\n' +
        '금액: ' + formatWon(amount) + '\n' +
        '날짜: ' + date +
        (memo ? '\n메모: ' + memo : '');
      if (!confirm(newSummary)) return;
      state.expenses.push({ id: uid(), date: date, categoryId: categoryId, amount: amount, memo: memo });
      pushState();
      showToast('저장되었습니다');
    }
  }

  function saveIncome() {
    var date = document.getElementById('f-date').value || todayStr();
    var source = document.getElementById('f-source').value.trim();
    var amount = parseInt(document.getElementById('f-amount').value, 10);
    var memo = document.getElementById('f-memo').value.trim();
    if (!amount || amount <= 0) {
      alert('금액을 입력해주세요.');
      return;
    }
    if (editingIncomeId) {
      var summary = '다음 내용으로 수정할까요?\n\n' +
        '수입원: ' + (source || '수입') + '\n' +
        '금액: ' + formatWon(amount) + '\n' +
        '날짜: ' + date +
        (memo ? '\n메모: ' + memo : '');
      if (!confirm(summary)) return;
      var existing = state.income.find(function (e) { return e.id === editingIncomeId; });
      if (existing) {
        existing.date = date;
        existing.source = source;
        existing.amount = amount;
        existing.memo = memo;
      }
      pushState();
      showToast('수정되었습니다');
      goBack();
    } else {
      var newSummary = '다음 내용으로 등록할까요?\n\n' +
        '수입원: ' + (source || '수입') + '\n' +
        '금액: ' + formatWon(amount) + '\n' +
        '날짜: ' + date +
        (memo ? '\n메모: ' + memo : '');
      if (!confirm(newSummary)) return;
      state.income.push({ id: uid(), date: date, source: source, amount: amount, memo: memo });
      pushState();
      showToast('저장되었습니다');
    }
  }

  function saveSchedule() {
    var date = document.getElementById('sch-date').value || todayStr();
    var title = document.getElementById('sch-title').value.trim();
    var memo = document.getElementById('sch-memo').value.trim();
    if (!title) {
      alert('제목을 입력해주세요.');
      return;
    }
    if (editingScheduleId) {
      var existing = state.schedules.find(function (s) { return s.id === editingScheduleId; });
      if (existing) {
        existing.date = date;
        existing.title = title;
        existing.memo = memo;
      }
      pushState();
      showToast('일정이 수정되었습니다');
      goBack();
    } else {
      state.schedules.push({ id: uid(), date: date, title: title, memo: memo });
      pushState();
      showToast('일정이 등록되었습니다');
    }
  }

  function saveSettings() {
    state.savingsGoal = parseInt(document.getElementById('s-goal').value, 10) || state.savingsGoal;
    document.querySelectorAll('#s-categories .settings-row').forEach(function (row) {
      var id = row.dataset.catId;
      var cat = state.categories.find(function (c) { return c.id === id; });
      if (!cat) return;
      cat.name = row.querySelector('.s-cat-name').value.trim() || cat.name;
      cat.cap = parseInt(row.querySelector('.s-cat-cap').value, 10) || 0;
    });
    pushState();
    alert('저장되었습니다.');
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportData() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    triggerDownload(blob, 'budget-backup-' + todayStr() + '.json');
  }

  // ---------- Monthly report (Excel / PDF) ----------

  function monthlyReportData(mk) {
    var rows = state.categories.map(function (cat) {
      var spent = getCategoryTotal(mk, cat.id);
      return { name: cat.name, spent: spent, cap: cat.cap, over: spent > cat.cap };
    });
    var totalSpent = rows.reduce(function (s, r) { return s + r.spent; }, 0);
    var totalCap = rows.reduce(function (s, r) { return s + r.cap; }, 0);
    return { rows: rows, totalSpent: totalSpent, totalCap: totalCap };
  }

  function exportMonthlyExcel(mk) {
    if (!window.ExcelJS) { alert('엑셀 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.'); return; }
    var data = monthlyReportData(mk);
    var goal = state.savingsGoal;
    var actualSavings = state.monthlySavings[mk] || 0;

    var wb = new window.ExcelJS.Workbook();
    var ws = wb.addWorksheet('소비내역', {
      pageSetup: {
        paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1,
        margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 }
      }
    });
    ws.columns = [{ width: 22 }, { width: 16 }, { width: 16 }, { width: 12 }];

    var thin = { style: 'thin', color: { argb: 'FF000000' } };
    var borderAll = { top: thin, left: thin, bottom: thin, right: thin };
    var headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6ECFF' } };
    var blackFont = { color: { argb: 'FF000000' } };

    ws.mergeCells('A1:D1');
    var titleCell = ws.getCell('A1');
    titleCell.value = monthLabel(mk) + ' 소비내역';
    titleCell.font = { bold: true, size: 16, color: { argb: 'FF000000' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;

    ws.mergeCells('A2:D2');
    var summaryCell = ws.getCell('A2');
    summaryCell.value = '저축목표 ' + formatWon(goal) + '  ·  실제저축 ' + formatWon(actualSavings) + '  ·  총지출 ' + formatWon(data.totalSpent);
    summaryCell.font = { size: 10, color: { argb: 'FF000000' } };
    summaryCell.alignment = { horizontal: 'center' };

    var headerRowIdx = 4;
    ['카테고리', '지출액', '상한액', '상태'].forEach(function (h, i) {
      var cell = ws.getCell(headerRowIdx, i + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FF000000' } };
      cell.fill = headerFill;
      cell.border = borderAll;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    var r = headerRowIdx + 1;
    data.rows.forEach(function (row) {
      ws.getCell(r, 1).value = row.name;
      ws.getCell(r, 2).value = row.spent;
      ws.getCell(r, 3).value = row.cap;
      ws.getCell(r, 4).value = row.over ? '초과' : '정상';
      for (var c = 1; c <= 4; c++) {
        var cell = ws.getCell(r, c);
        cell.border = borderAll;
        cell.font = blackFont;
        if (c === 2 || c === 3) { cell.numFmt = '#,##0"원"'; cell.alignment = { horizontal: 'right' }; }
        else cell.alignment = { horizontal: c === 1 ? 'left' : 'center' };
      }
      r++;
    });

    ws.getCell(r, 1).value = '합계';
    ws.getCell(r, 2).value = data.totalSpent;
    ws.getCell(r, 3).value = data.totalCap;
    ws.getCell(r, 4).value = '';
    for (var c2 = 1; c2 <= 4; c2++) {
      var tcell = ws.getCell(r, c2);
      tcell.border = borderAll;
      tcell.font = { bold: true, color: { argb: 'FF000000' } };
      if (c2 === 2 || c2 === 3) { tcell.numFmt = '#,##0"원"'; tcell.alignment = { horizontal: 'right' }; }
    }

    wb.xlsx.writeBuffer().then(function (buf) {
      var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      triggerDownload(blob, '소비내역-' + mk + '.xlsx');
    });
  }

  function buildReportNode(mk) {
    var data = monthlyReportData(mk);
    var goal = state.savingsGoal;
    var actualSavings = state.monthlySavings[mk] || 0;
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;width:750px;background:#ffffff;' +
      'padding:28px;font-family:"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#000000;';

    var rowsHtml = data.rows.map(function (row) {
      return '<tr>' +
        '<td style="border:1px solid #000;padding:9px 10px;text-align:left;">' + escapeHtml(row.name) + '</td>' +
        '<td style="border:1px solid #000;padding:9px 10px;text-align:right;">' + formatWon(row.spent) + '</td>' +
        '<td style="border:1px solid #000;padding:9px 10px;text-align:right;">' + formatWon(row.cap) + '</td>' +
        '<td style="border:1px solid #000;padding:9px 10px;text-align:center;">' + (row.over ? '초과' : '정상') + '</td>' +
        '</tr>';
    }).join('');

    wrapper.innerHTML =
      '<h1 style="text-align:center;font-size:26px;margin:0 0 6px;color:#000;">' + escapeHtml(monthLabel(mk)) + ' 소비내역</h1>' +
      '<p style="text-align:center;font-size:13px;color:#000;margin:0 0 22px;">저축목표 ' + formatWon(goal) +
      ' · 실제저축 ' + formatWon(actualSavings) + ' · 총지출 ' + formatWon(data.totalSpent) + '</p>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px;background:#fff;">' +
      '<thead><tr>' +
      '<th style="border:1px solid #000;background:#d6ecff;font-weight:bold;padding:9px 10px;text-align:left;">카테고리</th>' +
      '<th style="border:1px solid #000;background:#d6ecff;font-weight:bold;padding:9px 10px;text-align:right;">지출액</th>' +
      '<th style="border:1px solid #000;background:#d6ecff;font-weight:bold;padding:9px 10px;text-align:right;">상한액</th>' +
      '<th style="border:1px solid #000;background:#d6ecff;font-weight:bold;padding:9px 10px;text-align:center;">상태</th>' +
      '</tr></thead><tbody>' + rowsHtml +
      '<tr>' +
      '<td style="border:1px solid #000;padding:9px 10px;font-weight:bold;">합계</td>' +
      '<td style="border:1px solid #000;padding:9px 10px;text-align:right;font-weight:bold;">' + formatWon(data.totalSpent) + '</td>' +
      '<td style="border:1px solid #000;padding:9px 10px;text-align:right;font-weight:bold;">' + formatWon(data.totalCap) + '</td>' +
      '<td style="border:1px solid #000;padding:9px 10px;"></td>' +
      '</tr>' +
      '</tbody></table>' +
      '<p style="text-align:right;font-size:10px;color:#000;margin-top:16px;">출력일: ' + todayStr() + '</p>';

    document.body.appendChild(wrapper);
    return wrapper;
  }

  function exportMonthlyPDF(mk) {
    if (!window.html2canvas || !window.jspdf) { alert('PDF 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.'); return; }
    var node = buildReportNode(mk);
    window.html2canvas(node, { scale: 2, backgroundColor: '#ffffff' }).then(function (canvas) {
      document.body.removeChild(node);
      var imgData = canvas.toDataURL('image/png');
      var pdfDoc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      var pageWidth = 210, pageHeight = 297, margin = 12;
      var usableWidth = pageWidth - margin * 2;
      var imgHeightMm = (canvas.height * usableWidth) / canvas.width;
      if (imgHeightMm > pageHeight - margin * 2) imgHeightMm = pageHeight - margin * 2;
      pdfDoc.addImage(imgData, 'PNG', margin, margin, usableWidth, imgHeightMm);
      pdfDoc.save('소비내역-' + mk + '.pdf');
    }).catch(function (err) {
      if (node.parentNode) document.body.removeChild(node);
      alert('PDF 생성 중 오류가 발생했습니다: ' + err.message);
    });
  }

  // ---------- Swipe left/right to switch tabs ----------

  var TAB_ORDER = ['home', 'add', 'plan'];
  var touchStartX = 0, touchStartY = 0;

  document.body.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.body.addEventListener('touchend', function (e) {
    if (currentModalView()) return;
    if (!e.changedTouches || e.changedTouches.length !== 1) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    var dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    var idx = TAB_ORDER.indexOf(currentTab);
    if (dx < 0 && idx < TAB_ORDER.length - 1) {
      pushNav({ tab: TAB_ORDER[idx + 1], modal: null, editingId: null, editingIncomeId: null, editingScheduleId: null, expandedCategoryId: null });
    } else if (dx > 0 && idx > 0) {
      pushNav({ tab: TAB_ORDER[idx - 1], modal: null, editingId: null, editingIncomeId: null, editingScheduleId: null, expandedCategoryId: null });
    }
  }, { passive: true });

  render(); // paint immediately from local cache while Firebase connects
})();
