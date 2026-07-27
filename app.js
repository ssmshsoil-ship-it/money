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
  var currentTab = 'home';
  var currentViewMonth = monthKeyOf(new Date());
  var isOnline = true;
  var unsubscribeSnapshot = null;
  var editingId = null;

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
      monthlySavings: {}
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
    setDoc(HOUSEHOLD_DOC, state).catch(function (err) {
      console.error('저장 실패(오프라인일 수 있음):', err);
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

  function planMonthList() {
    var months = [];
    var mk = state.planStart;
    for (var i = 0; i < state.planMonths; i++) {
      months.push(mk);
      mk = shiftMonth(mk, 1);
    }
    return months;
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
    else if (currentTab === 'settings') renderSettings();
  }

  function syncBadge() {
    return '<div style="text-align:right;font-size:11px;color:var(--text-muted);margin-bottom:4px;">' +
      (isOnline ? '● 동기화됨' : '○ 오프라인 - 연결되면 자동 저장') + '</div>';
  }

  function renderHome() {
    var data = monthlyReportData(currentViewMonth);

    var html = '';
    html += syncBadge();
    html += '<h1>가계부</h1>';
    html += '<div class="month-nav">';
    html += '<button data-action="prev-month">‹</button>';
    html += '<span class="month-label">' + monthLabel(currentViewMonth) + '</span>';
    html += '<button data-action="next-month">›</button>';
    html += '</div>';

    html += '<div class="card">';
    html += '<p class="metric-label">이번달 합계소비액</p>';
    html += '<p class="metric-value">' + formatWon(data.totalSpent) + ' <span class="metric-sub">/ 상한 ' + formatWon(data.totalCap) + '</span></p>';
    html += '</div>';

    html += '<h2>카테고리별 상한</h2>';
    state.categories.forEach(function (cat, i) {
      var spent = getCategoryTotal(currentViewMonth, cat.id);
      var pct = Math.min(100, Math.round((spent / cat.cap) * 100));
      var over = spent > cat.cap;
      var color = categoryColor(i);
      html += '<div class="cat-row">';
      html += '<div class="cat-row-top"><span>' + escapeHtml(cat.name) + '</span><span class="amt' + (over ? ' over' : '') + '">' + formatWon(spent) + ' / ' + formatWon(cat.cap) + '</span></div>';
      html += '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>';
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

    var html = '';
    html += syncBadge();
    html += '<h1>' + (editingExpense ? '지출 수정' : '지출 추가') + '</h1>';
    html += '<div class="card">';
    html += '<label>날짜</label>';
    html += '<input type="date" id="f-date" value="' + (editingExpense ? editingExpense.date : todayStr()) + '">';
    html += '<label>카테고리</label>';
    html += '<div class="chip-group" id="f-cats">';
    state.categories.forEach(function (cat, i) {
      var isSelected = editingExpense ? cat.id === editingExpense.categoryId : i === 0;
      html += '<div class="chip' + (isSelected ? ' selected' : '') + '" data-cat="' + cat.id + '">' + escapeHtml(cat.name) + '</div>';
    });
    html += '</div>';
    html += '<label>금액</label>';
    html += '<input type="number" id="f-amount" placeholder="0" inputmode="numeric" value="' + (editingExpense ? editingExpense.amount : '') + '">';
    html += '<label>메모 (선택)</label>';
    html += '<input type="text" id="f-memo" placeholder="예: 더팜마트" value="' + (editingExpense ? escapeHtml(editingExpense.memo || '') : '') + '">';
    html += '<div style="margin-top:1rem;">';
    if (editingExpense) {
      html += '<div class="tx-edit-actions">';
      html += '<button class="btn editing" data-action="save-expense">수정저장</button>';
      html += '<button class="btn secondary" data-action="cancel-edit">취소</button>';
      html += '<button class="btn danger" data-action="delete-expense" data-id="' + editingExpense.id + '">삭제</button>';
      html += '</div>';
    } else {
      html += '<button class="btn" data-action="save-expense">저장</button>';
    }
    html += '</div>';
    html += '</div>';

    html += '<h2>최근 내역</h2>';
    var recent = state.expenses.slice().sort(function (a, b) { return b.date.localeCompare(a.date) || b.id.localeCompare(a.id); }).slice(0, 30);
    if (recent.length === 0) {
      html += '<div class="empty-state">아직 입력한 지출이 없습니다.</div>';
    } else {
      html += '<div class="card" style="padding:0.4rem 1.1rem;">';
      recent.forEach(function (e) {
        var cat = state.categories.find(function (c) { return c.id === e.categoryId; });
        html += '<div class="tx-row' + (e.id === editingId ? ' editing' : '') + '">';
        html += '<div class="tx-main">';
        html += '<span class="tx-cat">' + (cat ? escapeHtml(cat.name) : '기타') + '</span>';
        if (e.memo) html += '<span class="tx-memo">' + escapeHtml(e.memo) + '</span>';
        html += '<span class="tx-date">' + e.date + '</span>';
        html += '</div>';
        html += '<span class="tx-amt">' + formatWon(e.amount) + '</span>';
        html += '<button class="tx-edit" data-action="edit-expense" data-id="' + e.id + '">수정</button>';
        html += '<button class="tx-del" data-action="delete-expense" data-id="' + e.id + '">×</button>';
        html += '</div>';
      });
      html += '</div>';
    }

    app.innerHTML = html;
  }

  function renderPlan() {
    var months = planMonthList();
    var cumTarget = 0, cumActual = 0;
    months.forEach(function (mk) {
      cumTarget += state.savingsGoal;
      cumActual += (state.monthlySavings[mk] || 0);
    });

    var html = '';
    html += syncBadge();
    html += '<h1>12개월 저축 플랜</h1>';

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

  function renderSettings() {
    var html = '';
    html += syncBadge();
    html += '<h1>설정</h1>';

    html += '<div class="card">';
    html += '<label>월 저축 목표액</label>';
    html += '<input type="number" id="s-goal" value="' + state.savingsGoal + '" inputmode="numeric">';
    html += '</div>';

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

    html += '<h2>데이터 백업 (로컬 파일)</h2>';
    html += '<div class="card">';
    html += '<p class="metric-sub">데이터는 이제 두 분 모두에게 실시간으로 공유됩니다(Firebase). 이 백업은 만약을 위한 추가 안전장치입니다.</p>';
    html += '<div class="export-row">';
    html += '<button class="btn secondary" data-action="export-data">내보내기</button>';
    html += '<button class="btn secondary" data-action="import-data">가져오기</button>';
    html += '</div>';
    html += '<input type="file" id="import-file" accept="application/json" style="display:none;">';
    html += '<div style="margin-top:8px;"><button class="btn danger small" data-action="reset-data">전체 초기화(둘 다 삭제됨)</button></div>';
    html += '</div>';

    app.innerHTML = html;
  }

  // ---------- Event handling ----------

  document.getElementById('tabbar').addEventListener('click', function (e) {
    var btn = e.target.closest('.tab-btn');
    if (!btn) return;
    currentTab = btn.dataset.tab;
    render();
  });

  app.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) {
      document.querySelectorAll('#f-cats .chip').forEach(function (c) { c.classList.remove('selected'); });
      chip.classList.add('selected');
      return;
    }

    var actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    var action = actionEl.dataset.action;

    if (action === 'prev-month') { currentViewMonth = shiftMonth(currentViewMonth, -1); render(); }
    else if (action === 'next-month') { currentViewMonth = shiftMonth(currentViewMonth, 1); render(); }
    else if (action === 'save-expense') { saveExpense(); }
    else if (action === 'edit-expense') { editingId = actionEl.dataset.id; render(); }
    else if (action === 'cancel-edit') { editingId = null; render(); }
    else if (action === 'delete-expense') {
      if (!confirm('삭제할까요?')) return;
      if (actionEl.dataset.id === editingId) editingId = null;
      state.expenses = state.expenses.filter(function (ex) { return ex.id !== actionEl.dataset.id; });
      pushState();
      showToast('삭제되었습니다');
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
  });

  app.addEventListener('change', function (e) {
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
    if (editingId) {
      var existing = state.expenses.find(function (e) { return e.id === editingId; });
      if (existing) {
        existing.date = date;
        existing.categoryId = categoryId;
        existing.amount = amount;
        existing.memo = memo;
      }
      editingId = null;
      pushState();
      showToast('수정되었습니다');
    } else {
      state.expenses.push({ id: uid(), date: date, categoryId: categoryId, amount: amount, memo: memo });
      pushState();
      showToast('저장되었습니다');
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

  var TAB_ORDER = ['home', 'add', 'plan', 'settings'];
  var touchStartX = 0, touchStartY = 0;

  document.body.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.body.addEventListener('touchend', function (e) {
    if (!e.changedTouches || e.changedTouches.length !== 1) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    var dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    var idx = TAB_ORDER.indexOf(currentTab);
    if (dx < 0 && idx < TAB_ORDER.length - 1) { currentTab = TAB_ORDER[idx + 1]; render(); }
    else if (dx > 0 && idx > 0) { currentTab = TAB_ORDER[idx - 1]; render(); }
  }, { passive: true });

  render(); // paint immediately from local cache while Firebase connects
})();
