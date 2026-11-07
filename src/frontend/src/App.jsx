import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';

// Безопасный импорт локальных данных проекта (для работы в режиме оффлайн/демо)
let fallbackPivotFacts = [];
let fallbackComparisonCsv = '';
try {
  fallbackPivotFacts = (await import('./data/08_pivot_facts_demo.json')).default;
  fallbackComparisonCsv = (await import('./data/06_comparison_app1001.csv?raw')).default;
} catch (e) {
  console.warn('Локальные файлы мок-данных не обнаружены, система работает напрямую с FastAPI.', e);
}

// ----------------------------------------------------
// 1. ИСХОДНЫЙ КОД 5 ПРОВЕРОК ИЗ РЕПОЗИТОРИЯ (ДЛЯ ПРОСМОТРА)
// ----------------------------------------------------
const REPO_PYTHON_SCRIPTS = {
  ar_drop_by_product: `# -*- coding: utf-8 -*-
"""Approval Rate по продукту: FAIL, если относительное падение больше порога."""
DEFAULTS = {"max_drop_rel": 0.10, "low_confidence_cnt": 5, "app_ids_limit": 20}

def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    by_product = {}
    for s in mart.segments():
        for product in (s.get("PRODUCTS") or "").split(";"):
            if not product:
                continue
            d = by_product.setdefault(product, {"total": 0, "ap_b": 0, "ap_a": 0, "lost": []})
            d["total"] += 1
            if s.get("DECISION_BEFORE") == "APPROVE":
                d["ap_b"] += 1
            if s.get("DECISION_AFTER") == "APPROVE":
                d["ap_a"] += 1
            if s.get("DECISION_BEFORE") == "APPROVE" and s.get("DECISION_AFTER") != "APPROVE":
                d["lost"].append(s["APP_ID"])
    # Расчет drop_rel и возврат строк...
`,
  attribute_new_loss: `# -*- coding: utf-8 -*-
"""Изменился состав атрибутов ответа: появились новые или пропали существующие."""
DEFAULTS = {"min_share": 0.001, "low_confidence_cnt": 5, "app_ids_limit": 20}

def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    total = mart.total_apps()
    agg = {}
    for change in ("ATTRIBUTE_NEW", "ATTRIBUTE_LOST"):
        for r in mart.rows(change_type=change):
            agg.setdefault((change, r["PATH"]), set()).add(r["APP_ID"])
`,
  external_score_drift: `# -*- coding: utf-8 -*-
"""Различие вызвано входными данными, а не стратегией."""
SCORE_PATH = "characteristics.score_okb"
FEATURE_PATH = "decisionResult.scoring.features.score_okb"
DEFAULTS = {"low_confidence_cnt": 5, "app_ids_limit": 20}

def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    total = mart.total_apps()
    drifted = {r["APP_ID"] for r in mart.rows(path=SCORE_PATH, diff_flag=1)}
    decision_changed = {s["APP_ID"] for s in mart.segments() if s.get("DECISION_CHANGED")}
    false_alarm = drifted & decision_changed
`,
  stop_factor_disappeared: `# -*- coding: utf-8 -*-
"""Стоп-фактор перестал работать: правило пропало из ответа либо hit true -> false."""
RULE_HIT_PATH = "decisionResult.product_trials.rules.hit"
DEFAULTS = {"low_confidence_cnt": 5, "app_ids_limit": 20}

def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    lost, turned_off = {}, {}
    for r in mart.rows(path=RULE_HIT_PATH, change_type="ATTRIBUTE_LOST"):
        if r.get("VALUE_BEFORE") == "true":
            lost.setdefault(r["ARRAY_KEY"], set()).add(r["APP_ID"])
`,
  target_model_changed: `# -*- coding: utf-8 -*-
"""Сменилась целевая модель, по которой принимается решение по продукту."""
DEFAULTS = {"low_confidence_cnt": 5, "app_ids_limit": 20}

def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    total = mart.total_apps()
    pairs = {}
    for s in mart.segments():
        mb, ma = s.get("PD_MODEL_BEFORE"), s.get("PD_MODEL_AFTER")
        if mb != ma:
            pairs.setdefault(f"{mb} -> {ma}", set()).add(s["APP_ID"])
`
};

// ----------------------------------------------------
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ----------------------------------------------------
function parseSemicolonCsv(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].replace(/^\ufeff/, '').split(';').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(';').map((v) => v.trim());
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? '';
    });
    return row;
  });
}

const resolveModuleName = (row) => {
  const raw = row.CLASS || row.class_name || row.PREFIX || row.prefix || 'Общие параметры';
  return String(raw).trim() || 'Общие параметры';
};

const INITIAL_ANALYSTS = [
  { id: '1', name: 'Аналитик 1 (Иван Семенов)', username: 'ivan', role: 'Lead Risk Modeler' },
  { id: '2', name: 'Аналитик 2 (Мария Васильева)', username: 'maria', role: 'Senior Strategy Validator' }
];

