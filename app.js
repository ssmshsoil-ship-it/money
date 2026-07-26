(function () {
  'use strict';

  var STORAGE_KEY = 'budgetTrackerData_v1';
  var app = document.getElementById('app');
  var currentTab = 'home';
  var currentViewMonth = monthKeyOf(new Date());

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

  var state = loadState();

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var parsed = JSON.parse(raw);
      var def = defaultState();
      return Object.assign({}, def, parsed);
    } catch (e) {
      return defaultState();
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

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

  function renderHome() {
    var savings = state.monthlySavings[currentViewMonth] || 0;
    var goal = state.savingsGoal;
    var savingsPct = Math.min(100, Math.round((savings / goal) * 100));

    var html = '';
    html += '<h1>가계부 저축 트래커</h1>';
    html += '<div class="month-nav">';
    html += '<button data-action="prev-month">‹</button>';
    html += '<span class="month-label">' + monthLabel(currentViewMonth) + '</span>';
    html += '<button data-action="next-month">›</button>';
    html += '</div>';

    html += '<div class="card">';
    html += '<p class="metric-label">이번달 저축 목표</p>';
    html += '<p class="metric-value">' + formatWon(savings) + ' <span class="metric-sub">/ ' + formatWon(goal) + '</span></p>';
    html += '<div class="progress-track"><div class="progress-fill" style="width:' + savingsPct + '%"></div></div>';
    html += '</div>';

    html += '<h2>카테고리별 상한</h2>';
    state.categories.forEach(function (cat) {
      var spent = getCategoryTotal(currentViewMonth, cat.id);
      var pct = Math.min(100, Math.round((spent / cat.cap) * 100));
      var over = spent > cat.cap;
      html += '<div class="cat-row">';
      html += '<div class="cat-row-top"><span>' + cat.name + '</span><span class="amt' + (over ? ' over' : '') + '">' + formatWon(spent) + ' / ' + formatWon(cat.cap) + '</span></div>';
      html += '<div class="progress-track"><div class="progress-fill' + (over ? ' over' : '') + '" style="width:' + pct + '%"></div></div>';
      html += '</div>';
    });

    app.innerHTML = html;
  }

  function renderAdd() {
    var html = '';
    html += '<h1>지출 추가</h1>';
    html += '<div class="card">';
    html += '<label>날짜</label>';
    html += '<input type="date" id="f-date" value="' + todayStr() + '">';
    html += '<label>카테고리</label>';
    html += '<div class="chip-group" id="f-cats">';
    state.categories.forEach(function (cat, i) {
      html += '<div class="chip' + (i === 0 ? ' selected' : '') + '" data-cat="' + cat.id + '">' + cat.name + '</div>';
    });
    html += '</div>';
    html += '<label>금액</label>';
    html += '<input type="number" id="f-amount" placeholder="0" inputmode="numeric">';
    html += '<label>메모 (선택)</label>';
    html += '<input type="text" id="f-memo" placeholder="예: 더팜마트">';
    html += '<div style="margin-top:1rem;"><button class="btn" data-action="save-expense">저장</button></div>';
    html += '</div>';

    html += '<h2>최근 내역</h2>';
    var recent = state.expenses.slice().sort(function (a, b) { return b.date.localeCompare(a.date) || b.id.localeCompare(a.id); }).slice(0, 30);
    if (recent.length === 0) {
      html += '<div class="empty-state">아직 입력한 지출이 없습니다.</div>';
    } else {
      html += '<div class="card" style="padding:0.4rem 1.1rem;">';
      recent.forEach(function (e) {
        var cat = state.categories.find(function (c) { return c.id === e.categoryId; });
        html += '<div class="tx-row">';
        html += '<div class="tx-main"><span class="tx-cat">' + (cat ? cat.name : '기타') + (e.memo ? ' · ' + escapeHtml(e.memo) : '') + '</span><span class="tx-date">' + e.date + '</span></div>';
        html += '<span class="tx-amt">' + formatWon(e.amount) + '</span>';
        html += '<button class="tx-del" data-action="delete-expense" data-id="' + e.id + '">×</button>';
        html += '</div>';
      });
      html += '</div>';
    }

    app.innerHTML = html;
  }

  function renderPlan() {
    var months = planMonthList();
    var html = '';
    html += '<h1>12개월 저축 플랜</h1>';
    html += '<div class="card">';
    html += '<p class="metric-label">연간 목표</p>';
    html += '<p class="metric-value">' + formatWon(state.savingsGoal * state.planMonths) + '</p>';
    html += '</div>';

    html += '<table class="plan-table"><thead><tr><th>월</th><th>목표</th><th>실제</th><th>상태</th></tr></thead><tbody>';
    var cumTarget = 0, cumActual = 0;
    months.forEach(function (mk) {
      var actual = state.monthlySavings[mk] || 0;
      cumTarget += state.savingsGoal;
      cumActual += actual;
      var achieved = actual >= state.savingsGoal;
      html += '<tr>';
      html += '<td>' + monthLabel(mk) + '</td>';
      html += '<td>' + formatWon(state.savingsGoal) + '</td>';
      html += '<td><input type="number" data-month="' + mk + '" class="savings-input" value="' + actual + '" inputmode="numeric"></td>';
      html += '<td><span class="status-pill ' + (achieved ? 'achieved' : 'pending') + '">' + (achieved ? '달성' : '미달') + '</span></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';

    html += '<div class="card" style="margin-top:1rem;">';
    html += '<p class="metric-label">누적 실제 저축액</p>';
    html += '<p class="metric-value">' + formatWon(cumActual) + ' <span class="metric-sub">/ ' + formatWon(cumTarget) + '</span></p>';
    html += '</div>';

    app.innerHTML = html;
  }

  function renderSettings() {
    var html = '';
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

    html += '<h2>데이터 백업</h2>';
    html += '<div class="card">';
    html += '<p class="metric-sub">이 앱의 데이터는 이 기기의 브라우저에만 저장됩니다. 기기를 바꾸기 전에 내보내기로 백업하세요.</p>';
    html += '<div class="export-row">';
    html += '<button class="btn secondary" data-action="export-data">내보내기</button>';
    html += '<button class="btn secondary" data-action="import-data">가져오기</button>';
    html += '</div>';
    html += '<input type="file" id="import-file" accept="application/json" style="display:none;">';
    html += '<div style="margin-top:8px;"><button class="btn danger small" data-action="reset-data">전체 초기화</button></div>';
    html += '</div>';

    app.innerHTML = html;
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
    else if (action === 'delete-expense') {
      state.expenses = state.expenses.filter(function (ex) { return ex.id !== actionEl.dataset.id; });
      saveState(); render();
    }
    else if (action === 'add-category') {
      state.categories.push({ id: uid(), name: '새 카테고리', cap: 50000 });
      saveState(); render();
    }
    else if (action === 'delete-category') {
      if (confirm('이 카테고리를 삭제할까요? 관련 지출 내역은 남아있지만 홈 화면에는 더 이상 표시되지 않습니다.')) {
        state.categories = state.categories.filter(function (c) { return c.id !== actionEl.dataset.id; });
        saveState(); render();
      }
    }
    else if (action === 'save-settings') { saveSettings(); }
    else if (action === 'export-data') { exportData(); }
    else if (action === 'import-data') { document.getElementById('import-file').click(); }
    else if (action === 'reset-data') {
      if (confirm('모든 데이터를 삭제하고 초기 상태로 되돌립니다. 계속할까요?')) {
        state = defaultState(); saveState(); render();
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
          saveState();
          alert('가져오기가 완료되었습니다.');
          render();
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
      saveState();
      render();
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
    state.expenses.push({ id: uid(), date: date, categoryId: categoryId, amount: amount, memo: memo });
    saveState();
    document.getElementById('f-amount').value = '';
    document.getElementById('f-memo').value = '';
    render();
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
    saveState();
    alert('저장되었습니다.');
    render();
  }

  function exportData() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'budget-backup-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  render();
})();
