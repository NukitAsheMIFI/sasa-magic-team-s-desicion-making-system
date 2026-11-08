import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { REPO_PYTHON_SCRIPTS } from './checkScripts.js';

// ----------------------------------------------------
// Локальные данные для fallback-режима.
// import.meta.glob не падает на сборке, если файлов нет: просто вернёт пустой объект.
// ----------------------------------------------------
const pivotGlob = import.meta.glob('./data/08_pivot_facts_demo.json', { eager: true, import: 'default' });
const csvGlob = import.meta.glob('./data/06_comparison_app1001.csv', { eager: true, query: '?raw', import: 'default' });
const fallbackPivotFacts = Object.values(pivotGlob)[0] ?? [];
const fallbackComparisonCsv = Object.values(csvGlob)[0] ?? '';

// ----------------------------------------------------
// Конфигурация (единственное место с "знанием" о данных)
// ----------------------------------------------------
const DECISION_KEY = 'decision'; // KEY строки итогового решения (без ARRAY_KEY)
// Порядок строгости исходов: чем правее, тем жёстче. Неизвестные исходы нейтральны.
const SEVERITY = ['APPROVE', 'VERIFICATION', 'REFER', 'REJECT', 'DECLINE'];
const NO_VALUE = '—';
const ROWS_PER_MODULE = 50;
const APPS_PAGE = 100;
const HIGH_CARDINALITY = 300;
const POLL_MS = 2000;
const POLL_MAX = 300; // 10 минут
const TERMINAL_OK = ['completed', 'done', 'finished', 'success'];
const TERMINAL_FAIL = ['failed', 'error', 'cancelled'];
const STEP_LABELS = {
  load: 'Загрузка JSON-файлов датасета',
  normalize: 'Нормализация и расчёт различий (DuckDB)',
  checks: 'Исполнение проверок (Quality Gates)'
};

const LABEL_TO_CHECK_ID = Object.fromEntries(
  Object.entries(REPO_PYTHON_SCRIPTS).map(([id, code]) => [(code.match(/"label":\s*"([^"]+)"/) || [])[1], id])
);

// ----------------------------------------------------
// Утилиты
// ----------------------------------------------------
// Только относительные пути (/api/...): работает и через Vite Proxy, и в Docker
const api = (path) => path;

const getJson = async (path, signal) => {
  const res = await fetch(api(path), { signal });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isEmpty = (v) => v === null || v === undefined || v === '';
const normId = (x) => String(x ?? '').trim().replace(/^APP-/, '');
const fmtPct = (x) => (Number.isFinite(Number(x)) && x !== null ? `${(Number(x) * 100).toFixed(1)}%` : '—');
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const resolveModuleName = (row) => [row.PREFIX, row.CLASS].filter((x) => !isEmpty(x)).join(' › ') || 'Общие параметры';
const paramPath = (r) => [r.ARRAY_KEY ?? r.arrayKey, r.KEY ?? r.key].filter((x) => !isEmpty(x)).join('.');

const severityRank = (d) => {
  const i = SEVERITY.indexOf(String(d).toUpperCase());
  return i === -1 ? null : i;
};
const sortDecisions = (a, b) => {
  const ra = severityRank(a);
  const rb = severityRank(b);
  if (ra !== null && rb !== null) return ra - rb;
  if (ra !== null) return -1;
  if (rb !== null) return 1;
  return String(a).localeCompare(String(b));
};
const decisionClass = (d) => {
  const v = String(d).toUpperCase();
  if (v === '—') return 'bg-slate-100 text-slate-400';
  if (v === 'APPROVE') return 'bg-emerald-100 text-emerald-800 border border-emerald-200';
  if (v === 'REJECT' || v === 'DECLINE') return 'bg-rose-100 text-rose-800 border border-rose-200';
  return 'bg-amber-100 text-amber-800 border border-amber-200';
};

function parseSemicolonCsv(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].replace(/^﻿/, '').split(';').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(';').map((v) => v.trim());
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? '';
    });
    return row;
  });
}

// Реестр заявок для fallback-режима из демо-CSV
function buildAppsFromCsv(text) {
  const map = {};
  parseSemicolonCsv(text).forEach((r) => {
    const id = normId(r.APP_ID);
    if (!id) return;
    const a = (map[id] = map[id] || { app_id: id, id: `APP-${id}`, beforeDecision: null, afterDecision: null, diffCount: 0 });
    if (Number(r.DIFF_FLAG) === 1) a.diffCount += 1;
    if (r.KEY === DECISION_KEY && isEmpty(r.ARRAY_KEY)) {
      a.beforeDecision = r.ADJUSTED_BEFORE || r.VALUE_BEFORE || null;
      a.afterDecision = r.ADJUSTED_AFTER || r.VALUE_AFTER || null;
    }
  });
  return Object.values(map);
}

const parseIds = (v) => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* не JSON */
    }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
};

const normalizeCheck = (c) => {
  const label = c.LABEL ?? c.label ?? '—';
  return {
    LABEL: label,
    ARGUMENT: c.ARGUMENT ?? c.argument ?? '',
    CNT: Number(c.CNT ?? c.cnt ?? 0),
    TOTAL: Number(c.TOTAL ?? c.total ?? 0),
    METRIC: c.METRIC ?? c.metric ?? null,
    RESULT: String(c.RESULT ?? c.result ?? '').toUpperCase(),
    CONFIDENCE: c.CONFIDENCE ?? c.confidence ?? null,
    APP_IDS: parseIds(c.APP_IDS ?? c.app_ids),
    CHECK_ID: c.CHECK_ID ?? c.check_id ?? LABEL_TO_CHECK_ID[label] ?? null,
    ESTIMATE: false
  };
};

// Порог пользовательской проверки: "5%", "0.05", "5" (число больше 1 считается процентами)
const parseThreshold = (t) => {
  const m = String(t ?? '').trim().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(%?)$/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] ? v / 100 : v > 1 ? v / 100 : v;
};

// Значение ячейки: пустое показываем как «нет» (атрибут отсутствовал до/после)
const Cell = ({ v }) =>
  isEmpty(v) ? <span className="text-slate-300 italic font-sans">нет</span> : <span>{String(v)}</span>;