export default function App() {
  // ----------------------------------------------------
  // СИСТЕМНОЕ СОСТОЯНИЕ
  // ----------------------------------------------------
  const [activeTab, setActiveTab] = useState('matrix');
  const [apiStatus, setApiStatus] = useState('checking'); // 'connected' | 'fallback'
  const [backendUrl, setBackendUrl] = useState(() => localStorage.getItem('spr_backend_url') || '');
  const [runId, setRunId] = useState(null);
  const [availableRuns, setAvailableRuns] = useState([]);
  const [isLoadingApi, setIsLoadingApi] = useState(false);

  // Пользователи и аналитики
  const [analysts, setAnalysts] = useState(() => {
    try {
      const saved = localStorage.getItem('spr_analysts_list_v2');
      return saved ? JSON.parse(saved) : INITIAL_ANALYSTS;
    } catch {
      return INITIAL_ANALYSTS;
    }
  });
  const [currentUser, setCurrentUser] = useState(() => analysts[0] || INITIAL_ANALYSTS[0]);
  const [isAddUserModalOpen, setIsAddUserModalOpen] = useState(false);
  const [newUserName, setNewUserName] = useState('');
  const [newUserRole, setNewUserRole] = useState('Риск-аналитик');
  const [newUserUsername, setNewUserUsername] = useState('');

  // Сохранение списка аналитиков
  useEffect(() => {
    try {
      localStorage.setItem('spr_analysts_list_v2', JSON.stringify(analysts));
    } catch {}
  }, [analysts]);

  // Данные из FastAPI
  const [pivotFacts, setPivotFacts] = useState([]);
  const [applications, setApplications] = useState([]);
  const [checksResults, setChecksResults] = useState([]);

  // Пайплайн
  const [pipelineSteps, setPipelineSteps] = useState([]);
  const [isPipelineRunning, setIsPipelineRunning] = useState(false);
  const [pipelineSeconds, setPipelineSeconds] = useState(0);
  const timerRef = useRef(null);

  // Фильтрация и Drill-down
  const [selectedPivotFilter, setSelectedPivotFilter] = useState(null);
  const [waterfallTargetBucket, setWaterfallTargetBucket] = useState(null); // Исход для диаграммы Waterfall
  const [searchFilter, setSearchFilter] = useState('');
  const [onlyDiffRows, setOnlyDiffRows] = useState(false);
  const [significantOnly, setSignificantOnly] = useState(false);
  const [sortMode, setSortMode] = useState('impact'); // 'impact' | 'delta' | 'alpha'
  const [registryStatusFilter, setRegistryStatusFilter] = useState('ALL');
  const [registrySearch, setRegistrySearch] = useState('');
  const [collapsedModules, setCollapsedModules] = useState({});

  // Досье заявки
  const [activeDossierAppId, setActiveDossierAppId] = useState(null);
  const [dossierRows, setDossierRows] = useState([]);
  const [isDossierLoading, setIsDossierLoading] = useState(false);

  // Модальные окна
  const [codeModal, setCodeModal] = useState({ isOpen: false, title: '', code: '' });

  const getApiUrl = useCallback((path) => {
    const cleanBase = backendUrl.trim().replace(/\/+$/, '');
    return cleanBase ? `${cleanBase}${path}` : path;
  }, [backendUrl]);

  // Авторизация аналитика
  const authenticateAnalyst = useCallback(async (analyst) => {
    setCurrentUser(analyst);
    try {
      await fetch(getApiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: analyst.id, username: analyst.username })
      });
    } catch {}
  }, [getApiUrl]);

  // ----------------------------------------------------
  // ЗАГРУЗКА СПИСКА ПРОГОНОВ (БЕЗ ХАРДКОДА ID)
  // ----------------------------------------------------
  const fetchRunsList = useCallback(async () => {
    try {
      const res = await fetch(getApiUrl('/api/runs/'));
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          setAvailableRuns(data);
          setRunId((prev) => prev || String(data[data.length - 1].id || data[data.length - 1].run_id || 1));
          setApiStatus('connected');
          return;
        }
      }
    } catch {
      console.warn('API /api/runs/ недоступен, включен режим фолбэка.');
    }
    setApiStatus('fallback');
    setRunId((prev) => prev || '1');
  }, [getApiUrl]);

  // ----------------------------------------------------
  // ЗАГРУЗКА ДАННЫХ ВЫБРАННОГО ПРОГОНА ИЗ FASTAPI
  // ----------------------------------------------------
  const fetchReportData = useCallback(async (targetRunId) => {
    if (!targetRunId) return;
    setIsLoadingApi(true);

    try {
      // 1. Загрузка витрины фактов
      const resFacts = await fetch(getApiUrl(`/api/reports/${targetRunId}/pivot-facts`));
      if (resFacts.ok) {
        const facts = await resFacts.json();
        if (Array.isArray(facts)) setPivotFacts(facts);
      } else if (fallbackPivotFacts?.length > 0) {
        setPivotFacts(fallbackPivotFacts);
      }

      // 2. Загрузка готовых проверок из базы (CheckResult)
      const resChecks = await fetch(getApiUrl(`/api/reports/${targetRunId}/checks`));
      if (resChecks.ok) {
        const checks = await resChecks.json();
        if (Array.isArray(checks)) setChecksResults(checks);
      }

      // 3. Загрузка реестра заявок
      const resApps = await fetch(getApiUrl(`/api/reports/${targetRunId}/applications`));
      if (resApps.ok) {
        const apps = await resApps.json();
        if (Array.isArray(apps)) setApplications(apps);
      }

      // 4. Загрузка этапов пайплайна
      try {
        const resSteps = await fetch(getApiUrl(`/api/runs/${targetRunId}/steps`));
        if (resSteps.ok) {
          const steps = await resSteps.json();
          if (Array.isArray(steps)) setPipelineSteps(steps);
        }
      } catch {}

      setApiStatus('connected');
    } catch {
      setApiStatus('fallback');
      if (fallbackPivotFacts?.length > 0) setPivotFacts(fallbackPivotFacts);
    } finally {
      setIsLoadingApi(false);
    }
  }, [getApiUrl]);

  useEffect(() => {
    fetchRunsList();
  }, [fetchRunsList]);

  useEffect(() => {
    if (runId) {
      fetchReportData(runId);
    }
  }, [runId, fetchReportData]);

  // ----------------------------------------------------
  // ДОСЬЕ АНКЕТЫ (/api/reports/{run_id}/applications/{app_id}/diff)
  // ----------------------------------------------------
  const handleOpenDossier = useCallback(async (rawAppId) => {
    if (!rawAppId) return;
    const cleanId = String(rawAppId).trim();
    const targetQueryId = cleanId.replace(/^APP-/, '');

    setActiveDossierAppId(cleanId);
    setIsDossierLoading(true);

    try {
      const res = await fetch(getApiUrl(`/api/reports/${runId}/applications/${encodeURIComponent(targetQueryId)}/diff`));
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length > 0) {
          setDossierRows(rows);
          setIsDossierLoading(false);
          return;
        }
      }
    } catch {}

    // Локальный фолбэк по CSV
    if (fallbackComparisonCsv) {
      const parsed = parseSemicolonCsv(fallbackComparisonCsv);
      const matched = parsed.filter(
        (r) => r.APP_ID === cleanId || r.APP_ID === targetQueryId || String(r.APP_ID).replace(/^APP-/, '') === targetQueryId
      );
      setDossierRows(matched);
    } else {
      setDossierRows([]);
    }
    setIsDossierLoading(false);
  }, [runId, getApiUrl]);

  // ----------------------------------------------------
  // ДИНАМИЧЕСКАЯ АГРЕГАЦИЯ ВИТРИНЫ
  // ----------------------------------------------------
  const { decisionRows, moduleBlocks, summaryMetrics, uniqueDecisions } = useMemo(() => {
    const map = {};

    pivotFacts.forEach((row) => {
      const mod = resolveModuleName(row);
      const arrKey = row.ARRAY_KEY ? String(row.ARRAY_KEY) : '';
      const key = row.KEY ? String(row.KEY) : '';
      const val = row.VALUE_ADJUSTED ?? row.VALUE_AFTER ?? row.VALUE_BEFORE ?? '—';
      const rowId = `${mod}__${arrKey}__${key}__${val}`;

      if (!map[rowId]) {
        map[rowId] = {
          id: rowId,
          module: mod,
          arrayKey: arrKey,
          key,
          value: val,
          stableCount: 0,
          leftCount: 0,
          arrivedCount: 0
        };
      }

      const count = Number(row.CNT) || 0;
      const isDiff = Number(row.DIFF_FLAG) === 1;
      const isBefore = String(row.SOURCE || '').toUpperCase().includes('BEFORE');

      if (!isDiff) {
        if (isBefore) map[rowId].stableCount += count;
      } else {
        if (isBefore) map[rowId].leftCount += count;
        else map[rowId].arrivedCount += count;
      }
    });

    const calculatedRows = Object.values(map).map((r) => {
      const masterTotal = r.stableCount + r.leftCount;
      const betaTotal = r.stableCount + r.arrivedCount;
      const netDelta = betaTotal - masterTotal;
      return {
        ...r,
        masterTotal,
        betaTotal,
        netDelta,
        absDelta: Math.abs(netDelta),
        totalChanges: r.leftCount + r.arrivedCount,
        maxAffectedClients: Math.max(r.leftCount, r.arrivedCount)
      };
    });

    // Определение модуля решений
    const decRows = calculatedRows.filter(
      (r) =>
        r.key.toLowerCase().includes('decision') ||
        r.module.toLowerCase().includes('decision') ||
        r.module.toLowerCase() === 'decisionresult'
    );
    const primaryDecModule = decRows[0]?.module || calculatedRows[0]?.module || 'decisionResult';
    const primaryDecRows = calculatedRows.filter((r) => r.module === primaryDecModule);

    // Уникальные исходы
    const decValuesSet = new Set();
    primaryDecRows.forEach((r) => decValuesSet.add(r.value));
    applications.forEach((a) => {
      if (a.afterDecision && a.afterDecision !== 'UNKNOWN') decValuesSet.add(a.afterDecision);
      if (a.decision_after && a.decision_after !== 'UNKNOWN') decValuesSet.add(a.decision_after);
    });

    const totalPortfolio = primaryDecRows.reduce((sum, r) => sum + r.masterTotal, 0) || applications.length || 1;
    const totalFlips = primaryDecRows.reduce((sum, r) => sum + r.leftCount, 0);

    // Группировка блоков
    const groups = {};
    calculatedRows.forEach((r) => {
      if (!groups[r.module]) {
        groups[r.module] = {
          name: r.module,
          rows: [],
          totalDiffChanges: 0,
          maxAffectedClients: 0,
          maxAbsDelta: 0
        };
      }
      groups[r.module].rows.push(r);
      groups[r.module].totalDiffChanges += r.totalChanges;
      if (r.maxAffectedClients > groups[r.module].maxAffectedClients) {
        groups[r.module].maxAffectedClients = r.maxAffectedClients;
      }
      if (r.absDelta > groups[r.module].maxAbsDelta) {
        groups[r.module].maxAbsDelta = r.absDelta;
      }
    });

    return {
      decisionRows: primaryDecRows,
      moduleBlocks: Object.values(groups),
      uniqueDecisions: Array.from(decValuesSet),
      summaryMetrics: {
        totalPortfolio,
        totalFlips,
        flipsPct: ((totalFlips / totalPortfolio) * 100).toFixed(1)
      }
    };
  }, [pivotFacts, applications]);

  // Строка, выбранная для отображения в Waterfall
  const activeWaterfallRow = useMemo(() => {
    if (decisionRows.length === 0) return null;
    if (waterfallTargetBucket) {
      return decisionRows.find((r) => r.value === waterfallTargetBucket) || decisionRows[0];
    }
    return decisionRows[0];
  }, [decisionRows, waterfallTargetBucket]);

  // ----------------------------------------------------
  // ФИЛЬТРАЦИЯ БЛОКОВ ВИТРИНЫ
  // ----------------------------------------------------
  const filteredBlocks = useMemo(() => {
    const q = searchFilter.toLowerCase().trim();

    let list = moduleBlocks
      .map((block) => {
        let rows = block.rows.filter((r) => {
          if (onlyDiffRows && r.totalChanges === 0) return false;
          if (significantOnly && r.maxAffectedClients < 10) return false;
          if (q) {
            const match =
              r.module.toLowerCase().includes(q) ||
              r.key.toLowerCase().includes(q) ||
              String(r.value).toLowerCase().includes(q);
            if (!match) return false;
          }
          return true;
        });

        rows.sort((a, b) => {
          if (sortMode === 'impact') return b.maxAffectedClients - a.maxAffectedClients || b.totalChanges - a.totalChanges;
          if (sortMode === 'delta') return b.absDelta - a.absDelta;
          return a.key.localeCompare(b.key);
        });

        return { ...block, rows };
      })
      .filter((b) => b.rows.length > 0);

    list.sort((a, b) => {
      if (sortMode === 'impact') return b.maxAffectedClients - a.maxAffectedClients;
      if (sortMode === 'delta') return b.maxAbsDelta - a.maxAbsDelta;
      return a.name.localeCompare(b.name);
    });

    return list;
  }, [moduleBlocks, searchFilter, onlyDiffRows, significantOnly, sortMode]);

  // ----------------------------------------------------
  // ФИЛЬТРАЦИЯ РЕЕСТРА АНКЕТ
  // ----------------------------------------------------
  const filteredApps = useMemo(() => {
    const q = registrySearch.toLowerCase().trim();

    return applications.filter((app) => {
      const appId = String(app.app_id || app.id || '');
      const decAfter = app.afterDecision || app.decision_after || '—';

      if (q && !appId.toLowerCase().includes(q)) return false;
      if (registryStatusFilter !== 'ALL' && decAfter !== registryStatusFilter) return false;

      if (selectedPivotFilter) {
        const targetVal = String(selectedPivotFilter.value).toUpperCase();
        if (selectedPivotFilter.direction === 'LEFT') {
          return decAfter.toUpperCase() !== targetVal;
        }
        if (selectedPivotFilter.direction === 'ARRIVED') {
          return decAfter.toUpperCase() === targetVal;
        }
        const diffCnt = Number(app.diffCount ?? app.diff_count ?? 0);
        return diffCnt > 0;
      }
      return true;
    });
  }, [applications, registrySearch, registryStatusFilter, selectedPivotFilter]);

  // Добавление нового аналитика
  const handleCreateAnalyst = (e) => {
    e.preventDefault();
    if (!newUserName.trim()) return;

    const newAnalyst = {
      id: String(Date.now()),
      name: newUserName.trim(),
      username: newUserUsername.trim() || newUserName.trim().toLowerCase().replace(/\s+/g, '_'),
      role: newUserRole.trim() || 'Риск-аналитик'
    };

    setAnalysts((prev) => [...prev, newAnalyst]);
    authenticateAnalyst(newAnalyst);
    setNewUserName('');
    setNewUserUsername('');
    setIsAddUserModalOpen(false);
  };

  // Экспорт автономного HTML
  const handleExportHtml = () => {
    const reportDate = new Date().toLocaleString('ru-RU');
    const content = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>СПР • Аудит кредитного риска — Прогон #${runId}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; padding: 32px; }
    .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e2e8f0; }
    th { background: #f1f5f9; color: #475569; font-size: 11px; text-transform: uppercase; }
    .badge-pass { background: #d1fae5; color: #065f46; font-weight: bold; padding: 2px 6px; border-radius: 4px; }
    .badge-fail { background: #ffe4e6; color: #9f1239; font-weight: bold; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h2>Отчёт аудита кредитных стратегий СПР (Прогон #${runId})</h2>
  <p style="color:#64748b;font-size:12px;">Сформировано: ${reportDate} | Аналитик: ${currentUser.name} (${currentUser.role})</p>
  
  <div class="card">
    <h3>Macro Impact (Сводка портфеля)</h3>
    <p>Всего анкет в выборке: <b>${summaryMetrics.totalPortfolio}</b></p>
    <p>Сменили решение (Flips): <b>${summaryMetrics.totalFlips} (${summaryMetrics.flipsPct}%)</b></p>
  </div>

  <div class="card">
    <h3>Исполнение проверок качества (Quality Gates)</h3>
    <table>
      <thead><tr><th>Правило</th><th>Аргумент</th><th>Метрика</th><th>Факт</th><th>Статус</th></tr></thead>
      <tbody>
        ${checksResults.map((c) => `
          <tr>
            <td><b>${c.LABEL || c.label || '—'}</b></td>
            <td><code>${c.ARGUMENT || c.argument || '—'}</code></td>
            <td>${c.METRIC ?? c.metric ?? '—'}</td>
            <td>${c.CNT ?? c.cnt ?? 0} из ${c.TOTAL ?? c.total ?? '—'}</td>
            <td><span class="${(c.RESULT || c.result) === 'PASS' ? 'badge-pass' : 'badge-fail'}">${c.RESULT || c.result}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;

    const blob = new Blob(['\ufeff' + content], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `SPR_Audit_Report_Run_${runId}.html`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50/70 text-slate-900 font-sans flex flex-col antialiased">
      {/* ==========================================
          ШАПКА (СВЕТЛАЯ FINTECH ТЕМА)
      ========================================== */}
      <header className="border-b border-slate-200 bg-white px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-30 shadow-sm">
        <div className="flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full ${apiStatus === 'connected' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
          <span className="font-bold text-sm text-slate-800">СПР • Аудит кредитных стратегий</span>
          
          {/* Селектор прогонов */}
          <div className="flex items-center gap-1.5 bg-slate-100 border border-slate-200 rounded-lg px-2 py-0.5 text-xs font-mono">
            <span className="text-slate-500 font-sans">Прогон:</span>
            {availableRuns.length > 0 ? (
              <select
                value={runId || ''}
                onChange={(e) => setRunId(e.target.value)}
                className="bg-transparent border-none outline-none font-bold text-blue-700 cursor-pointer"
              >
                {availableRuns.map((r) => (
                  <option key={r.id || r.run_id} value={r.id || r.run_id}>
                    #{r.id || r.run_id} {r.status ? `(${r.status})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={runId || ''}
                onChange={(e) => setRunId(e.target.value)}
                className="w-10 bg-white border border-slate-300 rounded px-1 text-center font-bold text-blue-700"
              />
            )}
            <button
              onClick={() => runId && fetchReportData(runId)}
              className="text-slate-600 hover:text-blue-600 font-bold px-1"
              title="Обновить данные"
            >
              ↻
            </button>
          </div>
        </div>

        {/* Навигация */}
        <nav className="flex gap-1 bg-slate-100 p-1 rounded-lg text-xs font-semibold">
          {[
            { id: 'matrix', label: 'Сводный отчёт (Витрина)' },
            { id: 'registry', label: `Реестр заявок (${filteredApps.length})` },
            { id: 'run', label: 'Запуск и пайплайн' }
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-3 py-1.5 rounded-md transition cursor-pointer ${
                activeTab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Селектор аналитика + Кнопка добавления + Экспорт */}
        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center bg-white border border-slate-300 rounded-lg px-2.5 py-1 shadow-sm">
            <span className="text-slate-400 mr-1.5">👤</span>
            <select
              value={currentUser.id}
              onChange={(e) => {
                const found = analysts.find((a) => a.id === e.target.value);
                if (found) authenticateAnalyst(found);
              }}
              className="bg-transparent border-none outline-none font-semibold text-slate-700 cursor-pointer"
            >
              {analysts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => setIsAddUserModalOpen(true)}
            className="px-2.5 py-1 rounded-lg font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 transition cursor-pointer"
            title="Создать новую учётную запись аналитика"
          >
            + Аналитик
          </button>

          <button
            onClick={handleExportHtml}
            className="px-3 py-1 rounded-lg font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition shadow-sm cursor-pointer"
          >
            ⬇ Скачать HTML
          </button>
        </div>
      </header>

      {/* ==========================================
          ВКЛАДКА 1: СВОДНЫЙ ОТЧЁТ И ВИТРИНА
      ========================================== */}
      {activeTab === 'matrix' && (
        <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-6">
          {/* 1. БЫСТРАЯ ОСНОВНАЯ ИНФОРМАЦИЯ (EXECUTIVE SUMMARY) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Всего анкет в выборке</div>
              <div className="text-2xl font-extrabold text-slate-900 font-mono mt-1">
                {summaryMetrics.totalPortfolio.toLocaleString('ru-RU')}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Данные витрины pivot-facts</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Смена кредитного решения (Flips)</div>
              <div className="flex items-baseline justify-between mt-1">
                <div className="text-2xl font-extrabold text-amber-600 font-mono">{summaryMetrics.totalFlips}</div>
                <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                  {summaryMetrics.flipsPct}% выборки
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Анкеты с миграцией исхода</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Загружено в реестр</div>
              <div className="flex items-baseline justify-between mt-1">
                <div className="text-2xl font-extrabold text-blue-600 font-mono">{applications.length}</div>
                <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">Из базы FastAPI</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Доступен поатрибутный аудит</div>
            </div>
          </div>

          {/* 2. ДИАГРАММА WATERFALL ПЕРЕТОКА РЕШЕНИЙ */}
          {activeWaterfallRow && (
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4">
              <div className="flex flex-wrap justify-between items-center gap-2 border-b border-slate-100 pb-3">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600">
                    Динамический баланс решений
                  </span>
                  <h3 className="text-sm font-bold text-slate-800">
                    Диаграмма миграции (Waterfall): срез по исходу «{activeWaterfallRow.value}»
                  </h3>
                </div>

                {/* Переключатель исходов для Waterfall (динамический) */}
                <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-lg text-xs font-semibold">
                  <span className="text-slate-400 text-[11px] px-1 font-sans">Срез исхода:</span>
                  {decisionRows.map((dr) => (
                    <button
                      key={dr.id}
                      onClick={() => setWaterfallTargetBucket(dr.value)}
                      className={`px-2.5 py-0.5 rounded-md transition cursor-pointer ${
                        activeWaterfallRow.value === dr.value
                          ? 'bg-white text-slate-900 shadow-sm font-bold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {dr.value}
                    </button>
                  ))}
                </div>
              </div>

              {/* Столбики диаграммы */}
              {(() => {
                const maxVal = Math.max(
                  activeWaterfallRow.masterTotal,
                  activeWaterfallRow.betaTotal,
                  activeWaterfallRow.stableCount,
                  1
                );
                const getHeight = (val) => Math.max(Math.round((val / maxVal) * 110), 18);

                const bars = [
                  {
                    label: 'MASTER (Было)',
                    val: activeWaterfallRow.masterTotal,
                    sub: 'было в срезе',
                    color: 'bg-slate-700 hover:bg-slate-800',
                    textColor: 'text-slate-800',
                    onClick: () => setSelectedPivotFilter({ rowId: activeWaterfallRow.id, value: activeWaterfallRow.value, direction: 'ALL' })
                  },
                  {
                    label: 'Сохранено (DIFF=0)',
                    val: activeWaterfallRow.stableCount,
                    sub: 'без изменений',
                    color: 'bg-slate-400 hover:bg-slate-500',
                    textColor: 'text-slate-600',
                    onClick: null
                  },
                  {
                    label: 'Ушло в другие (-)',
                    val: activeWaterfallRow.leftCount,
                    prefix: '-',
                    sub: 'клик ➔ анкеты',
                    color: 'bg-rose-500 hover:bg-rose-600 ring-2 ring-rose-200',
                    textColor: 'text-rose-600 font-bold',
                    onClick: () => setSelectedPivotFilter({ rowId: activeWaterfallRow.id, value: activeWaterfallRow.value, direction: 'LEFT' })
                  },
                  {
                    label: 'Пришло из других (+)',
                    val: activeWaterfallRow.arrivedCount,
                    prefix: '+',
                    sub: 'клик ➔ анкеты',
                    color: 'bg-emerald-500 hover:bg-emerald-600 ring-2 ring-emerald-200',
                    textColor: 'text-emerald-600 font-bold',
                    onClick: () => setSelectedPivotFilter({ rowId: activeWaterfallRow.id, value: activeWaterfallRow.value, direction: 'ARRIVED' })
                  },
                  {
                    label: 'BETA (Стало)',
                    val: activeWaterfallRow.betaTotal,
                    sub: `дельта: ${activeWaterfallRow.netDelta >= 0 ? '+' : ''}${activeWaterfallRow.netDelta}`,
                    color: 'bg-blue-600 hover:bg-blue-700',
                    textColor: 'text-blue-700 font-bold',
                    onClick: () => setSelectedPivotFilter({ rowId: activeWaterfallRow.id, value: activeWaterfallRow.value, direction: 'ARRIVED' })
                  }
                ];

                return (
                  <div className="pt-2 pb-1 px-3 bg-slate-50/80 rounded-xl border border-slate-100">
                    <div className="grid grid-cols-5 gap-3 items-end h-36 pt-4 px-2">
                      {bars.map((b, idx) => (
                        <div
                          key={idx}
                          onClick={b.onClick || undefined}
                          className={`flex flex-col items-center justify-end h-full ${b.onClick ? 'cursor-pointer group' : ''}`}
                        >
                          <div className={`text-xs font-mono mb-1 ${b.textColor}`}>
                            {b.prefix || ''}{b.val}
                          </div>
                          <div
                            style={{ height: `${getHeight(b.val)}px` }}
                            className={`w-full max-w-16 rounded-t-lg transition-all duration-300 shadow-sm ${b.color}`}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-5 gap-3 border-t border-slate-200 pt-2 pb-1 text-center font-sans">
                      {bars.map((b, idx) => (
                        <div key={idx}>
                          <div className="text-[11px] font-bold text-slate-700 leading-tight">{b.label}</div>
                          <div className="text-[10px] text-slate-400 mt-0.5">{b.sub}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* 3. ПРОВЕРКИ РИСК-ПОЛИТИКИ ИЗ РЕПОЗИТОРИЯ (GET /api/reports/{id}/checks) */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Автоматические проверки стратегии (Quality Gates)</h3>
                <p className="text-[11px] text-slate-500">Результаты расчета проверок из репозитория проекта</p>
              </div>
              <div className="flex gap-2 text-xs font-bold">
                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                  PASS: {checksResults.filter((c) => (c.RESULT || c.result) === 'PASS').length}
                </span>
                <span className="px-2 py-0.5 rounded bg-rose-100 text-rose-800">
                  FAIL: {checksResults.filter((c) => (c.RESULT || c.result) === 'FAIL').length}
                </span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-white text-slate-500 border-b border-slate-200 font-semibold">
                  <tr>
                    <th className="py-2.5 px-4">Название проверки (LABEL)</th>
                    <th className="py-2.5 px-4">Аргумент</th>
                    <th className="py-2.5 px-4 text-center">Затронуто анкет (CNT)</th>
                    <th className="py-2.5 px-4 text-center">Метрика</th>
                    <th className="py-2.5 px-4 text-center">Статус</th>
                    <th className="py-2.5 px-4 text-right">Код</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {checksResults.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-4 text-center text-slate-400">
                        Нет сохраненных результатов проверок в базе для этого прогона
                      </td>
                    </tr>
                  ) : (
                    checksResults.map((c, idx) => {
                      const label = c.LABEL || c.label || 'Проверка';
                      const res = c.RESULT || c.result || 'PASS';
                      const arg = c.ARGUMENT || c.argument || '—';
                      const cnt = c.CNT ?? c.cnt ?? 0;
                      const metric = c.METRIC ?? c.metric ?? '—';
                      const checkId = Object.keys(REPO_PYTHON_SCRIPTS).find((k) => label.toLowerCase().includes(k)) || 'ar_drop_by_product';

                      return (
                        <tr key={idx} className="hover:bg-slate-50 transition">
                          <td className="py-2.5 px-4 font-semibold text-slate-800">{label}</td>
                          <td className="py-2.5 px-4 font-mono text-slate-600">
                            <span className="bg-slate-100 px-2 py-0.5 rounded text-[11px]">{arg}</span>
                          </td>
                          <td className="py-2.5 px-4 text-center font-mono font-bold text-slate-800">{cnt}</td>
                          <td className="py-2.5 px-4 text-center font-mono text-slate-700">{metric}</td>
                          <td className="py-2.5 px-4 text-center">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              res === 'PASS'
                                ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                : 'bg-rose-100 text-rose-800 border border-rose-200'
                            }`}>
                              {res}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            <button
                              onClick={() => setCodeModal({ isOpen: true, title: label, code: REPO_PYTHON_SCRIPTS[checkId] || '# Код проверки в репозитории\n' })}
                              className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 rounded font-semibold transition cursor-pointer"
                            >
                              Код ↗
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 4. ПОЛНЫЙ БАЛАНС ПЕРЕТОКА РЕШЕНИЙ (УНИВЕРСАЛЬНЫЙ DATA-AGNOSTIC) */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 bg-slate-900 text-white flex justify-between items-center">
              <div>
                <h3 className="text-sm font-bold">Сводный баланс кредитных решений (Полная арифметика перетока)</h3>
                <p className="text-[11px] text-slate-300">
                  Формула: <code>MASTER (Было)</code> - <code>Ушло</code> + <code>Пришло</code> = <code>BETA (Стало)</code>
                </p>
              </div>
              {selectedPivotFilter && (
                <button
                  onClick={() => setSelectedPivotFilter(null)}
                  className="text-xs bg-white/20 hover:bg-white/30 text-white px-2.5 py-1 rounded transition cursor-pointer"
                >
                  ✕ Сбросить фильтр с таблицы ({selectedPivotFilter.value})
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-sans font-semibold">
                  <tr>
                    <th className="py-2.5 px-4">Параметр (KEY)</th>
                    <th className="py-2.5 px-4">Исход (VALUE)</th>
                    <th className="py-2.5 px-4 text-center font-bold text-slate-800">MASTER (Было)</th>
                    <th className="py-2.5 px-4 text-center text-slate-500">Без изменений (DIFF=0)</th>
                    <th className="py-2.5 px-4 text-center text-rose-700 bg-rose-50/50">Ушло в др. (-LEFT)</th>
                    <th className="py-2.5 px-4 text-center text-emerald-700 bg-emerald-50/50">Пришло из др. (+ARRIVED)</th>
                    <th className="py-2.5 px-4 text-center font-bold text-slate-900">BETA (Стало)</th>
                    <th className="py-2.5 px-4 text-center font-sans">Чистый сдвиг (Δ)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {decisionRows.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-4 font-sans text-slate-600">{r.key}</td>
                      <td className="py-2.5 px-4 font-bold text-slate-900">{r.value}</td>
                      <td className="py-2.5 px-4 text-center font-bold text-slate-800">{r.masterTotal}</td>
                      <td className="py-2.5 px-4 text-center text-slate-400">{r.stableCount}</td>

                      <td className="py-2.5 px-4 text-center bg-rose-50/20 font-sans">
                        {r.leftCount > 0 ? (
                          <button
                            onClick={() => setSelectedPivotFilter({ rowId: r.id, value: r.value, direction: 'LEFT' })}
                            className={`px-2.5 py-0.5 rounded font-mono font-bold text-xs transition cursor-pointer ${
                              selectedPivotFilter?.rowId === r.id && selectedPivotFilter?.direction === 'LEFT'
                                ? 'bg-rose-600 text-white ring-2 ring-rose-300'
                                : 'bg-rose-100 hover:bg-rose-600 hover:text-white text-rose-800'
                            }`}
                            title="Отфильтровать анкеты, ушедшие из этого исхода"
                          >
                            -{r.leftCount} ▼
                          </button>
                        ) : '0'}
                      </td>

                      <td className="py-2.5 px-4 text-center bg-emerald-50/20 font-sans">
                        {r.arrivedCount > 0 ? (
                          <button
                            onClick={() => setSelectedPivotFilter({ rowId: r.id, value: r.value, direction: 'ARRIVED' })}
                            className={`px-2.5 py-0.5 rounded font-mono font-bold text-xs transition cursor-pointer ${
                              selectedPivotFilter?.rowId === r.id && selectedPivotFilter?.direction === 'ARRIVED'
                                ? 'bg-emerald-600 text-white ring-2 ring-emerald-300'
                                : 'bg-emerald-100 hover:bg-emerald-600 hover:text-white text-emerald-800'
                            }`}
                            title="Отфильтровать анкеты, пришедшие в этот исход"
                          >
                            +{r.arrivedCount} ▼
                          </button>
                        ) : '0'}
                      </td>

                      <td className="py-2.5 px-4 text-center font-bold text-slate-900">{r.betaTotal}</td>
                      <td className="py-2.5 px-4 text-center font-bold font-sans">
                        {r.netDelta > 0 ? (
                          <span className="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">+{r.netDelta}</span>
                        ) : r.netDelta < 0 ? (
                          <span className="bg-rose-100 text-rose-800 px-1.5 py-0.5 rounded">{r.netDelta}</span>
                        ) : '0'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 5. ВИТРИНА МОДУЛЕЙ С ПАРАМЕТРАМИ */}
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-wrap justify-between items-center gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="Поиск по модулю, признаку или бакету..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  className="bg-slate-50 border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none w-64 focus:border-blue-500"
                />

                <button
                  onClick={() => setOnlyDiffRows(!onlyDiffRows)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                    onlyDiffRows ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  Только расхождения (DIFF=1)
                </button>

                <button
                  onClick={() => setSignificantOnly(!significantOnly)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                    significantOnly ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  Сдвиги ≥ 10 анкет
                </button>

                <button
                  onClick={() => setSortMode(sortMode === 'impact' ? 'delta' : sortMode === 'delta' ? 'alpha' : 'impact')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 text-white hover:bg-blue-600 transition cursor-pointer"
                >
                  {sortMode === 'impact' && '↓ По охвату клиентов'}
                  {sortMode === 'delta' && '↓ По чистой дельте |Δ|'}
                  {sortMode === 'alpha' && 'А–Я По алфавиту'}
                </button>
              </div>

              <div className="text-xs text-slate-500">
                Модулей: <b>{filteredBlocks.length}</b>
              </div>
            </div>

            {filteredBlocks.map((block) => {
              const isCollapsed = !!collapsedModules[block.name];
              return (
                <div key={block.name} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div
                    onClick={() => setCollapsedModules((p) => ({ ...p, [block.name]: !p[block.name] }))}
                    className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center cursor-pointer hover:bg-slate-100 transition"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400 font-bold">{isCollapsed ? '▶' : '▼'}</span>
                      <span className="font-bold text-sm text-slate-800">{block.name}</span>
                      <span className="text-xs text-slate-500">({block.rows.length} бакетов)</span>
                    </div>
                    <span className="text-xs font-semibold text-slate-600 bg-white border border-slate-200 px-2 py-0.5 rounded">
                      Макс. сдвиг: до <b>{block.maxAffectedClients}</b> анкет
                    </span>
                  </div>

                  {!isCollapsed && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-white text-slate-500 border-b border-slate-100 font-sans font-semibold">
                          <tr>
                            <th className="py-2 px-4">Параметр (KEY)</th>
                            <th className="py-2 px-4">Бакет (VALUE)</th>
                            <th className="py-2 px-4 text-center">MASTER (Было)</th>
                            <th className="py-2 px-4 text-center">DIFF=0</th>
                            <th className="py-2 px-4 text-center text-rose-700">Ушло (-LEFT)</th>
                            <th className="py-2 px-4 text-center text-emerald-700">Пришло (+ARRIVED)</th>
                            <th className="py-2 px-4 text-center">BETA (Стало)</th>
                            <th className="py-2 px-4 text-center">Дельта (Δ)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {block.rows.map((row) => (
                            <tr key={row.id} className={row.totalChanges > 0 ? 'bg-amber-50/20' : 'hover:bg-slate-50'}>
                              <td className="py-2 px-4 text-slate-700 font-medium">{row.arrayKey ? `${row.arrayKey}.${row.key}` : row.key}</td>
                              <td className="py-2 px-4 font-bold text-slate-900">{row.value}</td>
                              <td className="py-2 px-4 text-center font-bold text-slate-700">{row.masterTotal}</td>
                              <td className="py-2 px-4 text-center text-slate-400">{row.stableCount}</td>
                              <td className="py-2 px-4 text-center text-rose-600 font-bold">
                                {row.leftCount > 0 ? `-${row.leftCount}` : '0'}
                              </td>
                              <td className="py-2 px-4 text-center text-emerald-600 font-bold">
                                {row.arrivedCount > 0 ? `+${row.arrivedCount}` : '0'}
                              </td>
                              <td className="py-2 px-4 text-center font-bold text-slate-900">{row.betaTotal}</td>
                              <td className="py-2 px-4 text-center font-bold">
                                {row.netDelta > 0 ? `+${row.netDelta}` : row.netDelta}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </main>
      )}

      {/* ==========================================
          ВКЛАДКА 2: РЕЕСТР АНКЕТ
      ========================================== */}
      {activeTab === 'registry' && (
        <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-wrap justify-between items-center gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-800">Реестр кредитных заявок (Прогон #{runId})</h3>
                <p className="text-xs text-slate-500">
                  Показано: <b>{filteredApps.length} из {applications.length}</b> анкет из базы FastAPI
                </p>
              </div>

              {selectedPivotFilter && (
                <button
                  onClick={() => setSelectedPivotFilter(null)}
                  className="px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 rounded-lg border border-blue-200 cursor-pointer"
                >
                  ✕ Сбросить срез: {selectedPivotFilter.value} ({selectedPivotFilter.direction})
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-3 rounded-lg">
              <input
                type="text"
                placeholder="Поиск по ID заявки (например: I32554354)..."
                value={registrySearch}
                onChange={(e) => setRegistrySearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && registrySearch.trim() && handleOpenDossier(registrySearch)}
                className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none w-72 focus:border-blue-500 font-mono"
              />

              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setRegistryStatusFilter('ALL')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                    registryStatusFilter === 'ALL'
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  Все ({applications.length})
                </button>
                {uniqueDecisions.map((dec) => (
                  <button
                    key={dec}
                    onClick={() => setRegistryStatusFilter(dec)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                      registryStatusFilter === dec
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                    }`}
                  >
                    {dec}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-sans font-semibold">
                  <tr>
                    <th className="py-2.5 px-4">ID Заявки</th>
                    <th className="py-2.5 px-4">MASTER (Было)</th>
                    <th className="py-2.5 px-4">BETA (Стало)</th>
                    <th className="py-2.5 px-4 text-center">Расхождений (DIFF)</th>
                    <th className="py-2.5 px-4 text-right font-sans">Действие</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredApps.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-400 font-sans">
                        Заявок по заданному критерию не обнаружено
                      </td>
                    </tr>
                  ) : (
                    filteredApps.map((app, idx) => {
                      const appId = String(app.app_id || app.id || '');
                      const decBefore = app.beforeDecision || '—';
                      const decAfter = app.afterDecision || app.decision_after || '—';
                      const diffCnt = Number(app.diffCount ?? app.diff_count ?? 0);

                      return (
                        <tr
                          key={idx}
                          onClick={() => handleOpenDossier(appId)}
                          className="hover:bg-blue-50/40 cursor-pointer transition"
                        >
                          <td className="py-3 px-4 font-bold text-slate-900">{appId}</td>
                          <td className="py-3 px-4">{decBefore}</td>
                          <td className="py-3 px-4 font-bold text-slate-900">
                            <span className="px-2 py-0.5 rounded text-[11px] bg-slate-100 border border-slate-200">
                              {decAfter}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-center text-amber-700 font-bold">{diffCnt} шт.</td>
                          <td className="py-3 px-4 text-right font-sans">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenDossier(appId);
                              }}
                              className="bg-slate-900 hover:bg-blue-600 text-white px-3 py-1 rounded text-xs font-semibold transition cursor-pointer"
                            >
                              Открыть досье →
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      )}

      {/* ==========================================
          ВКЛАДКА 3: ЗАПУСК И ПАЙПЛАЙН
      ========================================== */}
      {activeTab === 'run' && (
        <main className="flex-1 p-6 max-w-5xl w-full mx-auto space-y-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h3 className="text-sm font-bold text-slate-800">Запуск нового бэктеста</h3>
            <p className="text-xs text-slate-500">
              Пользователь: <b>{currentUser.name} (ID: {currentUser.id})</b>
            </p>

            <button
              onClick={async () => {
                setIsPipelineRunning(true);
                setPipelineSeconds(0);
                if (timerRef.current) clearInterval(timerRef.current);
                timerRef.current = setInterval(() => setPipelineSeconds((s) => s + 1), 1000);

                try {
                  const res = await fetch(getApiUrl('/api/runs/'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: currentUser.id })
                  });
                  if (res.ok) {
                    const data = await res.json();
                    const newId = String(data.id || data.run_id);
                    setRunId(newId);
                    await fetchRunsList();
                    await fetchReportData(newId);
                  }
                } catch {}

                setTimeout(() => {
                  clearInterval(timerRef.current);
                  setIsPipelineRunning(false);
                  setActiveTab('matrix');
                }, 1500);
              }}
              disabled={isPipelineRunning}
              className="w-full py-2.5 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition shadow-sm cursor-pointer disabled:opacity-50"
            >
              {isPipelineRunning ? `Выполняется расчет (${pipelineSeconds} с)...` : '▶ Запустить новый прогон пайплайна'}
            </button>
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-3">
            <h3 className="text-sm font-bold text-slate-800">Журнал этапов пайплайна</h3>
            {(pipelineSteps.length > 0 ? pipelineSteps : [
              { name: '1. Загрузка JSON-файлов датасета', status: 'done', time: 'Готово' },
              { name: '2. Динамическая нормализация (Generic Flattener)', status: 'done', time: 'Готово' },
              { name: '3. Вертикальный UNION и расчет различий (DuckDB)', status: 'done', time: 'Готово' },
              { name: '4. Исполнение проверок риск-политики (Quality Gates)', status: 'done', time: 'Готово' }
            ]).map((s, idx) => (
              <div key={idx} className="flex justify-between items-center p-3 rounded-lg bg-slate-50 border border-slate-100 text-xs">
                <span className="font-semibold text-slate-700">{s.name || `Этап ${idx + 1}`}</span>
                <span className="text-[11px] font-mono text-slate-400">{s.time || s.status || 'OK'}</span>
              </div>
            ))}
          </div>
        </main>
      )}

      {/* ==========================================
          ПОЛНОЕ И ЧЕСТНОЕ ДОСЬЕ ЗАЯВКИ
      ========================================== */}
      {activeDossierAppId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm">
          <div className="bg-white w-full max-w-3xl h-full shadow-2xl flex flex-col p-6 overflow-hidden">
            <div className="flex justify-between items-start border-b border-slate-200 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-lg text-slate-800 font-mono">Досье анкеты: {activeDossierAppId}</h3>
                  <span className="text-xs bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded">
                    Строк: {dossierRows.length}
                  </span>
                  {isDossierLoading && (
                    <span className="text-xs text-blue-600 animate-pulse font-semibold">Запрос к FastAPI...</span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Данные из <code>/api/reports/{runId}/applications/{activeDossierAppId}/diff</code>
                </p>
              </div>
              <button
                onClick={() => setActiveDossierAppId(null)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold p-1 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto my-4 border border-slate-200 rounded-xl">
              {dossierRows.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  Для анкеты {activeDossierAppId} нет зарегистрированных расхождений
                </div>
              ) : (
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-sans font-semibold">
                    <tr>
                      <th className="py-2 px-3">Модуль (CLASS)</th>
                      <th className="py-2 px-3">Параметр (KEY)</th>
                      <th className="py-2 px-3 text-rose-700">VALUE_BEFORE</th>
                      <th className="py-2 px-3 text-emerald-700">VALUE_AFTER</th>
                      <th className="py-2 px-3 text-center">Статус</th>
                      <th className="py-2 px-3">Комментарий</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dossierRows.map((r, idx) => {
                      const isDiff = Number(r.DIFF_FLAG ?? r.diff_flag) === 1;
                      const comment = r.COMMENT || r.comment || '';

                      return (
                        <tr key={idx} className={isDiff ? 'bg-amber-50/50' : 'hover:bg-slate-50'}>
                          <td className="py-2 px-3 font-sans text-slate-600">{r.CLASS || r.class_name || r.PREFIX || '—'}</td>
                          <td className="py-2 px-3 font-bold text-slate-800">{r.ARRAY_KEY ? `${r.ARRAY_KEY}.${r.KEY || r.key}` : r.KEY || r.key}</td>
                          <td className="py-2 px-3 text-rose-600">{String(r.VALUE_BEFORE ?? r.value_before ?? '—')}</td>
                          <td className="py-2 px-3 text-emerald-600 font-bold">{String(r.VALUE_AFTER ?? r.value_after ?? '—')}</td>
                          <td className="py-2 px-3 text-center font-sans">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                              isDiff ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'
                            }`}>
                              {isDiff ? 'DIFF=1' : 'MATCH'}
                            </span>
                          </td>
                          <td className="py-2 px-3 font-sans text-slate-500 text-[11px]">{comment}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="border-t border-slate-200 pt-3 flex justify-end">
              <button
                onClick={() => setActiveDossierAppId(null)}
                className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Закрыть досье
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
          МОДАЛЬНОЕ ОКНО ДОБАВЛЕНИЯ АНАЛИТИКА
      ========================================== */}
      {isAddUserModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <form
            onSubmit={handleCreateAnalyst}
            className="bg-white rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-xl border border-slate-200"
          >
            <h3 className="font-bold text-sm text-slate-800">Создать профиль аналитика</h3>
            
            <div className="text-xs space-y-3">
              <div>
                <label className="block text-slate-500 mb-1">ФИО / Отображаемое имя</label>
                <input
                  type="text"
                  required
                  placeholder="например: Аналитик 3 (Ольга)"
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-slate-500 mb-1">Логин для API (username)</label>
                <input
                  type="text"
                  placeholder="olga"
                  value={newUserUsername}
                  onChange={(e) => setNewUserUsername(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 font-mono outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-slate-500 mb-1">Должность / Роль</label>
                <input
                  type="text"
                  placeholder="Risk Officer"
                  value={newUserRole}
                  onChange={(e) => setNewUserRole(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsAddUserModalOpen(false)}
                className="px-3 py-1.5 text-xs text-slate-600 cursor-pointer"
              >
                Отмена
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-blue-600 text-white rounded-lg transition cursor-pointer"
              >
                Создать профиль
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ==========================================
          ПРОСМОТР КОДА ПРОВЕРОК ИЗ РЕПОЗИТОРИЯ
      ========================================== */}
      {codeModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-2xl w-full max-w-3xl overflow-hidden flex flex-col text-white">
            <div className="px-5 py-3.5 border-b border-slate-800 flex justify-between items-center">
              <h3 className="font-bold text-sm text-slate-100">{codeModal.title}</h3>
              <button onClick={() => setCodeModal({ isOpen: false, title: '', code: '' })} className="text-slate-400 hover:text-white">✕</button>
            </div>
            <div className="p-3 bg-slate-950 font-mono text-xs">
              <CodeMirror
                value={codeModal.code}
                height="320px"
                theme="dark"
                extensions={[python()]}
                readOnly={true}
              />
            </div>
            <div className="px-5 py-3 border-t border-slate-800 flex justify-end bg-slate-900/80">
              <button
                onClick={() => setCodeModal({ isOpen: false, title: '', code: '' })}
                className="px-4 py-1.5 text-xs text-slate-300 hover:text-white bg-slate-800 rounded-lg cursor-pointer"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}