export default function App() {
  const [activeTab, setActiveTab] = useState('matrix');
  const [apiStatus, setApiStatus] = useState('checking'); // checking | connected | fallback
  const [runId, setRunId] = useState(null);
  const [availableRuns, setAvailableRuns] = useState([]);
  const [isLoadingApi, setIsLoadingApi] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Вход по логину (без пароля): POST /api/auth/login → {id, username}. Сессия хранится в localStorage.
  const [session, setSession] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('spr_session_v1') || 'null');
      return saved && (saved.demo || saved.id != null) ? saved : null;
    } catch {
      return null;
    }
  });
  const [loginName, setLoginName] = useState('');
  const [loginError, setLoginError] = useState(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const currentUser = useMemo(
    () => ({
      id: session?.id ?? 'demo',
      name: session?.username ?? 'demo',
      username: session?.username ?? 'demo',
      backendId: session?.demo ? null : session?.id ?? null
    }),
    [session]
  );

  const saveSession = (sess) => {
    setSession(sess);
    try {
      if (sess) localStorage.setItem('spr_session_v1', JSON.stringify(sess));
      else localStorage.removeItem('spr_session_v1');
    } catch {
      /* localStorage недоступен */
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    const username = loginName.trim();
    if (!username || loginBusy) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      const res = await fetch(api('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.id == null) throw new Error('в ответе нет id пользователя');
      saveSession({ id: data.id, username: data.username ?? username });
    } catch (err) {
      setLoginError(`Не удалось войти: ${err.message}`);
    } finally {
      setLoginBusy(false);
    }
  };

  // Данные прогона
  const [pivotFacts, setPivotFacts] = useState([]);
  const [rawApplications, setRawApplications] = useState([]);
  const [rawDbChecks, setRawDbChecks] = useState([]);
  const [pipelineSteps, setPipelineSteps] = useState([]);

  // Пайплайн
  const [isPipelineRunning, setIsPipelineRunning] = useState(false);
  const [pipelineSeconds, setPipelineSeconds] = useState(0);
  const [pipelineError, setPipelineError] = useState(null);
  const [aiSummary, setAiSummary] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const aiReqRef = useRef(0);
  const [runTag, setRunTag] = useState('Сравнение MASTER vs BETA');

  // Свои входные данные: JSON до (MASTER) и после (BETA), загружаются на бэкенд перед запуском прогона
  const [dsName, setDsName] = useState('');
  const [beforeFiles, setBeforeFiles] = useState([]);
  const [afterFiles, setAfterFiles] = useState([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [uploadedDataset, setUploadedDataset] = useState(null); // конфиг, который вернул бэкенд
  const timerRef = useRef(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearInterval(timerRef.current);
    };
  }, []);

  // Фильтры витрины
  const [selectedPivotFilter, setSelectedPivotFilter] = useState(null);
  const [activeInvestigateCheck, setActiveInvestigateCheck] = useState(null);
  const [waterfallTargetBucket, setWaterfallTargetBucket] = useState(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [onlyDiffRows, setOnlyDiffRows] = useState(true);
  const [significantOnly, setSignificantOnly] = useState(false);
  const [sortMode, setSortMode] = useState('impact');
  const [expandedModules, setExpandedModules] = useState({});
  const [rowLimits, setRowLimits] = useState({});
  const [expandedChecks, setExpandedChecks] = useState({});

  // Реестр
  const [registryStatusFilter, setRegistryStatusFilter] = useState('ALL');
  const [registrySearch, setRegistrySearch] = useState('');
  const [registryLimit, setRegistryLimit] = useState(APPS_PAGE);

  // Досье
  const [activeDossierAppId, setActiveDossierAppId] = useState(null);
  const [dossierRows, setDossierRows] = useState([]);
  const [isDossierLoading, setIsDossierLoading] = useState(false);
  const [dossierError, setDossierError] = useState(null);
  const [dossierOnlyDiff, setDossierOnlyDiff] = useState(true);
  const [dossierSearch, setDossierSearch] = useState('');
  const dossierReq = useRef(0);

  const [codeModal, setCodeModal] = useState({ isOpen: false, title: '', code: '' });

  // Пользовательские Quality Gates (бэкенд пока не умеет их сохранять и запускать, поэтому хранятся локально)
  const CUSTOM_TEMPLATE = `# df: pandas DataFrame строк сравнения прогона (MASTER vs BETA).
# Колонки: APP_ID, PREFIX, CLASS, SUFFIX, ARRAY_KEY, KEY, VALUE_BEFORE, VALUE_AFTER,
#          ADJUSTED_BEFORE, ADJUSTED_AFTER, DIFF_FLAG
# Функция run возвращает список срезов: label, argument, cnt, total (+ необязательно app_ids, metric, result).
def run(df):
    d = df[(df["PREFIX"] == "decisionResult") & (df["CLASS"] == "decision") & (df["KEY"] == "decision")]
    lost = d[(d["VALUE_BEFORE"] == "APPROVE") & (d["VALUE_AFTER"] != "APPROVE")]
    return [{
        "label": "Потеряны одобрения",
        "argument": "APPROVE -> не APPROVE",
        "cnt": int(len(lost)),
        "total": int(len(d)),
        "app_ids": lost["APP_ID"].astype(str).tolist(),
    }]
`;
  const [customChecks, setCustomChecks] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('spr_custom_checks_v1') || '[]');
    } catch {
      return [];
    }
  });
  const [isAddCheckOpen, setIsAddCheckOpen] = useState(false);
  const [ccError, setCcError] = useState(null);
  const [customRuns, setCustomRuns] = useState({}); // id → {status: running|done|error, rows, error}
  const [ccName, setCcName] = useState('');
  const [ccModule, setCcModule] = useState('');
  const [ccThreshold, setCcThreshold] = useState('');
  const [ccCode, setCcCode] = useState(CUSTOM_TEMPLATE);
  useEffect(() => {
    try {
      localStorage.setItem('spr_custom_checks_v1', JSON.stringify(customChecks));
    } catch {
      /* localStorage недоступен */
    }
  }, [customChecks]);

  // Esc закрывает модалки
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setCodeModal((m) => (m.isOpen ? { isOpen: false, title: '', code: '' } : m));
      setIsAddCheckOpen(false);
      setActiveDossierAppId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ----------------------------------------------------
  // Загрузка данных
  // ----------------------------------------------------
  const fetchRunsList = useCallback(async () => {
    try {
      const res = await fetch(api('/api/runs/'));
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          const sorted = [...data].sort((a, b) => Number(b.id) - Number(a.id)); // новые первыми
          setAvailableRuns(sorted);
          setRunId((prev) => prev || String(sorted[0].id));
          setApiStatus('connected');
          return sorted;
        }
      }
    } catch {
      /* бэкенд недоступен */
    }
    setApiStatus('fallback');
    setRunId((prev) => prev || 'demo');
    return [];
  }, []);

  const resetRunState = useCallback(() => {
    setPivotFacts([]);
    setRawApplications([]);
    setRawDbChecks([]);
    setPipelineSteps([]);
    setActiveInvestigateCheck(null);
    setSelectedPivotFilter(null);
    setWaterfallTargetBucket(null);
    setExpandedModules({});
    setRowLimits({});
    setRegistryLimit(APPS_PAGE);
    setRegistryStatusFilter('ALL');
    setLoadError(null);
  }, []);

  const loadDemo = useCallback(() => {
    resetRunState();
    setPivotFacts(Array.isArray(fallbackPivotFacts) ? fallbackPivotFacts : []);
    setRawApplications(buildAppsFromCsv(fallbackComparisonCsv));
  }, [resetRunState]);

  // Заявки: пробуем limit/offset, чтобы обойти лимит бэкенда. Если параметры не поддерживаются,
  // повторные страницы не дадут новых app_id и цикл остановится на первой странице.
  const fetchAllApplications = async (id, signal) => {
    const SIZE = 5000;
    const seen = new Set();
    const all = [];
    let offset = 0;
    for (let i = 0; i < 20; i += 1) {
      const page = await getJson(`/api/reports/${id}/applications?limit=${SIZE}&offset=${offset}`, signal);
      if (!Array.isArray(page) || page.length === 0) break;
      let added = 0;
      for (const a of page) {
        const key = String(a.app_id ?? a.id);
        if (!seen.has(key)) {
          seen.add(key);
          all.push(a);
          added += 1;
        }
      }
      if (added === 0 || page.length < 100 || page.length % 100 !== 0) break; // новых нет или явно последняя страница
      offset += page.length;
    }
    return all;
  };

  const loadReport = useCallback(
    async (id, signal) => {
      resetRunState();
      setIsLoadingApi(true);
      const optional = (p) =>
        p.catch((e) => {
          if (e.name === 'AbortError') throw e;
          return [];
        });
      try {
        const [facts, checks, apps, steps] = await Promise.all([
          getJson(`/api/reports/${id}/pivot-facts`, signal),
          optional(getJson(`/api/reports/${id}/checks`, signal)),
          optional(fetchAllApplications(id, signal)),
          optional(getJson(`/api/runs/${id}/steps`, signal))
        ]);
        if (signal.aborted) return;
        setPivotFacts(Array.isArray(facts) ? facts : []);
        setRawDbChecks(Array.isArray(checks) ? checks : []);
        setRawApplications(Array.isArray(apps) ? apps : []);
        setPipelineSteps(Array.isArray(steps) ? steps : []);
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (e instanceof TypeError) setApiStatus('fallback'); // сеть пропала
        else setLoadError(e.message || String(e));
      } finally {
        if (!signal.aborted) setIsLoadingApi(false);
      }
    },
    [resetRunState]
  );

  const fetchSteps = useCallback(async (id) => {
    try {
      const res = await fetch(api(`/api/runs/${id}/steps`));
      if (res.ok) {
        const s = await res.json();
        if (Array.isArray(s)) {
          setPipelineSteps(s);
          return s;
        }
      }
    } catch {
      /* пропускаем тик */
    }
    return [];
  }, []);

  useEffect(() => {
    fetchRunsList();
  }, [fetchRunsList]);

  useEffect(() => {
    if (apiStatus === 'checking') return undefined;
    if (apiStatus === 'fallback') {
      loadDemo();
      return undefined;
    }
    if (!runId) return undefined;
    const ctrl = new AbortController();
    loadReport(runId, ctrl.signal);
    return () => ctrl.abort();
  }, [apiStatus, runId, loadReport, loadDemo]);

  // ----------------------------------------------------
  // Аналитики и запуск прогона
  // ----------------------------------------------------
  const pollRun = useCallback(
    async (id, initialStatus) => {
      let status = String(initialStatus || '').toLowerCase();
      for (let i = 0; i < POLL_MAX; i += 1) {
        if (!aliveRef.current) return;
        await fetchSteps(id);
        if (TERMINAL_OK.includes(status) || TERMINAL_FAIL.includes(status)) break;
        await sleep(POLL_MS);
        try {
          const res = await fetch(api('/api/runs/'));
          if (res.ok) {
            const list = await res.json();
            const r = Array.isArray(list) ? list.find((x) => String(x.id) === id) : null;
            if (r) status = String(r.status || '').toLowerCase();
          }
        } catch {
          /* следующий тик */
        }
      }
      if (TERMINAL_FAIL.includes(status)) throw new Error(`Прогон завершился со статусом «${status}»`);
    },
    [fetchSteps]
  );

  // Запуск пользовательской проверки на бэкенде: POST /api/reports/{run_id}/checks/custom
  const runCustomCheck = async (c) => {
    if (!runId || apiStatus !== 'connected') return;
    setCustomRuns((m) => ({ ...m, [c.id]: { status: 'running' } }));
    try {
      const res = await fetch(api(`/api/reports/${runId}/checks/custom`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: c.name, module: c.module, threshold: c.threshold, code: c.code })
      });
      if (!res.ok) {
        let detail = '';
        try {
          const j = await res.json();
          detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j);
        } catch {
          detail = await res.text().catch(() => '');
        }
        throw new Error(`HTTP ${res.status}: ${String(detail).slice(-800)}`);
      }
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.results ?? data.checks ?? [];
      const thr = parseThreshold(c.threshold);
      const rows = list.map(normalizeCheck).map((r) => {
        let result = r.RESULT === 'PASS' || r.RESULT === 'FAIL' ? r.RESULT : null;
        const metric = r.METRIC !== null && r.METRIC !== undefined ? Number(r.METRIC) : r.TOTAL > 0 ? r.CNT / r.TOTAL : null;
        if (!result) result = thr !== null && metric !== null ? (metric > thr ? 'FAIL' : 'PASS') : r.CNT > 0 ? 'FAIL' : 'PASS';
        return { ...r, LABEL: r.LABEL === '—' ? c.name : r.LABEL, METRIC: metric, RESULT: result };
      });
      setCustomRuns((m) => ({ ...m, [c.id]: { status: 'done', rows } }));
    } catch (e) {
      setCustomRuns((m) => ({ ...m, [c.id]: { status: 'error', error: e.message || String(e) } }));
    }
  };

  const jsonOnly = (list) => Array.from(list || []).filter((f) => f.name.toLowerCase().endsWith('.json'));
  const baseName = (f) => f.name.replace(/\.json$/i, '');
  const pairInfo = useMemo(() => {
    const a = new Set(afterFiles.map(baseName));
    const b = new Set(beforeFiles.map(baseName));
    return {
      paired: beforeFiles.filter((f) => a.has(baseName(f))).length,
      onlyBefore: beforeFiles.filter((f) => !a.has(baseName(f))).length,
      onlyAfter: afterFiles.filter((f) => !b.has(baseName(f))).length
    };
  }, [beforeFiles, afterFiles]);

  // POST /api/datasets (multipart): dataset_name, before[], after[]  → {datasetName, sourceDir} или {config: {...}}
  const uploadDataset = async () => {
    if (uploadBusy) return;
    setUploadError(null);
    setUploadedDataset(null);
    if (apiStatus !== 'connected') return setUploadError('Бэкенд недоступен: загрузка возможна только в режиме ONLINE.');
    if (!dsName.trim()) return setUploadError('Укажите название набора данных.');
    if (pairInfo.paired === 0) return setUploadError('Нет пар файлов: у BEFORE и AFTER должны совпадать имена (например I32554354.json).');
    setUploadBusy(true);
    try {
      const fd = new FormData();
      fd.append('dataset_name', dsName.trim());
      beforeFiles.forEach((f) => fd.append('before', f, f.name));
      afterFiles.forEach((f) => fd.append('after', f, f.name));
      const res = await fetch(api('/api/datasets'), { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json().catch(() => ({}));
      const config = data.config ?? {
        datasetName: data.datasetName ?? data.dataset_name ?? dsName.trim(),
        ...(data.sourceDir ?? data.source_dir ? { sourceDir: data.sourceDir ?? data.source_dir } : {})
      };
      setUploadedDataset({ config, pairs: pairInfo.paired });
    } catch (e) {
      setUploadError(`Не удалось загрузить данные: ${e.message}`);
    } finally {
      setUploadBusy(false);
    }
  };

  const startRun = async () => {
    if (isPipelineRunning) return;
    setIsPipelineRunning(true);
    setPipelineError(null);
    setPipelineSeconds(0);
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setPipelineSeconds((s) => s + 1), 1000);

    try {
      if (apiStatus !== 'connected') throw new Error('Бэкенд недоступен: запуск возможен только в режиме ONLINE.');
      const user = currentUser;
      if (user.backendId == null) throw new Error('Нужен вход под логином при подключённом бэкенде. Нажмите «Выйти» и войдите заново.');
      const baseConfig = availableRuns[0]?.config ?? {};
      const res = await fetch(api('/api/runs/'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: user.backendId,
          config: { ...baseConfig, ...(uploadedDataset?.config ?? {}), runTag: runTag.trim() || baseConfig.runTag || 'run' }
        })
      });
      if (!res.ok) throw new Error(`POST /api/runs/ → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const run = await res.json();
      const newId = String(run.id);
      setRunId(newId);
      await pollRun(newId, run.status);
      if (!aliveRef.current) return;
      await fetchRunsList();
      await loadReport(newId, new AbortController().signal);
      setActiveTab('matrix');
    } catch (e) {
      setPipelineError(String(e.message || e));
    } finally {
      clearInterval(timerRef.current);
      setIsPipelineRunning(false);
    }
  };

  // ----------------------------------------------------
  // Заявки
  // ----------------------------------------------------
  const applications = useMemo(() => {
    const clean = (v) => (v && String(v).toUpperCase() !== 'UNKNOWN' ? String(v).toUpperCase() : '—');
    // ищем поле решения по имени без учёта регистра и разделителей: beforeDecision / before_decision / decision_before / master_decision ...
    const pick = (app, side) => {
      const names = side === 'before' ? ['before', 'master'] : ['after', 'beta'];
      for (const k of Object.keys(app)) {
        const low = k.toLowerCase().replace(/[^a-z]/g, '');
        if (low.includes('decision') && names.some((n) => low.includes(n))) return app[k];
      }
      return null;
    };
    return rawApplications.map((app) => {
      const rawId = normId(app.app_id ?? app.id);
      return {
        app_id: rawId,
        id: `APP-${rawId}`,
        beforeDecision: clean(pick(app, 'before')),
        afterDecision: clean(pick(app, 'after')),
        diffCount: Number(app.diffCount ?? app.diff_count ?? 0)
      };
    });
  }, [rawApplications]);

  const hasDecisions = useMemo(
    () => applications.some((a) => a.beforeDecision !== '—' || a.afterDecision !== '—'),
    [applications]
  );
  const changedApps = useMemo(() => applications.filter((a) => a.diffCount > 0).length, [applications]);

  // ----------------------------------------------------
  // Агрегация витрины (честный баланс: Было − Ушло + Пришло = Стало)
  // ----------------------------------------------------
  const { decisionRows, moduleBlocks, summaryMetrics, calculatedRows } = useMemo(() => {
    const map = {};

    pivotFacts.forEach((row) => {
      const mod = resolveModuleName(row);
      const arrKey = isEmpty(row.ARRAY_KEY) ? '' : String(row.ARRAY_KEY);
      const key = isEmpty(row.KEY) ? '' : String(row.KEY);
      const rawVal = [row.VALUE_ADJUSTED, row.VALUE_AFTER, row.VALUE_BEFORE].find((v) => !isEmpty(v));
      const val = isEmpty(rawVal) ? NO_VALUE : String(rawVal);
      const rowId = `${mod}\u0001${arrKey}\u0001${key}\u0001${val}`;

      if (!map[rowId]) {
        map[rowId] = { id: rowId, module: mod, arrayKey: arrKey, key, value: val, stableCount: 0, leftCount: 0, arrivedCount: 0 };
      }

      const count = Number(row.CNT) || 0;
      const isDiff = Number(row.DIFF_FLAG) === 1;
      const isBefore = String(row.SOURCE || '').toUpperCase().includes('BEFORE');

      if (!isDiff) {
        if (isBefore) map[rowId].stableCount += count; // BEFORE и AFTER для DIFF=0 равны, считаем один раз
      } else if (isBefore) {
        map[rowId].leftCount += count;
      } else {
        map[rowId].arrivedCount += count;
      }
    });

    const calc = Object.values(map).map((r) => {
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

    // Итоговое решение: строки с KEY=decision без ARRAY_KEY. Если таких модулей несколько, берём самый "массовый".
    const candidates = calc.filter((r) => r.key.toLowerCase() === DECISION_KEY && !r.arrayKey);
    const byModule = {};
    candidates.forEach((r) => {
      byModule[r.module] = (byModule[r.module] || 0) + r.masterTotal;
    });
    const primaryDecModule = Object.keys(byModule).sort((a, b) => byModule[b] - byModule[a])[0];
    const primaryDecRows = candidates.filter((r) => r.module === primaryDecModule).sort((a, b) => sortDecisions(a.value, b.value));

    const totalPortfolio = primaryDecRows.reduce((s, r) => s + r.masterTotal, 0);
    const totalFlips = primaryDecRows.reduce((s, r) => s + r.leftCount, 0);

    const groups = {};
    calc.forEach((r) => {
      if (!groups[r.module]) {
        groups[r.module] = { name: r.module, rows: [], totalDiffChanges: 0, maxAffectedClients: 0, maxAbsDelta: 0 };
      }
      const g = groups[r.module];
      g.rows.push(r);
      g.totalDiffChanges += r.totalChanges;
      g.maxAffectedClients = Math.max(g.maxAffectedClients, r.maxAffectedClients);
      g.maxAbsDelta = Math.max(g.maxAbsDelta, r.absDelta);
    });

    return {
      calculatedRows: calc,
      decisionRows: primaryDecRows,
      moduleBlocks: Object.values(groups),
      summaryMetrics: {
        totalPortfolio,
        totalFlips,
        flipsPct: totalPortfolio > 0 ? ((totalFlips / totalPortfolio) * 100).toFixed(1) : '0.0'
      }
    };
  }, [pivotFacts]);

  // Список заявок покрывает все смены решения: бэкенд может отдавать не весь портфель, а только заявки с расхождениями
  const flipsCovered = useMemo(() => {
    if (!hasDecisions) return false;
    const changed = applications.filter((a) => a.beforeDecision !== '—' && a.afterDecision !== '—' && a.beforeDecision !== a.afterDecision).length;
    return changed >= summaryMetrics.totalFlips && summaryMetrics.totalFlips > 0;
  }, [applications, hasDecisions, summaryMetrics.totalFlips]);


  const portfolioSize = summaryMetrics.totalPortfolio || applications.length;

  const uniqueDecisions = useMemo(() => {
    const set = new Set();
    applications.forEach((a) => {
      if (a.afterDecision !== '—') set.add(a.afterDecision);
      if (a.beforeDecision !== '—') set.add(a.beforeDecision);
    });
    decisionRows.forEach((r) => {
      if (r.value !== NO_VALUE) set.add(r.value);
    });
    return Array.from(set).sort(sortDecisions);
  }, [applications, decisionRows]);

  // ----------------------------------------------------
  // Проверки: данные бэка, а при их отсутствии честные оценки по витрине
  // ----------------------------------------------------
  const estimatedChecks = useMemo(() => {
    const total = portfolioSize || 1;
    const out = [];

    const approveRow = decisionRows.find((r) => r.value.toUpperCase() === 'APPROVE');
    if (approveRow && approveRow.masterTotal > 0) {
      const rel = (approveRow.masterTotal - approveRow.betaTotal) / approveRow.masterTotal;
      out.push({
        LABEL: 'Approval Rate упал',
        ARGUMENT: `APPROVE: ${approveRow.masterTotal} → ${approveRow.betaTotal}`,
        CNT: approveRow.leftCount,
        TOTAL: total,
        METRIC: Number(rel.toFixed(4)),
        RESULT: rel > 0.1 ? 'FAIL' : 'PASS',
        CONFIDENCE: null,
        APP_IDS: [],
        CHECK_ID: 'ar_drop_by_product',
        ESTIMATE: true
      });
    }

    const lost = {};
    calculatedRows.forEach((r) => {
      if (r.key.toLowerCase() !== 'hit' || r.leftCount <= 0) return;
      if (String(r.value).toLowerCase() !== 'true') return;
      const rule = r.arrayKey.split('|').pop() || r.arrayKey;
      lost[rule] = Math.max(lost[rule] || 0, r.leftCount); // по продуктам заявки пересекаются, суммировать нельзя
    });
    Object.entries(lost)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([rule, cnt]) => {
        out.push({
          LABEL: 'Стоп-фактор перестал срабатывать',
          ARGUMENT: `${rule} (макс. по продукту)`,
          CNT: cnt,
          TOTAL: total,
          METRIC: Number((cnt / total).toFixed(4)),
          RESULT: 'FAIL',
          CONFIDENCE: cnt < 5 ? 'LOW' : 'HIGH',
          APP_IDS: [],
          CHECK_ID: 'stop_factor_disappeared',
          ESTIMATE: true
        });
      });

    return out;
  }, [decisionRows, calculatedRows, portfolioSize]);

  const checksResults = useMemo(
    () => (rawDbChecks.length > 0 ? rawDbChecks.map(normalizeCheck) : estimatedChecks),
    [rawDbChecks, estimatedChecks]
  );
  const checksAreEstimates = rawDbChecks.length === 0;

  // Бэкенд отдаёт много срезов на одну проверку (по продукту, по пути атрибута).
  // Группируем по названию: проверка = FAIL, если упал хотя бы один срез.
  const checkGroups = useMemo(() => {
    const map = new Map();
    checksResults.forEach((c) => {
      if (!map.has(c.LABEL)) map.set(c.LABEL, { label: c.LABEL, checkId: c.CHECK_ID, items: [] });
      const g = map.get(c.LABEL);
      g.items.push(c);
      if (!g.checkId && c.CHECK_ID) g.checkId = c.CHECK_ID;
    });
    return [...map.values()].map((g) => {
      const items = [...g.items].sort((a, b) => b.CNT - a.CNT);
      const fails = items.filter((i) => i.RESULT === 'FAIL').length;
      const metrics = items.map((i) => Number(i.METRIC)).filter((m) => Number.isFinite(m));
      return {
        ...g,
        items,
        fails,
        result: fails > 0 ? 'FAIL' : 'PASS',
        estimate: items.some((i) => i.ESTIMATE),
        maxCnt: Math.max(...items.map((i) => i.CNT)),
        maxMetric: metrics.length ? Math.max(...metrics) : null
      };
    });
  }, [checksResults]);

  // Waterfall
  const activeWaterfallRow = useMemo(() => {
    if (decisionRows.length === 0) return null;
    return decisionRows.find((r) => r.value === (waterfallTargetBucket || decisionRows[0].value)) || decisionRows[0];
  }, [decisionRows, waterfallTargetBucket]);

  // ----------------------------------------------------
  // Фильтрация витрины модулей
  // ----------------------------------------------------
  const filteredBlocks = useMemo(() => {
    const q = searchFilter.toLowerCase().trim();

    const list = moduleBlocks
      .map((block) => {
        const rows = block.rows.filter((r) => {
          if (onlyDiffRows && r.totalChanges === 0) return false;
          if (significantOnly && r.maxAffectedClients < 10) return false;
          if (q) {
            const hay = `${r.module} ${r.arrayKey} ${r.key} ${r.value}`.toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
        rows.sort((a, b) => {
          if (sortMode === 'impact') return b.maxAffectedClients - a.maxAffectedClients || b.totalChanges - a.totalChanges;
          if (sortMode === 'delta') return b.absDelta - a.absDelta;
          return paramPath(a).localeCompare(paramPath(b));
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

  const expandChanged = () => {
    const next = {};
    filteredBlocks.forEach((b) => {
      if (b.totalDiffChanges > 0 && b.rows.length <= HIGH_CARDINALITY) next[b.name] = true;
    });
    setExpandedModules(next);
  };

  // ----------------------------------------------------
  // Реестр заявок
  // ----------------------------------------------------
  const filteredApps = useMemo(() => {
    const q = registrySearch.toLowerCase().trim();
    const invSet = activeInvestigateCheck ? new Set(activeInvestigateCheck.appIds.map(normId)) : null;
    const target = selectedPivotFilter ? String(selectedPivotFilter.value).toUpperCase() : null;

    const risk = (a) => {
      const rb = severityRank(a.beforeDecision);
      const ra = severityRank(a.afterDecision);
      return rb !== null && ra !== null ? ra - rb : 0;
    };

    return applications
      .filter((app) => {
        if (q && !app.app_id.toLowerCase().includes(q)) return false;
        if (invSet && !invSet.has(app.app_id)) return false;
        if (registryStatusFilter !== 'ALL' && app.afterDecision !== registryStatusFilter && app.beforeDecision !== registryStatusFilter) {
          return false;
        }
        if (selectedPivotFilter) {
          if (!hasDecisions) return app.diffCount > 0; // решений от бэка нет, остаётся только факт расхождения
          if (selectedPivotFilter.direction === 'LEFT') return app.beforeDecision === target && app.afterDecision !== target;
          if (selectedPivotFilter.direction === 'ARRIVED') return app.afterDecision === target && app.beforeDecision !== target;
          return app.diffCount > 0;
        }
        return true;
      })
      .sort((a, b) => risk(b) - risk(a) || b.diffCount - a.diffCount); // срывы наверх
  }, [applications, registrySearch, activeInvestigateCheck, registryStatusFilter, selectedPivotFilter, hasDecisions]);

  const getAppDriverBadge = (app) => {
    const b = app.beforeDecision;
    const a = app.afterDecision;
    if (b !== '—' && a !== '—' && b !== a) {
      const rb = severityRank(b);
      const ra = severityRank(a);
      if (rb !== null && ra !== null && ra > rb) {
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-rose-100 text-rose-800 border border-rose-200">
            ● Ужесточение: {b} → {a}
          </span>
        );
      }
      if (rb !== null && ra !== null && ra < rb) {
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
            ● Смягчение: {b} → {a}
          </span>
        );
      }
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-blue-50 text-blue-800 border border-blue-200">
          ● Смена решения: {b} → {a}
        </span>
      );
    }
    if (app.diffCount > 0) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200">
          Сдвиг параметров ({app.diffCount} diff)
        </span>
      );
    }
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] text-slate-400">Стабильно (MATCH)</span>;
  };

  // Сброс резюме при смене прогона
  useEffect(() => {
    aiReqRef.current += 1;
    setCustomRuns({});
    setAiSummary(null);
    setAiError(null);
    setAiLoading(false);
  }, [runId]);

  const generateAiSummary = async () => {
    if (!runId || aiLoading) return;
    const req = ++aiReqRef.current;
    setAiLoading(true);
    setAiError(null);
    try {
      // минимум 1 секунда индикатора, чтобы анимация не мигала
      const [data] = await Promise.all([getJson(`/api/reports/${runId}/ai-summary`), sleep(1000)]);
      if (req !== aiReqRef.current) return;
      if (data && typeof data === 'object' && String(data.status || '').toLowerCase() === 'error') {
        throw new Error(data.summary ?? data.message ?? 'бэкенд вернул status=error');
      }
      let text = data;
      if (data && typeof data === 'object') {
        text = data.summary ?? data.text ?? data.content ?? data.message ?? data.result ?? data.ai_summary ?? JSON.stringify(data, null, 2);
      }
      setAiSummary(String(text ?? '').trim() || 'Бэкенд вернул пустое резюме.');
    } catch (e) {
      if (req !== aiReqRef.current) return;
      setAiError(e.message || String(e));
    } finally {
      if (req === aiReqRef.current) setAiLoading(false);
    }
  };

  const handleInvestigateCheck = (check) => {
    // Для проверки падения Approval Rate список считаем сами: APPROVE → не APPROVE (бэк отдаёт максимум первые N)
    const isAr = check.CHECK_ID === 'ar_drop_by_product' || /approval\s*rate/i.test(check.LABEL || '');
    let ids = check.APP_IDS || [];
    let cnt = check.CNT;
    if (isAr && hasDecisions && flipsCovered) {
      const failed = applications
        .filter((a) => a.beforeDecision === 'APPROVE' && a.afterDecision !== 'APPROVE')
        .map((a) => a.app_id);
      if (failed.length) {
        ids = failed;
        cnt = failed.length;
      }
    }
    if (ids.length === 0) return;
    setActiveInvestigateCheck({ label: check.LABEL, argument: check.ARGUMENT, appIds: ids, cnt });
    setRegistryStatusFilter('ALL');
    setSelectedPivotFilter(null);
    setRegistryLimit(APPS_PAGE);
    setActiveTab('registry');
  };

  // ----------------------------------------------------
  // Досье
  // ----------------------------------------------------
  const handleOpenDossier = useCallback(
    async (rawAppId) => {
      const clean = normId(rawAppId);
      if (!clean) return;
      const reqNo = (dossierReq.current += 1);
      setActiveDossierAppId(clean);
      setDossierRows([]);
      setDossierError(null);
      setDossierSearch('');
      setIsDossierLoading(true);

      let rows = null;
      if (apiStatus === 'connected') {
        try {
          const res = await fetch(api(`/api/reports/${runId}/applications/${encodeURIComponent(clean)}/diff`));
          if (res.ok) rows = await res.json();
          else setDossierError(`Бэкенд ответил HTTP ${res.status}`);
        } catch (e) {
          setDossierError(String(e.message || e));
        }
      }
      if (reqNo !== dossierReq.current) return; // пришёл ответ на устаревший клик

      if ((!Array.isArray(rows) || rows.length === 0) && apiStatus === 'fallback' && fallbackComparisonCsv) {
        rows = parseSemicolonCsv(fallbackComparisonCsv).filter((r) => normId(r.APP_ID) === clean);
      }
      setDossierRows(Array.isArray(rows) ? rows : []);
      setIsDossierLoading(false);
    },
    [runId, apiStatus]
  );

  const visibleDossierRows = useMemo(() => {
    const q = dossierSearch.toLowerCase().trim();
    return dossierRows
      .filter((r) => !dossierOnlyDiff || Number(r.DIFF_FLAG) === 1)
      .filter((r) => {
        if (!q) return true;
        const hay = `${r.PREFIX} ${r.CLASS} ${paramPath(r)} ${r.VALUE_BEFORE} ${r.VALUE_AFTER} ${r.COMMENT}`.toLowerCase();
        return hay.includes(q);
      });
  }, [dossierRows, dossierOnlyDiff, dossierSearch]);

  const diffRowsCount = useMemo(() => dossierRows.filter((r) => Number(r.DIFF_FLAG) === 1).length, [dossierRows]);

  // ----------------------------------------------------
  // Экспорт HTML
  // ----------------------------------------------------
  const handleExportHtml = () => {
    const reportDate = new Date().toLocaleString('ru-RU');
    const runInfo = availableRuns.find((r) => String(r.id) === String(runId));
    const rows = checksResults
      .map(
        (c) => `
          <tr>
            <td><b>${escapeHtml(c.LABEL)}</b>${c.ESTIMATE ? ' <i>(оценка по витрине)</i>' : ''}</td>
            <td><code>${escapeHtml(c.ARGUMENT)}</code></td>
            <td>${escapeHtml(c.METRIC === null ? '—' : fmtPct(c.METRIC))}</td>
            <td>${escapeHtml(c.CNT)} из ${escapeHtml(c.TOTAL || '—')}</td>
            <td><span class="${c.RESULT === 'PASS' ? 'badge-pass' : 'badge-fail'}">${escapeHtml(c.RESULT)}</span></td>
          </tr>`
      )
      .join('');
    const decRows = decisionRows
      .map(
        (r) => `<tr><td>${escapeHtml(r.value)}</td><td>${r.masterTotal}</td><td>-${r.leftCount}</td><td>+${r.arrivedCount}</td><td>${r.betaTotal}</td></tr>`
      )
      .join('');

    const content = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>СПР • Аудит кредитного риска — Прогон #${escapeHtml(runId)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; padding: 32px; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e2e8f0; }
    th { background: #f1f5f9; color: #475569; font-size: 11px; text-transform: uppercase; }
    .badge-pass { background: #d1fae5; color: #065f46; font-weight: bold; padding: 2px 6px; border-radius: 4px; }
    .badge-fail { background: #ffe4e6; color: #9f1239; font-weight: bold; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h2>Отчёт аудита кредитных стратегий СПР (Прогон #${escapeHtml(runId)})</h2>
  <p style="color:#64748b;font-size:12px;">${escapeHtml(runInfo?.config?.runTag || '')} · Сформировано: ${escapeHtml(reportDate)} · Аналитик: ${escapeHtml(currentUser.name)} (${escapeHtml(currentUser.role)})</p>
  <div class="card">
    <h3>Macro Impact</h3>
    <p>Анкет в выборке: <b>${summaryMetrics.totalPortfolio}</b></p>
    <p>Сменили решение (Flips): <b>${summaryMetrics.totalFlips} (${summaryMetrics.flipsPct}%)</b></p>
    <table><thead><tr><th>Исход</th><th>MASTER</th><th>Ушло</th><th>Пришло</th><th>BETA</th></tr></thead><tbody>${decRows}</tbody></table>
  </div>
  <div class="card">
    <h3>Проверки (Quality Gates)</h3>
    <table>
      <thead><tr><th>Правило</th><th>Аргумент</th><th>Метрика</th><th>Факт</th><th>Статус</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`;

    const blob = new Blob(['﻿' + content], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `SPR_Audit_Report_Run_${runId}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Основной экспорт: готовый файл с бэкенда (/export.html). Если эндпоинта нет или он отвечает ошибкой,
  // скачивается локально собранный отчёт (handleExportHtml).
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState(null);
  const handleDownloadReport = async () => {
    if (!runId) return;
    if (apiStatus !== 'connected') {
      handleExportHtml();
      return;
    }
    setExporting(true);
    setExportNote(null);
    try {
      const res = await fetch(api(`/api/reports/${runId}/export.html`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `SPR_Audit_Report_Run_${runId}.html`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setExportNote(`Отчёт с бэкенда недоступен (${e.message}), скачан локальный вариант`);
      handleExportHtml();
      setTimeout(() => setExportNote(null), 6000);
    } finally {
      setExporting(false);
    }
  };

  // ----------------------------------------------------
  // Шаги пайплайна для отображения
  // ----------------------------------------------------
  const stepDuration = (s) => {
    if (!s.started_at || !s.finished_at) return null;
    const sec = (new Date(s.finished_at) - new Date(s.started_at)) / 1000;
    return Number.isFinite(sec) ? `${sec.toFixed(1)} с` : null;
  };
  const stepBadge = (status) => {
    const v = String(status || '').toLowerCase();
    if (TERMINAL_OK.includes(v)) return 'bg-emerald-100 text-emerald-800';
    if (TERMINAL_FAIL.includes(v)) return 'bg-rose-100 text-rose-800';
    if (v === 'running') return 'bg-blue-100 text-blue-800 animate-pulse';
    return 'bg-slate-100 text-slate-600';
  };

  // Одна строка таблицы проверок (обычная или вложенный срез внутри группы)
  const renderCheckRow = (c, key, nested) => {
    const hasAppIds = c.APP_IDS.length > 0 || (hasDecisions && flipsCovered && c.RESULT === 'FAIL' && (c.CHECK_ID === 'ar_drop_by_product' || /approval\s*rate/i.test(c.LABEL || '')));
    const code = REPO_PYTHON_SCRIPTS[c.CHECK_ID];
    return (
      <tr key={key} className={nested ? 'bg-slate-50/70' : 'hover:bg-slate-50 transition'}>
        <td className="py-2.5 px-4 font-semibold text-slate-800">
          {nested ? (
            <span className="pl-5 text-slate-400 font-normal">↳ срез</span>
          ) : (
            <>
              {c.LABEL}
              {c.ESTIMATE && <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">оценка</span>}
              {c.CONFIDENCE === 'LOW' && (
                <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600" title="Мало анкет, результат ненадёжен">
                  LOW
                </span>
              )}
            </>
          )}
        </td>
        <td className="py-2.5 px-4 font-mono text-slate-600">
          <span className="bg-slate-100 px-2 py-0.5 rounded text-[11px] break-all">{c.ARGUMENT || '—'}</span>
        </td>
        <td className="py-2.5 px-4 text-center font-mono font-bold">
          {hasAppIds ? (
            <button
              onClick={() => handleInvestigateCheck(c)}
              className="px-2.5 py-1 rounded bg-blue-50 hover:bg-blue-600 hover:text-white text-blue-700 border border-blue-300 font-bold transition cursor-pointer"
              title="Открыть эти анкеты в реестре"
            >
              🔍 {c.CNT} анкет ➔
            </button>
          ) : (
            <span className="text-slate-800">{c.CNT}</span>
          )}
        </td>
        <td className="py-2.5 px-4 text-center font-mono text-slate-700">{c.METRIC === null ? '—' : fmtPct(c.METRIC)}</td>
        <td className="py-2.5 px-4 text-center">
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
              c.RESULT === 'PASS'
                ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                : 'bg-rose-100 text-rose-800 border border-rose-200'
            }`}
          >
            {c.RESULT || '—'}
          </span>
        </td>
        <td className="py-2.5 px-4 text-right">
          {!nested && (
            <button
              disabled={!code}
              onClick={() => setCodeModal({ isOpen: true, title: c.LABEL, code })}
              className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 rounded font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Код ↗
            </button>
          )}
        </td>
      </tr>
    );
  };

  const runOptions = availableRuns.length > 0 ? availableRuns : [{ id: 'demo', status: 'demo', config: { runTag: 'демо-данные' } }];
  const isFallback = apiStatus === 'fallback';

  if (!session) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans antialiased text-slate-900">
        <form onSubmit={handleLogin} className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-sm p-6 space-y-4">
          <div>
            <h1 className="text-base font-extrabold text-slate-900">СПР • Аудит кредитных стратегий</h1>
            <p className="text-xs text-slate-500 mt-1">Введите логин аналитика. Пароль не нужен.</p>
          </div>
          <input
            autoFocus
            value={loginName}
            onChange={(e) => setLoginName(e.target.value)}
            placeholder="Логин"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
          />
          {loginError && <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{loginError}</div>}
          <button
            type="submit"
            disabled={loginBusy || !loginName.trim()}
            className="w-full py-2 rounded-lg bg-slate-900 hover:bg-blue-600 disabled:bg-slate-300 text-white text-sm font-semibold transition cursor-pointer"
          >
            {loginBusy ? 'Входим…' : 'Войти'}
          </button>
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${apiStatus === 'connected' ? 'bg-emerald-500' : apiStatus === 'fallback' ? 'bg-amber-500' : 'bg-slate-400'}`} />
              {apiStatus === 'connected' ? 'ONLINE' : apiStatus === 'fallback' ? 'FALLBACK' : 'проверяем бэкенд…'}
            </span>
            {apiStatus === 'fallback' && (
              <button type="button" onClick={() => saveSession({ demo: true, username: 'demo' })} className="underline hover:text-slate-800 cursor-pointer">
                Продолжить в demo-режиме
              </button>
            )}
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50/70 text-slate-900 font-sans flex flex-col antialiased">
      {/* ШАПКА */}
      <header className="border-b border-slate-200 bg-white px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-30 shadow-sm">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
              apiStatus === 'connected'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : apiStatus === 'fallback'
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-slate-50 text-slate-500 border-slate-200'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                apiStatus === 'connected' ? 'bg-emerald-500 animate-pulse' : apiStatus === 'fallback' ? 'bg-amber-500' : 'bg-slate-400'
              }`}
            />
            {apiStatus === 'connected' ? 'ONLINE' : apiStatus === 'fallback' ? 'FALLBACK' : '…'}
          </span>
          <span className="font-bold text-sm text-slate-800">СПР • Аудит кредитных стратегий</span>

          <div className="flex items-center gap-1.5 bg-slate-100 border border-slate-200 rounded-lg px-2 py-0.5 text-xs font-mono">
            <span className="text-slate-500 font-sans">Прогон:</span>
            <select
              value={runId || ''}
              onChange={(e) => setRunId(e.target.value)}
              className="bg-transparent border-none outline-none font-bold text-blue-700 cursor-pointer max-w-64"
            >
              {runOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  #{r.id} · {r.config?.runTag || r.status || 'done'}
                </option>
              ))}
            </select>
          </div>
          {isLoadingApi && <span className="text-xs text-blue-600 animate-pulse font-semibold">Загрузка…</span>}
        </div>

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

        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center gap-2 bg-white border border-slate-300 rounded-lg px-2.5 py-1 shadow-sm">
            <span className="text-slate-400">👤</span>
            <span className="font-semibold text-slate-700 font-mono">{currentUser.username}</span>
            {session?.demo && <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 rounded">demo</span>}
            <button onClick={() => saveSession(null)} className="text-slate-400 hover:text-slate-800 cursor-pointer" title="Выйти">
              Выйти
            </button>
          </div>
          <button
            onClick={() => {
              setCcError(null);
              setIsAddCheckOpen(true);
            }}
            className="px-2.5 py-1 rounded-lg font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 transition cursor-pointer"
          >
            + Проверка
          </button>
          <button
            onClick={handleDownloadReport}
            disabled={exporting || !runId}
            className="px-3 py-1 rounded-lg font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white transition shadow-sm cursor-pointer"
          >
            {exporting ? 'Готовим…' : '⬇ Скачать HTML'}
          </button>
          {exportNote && <span className="text-[11px] text-amber-700 max-w-xs">{exportNote}</span>}
        </div>
      </header>

      {isFallback && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-xs px-6 py-2">
          <b>Демо-режим:</b> бэкенд недоступен, показаны локальные демонстрационные данные. Запуск прогонов отключён.
        </div>
      )}
      {loadError && (
        <div className="bg-rose-50 border-b border-rose-200 text-rose-900 text-xs px-6 py-2">
          <b>Ошибка загрузки прогона #{runId}:</b> {loadError}
        </div>
      )}

      {/* ВКЛАДКА 1 */}
      {activeTab === 'matrix' && (
        <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-6">
          {/* Метрики */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Всего анкет в выборке</div>
              <div className="text-2xl font-extrabold text-slate-900 font-mono mt-1">{portfolioSize.toLocaleString('ru-RU')}</div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Смена решения (Flips)</div>
              <div className="flex items-baseline justify-between mt-1">
                <div className="text-2xl font-extrabold text-amber-600 font-mono">{summaryMetrics.totalFlips.toLocaleString('ru-RU')}</div>
                <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">{summaryMetrics.flipsPct}% выборки</span>
              </div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Анкет с расхождениями</div>
              <div className="flex items-baseline justify-between mt-1">
                <div className="text-2xl font-extrabold text-blue-600 font-mono">{changedApps.toLocaleString('ru-RU')}</div>
                <span className="text-xs text-slate-500 font-mono">из {portfolioSize.toLocaleString('ru-RU')} в выборке</span>
              </div>
            </div>
          </div>

          {/* AI Executive Summary */}
          <section className="bg-white rounded-xl border border-indigo-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 bg-indigo-50/60 border-b border-indigo-100 flex flex-wrap justify-between items-center gap-3">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-indigo-600" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14zM5 15l.7 2 2 .7-2 .7L5 20l-.7-2-2-.7 2-.7L5 15z" />
                </svg>
                <div>
                  <h3 className="text-sm font-bold text-slate-800">AI Executive Summary</h3>
                  <p className="text-[11px] text-slate-500">Краткое резюме по прогону #{runId}</p>
                </div>
              </div>
              <button
                onClick={generateAiSummary}
                disabled={aiLoading || !runId || apiStatus !== 'connected'}
                title={apiStatus !== 'connected' ? 'Нужно подключение к бэкенду' : undefined}
                className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-xs font-bold transition cursor-pointer"
              >
                {aiLoading ? 'Генерация…' : aiSummary ? 'Сгенерировать заново' : 'Сгенерировать резюме'}
              </button>
            </div>
            {(aiLoading || aiSummary || aiError) && (
              <div className="p-5" aria-live="polite">
                {aiLoading && (
                  <div className="flex items-center gap-3 text-sm text-indigo-800">
                    <span className="inline-block w-4 h-4 rounded-full border-2 border-indigo-300 border-t-indigo-600 animate-spin" />
                    ИИ анализирует {pivotFacts.length.toLocaleString('ru-RU')} строк...
                  </div>
                )}
                {!aiLoading && aiError && (
                  <div className="text-sm text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3">
                    Не удалось получить резюме: {aiError}
                  </div>
                )}
                {!aiLoading && !aiError && aiSummary && (
                  <div className="text-sm leading-relaxed text-slate-800 whitespace-pre-wrap bg-indigo-50/40 border border-indigo-100 rounded-lg px-4 py-3">
                    {aiSummary}
                  </div>
                )}
              </div>
            )}
          </section>

          {!isLoadingApi && pivotFacts.length === 0 && !loadError && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 text-sm text-slate-500 text-center">
              Для прогона #{runId} нет данных витрины. Возможно, расчёт ещё не завершён.
            </div>
          )}

          {/* Проверки */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
              <div>
                <h3 className="text-sm font-bold text-slate-800">Автоматические проверки стратегии (Quality Gates)</h3>
                <p className="text-[11px] text-slate-500">
                  Нажмите на синюю кнопку в колонке CNT, чтобы открыть затронутые анкеты в реестре
                </p>
              </div>
              <div className="flex gap-2 text-xs font-bold">
                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">PASS: {checkGroups.filter((g) => g.result === 'PASS').length}</span>
                <span className="px-2 py-0.5 rounded bg-rose-100 text-rose-800">FAIL: {checkGroups.filter((g) => g.result === 'FAIL').length}</span>
              </div>
            </div>

            {checksAreEstimates && (
              <div className="px-5 py-2 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900">
                {isFallback
                  ? 'Демо-режим: проверки оценены по данным витрины.'
                  : 'Бэкенд не вернул результаты проверок для этого прогона. Ниже оценки по данным витрины (не результат скриптов), список анкет для них недоступен.'}
              </div>
            )}

            {checksResults.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-500">Проверок нет.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-white text-slate-500 border-b border-slate-200 font-semibold">
                    <tr>
                      <th className="py-2.5 px-4">Название проверки</th>
                      <th className="py-2.5 px-4">Аргумент</th>
                      <th className="py-2.5 px-4 text-center">Затронуто анкет (CNT)</th>
                      <th className="py-2.5 px-4 text-center">Метрика</th>
                      <th className="py-2.5 px-4 text-center">Статус</th>
                      <th className="py-2.5 px-4 text-right">Код</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {checkGroups.map((g) => {
                      if (g.items.length === 1) return renderCheckRow(g.items[0], g.label, false);
                      const open = !!expandedChecks[g.label];
                      const code = REPO_PYTHON_SCRIPTS[g.checkId];
                      return (
                        <React.Fragment key={g.label}>
                          <tr
                            onClick={() => setExpandedChecks((p) => ({ ...p, [g.label]: !p[g.label] }))}
                            className="hover:bg-slate-50 transition cursor-pointer"
                          >
                            <td className="py-2.5 px-4 font-semibold text-slate-800">
                              <span className="text-slate-400 mr-1.5">{open ? '▼' : '▶'}</span>
                              {g.label}
                              <span className="ml-2 text-[10px] font-normal text-slate-500">
                                {g.items.length} срезов{g.fails > 0 ? `, FAIL: ${g.fails}` : ''}
                              </span>
                              {g.estimate && <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">оценка</span>}
                            </td>
                            <td className="py-2.5 px-4 text-slate-400">{open ? 'свернуть' : 'развернуть'}</td>
                            <td className="py-2.5 px-4 text-center font-mono text-slate-700">до {g.maxCnt}</td>
                            <td className="py-2.5 px-4 text-center font-mono text-slate-700">{g.maxMetric === null ? '—' : `до ${fmtPct(g.maxMetric)}`}</td>
                            <td className="py-2.5 px-4 text-center">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  g.result === 'PASS'
                                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                    : 'bg-rose-100 text-rose-800 border border-rose-200'
                                }`}
                              >
                                {g.result}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <button
                                disabled={!code}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCodeModal({ isOpen: true, title: g.label, code });
                                }}
                                className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 rounded font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                Код ↗
                              </button>
                            </td>
                          </tr>
                          {open && g.items.map((c, i) => renderCheckRow(c, `${g.label}-${i}`, true))}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {customChecks.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
                <h3 className="text-sm font-bold text-slate-800">Пользовательские проверки</h3>
                <p className="text-[11px] text-slate-500">
                  Выполняются на бэкенде по данным прогона #{runId}. Сами проверки хранятся в браузере.
                </p>
              </div>
              <table className="w-full text-xs text-left">
                <thead className="text-[11px] uppercase text-slate-500 bg-white border-b border-slate-100">
                  <tr>
                    <th className="py-2 px-4">Название</th>
                    <th className="py-2 px-4">Модуль</th>
                    <th className="py-2 px-4 text-center">Порог</th>
                    <th className="py-2 px-4 text-center">Затронуто</th>
                    <th className="py-2 px-4 text-center">Метрика</th>
                    <th className="py-2 px-4 text-center">Статус</th>
                    <th className="py-2 px-4 text-right">Действия</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {customChecks.map((c) => {
                    const run = customRuns[c.id];
                    const rows = run?.status === 'done' ? run.rows : [];
                    const overall = run?.status === 'done' ? (rows.length === 0 ? 'EMPTY' : rows.some((r) => r.RESULT === 'FAIL') ? 'FAIL' : 'PASS') : run?.status === 'error' ? 'ERROR' : run?.status === 'running' ? 'RUNNING' : 'NONE';
                    const maxCnt = rows.reduce((m, r) => Math.max(m, r.CNT), 0);
                    const maxMetric = rows.reduce((m, r) => (r.METRIC !== null && r.METRIC > m ? r.METRIC : m), 0);
                    const badge = {
                      FAIL: 'bg-rose-100 text-rose-800',
                      PASS: 'bg-emerald-100 text-emerald-800',
                      ERROR: 'bg-rose-100 text-rose-800',
                      RUNNING: 'bg-blue-100 text-blue-800',
                      EMPTY: 'bg-amber-100 text-amber-800',
                      NONE: 'bg-slate-100 text-slate-600'
                    }[overall];
                    const label = { FAIL: 'FAIL', PASS: 'PASS', ERROR: 'Ошибка', RUNNING: 'Выполняется…', EMPTY: 'Нет результата', NONE: 'Не запускалась' }[overall];
                    const investigate = (row) => {
                      if (!row.APP_IDS.length) return;
                      setActiveInvestigateCheck({ label: row.LABEL, argument: row.ARGUMENT, appIds: row.APP_IDS, cnt: row.CNT });
                      setRegistryStatusFilter('ALL');
                      setSelectedPivotFilter(null);
                      setRegistryLimit(APPS_PAGE);
                      setActiveTab('registry');
                    };
                    return (
                      <React.Fragment key={c.id}>
                        <tr>
                          <td className="py-2.5 px-4 font-semibold text-slate-800">{c.name}</td>
                          <td className="py-2.5 px-4 font-mono text-slate-600">{c.module || '—'}</td>
                          <td className="py-2.5 px-4 text-center font-mono">{c.threshold || '—'}</td>
                          <td className="py-2.5 px-4 text-center font-mono font-bold">{rows.length ? (rows.length > 1 ? `до ${maxCnt}` : maxCnt) : '—'}</td>
                          <td className="py-2.5 px-4 text-center font-mono">{rows.length ? fmtPct(maxMetric) : '—'}</td>
                          <td className="py-2.5 px-4 text-center">
                            <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${badge}`}>{label}</span>
                          </td>
                          <td className="py-2.5 px-4 text-right space-x-2 whitespace-nowrap">
                            <button
                              onClick={() => runCustomCheck(c)}
                              disabled={overall === 'RUNNING' || apiStatus !== 'connected' || !runId}
                              className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-[11px] font-semibold cursor-pointer disabled:cursor-not-allowed"
                            >
                              ▶ Запустить
                            </button>
                            <button
                              onClick={() => setCodeModal({ isOpen: true, title: c.name, code: c.code })}
                              className="px-2 py-1 rounded bg-slate-900 text-white text-[11px] font-semibold cursor-pointer"
                            >
                              Код
                            </button>
                            <button
                              onClick={() => {
                                setCustomChecks((list) => list.filter((x) => x.id !== c.id));
                                setCustomRuns((m) => {
                                  const { [c.id]: _drop, ...rest } = m;
                                  return rest;
                                });
                              }}
                              className="px-2 py-1 rounded bg-white border border-rose-300 text-rose-700 text-[11px] font-semibold cursor-pointer"
                            >
                              Удалить
                            </button>
                          </td>
                        </tr>
                        {run?.status === 'error' && (
                          <tr>
                            <td colSpan={7} className="px-4 py-2 bg-rose-50">
                              <pre className="text-[11px] text-rose-900 whitespace-pre-wrap break-words font-mono">{run.error}</pre>
                            </td>
                          </tr>
                        )}
                        {rows.length > 1 &&
                          rows.map((r, i) => (
                            <tr key={`${c.id}-${i}`} className="bg-slate-50/70">
                              <td className="py-2 px-4 pl-8 text-slate-700">{r.LABEL}</td>
                              <td className="py-2 px-4 font-mono text-slate-500" colSpan={2}>{r.ARGUMENT || '—'}</td>
                              <td className="py-2 px-4 text-center font-mono">
                                {r.APP_IDS.length ? (
                                  <button onClick={() => investigate(r)} className="px-2 py-0.5 rounded bg-blue-50 hover:bg-blue-600 hover:text-white text-blue-700 border border-blue-300 font-bold cursor-pointer">
                                    🔍 {r.CNT}
                                  </button>
                                ) : (
                                  r.CNT
                                )}
                              </td>
                              <td className="py-2 px-4 text-center font-mono">{r.METRIC === null ? '—' : fmtPct(r.METRIC)}</td>
                              <td className="py-2 px-4 text-center">
                                <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${r.RESULT === 'FAIL' ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'}`}>{r.RESULT}</span>
                              </td>
                              <td />
                            </tr>
                          ))}
                        {rows.length === 1 && rows[0].APP_IDS.length > 0 && (
                          <tr className="bg-slate-50/70">
                            <td colSpan={7} className="py-2 px-4 pl-8 text-[11px] text-slate-600">
                              {rows[0].ARGUMENT && <span className="font-mono mr-3">{rows[0].ARGUMENT}</span>}
                              <button onClick={() => investigate(rows[0])} className="px-2 py-0.5 rounded bg-blue-50 hover:bg-blue-600 hover:text-white text-blue-700 border border-blue-300 font-bold cursor-pointer">
                                🔍 Открыть {rows[0].CNT} анкет в реестре ➔
                              </button>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Waterfall */}
          {activeWaterfallRow && (
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4">
              <div className="flex flex-wrap justify-between items-center gap-2 border-b border-slate-100 pb-3">
                <h3 className="text-sm font-bold text-slate-800">
                  Диаграмма миграции решений (Waterfall): срез по «{activeWaterfallRow.value}»
                </h3>
                <div className="flex gap-1.5 bg-slate-100 p-1 rounded-lg text-xs font-semibold">
                  {decisionRows.map((dr) => (
                    <button
                      key={dr.id}
                      onClick={() => setWaterfallTargetBucket(dr.value)}
                      className={`px-2.5 py-0.5 rounded-md transition cursor-pointer ${
                        activeWaterfallRow.value === dr.value ? 'bg-white text-slate-900 shadow-sm font-bold' : 'text-slate-600'
                      }`}
                    >
                      {dr.value}
                    </button>
                  ))}
                </div>
              </div>

              {(() => {
                const w = activeWaterfallRow;
                const maxVal = Math.max(w.masterTotal, w.betaTotal, w.stableCount, 1);
                const getHeight = (val) => (val === 0 ? 2 : Math.max(Math.round((val / maxVal) * 110), 6));
                const bars = [
                  { label: 'MASTER (Было)', val: w.masterTotal, color: 'bg-slate-700', text: 'text-slate-800' },
                  { label: 'Сохранено (DIFF=0)', val: w.stableCount, color: 'bg-slate-400', text: 'text-slate-600' },
                  { label: 'Ушло (-)', val: w.leftCount, prefix: '-', color: 'bg-rose-500 ring-2 ring-rose-200', text: 'text-rose-600 font-bold' },
                  { label: 'Пришло (+)', val: w.arrivedCount, prefix: '+', color: 'bg-emerald-500 ring-2 ring-emerald-200', text: 'text-emerald-600 font-bold' },
                  { label: 'BETA (Стало)', val: w.betaTotal, color: 'bg-blue-600', text: 'text-blue-700 font-bold' }
                ];
                return (
                  <div className="pt-2 pb-1 px-3 bg-slate-50/80 rounded-xl border border-slate-100">
                    <div className="grid grid-cols-5 gap-3 items-end h-36 pt-4 px-2">
                      {bars.map((b, idx) => (
                        <div key={idx} className="flex flex-col items-center justify-end h-full">
                          <div className={`text-xs font-mono mb-1 ${b.text}`}>
                            {b.prefix || ''}
                            {b.val}
                          </div>
                          <div style={{ height: `${getHeight(b.val)}px` }} className={`w-full max-w-16 rounded-t-lg shadow-sm ${b.color}`} />
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-5 gap-3 border-t border-slate-200 pt-2 pb-1 text-center">
                      {bars.map((b, idx) => (
                        <div key={idx} className="text-[11px] font-bold text-slate-700">
                          {b.label}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Баланс решений */}
          {decisionRows.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3.5 bg-slate-900 text-white flex justify-between items-center">
                <div>
                  <h3 className="text-sm font-bold">Сводный баланс кредитных решений</h3>
                  <p className="text-[11px] text-slate-300">
                    <code>MASTER (Было)</code> − <code>Ушло</code> + <code>Пришло</code> = <code>BETA (Стало)</code>
                  </p>
                </div>
                {selectedPivotFilter && (
                  <button
                    onClick={() => setSelectedPivotFilter(null)}
                    className="text-xs bg-white/20 hover:bg-white/30 text-white px-2.5 py-1 rounded transition cursor-pointer"
                  >
                    ✕ Сбросить срез ({selectedPivotFilter.value})
                  </button>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-sans font-semibold">
                    <tr>
                      <th className="py-2.5 px-4">Исход (VALUE)</th>
                      <th className="py-2.5 px-4 text-center font-bold text-slate-800">MASTER (Было)</th>
                      <th className="py-2.5 px-4 text-center text-slate-500">Без изменений</th>
                      <th className="py-2.5 px-4 text-center text-rose-700 bg-rose-50/50">Ушло (-LEFT)</th>
                      <th className="py-2.5 px-4 text-center text-emerald-700 bg-emerald-50/50">Пришло (+ARRIVED)</th>
                      <th className="py-2.5 px-4 text-center font-bold text-slate-900">BETA (Стало)</th>
                      <th className="py-2.5 px-4 text-center font-sans">Чистый сдвиг (Δ)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {decisionRows.map((r) => (
                      <tr key={r.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-4 font-bold text-slate-900">
                          <span className={`px-2 py-0.5 rounded text-[11px] ${decisionClass(r.value)}`}>{r.value}</span>
                        </td>
                        <td className="py-2.5 px-4 text-center font-bold text-slate-800">{r.masterTotal}</td>
                        <td className="py-2.5 px-4 text-center text-slate-400">{r.stableCount}</td>
                        <td className="py-2.5 px-4 text-center bg-rose-50/20 font-sans">
                          {r.leftCount > 0 ? (
                            <button
                              onClick={() => {
                                setSelectedPivotFilter({ rowId: r.id, value: r.value, direction: 'LEFT' });
                                setActiveInvestigateCheck(null);
                                setRegistryLimit(APPS_PAGE);
                              }}
                              className={`px-2.5 py-0.5 rounded font-mono font-bold text-xs transition cursor-pointer ${
                                selectedPivotFilter?.rowId === r.id && selectedPivotFilter?.direction === 'LEFT'
                                  ? 'bg-rose-600 text-white ring-2 ring-rose-300'
                                  : 'bg-rose-100 hover:bg-rose-600 hover:text-white text-rose-800'
                              }`}
                              title="Анкеты, ушедшие из этого исхода"
                            >
                              -{r.leftCount} ▼
                            </button>
                          ) : (
                            '0'
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-center bg-emerald-50/20 font-sans">
                          {r.arrivedCount > 0 ? (
                            <button
                              onClick={() => {
                                setSelectedPivotFilter({ rowId: r.id, value: r.value, direction: 'ARRIVED' });
                                setActiveInvestigateCheck(null);
                                setRegistryLimit(APPS_PAGE);
                              }}
                              className={`px-2.5 py-0.5 rounded font-mono font-bold text-xs transition cursor-pointer ${
                                selectedPivotFilter?.rowId === r.id && selectedPivotFilter?.direction === 'ARRIVED'
                                  ? 'bg-emerald-600 text-white ring-2 ring-emerald-300'
                                  : 'bg-emerald-100 hover:bg-emerald-600 hover:text-white text-emerald-800'
                              }`}
                              title="Анкеты, пришедшие в этот исход"
                            >
                              +{r.arrivedCount} ▼
                            </button>
                          ) : (
                            '0'
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-center font-bold text-slate-900">{r.betaTotal}</td>
                        <td className="py-2.5 px-4 text-center font-bold font-sans">
                          {r.netDelta > 0 ? (
                            <span className="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">+{r.netDelta}</span>
                          ) : r.netDelta < 0 ? (
                            <span className="bg-rose-100 text-rose-800 px-1.5 py-0.5 rounded">{r.netDelta}</span>
                          ) : (
                            '0'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Витрина модулей */}
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
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span>
                  Модулей: <b>{filteredBlocks.length}</b>
                </span>
                <button onClick={expandChanged} className="px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 font-semibold cursor-pointer">
                  Развернуть изменённые
                </button>
                <button onClick={() => setExpandedModules({})} className="px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 font-semibold cursor-pointer">
                  Свернуть все
                </button>
              </div>
            </div>

            {filteredBlocks.map((block) => {
              const isOpen = !!expandedModules[block.name];
              const limit = rowLimits[block.name] ?? ROWS_PER_MODULE;
              const shown = block.rows.slice(0, limit);
              return (
                <div key={block.name} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div
                    onClick={() => setExpandedModules((p) => ({ ...p, [block.name]: !p[block.name] }))}
                    className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center cursor-pointer hover:bg-slate-100 transition"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400 font-bold">{isOpen ? '▼' : '▶'}</span>
                      <span className="font-bold text-sm text-slate-800">{block.name}</span>
                      <span className="text-xs text-slate-500">({block.rows.length} бакетов)</span>
                      {block.rows.length > HIGH_CARDINALITY && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600" title="Много уникальных значений (идентификаторы и т.п.)">
                          высокая кардинальность
                        </span>
                      )}
                    </div>
                    <span className="text-xs font-semibold text-slate-600 bg-white border border-slate-200 px-2 py-0.5 rounded">
                      Макс. сдвиг: до <b>{block.maxAffectedClients}</b> анкет
                    </span>
                  </div>

                  {isOpen && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-white text-slate-500 border-b border-slate-100 font-sans font-semibold">
                          <tr>
                            <th className="py-2 px-4">Параметр</th>
                            <th className="py-2 px-4">Бакет (VALUE)</th>
                            <th className="py-2 px-4 text-center">MASTER</th>
                            <th className="py-2 px-4 text-center">DIFF=0</th>
                            <th className="py-2 px-4 text-center text-rose-700">Ушло</th>
                            <th className="py-2 px-4 text-center text-emerald-700">Пришло</th>
                            <th className="py-2 px-4 text-center">BETA</th>
                            <th className="py-2 px-4 text-center">Δ</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {shown.map((row) => (
                            <tr key={row.id} className={row.totalChanges > 0 ? 'bg-amber-50/20' : 'hover:bg-slate-50'}>
                              <td className="py-2 px-4 text-slate-700 font-medium">{paramPath(row) || '(значение)'}</td>
                              <td className="py-2 px-4 font-bold text-slate-900">
                                {row.value === NO_VALUE ? <span className="text-slate-400 font-sans italic">нет атрибута</span> : row.value}
                              </td>
                              <td className="py-2 px-4 text-center font-bold text-slate-700">{row.masterTotal}</td>
                              <td className="py-2 px-4 text-center text-slate-400">{row.stableCount}</td>
                              <td className="py-2 px-4 text-center text-rose-600 font-bold">{row.leftCount > 0 ? `-${row.leftCount}` : '0'}</td>
                              <td className="py-2 px-4 text-center text-emerald-600 font-bold">{row.arrivedCount > 0 ? `+${row.arrivedCount}` : '0'}</td>
                              <td className="py-2 px-4 text-center font-bold text-slate-900">{row.betaTotal}</td>
                              <td className="py-2 px-4 text-center font-bold">{row.netDelta > 0 ? `+${row.netDelta}` : row.netDelta}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {block.rows.length > limit && (
                        <div className="px-5 py-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                          <span>
                            Показано {limit} из {block.rows.length}
                          </span>
                          <button
                            onClick={() => setRowLimits((p) => ({ ...p, [block.name]: limit + ROWS_PER_MODULE }))}
                            className="px-3 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50 font-semibold cursor-pointer"
                          >
                            Показать ещё {ROWS_PER_MODULE}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </main>
      )}

      {/* ВКЛАДКА 2: РЕЕСТР */}
      {activeTab === 'registry' && (
        <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            {activeInvestigateCheck && (
              <div className="flex flex-wrap justify-between items-center gap-2 bg-rose-50 border border-rose-300 px-4 py-3 rounded-xl text-xs text-rose-900 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-rose-600 text-white font-bold text-[10px]">РЕЖИМ РАССЛЕДОВАНИЯ</span>
                  <span>
                    Проверка: <b>{activeInvestigateCheck.label}</b> — показано {filteredApps.length} анкет
                    {activeInvestigateCheck.cnt > activeInvestigateCheck.appIds.length &&
                      ` (бэкенд отдаёт первые ${activeInvestigateCheck.appIds.length} из ${activeInvestigateCheck.cnt})`}
                  </span>
                </div>
                <button
                  onClick={() => setActiveInvestigateCheck(null)}
                  className="px-2.5 py-1 rounded bg-white hover:bg-rose-100 text-rose-800 border border-rose-300 font-bold cursor-pointer"
                >
                  ✕ Сбросить фильтр расследования
                </button>
              </div>
            )}

            {rawApplications.length > 0 && applications.some((a) => a.beforeDecision === '—') && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-xs text-amber-900">
                У {applications.filter((a) => a.beforeDecision === '—').length} из {applications.length} заявок нет решения MASTER. Поля в ответе
                /applications: <span className="font-mono">{Object.keys(rawApplications[0]).join(', ')}</span>
              </div>
            )}

            {selectedPivotFilter && !hasDecisions && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-xs text-amber-900">
                Бэкенд пока не возвращает решения по заявкам (beforeDecision/afterDecision пустые), поэтому срез «{selectedPivotFilter.value}»
                показывает все заявки с расхождениями, а не только перешедшие в этот исход.
              </div>
            )}

            <div className="flex flex-wrap justify-between items-center gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-800">Реестр кредитных заявок (Прогон #{runId})</h3>
                <p className="text-xs text-slate-500">
                  Подходит: <b>{filteredApps.length}</b> из {applications.length} анкет · сверху заявки с наибольшим риском и числом расхождений{applications.length < portfolioSize && ` · в реестре только заявки с расхождениями (всего в выборке ${portfolioSize.toLocaleString('ru-RU')})`}
                </p>
              </div>
              {selectedPivotFilter && !activeInvestigateCheck && (
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
                placeholder="Поиск по номеру анкеты (например: I32554354)..."
                value={registrySearch}
                onChange={(e) => {
                  setRegistrySearch(e.target.value);
                  setRegistryLimit(APPS_PAGE);
                }}
                className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none w-72 focus:border-blue-500 font-mono"
              />
              {hasDecisions ? (
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <button
                    onClick={() => setRegistryStatusFilter('ALL')}
                    className={`px-3 py-1 rounded-lg border transition cursor-pointer ${
                      registryStatusFilter === 'ALL' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300'
                    }`}
                  >
                    Все ({applications.length})
                  </button>
                  {uniqueDecisions.map((dec) => (
                    <button
                      key={dec}
                      onClick={() => {
                        setRegistryStatusFilter(dec);
                        setRegistryLimit(APPS_PAGE);
                      }}
                      className={`px-3 py-1 rounded-lg border transition cursor-pointer ${
                        registryStatusFilter === dec ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300'
                      }`}
                    >
                      {dec}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="text-[11px] text-slate-400">Фильтры по исходам появятся, когда бэкенд вернёт решения по заявкам</span>
              )}
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-sans font-semibold">
                  <tr>
                    <th className="py-2.5 px-4">ID Заявки</th>
                    <th className="py-2.5 px-4">MASTER (Было)</th>
                    <th className="py-2.5 px-4">BETA (Стало)</th>
                    <th className="py-2.5 px-4 text-center">Расхождений (DIFF)</th>
                    <th className="py-2.5 px-4">Главный триггер (Driver)</th>
                    <th className="py-2.5 px-4 text-right">Действие</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredApps.slice(0, registryLimit).map((app) => (
                    <tr
                      key={app.app_id}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleOpenDossier(app.app_id)}
                      onKeyDown={(e) => e.key === 'Enter' && handleOpenDossier(app.app_id)}
                      className="hover:bg-blue-50/40 cursor-pointer transition font-sans"
                    >
                      <td className="py-3 px-4 font-bold font-mono text-slate-900">{app.app_id}</td>
                      <td className="py-3 px-4 font-mono font-semibold">
                        <span className={`px-2 py-0.5 rounded text-[11px] ${decisionClass(app.beforeDecision)}`}>{app.beforeDecision}</span>
                      </td>
                      <td className="py-3 px-4 font-mono font-bold">
                        <span className={`px-2 py-0.5 rounded text-[11px] ${decisionClass(app.afterDecision)}`}>{app.afterDecision}</span>
                      </td>
                      <td className="py-3 px-4 text-center font-mono text-amber-700 font-bold">{app.diffCount} шт.</td>
                      <td className="py-3 px-4">{getAppDriverBadge(app)}</td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenDossier(app.app_id);
                          }}
                          className="bg-slate-900 hover:bg-blue-600 text-white px-3 py-1 rounded text-xs font-semibold transition cursor-pointer"
                        >
                          Открыть досье →
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredApps.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-400 font-sans">
                        Нет заявок под выбранные фильтры
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {filteredApps.length > registryLimit && (
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>
                  Показано {registryLimit} из {filteredApps.length}
                </span>
                <button
                  onClick={() => setRegistryLimit((n) => n + APPS_PAGE)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 font-semibold cursor-pointer"
                >
                  Показать ещё {APPS_PAGE}
                </button>
              </div>
            )}
          </div>
        </main>
      )}

      {/* ВКЛАДКА 3: ПАЙПЛАЙН */}
      {activeTab === 'run' && (
        <main className="flex-1 p-6 max-w-5xl w-full mx-auto space-y-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h3 className="text-sm font-bold text-slate-800">Запуск нового бэктеста</h3>
            <p className="text-xs text-slate-500">
              Аналитик: <b>{currentUser.name}</b> (логин: {currentUser.username}
              {currentUser.backendId ? `, ID на бэке: ${currentUser.backendId}` : ''})
            </p>
            <div className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/60">
              <div className="flex justify-between items-center">
                <h4 className="text-xs font-bold text-slate-800">Свои входные данные (необязательно)</h4>
                {uploadedDataset && (
                  <button
                    type="button"
                    onClick={() => {
                      setUploadedDataset(null);
                      setBeforeFiles([]);
                      setAfterFiles([]);
                      setDsName('');
                    }}
                    className="text-[11px] text-slate-500 hover:text-slate-800 underline cursor-pointer"
                  >
                    Сбросить
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                Выберите JSON-файлы заявок «до» (MASTER) и «после» (BETA). Имена файлов должны совпадать: пара определяется по имени.
              </p>
              <input
                type="text"
                value={dsName}
                onChange={(e) => setDsName(e.target.value)}
                placeholder="Название набора данных"
                className="w-full border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-blue-500"
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block text-[11px] text-slate-600">
                  BEFORE (MASTER), {beforeFiles.length} файлов
                  <input
                    type="file"
                    accept=".json,application/json"
                    multiple
                    onChange={(e) => setBeforeFiles(jsonOnly(e.target.files))}
                    className="mt-1 block w-full text-[11px]"
                  />
                </label>
                <label className="block text-[11px] text-slate-600">
                  AFTER (BETA), {afterFiles.length} файлов
                  <input
                    type="file"
                    accept=".json,application/json"
                    multiple
                    onChange={(e) => setAfterFiles(jsonOnly(e.target.files))}
                    className="mt-1 block w-full text-[11px]"
                  />
                </label>
              </div>
              {(beforeFiles.length > 0 || afterFiles.length > 0) && (
                <p className="text-[11px] text-slate-600">
                  Пар: <b>{pairInfo.paired}</b>
                  {pairInfo.onlyBefore > 0 && <span className="text-amber-700"> · без пары в AFTER: {pairInfo.onlyBefore}</span>}
                  {pairInfo.onlyAfter > 0 && <span className="text-amber-700"> · без пары в BEFORE: {pairInfo.onlyAfter}</span>}
                </p>
              )}
              {uploadError && <div className="bg-rose-50 border border-rose-200 text-rose-900 text-xs rounded-lg px-3 py-2 break-words">{uploadError}</div>}
              {uploadedDataset && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs rounded-lg px-3 py-2">
                  Загружено, пар: {uploadedDataset.pairs}. Следующий прогон возьмёт набор «{uploadedDataset.config.datasetName}».
                </div>
              )}
              <button
                type="button"
                onClick={uploadDataset}
                disabled={uploadBusy || isFallback || beforeFiles.length === 0 || afterFiles.length === 0}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-blue-600 text-white transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploadBusy ? 'Загружаем…' : '⬆ Загрузить данные'}
              </button>
            </div>

            <label className="block text-xs text-slate-600">
              Метка прогона (runTag)
              <input
                type="text"
                value={runTag}
                onChange={(e) => setRunTag(e.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-blue-500"
              />
            </label>
            {availableRuns[0]?.config && (
              <p className="text-[11px] text-slate-400 font-mono">
                Остальная конфигурация берётся из последнего прогона: {availableRuns[0].config.datasetName}
              </p>
            )}

            {pipelineError && (
              <div className="bg-rose-50 border border-rose-200 text-rose-900 text-xs rounded-lg px-4 py-2 break-words">
                <b>Не удалось запустить прогон:</b> {pipelineError}
              </div>
            )}

            <button
              onClick={startRun}
              disabled={isPipelineRunning || isFallback}
              className="w-full py-2.5 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPipelineRunning ? `Выполняется расчёт (${pipelineSeconds} с)...` : '▶ Запустить новый прогон пайплайна'}
            </button>
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-3">
            <h3 className="text-sm font-bold text-slate-800">Журнал этапов пайплайна (прогон #{runId})</h3>
            {isFallback ? (
              <p className="text-xs text-slate-500">В демо-режиме данные об этапах недоступны.</p>
            ) : pipelineSteps.length === 0 ? (
              <p className="text-xs text-slate-500">Бэкенд не вернул этапы для этого прогона.</p>
            ) : (
              pipelineSteps.map((s) => (
                <div key={s.id ?? s.name} className="p-3 rounded-lg bg-slate-50 border border-slate-100 text-xs space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="font-semibold text-slate-700">{STEP_LABELS[s.name] || s.name}</span>
                    <span className="flex items-center gap-2">
                      {stepDuration(s) && <span className="text-[11px] font-mono text-slate-400">{stepDuration(s)}</span>}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${stepBadge(s.status)}`}>{String(s.status || '—').toUpperCase()}</span>
                    </span>
                  </div>
                  {s.code_ref && <div className="text-[11px] font-mono text-slate-500">код: {s.code_ref}</div>}
                  {s.logs && <pre className="text-[11px] font-mono text-slate-500 whitespace-pre-wrap">{String(s.logs).slice(0, 500)}</pre>}
                </div>
              ))
            )}
          </div>
        </main>
      )}

      {/* ДОСЬЕ */}
      {activeDossierAppId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm" onClick={() => setActiveDossierAppId(null)}>
          <div className="bg-white w-full max-w-4xl h-full shadow-2xl flex flex-col p-6 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start border-b border-slate-200 pb-4">
              <div>
                <h3 className="font-bold text-lg text-slate-800 font-mono">Досье анкеты: {activeDossierAppId}</h3>
                <span className="text-xs bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded">
                  Расхождений: {diffRowsCount} из {dossierRows.length}
                </span>
                {isDossierLoading && <span className="text-xs text-blue-600 animate-pulse font-semibold ml-2">Запрос к FastAPI...</span>}
              </div>
              <button onClick={() => setActiveDossierAppId(null)} className="text-slate-400 hover:text-slate-700 text-lg font-bold p-1 cursor-pointer">
                ✕
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 py-3">
              <input
                type="text"
                placeholder="Поиск по параметру, значению, комментарию..."
                value={dossierSearch}
                onChange={(e) => setDossierSearch(e.target.value)}
                className="bg-slate-50 border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none w-72 focus:border-blue-500"
              />
              <button
                onClick={() => setDossierOnlyDiff(!dossierOnlyDiff)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                  dossierOnlyDiff ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-slate-600 border-slate-300'
                }`}
              >
                Только расхождения
              </button>
            </div>

            {dossierError && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-1.5 mb-2">{dossierError}</div>}

            <div className="flex-1 overflow-y-auto border border-slate-200 rounded-xl">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 font-sans font-semibold sticky top-0">
                  <tr>
                    <th className="py-2 px-3">Модуль</th>
                    <th className="py-2 px-3">Параметр</th>
                    <th className="py-2 px-3 text-rose-700">Было</th>
                    <th className="py-2 px-3 text-emerald-700">Стало</th>
                    <th className="py-2 px-3">Бакет (до → после)</th>
                    <th className="py-2 px-3 text-center">Статус</th>
                    <th className="py-2 px-3">Комментарий</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleDossierRows.map((r, idx) => {
                    const diff = Number(r.DIFF_FLAG) === 1;
                    const bBefore = r.ADJUSTED_BEFORE ?? r.adjusted_before;
                    const bAfter = r.ADJUSTED_AFTER ?? r.adjusted_after;
                    const sameBucket = !isEmpty(bBefore) && bBefore === bAfter;
                    return (
                      <tr key={idx} className={diff ? 'bg-amber-50/50' : 'hover:bg-slate-50'}>
                        <td className="py-2 px-3 font-sans text-slate-600">{[r.PREFIX, r.CLASS].filter((x) => !isEmpty(x)).join(' › ') || '—'}</td>
                        <td className="py-2 px-3 font-bold text-slate-800">{paramPath(r) || '(значение)'}</td>
                        <td className="py-2 px-3 text-rose-600">
                          <Cell v={r.VALUE_BEFORE} />
                        </td>
                        <td className="py-2 px-3 text-emerald-600 font-bold">
                          <Cell v={r.VALUE_AFTER} />
                        </td>
                        <td className="py-2 px-3 text-slate-500">
                          {isEmpty(bBefore) && isEmpty(bAfter) ? (
                            <span className="text-slate-300">—</span>
                          ) : sameBucket ? (
                            <span title="бакет не изменился">{bBefore}</span>
                          ) : (
                            <span>
                              <Cell v={bBefore} /> → <b className="text-slate-800">
                                <Cell v={bAfter} />
                              </b>
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${diff ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}`}>
                            {diff ? 'DIFF=1' : 'MATCH'}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-sans text-slate-500 text-[11px]">{r.COMMENT || r.comment || ''}</td>
                      </tr>
                    );
                  })}
                  {!isDossierLoading && visibleDossierRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-400 font-sans">
                        {dossierRows.length === 0 ? 'Для этой анкеты нет данных.' : 'Нет строк под фильтр. Отключите «Только расхождения».'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="border-t border-slate-200 pt-3 mt-3 flex justify-end">
              <button onClick={() => setActiveDossierAppId(null)} className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-semibold cursor-pointer">
                Закрыть досье
              </button>
            </div>
          </div>
        </div>
      )}

      {/* МОДАЛКА: НОВАЯ ПРОВЕРКА */}
      {isAddCheckOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!ccName.trim()) return;
              if (ccThreshold.trim() && parseThreshold(ccThreshold) === null) {
                setCcError('Порог: число или процент, например 5% или 0.05.');
                return;
              }
              if (!/def\s+run\s*\(/.test(ccCode)) {
                setCcError('В коде должна быть функция def run(df): ...');
                return;
              }
              const created = { id: String(Date.now()), name: ccName.trim(), module: ccModule.trim(), threshold: ccThreshold.trim(), code: ccCode };
              setCustomChecks((list) => [...list, created]);
              runCustomCheck(created);
              setCcError(null);
              setCcName('');
              setCcModule('');
              setCcThreshold('');
              setCcCode(CUSTOM_TEMPLATE);
              setIsAddCheckOpen(false);
            }}
            className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-2xl overflow-hidden"
          >
            <div className="px-5 py-3.5 border-b border-slate-200 flex justify-between items-center">
              <h3 className="font-bold text-sm text-slate-800">Новая проверка (Quality Gate)</h3>
              <button type="button" onClick={() => setIsAddCheckOpen(false)} className="text-slate-400 hover:text-slate-700 cursor-pointer">
                ✕
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="text-xs font-semibold text-slate-600 sm:col-span-1">
                  Название
                  <input
                    value={ccName}
                    onChange={(e) => setCcName(e.target.value)}
                    required
                    className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-normal"
                    placeholder="Approval Rate упал"
                  />
                </label>
                <label className="text-xs font-semibold text-slate-600">
                  Модуль
                  <input
                    value={ccModule}
                    onChange={(e) => setCcModule(e.target.value)}
                    list="cc-modules"
                    className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-normal"
                    placeholder="decisionResult › decision"
                  />
                  <datalist id="cc-modules">
                    {moduleBlocks.map((b) => (
                      <option key={b.name} value={b.name} />
                    ))}
                  </datalist>
                </label>
                <label className="text-xs font-semibold text-slate-600">
                  Порог
                  <input
                    value={ccThreshold}
                    onChange={(e) => setCcThreshold(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-normal"
                    placeholder="5%"
                  />
                </label>
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1">Код проверки (Python)</div>
                <div className="rounded-lg overflow-hidden border border-slate-700 text-xs">
                  <CodeMirror value={ccCode} height="260px" theme="dark" extensions={[python()]} onChange={(v) => setCcCode(v)} />
                </div>
              </div>
              {ccError && <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{ccError}</div>}
              <p className="text-[11px] text-slate-500">
                Проверка выполнится на бэкенде по данным выбранного прогона. Порог сравнивается с долей затронутых заявок (cnt / total): выше порога — FAIL.
                Без порога FAIL, если cnt больше нуля.
              </p>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2 bg-slate-50">
              <button type="button" onClick={() => setIsAddCheckOpen(false)} className="px-4 py-1.5 text-xs text-slate-700 bg-white border border-slate-300 rounded-lg cursor-pointer">
                Отмена
              </button>
              <button type="submit" className="px-4 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-blue-600 rounded-lg cursor-pointer">
                Создать
              </button>
            </div>
          </form>
        </div>
      )}

      {/* МОДАЛКА КОДА */}
      {codeModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-2xl w-full max-w-3xl overflow-hidden flex flex-col text-white">
            <div className="px-5 py-3.5 border-b border-slate-800 flex justify-between items-center">
              <h3 className="font-bold text-sm text-slate-100">{codeModal.title}</h3>
              <button onClick={() => setCodeModal({ isOpen: false, title: '', code: '' })} className="text-slate-400 hover:text-white cursor-pointer">
                ✕
              </button>
            </div>
            <div className="p-3 bg-slate-950 font-mono text-xs">
              <CodeMirror value={codeModal.code} height="320px" theme="dark" extensions={[python()]} readOnly={true} />
            </div>
            <div className="px-5 py-3 border-t border-slate-800 flex justify-end bg-slate-900/80">
              <button onClick={() => setCodeModal({ isOpen: false, title: '', code: '' })} className="px-4 py-1.5 text-xs text-slate-300 bg-slate-800 rounded-lg cursor-pointer">
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
