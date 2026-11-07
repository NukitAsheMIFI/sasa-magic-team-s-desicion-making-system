import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';

import fallbackPivotFacts from './data/08_pivot_facts_demo.json';
import fallbackComparisonCsv from './data/06_comparison_app1001.csv?raw';

function parseSemicolonCsv(text) {
  if (!text) return [];
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

const PIPELINE_STEP_CODES = {
  load: `# Шаг 1: Загрузка и чтение исходных ответов СПР
import os, json

def load_credit_files(folder_path: str):
    """Рекурсивное чтение файлов заявок BEFORE (MASTER) и AFTER (BETA)"""
    files = [f for f in os.listdir(folder_path) if f.endswith('.json')]
    print(f"Обнаружено файлов в выборке: {len(files)}")
    return files
`,
  normalize: `# Шаг 2: Динамический обход JSON (Generic Flattener)
def flatten_json(data, prefix='', path=''):
    """Рекурсивный разбор структуры любой глубины без хардкода имен полей"""
    items = []
    if isinstance(data, dict):
        for k, v in data.items():
            new_path = f"{path}.{k}" if path else k
            items.extend(flatten_json(v, prefix, new_path))
    elif isinstance(data, list):
        for idx, item in enumerate(data):
            items.extend(flatten_json(item, prefix, f"{path}[{idx}]"))
    else:
        items.append({"key": path, "value": str(data)})
    return items
`,
  union: `# Шаг 3: Вертикальный UNION и расчет расхождений (DuckDB)
import duckdb

def build_diff_storage(conn):
    """Склейка срезов и классификация различий"""
    conn.execute("""
        CREATE TABLE mart_rows AS 
        SELECT 
            b.app_id, b.key,
            b.value as value_before,
            a.value as value_after,
            CASE WHEN b.value != a.value THEN 1 ELSE 0 END as diff_flag
        FROM raw_before b
        FULL OUTER JOIN raw_after a ON b.app_id = a.app_id AND b.key = a.key
    """)
`,
  checks: `# Шаг 4: Исполнение автопроверок риск-политики
def check_approval_rate_drop(diff_df, max_drop=0.02):
    """Контроль просадки уровня одобрения портфеля"""
    before_rate = (diff_df['decision_before'] == 'APPROVE').mean()
    after_rate = (diff_df['decision_after'] == 'APPROVE').mean()
    delta = after_rate - before_rate
    return {
        "status": "PASS" if delta >= -max_drop else "FAIL",
        "delta": round(delta * 100, 2)
    }
`
};

const DEFAULT_WORKSPACES = {
  'Аналитик 1 (Иван)': {
    onlyDiffRows: false,
    searchFilter: '',
    sortByImpact: true,
    customRules: [],
    customChecks: [],
    pivotReviews: {},
    appReviews: {}
  },
  'Аналитик 2 (Мария)': {
    onlyDiffRows: true,
    searchFilter: '',
    sortByImpact: true,
    customRules: [],
    customChecks: [],
    pivotReviews: {},
    appReviews: {}
  }
};

export default function App() {
  const [activeTab, setActiveTab] = useState('matrix');
  const [currentUser, setCurrentUser] = useState('Аналитик 1 (Иван)');
  const [activeUserId, setActiveUserId] = useState(1);
  const [userRuns, setUserRuns] = useState([]);

  // Относительный путь по умолчанию: в Docker фронт и бэк на одном хосте
  const [backendUrl, setBackendUrl] = useState(() => {
    return localStorage.getItem('spr_backend_url') || '';
  });
  const [reportId, setReportId] = useState('2');
  const [pivotFacts, setPivotFacts] = useState(fallbackPivotFacts);
  const [apiAppsList, setApiAppsList] = useState([]);
  const [isLoadingApi, setIsLoadingApi] = useState(false);
  const [apiStatus, setApiStatus] = useState('init');

  // Хелпер формирования URL (относительный или абсолютный)
  const getApiUrl = useCallback((path) => {
    const cleanBase = backendUrl ? backendUrl.trim().replace(/\/+$/, '') : '';
    if (!cleanBase) return path;
    return `${cleanBase}${path}`;
  }, [backendUrl]);

  // Состояния пайплайна
  const [activeRunId, setActiveRunId] = useState(null);
  const [isPipelineRunning, setIsPipelineRunning] = useState(false);
  const [pipelineSeconds, setPipelineSeconds] = useState(0);
  const [pipelineSteps, setPipelineSteps] = useState([
    { id: 'load', name: '1. Загрузка JSON-файлов датасета', status: 'done', time: '0.4s' },
    { id: 'normalize', name: '2. Динамическая нормализация (Generic Flattener)', status: 'done', time: '1.8s' },
    { id: 'union', name: '3. Вертикальный UNION и расчет различий (DuckDB)', status: 'done', time: '0.9s' },
    { id: 'checks', name: '4. Исполнение проверок риск-политики (Quality Gates)', status: 'done', time: '0.3s' }
  ]);
  const [runConfig, setRunConfig] = useState({
    dataset: 'RUN-20260827-0001 (4004 файла BEFORE/AFTER)',
    normalizer: 'normalizer_dynamic.py',
    checks: ['approval_rate', 'stop_factors', 'scorecard_cutoff']
  });
  const pollingRef = useRef(null);
  const timerRef = useRef(null);

  // Редактор кода CodeMirror
  const [codeEditorModal, setCodeEditorModal] = useState({
    isOpen: false,
    title: '',
    code: '',
    readOnly: true,
    onSave: null
  });

  // Master-Detail и фильтрация
  const [expandedSegmentClass, setExpandedSegmentClass] = useState(null);
  const [selectedQualityGateId, setSelectedQualityGateId] = useState(null);
  const [collapsedClasses, setCollapsedClasses] = useState({});
  const [selectedPivotFilter, setSelectedPivotFilter] = useState(null);

  // Боковое досье
  const [activeDossierApp, setActiveDossierApp] = useState(null);
  const [dossierRows, setDossierRows] = useState([]);
  const [isDossierLoading, setIsDossierLoading] = useState(false);
  const [manualAppInput, setManualAppInput] = useState('');

  // Модальные окна
  const [isCheckModalOpen, setIsCheckModalOpen] = useState(false);
  const [newCheckName, setNewCheckName] = useState('Контроль обнуления лимита при APPROVE');
  const [newCheckClass, setNewCheckClass] = useState('limitResult');
  const [newCheckArg, setNewCheckArg] = useState('limit');
  const [newCheckThreshold, setNewCheckThreshold] = useState('0 обнулений лимита');
  const [newCheckCode, setNewCheckCode] = useState(`def check_zero_limits_on_approval(mart_df):
    """
    Quality Gate: запрещает скрытые отказы, когда заявке сохранили
    статус APPROVE, но кредитный лимит схлопнулся до 0 рублей.
    """
    zero_limit_anomalies = mart_df.filter(
        (mart_df["PREFIX"] == "limitResult") &
        (mart_df["KEY"] == "limit") &
        (mart_df["VALUE_AFTER"] == "0") &
        (mart_df["DIFF_FLAG"] == 1)
    )
    violations = len(zero_limit_anomalies)
    return {
        "status": "PASS" if violations == 0 else "FAIL",
        "violations_count": violations,
        "threshold": "0 обнулений лимита"
    }
`);

  const [newUserModalOpen, setNewUserModalOpen] = useState(false);
  const [newUserName, setNewUserName] = useState('');

  // Многопользовательское хранилище настроек интерфейса
  const [workspaces, setWorkspaces] = useState(() => {
    try {
      const saved = localStorage.getItem('spr_diff_workspaces_v11');
      return saved ? JSON.parse(saved) : DEFAULT_WORKSPACES;
    } catch {
      return DEFAULT_WORKSPACES;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('spr_diff_workspaces_v11', JSON.stringify(workspaces));
    } catch {}
  }, [workspaces]);

  const currentWorkspace = workspaces[currentUser] || DEFAULT_WORKSPACES['Аналитик 1 (Иван)'];

  const updateCurrentWorkspace = (patch) => {
    setWorkspaces((prev) => ({
      ...prev,
      [currentUser]: {
        ...prev[currentUser],
        ...patch
      }
    }));
  };

  // Авторизация пользователя через /api/auth/login и получение его реального id
  const resolveUserId = useCallback(async (userLabel) => {
    const isMaria = userLabel.includes('2') || userLabel.toLowerCase().includes('мария');
    const username = isMaria ? 'maria' : 'ivan';
    const fallbackId = isMaria ? 2 : 1;

    try {
      let res = await fetch(getApiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'password' })
      });

      if (res.status === 422 || res.status === 415) {
        const formData = new URLSearchParams();
        formData.append('username', username);
        formData.append('password', 'password');
        res = await fetch(getApiUrl('/api/auth/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData
        });
      }

      if (res.ok) {
        const data = await res.json();
        const detectedId = data.id || data.user_id || data.user?.id || fallbackId;
        return Number(detectedId);
      }
    } catch (err) {
      console.warn('Авторизация через /api/auth/login недоступна, используется id:', fallbackId, err);
    }
    return fallbackId;
  }, [getApiUrl]);

  // Запрос истории запусков конкретного пользователя
  const fetchUserRuns = useCallback(async (userId) => {
    try {
      const res = await fetch(getApiUrl(`/api/runs/?user_id=${userId}`), {
        headers: { 'X-User-Id': String(userId) }
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          const userSpecific = data.filter((r) => !r.user_id || Number(r.user_id) === Number(userId));
          setUserRuns(userSpecific.length > 0 ? userSpecific : data);
        }
      }
    } catch (e) {
      console.warn('Ошибка загрузки истории прогонов пользователя:', e);
    }
  }, [getApiUrl]);

  // Смена текущего аналитика: авторизация + подтягивание его истории
  const handleUserChange = async (newUserName) => {
    setCurrentUser(newUserName);
    const resolvedId = await resolveUserId(newUserName);
    setActiveUserId(resolvedId);
    await fetchUserRuns(resolvedId);
  };

  // Запрос агрегированной витрины и реестра с бэкенда
  const fetchBackendData = useCallback(async (targetReportId) => {
    setIsLoadingApi(true);

    try {
      if (backendUrl) {
        localStorage.setItem('spr_backend_url', backendUrl.trim());
      } else {
        localStorage.removeItem('spr_backend_url');
      }

      const resFacts = await fetch(getApiUrl(`/api/reports/${targetReportId}/pivot-facts`));
      if (resFacts.ok) {
        const jsonFacts = await resFacts.json();
        if (Array.isArray(jsonFacts)) setPivotFacts(jsonFacts);
      }

      const resApps = await fetch(getApiUrl(`/api/reports/${targetReportId}/applications`));
      if (resApps.ok) {
        const jsonApps = await resApps.json();
        if (Array.isArray(jsonApps)) setApiAppsList(jsonApps);
      } else {
        setApiAppsList([]);
      }

      setApiStatus('connected');
    } catch {
      setPivotFacts(fallbackPivotFacts);
      setApiAppsList([]);
      setApiStatus('fallback');
    } finally {
      setIsLoadingApi(false);
    }
  }, [backendUrl, getApiUrl]);

  useEffect(() => {
    const initSession = async () => {
      const uid = await resolveUserId(currentUser);
      setActiveUserId(uid);
      await fetchUserRuns(uid);
      await fetchBackendData(reportId);
    };
    initSession();
  }, [fetchBackendData, currentUser, resolveUserId, fetchUserRuns, reportId]);

  // Запуск пайплайна: передача user_id и заголовка X-User-Id
  const handleStartPipelineRun = async () => {
    setIsPipelineRunning(true);
    setPipelineSeconds(0);

    setPipelineSteps([
      { id: 'load', name: '1. Загрузка JSON-файлов датасета', status: 'running', time: '...' },
      { id: 'normalize', name: '2. Динамическая нормализация (Generic Flattener)', status: 'pending', time: '—' },
      { id: 'union', name: '3. Вертикальный UNION и расчет различий (DuckDB)', status: 'pending', time: '—' },
      { id: 'checks', name: '4. Исполнение проверок риск-политики (Quality Gates)', status: 'pending', time: '—' }
    ]);

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setPipelineSeconds((sec) => sec + 1);
    }, 1000);

    try {
      const res = await fetch(getApiUrl('/api/runs/'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': String(activeUserId)
        },
        body: JSON.stringify({
          user_id: Number(activeUserId),
          config: runConfig
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const runData = await res.json();
      const newRunId = runData.id || runData.run_id || 1;
      setActiveRunId(newRunId);

      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(async () => {
        try {
          const stepsRes = await fetch(getApiUrl(`/api/runs/${newRunId}/steps`));
          if (stepsRes.ok) {
            const stepsData = await stepsRes.json();
            if (Array.isArray(stepsData) && stepsData.length > 0) {
              setPipelineSteps(stepsData.map((s, idx) => ({
                id: s.name || `step_${idx}`,
                name: s.name ? `${idx + 1}. ${s.name}` : `Этап ${idx + 1}`,
                status: s.status || (s.is_done ? 'done' : 'running'),
                time: s.status === 'done' || s.is_done ? 'Готово' : 'В процессе...'
              })));

              const allDone = stepsData.every((s) => s.status === 'done' || s.is_done);
              if (allDone) {
                clearInterval(pollingRef.current);
                clearInterval(timerRef.current);
                setIsPipelineRunning(false);
                setReportId(String(newRunId));

                await fetchUserRuns(activeUserId);
                await fetchBackendData(String(newRunId));
                setActiveTab('matrix');
              }
            }
          }
        } catch (err) {
          console.warn('Ошибка опроса статуса шагов:', err);
        }
      }, 1000);

    } catch {
      setTimeout(() => {
        setPipelineSteps((prev) => prev.map((s, idx) => ({ ...s, status: idx <= 1 ? 'done' : 'running' })));
      }, 1200);

      setTimeout(() => {
        setPipelineSteps((prev) => prev.map((s) => ({ ...s, status: 'done', time: '0.8s' })));
        clearInterval(timerRef.current);
        setIsPipelineRunning(false);
        setActiveTab('matrix');
      }, 2600);
    }
  };

  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Парсинг локального CSV
  const parsedComparisonRows = useMemo(() => parseSemicolonCsv(fallbackComparisonCsv), []);

  const appsDatabase = useMemo(() => {
    const map = {};
    parsedComparisonRows.forEach((row) => {
      const rawId = row.APP_ID || '1001';
      const appId = String(rawId);
      if (!map[appId]) map[appId] = [];
      map[appId].push(row);
    });
    return map;
  }, [parsedComparisonRows]);

  const registeredAppList = useMemo(() => {
    if (apiAppsList.length > 0) {
      return apiAppsList.map((app) => {
        const id = String(app.app_id || app.id || app.APP_ID);
        const decAfter = app.decision_after || app.afterDecision || app.VALUE_AFTER || '—';
        const diffCnt = app.diff_count ?? app.diffCount ?? 0;

        return {
          id,
          rawRows: appsDatabase[id] || [],
          beforeDecision: app.beforeDecision || '—',
          afterDecision: decAfter,
          diffCount: diffCnt,
          driver: decAfter === 'UNKNOWN' 
            ? 'Решение: UNKNOWN (путь уточняется)' 
            : `Решение в BETA: ${decAfter}`
        };
      });
    }

    return Object.keys(appsDatabase).map((appId) => {
      const rows = appsDatabase[appId];
      const decRow = rows.find((r) => (r.KEY || '').toLowerCase().includes('decision')) || rows[0];
      const diffRows = rows.filter((r) => Number(r.DIFF_FLAG) === 1);

      return {
        id: appId,
        rawRows: rows,
        beforeDecision: decRow?.VALUE_BEFORE || '—',
        afterDecision: decRow?.VALUE_AFTER || '—',
        diffCount: diffRows.length,
        driver: diffRows.map((r) => r.COMMENT).filter(Boolean).join('; ') || 'Без комментариев'
      };
    });
  }, [apiAppsList, appsDatabase]);

  const handleOpenDossier = useCallback(async (appId) => {
    if (!appId) return;
    const cleanId = String(appId).trim();
    setActiveDossierApp(cleanId);

    const targetQueryId = cleanId.replace(/^APP-/, '');
    const localRows = appsDatabase[cleanId] || appsDatabase[targetQueryId] || [];
    setDossierRows(localRows);

    if (apiStatus === 'connected') {
      setIsDossierLoading(true);
      try {
        const res = await fetch(getApiUrl(`/api/reports/${reportId}/applications/${encodeURIComponent(targetQueryId)}/diff`));
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json) && json.length > 0) {
            setDossierRows(json);
          }
        }
      } catch {
      } finally {
        setIsDossierLoading(false);
      }
    }
  }, [apiStatus, reportId, appsDatabase, getApiUrl]);

  // Агрегация витрины facts
  const combinedPivotFacts = useMemo(() => {
    return [...pivotFacts, ...(currentWorkspace.customRules || [])];
  }, [pivotFacts, currentWorkspace.customRules]);

  const {
    decisionSummaryRows,
    groupedParameterBlocks,
    summaryMetrics,
    transitionMatrix,
    qualityGates
  } = useMemo(() => {
    const map = {};

    combinedPivotFacts.forEach((row) => {
      let cls = 'Общие параметры';
      if (row.CLASS && String(row.CLASS).trim() !== '') {
        cls = String(row.CLASS).trim();
      } else if (row.PREFIX && String(row.PREFIX).trim() !== '' && String(row.PREFIX).trim() !== 'company') {
        cls = String(row.PREFIX).trim();
      } else if (row.PREFIX) {
        cls = String(row.PREFIX).trim();
      }

      const arrKey = row.ARRAY_KEY ? String(row.ARRAY_KEY) : '';
      const key = row.KEY ? String(row.KEY) : '';
      const val = row.VALUE_ADJUSTED ?? row.VALUE_AFTER ?? row.VALUE_BEFORE ?? '—';
      const rowId = `${cls}__${arrKey}__${key}__${val}`;

      if (!map[rowId]) {
        map[rowId] = {
          id: rowId,
          class: cls,
          arrayKey: arrKey,
          key,
          value: val,
          stableCount: 0,
          leftCount: 0,
          arrivedCount: 0,
        };
      }

      const count = Number(row.CNT) || 0;
      const isDiff = Number(row.DIFF_FLAG) === 1;
      const isBefore = String(row.SOURCE || '').toUpperCase().includes('BEFORE');

      if (!isDiff) {
        if (isBefore) map[rowId].stableCount += count;
      } else {
        if (isBefore) {
          map[rowId].leftCount += count;
        } else {
          map[rowId].arrivedCount += count;
        }
      }
    });

    const allRows = Object.values(map).map((r) => {
      const totalBefore = r.stableCount + r.leftCount;
      const totalAfter = r.stableCount + r.arrivedCount;
      const netDelta = totalAfter - totalBefore;
      const totalChanges = r.leftCount + r.arrivedCount;
      const affectedClientsInBucket = Math.max(r.leftCount, r.arrivedCount);
      return {
        ...r,
        totalBefore,
        totalAfter,
        netDelta,
        absDelta: Math.abs(netDelta),
        totalChanges,
        affectedClientsInBucket
      };
    });

    const decRows = allRows.filter((r) => (r.key || '').toLowerCase().includes('decision') || (r.class || '').toLowerCase().includes('decision'));
    const primaryClass = decRows.length > 0 ? decRows[0].class : (allRows[0]?.class || 'decisionResult');
    const primaryDecRows = allRows.filter((r) => r.class === primaryClass);

    const totalPortfolio = primaryDecRows.reduce((acc, r) => acc + r.totalBefore, 0);
    const stableApps = primaryDecRows.reduce((acc, r) => acc + r.stableCount, 0);
    const flippedApps = primaryDecRows.reduce((acc, r) => acc + r.leftCount, 0);

    const approveRow = primaryDecRows.find((r) => String(r.value).toUpperCase() === 'APPROVE') || {
      totalBefore: 0,
      totalAfter: 0,
      stableCount: 0,
      leftCount: 0,
      arrivedCount: 0
    };
    const rejectRow = primaryDecRows.find((r) => String(r.value).toUpperCase() === 'REJECT') || {
      totalBefore: 0,
      totalAfter: 0,
      stableCount: 0,
      leftCount: 0,
      arrivedCount: 0
    };

    const rateBefore = totalPortfolio > 0 ? ((approveRow.totalBefore / totalPortfolio) * 100).toFixed(1) : '0.0';
    const rateAfter = totalPortfolio > 0 ? ((approveRow.totalAfter / totalPortfolio) * 100).toFixed(1) : '0.0';
    const rateDiffNum = Number((Number(rateAfter) - Number(rateBefore)).toFixed(1));

    const decisionTable = (decRows.length > 0 ? decRows : primaryDecRows).map((r) => ({
      ...r,
      shareBefore: totalPortfolio > 0 ? ((r.totalBefore / totalPortfolio) * 100).toFixed(1) : '0.0',
      shareAfter: totalPortfolio > 0 ? ((r.totalAfter / totalPortfolio) * 100).toFixed(1) : '0.0',
      shareDiff: totalPortfolio > 0 ? (((r.totalAfter - r.totalBefore) / totalPortfolio) * 100).toFixed(1) : '0.0'
    }));

    const allUniqueParams = new Set();
    const affectedUniqueParams = new Set();
    const groupsMap = {};

    allRows.forEach((row) => {
      const paramKey = `${row.class}.${row.arrayKey}.${row.key}`;
      allUniqueParams.add(paramKey);
      if (row.totalChanges > 0) {
        affectedUniqueParams.add(paramKey);
      }

      if (!groupsMap[row.class]) {
        groupsMap[row.class] = {
          className: row.class,
          paramSet: new Set(),
          affectedParamSet: new Set(),
          maxAffectedClients: 0,
          rowsCount: 0,
          totalDiffChanges: 0,
          rows: []
        };
      }
      const grp = groupsMap[row.class];
      grp.rows.push(row);
      grp.rowsCount += 1;
      grp.totalDiffChanges += row.totalChanges;
      grp.paramSet.add(paramKey);
      if (row.totalChanges > 0) {
        grp.affectedParamSet.add(paramKey);
      }
      if (row.affectedClientsInBucket > grp.maxAffectedClients) {
        grp.maxAffectedClients = row.affectedClientsInBucket;
      }
    });

    const groupedBlocks = Object.values(groupsMap).map((g) => ({
      className: g.className,
      totalParams: g.paramSet.size,
      affectedParams: g.affectedParamSet.size,
      maxAffectedClients: g.maxAffectedClients,
      totalDiffChanges: g.totalDiffChanges,
      rowsCount: g.rowsCount,
      rows: g.rows
    }));

    const dynamicGates = groupedBlocks.slice(0, 4).map((block, idx) => {
      const changedRows = block.rows.filter((r) => r.totalChanges > 0);
      const topShift = changedRows.reduce((max, r) => Math.max(max, r.affectedClientsInBucket), 0);
      const isDecision = block.className === primaryClass;

      let ruleName = `Контроль модуля «${block.className}»`;
      let threshold = 'Δ ≤ 5% сдвига';
      let status = 'PASS';
      let metric = `${changedRows.length} изменившихся бакетов`;

      if (isDecision) {
        ruleName = 'Контроль стабильности уровня одобрения (Approval Rate)';
        threshold = 'Δ AR ≥ -2.0%';
        metric = `${rateBefore}% → ${rateAfter}% (${rateDiffNum > 0 ? '+' : ''}${rateDiffNum}%)`;
        status = rateDiffNum >= -2.0 ? 'PASS' : 'FAIL';
      } else {
        status = block.totalDiffChanges === 0 || topShift < 30 ? 'PASS' : 'FAIL';
        metric = changedRows.length > 0 ? `Макс. переток: ${topShift} анкет` : '0 расхождений (норма)';
      }

      return {
        id: `gate-auto-${idx}`,
        name: `${idx + 1}. ${ruleName}`,
        targetClass: block.className,
        argument: changedRows[0]?.key || block.className,
        threshold,
        metric,
        affectedCount: topShift,
        status,
        codeSnippet: `def check_${block.className.toLowerCase()}(mart_df):\n    # Проверка отклонения по модулю ${block.className}\n    diff_rows = mart_df.filter(class_name="${block.className}", diff_flag=1)\n    return {"status": "${status}", "count": ${topShift}}\n`
      };
    });

    const customGatesEvaluated = (currentWorkspace.customChecks || []).map((cg) => {
      const matching = groupedBlocks.find((b) => b.className.toLowerCase() === (cg.targetClass || '').toLowerCase().trim());
      const changedRows = matching ? matching.rows.filter((r) => r.totalChanges > 0) : [];
      const diffs = changedRows.reduce((sum, r) => sum + r.affectedClientsInBucket, 0);

      const hasFail = diffs > 0;
      return {
        ...cg,
        status: hasFail ? 'FAIL' : 'PASS',
        metric: matching 
          ? (hasFail ? `Нарушений: ${diffs} анкет` : '0 расхождений (норма)')
          : 'Модуль не найден в отчёте',
        affectedCount: diffs
      };
    });

    return {
      decisionSummaryRows: decisionTable,
      groupedParameterBlocks: groupedBlocks,
      qualityGates: [...dynamicGates, ...customGatesEvaluated],
      transitionMatrix: {
        approveStable: approveRow.stableCount,
        approveLost: approveRow.leftCount,
        approveGained: approveRow.arrivedCount,
        rejectStable: rejectRow.stableCount,
        rejectLost: rejectRow.leftCount,
        rejectGained: rejectRow.arrivedCount
      },
      summaryMetrics: {
        primaryClass,
        totalPortfolio,
        stableApps,
        flippedApps,
        rateBefore,
        rateAfter,
        rateDiff: rateDiffNum > 0 ? `+${rateDiffNum}%` : `${rateDiffNum}%`,
        totalRows: allRows.length,
        totalUniqueParams: allUniqueParams.size,
        affectedUniqueParams: affectedUniqueParams.size
      }
    };
  }, [combinedPivotFacts, currentWorkspace.customChecks]);

  // Фильтрация блоков параметров
  const displayedBlocks = useMemo(() => {
    const q = (currentWorkspace.searchFilter || '').toLowerCase();

    return groupedParameterBlocks
      .map((block) => {
        let filteredRows = block.rows.filter((row) => {
          if (currentWorkspace.onlyDiffRows && row.totalChanges === 0) return false;
          if (q) {
            const match =
              row.class.toLowerCase().includes(q) ||
              row.arrayKey.toLowerCase().includes(q) ||
              row.key.toLowerCase().includes(q) ||
              String(row.value).toLowerCase().includes(q);
            if (!match) return false;
          }
          return true;
        });

        if (currentWorkspace.sortByImpact) {
          filteredRows = [...filteredRows].sort(
            (a, b) => b.affectedClientsInBucket - a.affectedClientsInBucket || b.absDelta - a.absDelta
          );
        }

        return { ...block, rows: filteredRows };
      })
      .filter((block) => block.rows.length > 0);
  }, [groupedParameterBlocks, currentWorkspace.onlyDiffRows, currentWorkspace.searchFilter, currentWorkspace.sortByImpact]);

  // Фильтрация реестра заявок
  const filteredApps = useMemo(() => {
    return registeredAppList.filter((app) => {
      if (!selectedPivotFilter) return true;
      if (selectedPivotFilter.value && app.afterDecision === selectedPivotFilter.value) {
        return true;
      }
      return false;
    });
  }, [registeredAppList, selectedPivotFilter]);

  const handleDrillDown = (row, direction) => {
    const expectedCount = direction === 'LEFT' ? row.leftCount : row.arrivedCount;
    if (expectedCount === 0) return;

    setSelectedPivotFilter({
      class: row.class,
      arrayKey: row.arrayKey,
      key: row.key,
      value: row.value,
      direction,
      expectedCount
    });
    setExpandedSegmentClass(`${row.class}__${row.value}`);
  };

  const toggleClassCollapse = (className) => {
    setCollapsedClasses((prev) => ({ ...prev, [className]: !prev[className] }));
  };

  const openCodeModal = (title, code, readOnly = true, onSave = null) => {
    setCodeEditorModal({
      isOpen: true,
      title,
      code,
      readOnly,
      onSave
    });
  };

  const handleAddCustomCheck = (e) => {
    e.preventDefault();
    if (!newCheckName.trim()) return;

    const newGate = {
      id: `custom-${Date.now()}`,
      name: newCheckName.trim(),
      targetClass: newCheckClass.trim() || 'limitResult',
      argument: newCheckArg.trim() || 'limit',
      threshold: newCheckThreshold.trim() || '0 обнулений лимита',
      codeSnippet: newCheckCode,
      isCustom: true
    };

    updateCurrentWorkspace({
      customChecks: [...(currentWorkspace.customChecks || []), newGate]
    });
    setIsCheckModalOpen(false);
  };

  const handleDeleteCustomCheck = (checkId) => {
    updateCurrentWorkspace({
      customChecks: (currentWorkspace.customChecks || []).filter((c) => c.id !== checkId)
    });
    if (selectedQualityGateId === checkId) setSelectedQualityGateId(null);
  };

  const handleCreateUser = (e) => {
    e.preventDefault();
    if (!newUserName.trim()) return;
    const label = newUserName.trim();
    if (!workspaces[label]) {
      setWorkspaces((prev) => ({
        ...prev,
        [label]: {
          onlyDiffRows: false,
          searchFilter: '',
          sortByImpact: true,
          customRules: [],
          customChecks: [],
          pivotReviews: {},
          appReviews: {}
        }
      }));
    }
    handleUserChange(label);
    setNewUserName('');
    setNewUserModalOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50/70 text-slate-900 font-sans flex flex-col">
      
      {/* ── ШАПКА ── */}
      <header className="border-b border-slate-200 bg-white px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-30 shadow-xs">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${apiStatus === 'connected' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></span>
            <span className="font-bold text-sm tracking-tight text-slate-800">СПР • Сравнение кредитных стратегий</span>
          </div>

          <nav className="flex gap-1 bg-slate-100 p-1 rounded-lg">
            <button
              onClick={() => setActiveTab('run')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'run' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>▶ Запуск и пайплайн</span>
              {isPipelineRunning && <span className="w-2 h-2 rounded-full bg-blue-600 animate-ping"></span>}
            </button>
            <button
              onClick={() => setActiveTab('matrix')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition cursor-pointer ${
                activeTab === 'matrix' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Сводный отчёт ({summaryMetrics.totalRows})
            </button>
            <button
              onClick={() => setActiveTab('registry')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition cursor-pointer ${
                activeTab === 'registry' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Реестр заявок ({registeredAppList.length} шт.)
            </button>
          </nav>

          {/* Панель подключения к API: без хардкода localhost */}
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs">
            <span className="text-slate-400 font-medium">Хост API:</span>
            <input
              type="text"
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
              placeholder="относительный (/api)"
              className="bg-white border border-slate-300 rounded px-2 py-0.5 text-xs font-mono w-32 outline-none focus:border-blue-500"
              title="Оставьте пустым для относительных путей /api (Docker / Proxy) или введите хост"
            />
            <span className="text-slate-400">#</span>
            <input
              type="text"
              value={reportId}
              onChange={(e) => setReportId(e.target.value)}
              className="bg-white border border-slate-300 rounded px-1.5 py-0.5 text-xs font-mono w-8 text-center outline-none focus:border-blue-500"
              title="ID прогона отчёта"
            />
            <button
              onClick={() => fetchBackendData(reportId)}
              className="px-2 py-0.5 bg-slate-900 hover:bg-blue-600 text-white rounded font-semibold transition cursor-pointer"
              title="Обновить данные с бэкенда"
            >
              {isLoadingApi ? '...' : '↻'}
            </button>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
              apiStatus === 'connected' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
            }`}>
              {apiStatus === 'connected' ? `RUN #${reportId} ONLINE` : 'DEMO'}
            </span>
          </div>
        </div>

        {/* Многопользовательский блок */}
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5 bg-white border border-slate-300 rounded-lg px-2.5 py-1 text-xs shadow-xs">
            <span className="text-slate-400">👤</span>
            <select
              value={currentUser}
              onChange={(e) => handleUserChange(e.target.value)}
              className="bg-transparent border-none outline-none font-medium text-slate-700 cursor-pointer"
            >
              {Object.keys(workspaces).map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <span className="text-[10px] bg-blue-100 text-blue-800 font-mono font-bold px-1.5 py-0.5 rounded">
              id:{activeUserId}
            </span>
          </div>

          <button
            onClick={() => setNewUserModalOpen(true)}
            className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 transition cursor-pointer"
          >
            + Аналитик
          </button>

          <button
            onClick={() => setIsCheckModalOpen(true)}
            className="px-3 py-1 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition shadow-xs cursor-pointer"
          >
            + Автопроверка
          </button>
        </div>
      </header>

      {/* ── ОСНОВНОЙ КОНТЕНТ ── */}
      <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-6">

        {/* ── ВКЛАДКА: ЗАПУСК БЭКТЕСТА, ПАЙПЛАЙН И ИСТОРИЯ ── */}
        {activeTab === 'run' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
              <div className="md:col-span-6 bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
                <div className="border-b border-slate-100 pb-3">
                  <div className="flex justify-between items-center">
                    <h2 className="text-base font-bold text-slate-800">Конфигурация бэктеста</h2>
                    <span className="text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-mono font-bold">
                      User ID: {activeUserId}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Запуск пайплайна нормализации через <code>POST /api/runs/</code>
                  </p>
                </div>

                <div className="space-y-3 text-xs">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Выбор пула ретро-заявок (Датасет)</label>
                    <select 
                      value={runConfig.dataset}
                      onChange={(e) => setRunConfig({ ...runConfig, dataset: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-xs font-mono text-slate-800 outline-none focus:border-blue-500"
                    >
                      <option value="RUN-20260827-0001 (4004 файла BEFORE/AFTER)">RUN-20260827-0001 (4004 файла BEFORE/AFTER)</option>
                      <option value="RUN-20260901-0042 (1000 файлов)">RUN-20260901-0042 (1000 файлов)</option>
                    </select>
                  </div>

                  <div>
                    <div className="flex justify-between items-center mb-1">
                      <label className="font-medium text-slate-700">Процедура нормализации (Скрипт)</label>
                      <button
                        onClick={() => openCodeModal('normalizer_dynamic.py', PIPELINE_STEP_CODES.normalize, false, (newCode) => {
                          PIPELINE_STEP_CODES.normalize = newCode;
                        })}
                        className="text-blue-600 hover:underline font-semibold cursor-pointer"
                      >
                        Редактировать код →
                      </button>
                    </div>
                    <input
                      type="text"
                      value={runConfig.normalizer}
                      onChange={(e) => setRunConfig({ ...runConfig, normalizer: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-xs font-mono text-slate-800"
                    />
                  </div>

                  <div className="pt-2">
                    <button
                      onClick={handleStartPipelineRun}
                      disabled={isPipelineRunning}
                      className="w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition shadow-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                    >
                      {isPipelineRunning ? (
                        <>
                          <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                          <span>Идёт расчёт ({pipelineSeconds} сек)...</span>
                        </>
                      ) : (
                        <span>▶ Запустить сравнение кредитных стратегий (ID: {activeUserId})</span>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <div className="md:col-span-6 bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
                <div className="flex justify-between items-center border-b border-slate-100 pb-3">
                  <div>
                    <h2 className="text-base font-bold text-slate-800">Журнал этапов пайплайна</h2>
                    <p className="text-xs text-slate-500">
                      Опрос статусов через <code>GET /api/runs/{'{id}'}/steps</code>
                    </p>
                  </div>
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${
                    isPipelineRunning ? 'bg-amber-100 text-amber-800 animate-pulse' : 'bg-emerald-100 text-emerald-800'
                  }`}>
                    {isPipelineRunning ? 'В ПРОЦЕССЕ' : 'ГОТОВ (ID: #' + reportId + ')'}
                  </span>
                </div>

                <div className="space-y-3">
                  {pipelineSteps.map((step) => {
                    const isDone = step.status === 'done';
                    const isRunning = step.status === 'running';

                    return (
                      <div
                        key={step.id}
                        className={`p-3 rounded-xl border transition flex items-center justify-between text-xs ${
                          isRunning 
                            ? 'bg-blue-50/60 border-blue-200' 
                            : isDone 
                            ? 'bg-slate-50 border-slate-200' 
                            : 'bg-white border-slate-100 opacity-60'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                            isDone 
                              ? 'bg-emerald-600 text-white' 
                              : isRunning 
                              ? 'bg-blue-600 text-white animate-spin' 
                              : 'bg-slate-200 text-slate-500'
                          }`}>
                            {isDone ? '✓' : isRunning ? '⟳' : '○'}
                          </span>
                          <div>
                            <div className="font-semibold text-slate-800">{step.name}</div>
                            <div className="text-[10px] text-slate-400">Время: {step.time}</div>
                          </div>
                        </div>

                        <button
                          onClick={() => openCodeModal(
                            `Код этапа: ${step.name}`,
                            PIPELINE_STEP_CODES[step.id] || '# Исходный код этапа выполняется на сервере\n',
                            true
                          )}
                          className="px-2.5 py-1 rounded bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 font-semibold transition cursor-pointer text-[11px]"
                        >
                          Код этапа ↗
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Персональная история запусков текущего аналитика */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs space-y-4">
              <div className="flex justify-between items-center border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-800">
                    История запусков пользователя: {currentUser} (User ID: {activeUserId})
                  </h3>
                  <p className="text-xs text-slate-500">
                    Отображает только прогоны, запущенные этой учётной записью
                  </p>
                </div>
                <button
                  onClick={() => fetchUserRuns(activeUserId)}
                  className="text-xs text-blue-600 hover:underline font-semibold cursor-pointer"
                >
                  ↻ Обновить историю
                </button>
              </div>

              {userRuns.length === 0 ? (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-500 text-center">
                  У этого пользователя пока нет отдельных сохранённых запусков. Запустите бэктест выше, и он появится здесь.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                  {userRuns.map((r) => (
                    <div
                      key={r.id || r.run_id}
                      onClick={() => {
                        const targetId = String(r.id || r.run_id);
                        setReportId(targetId);
                        fetchBackendData(targetId);
                        setActiveTab('matrix');
                      }}
                      className={`p-3 rounded-xl border cursor-pointer transition flex flex-col justify-between ${
                        reportId === String(r.id || r.run_id)
                          ? 'border-blue-500 bg-blue-50/50'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-mono font-bold text-xs text-slate-800">
                          Запуск #{r.id || r.run_id}
                        </span>
                        <span className="text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-bold">
                          {r.status || 'done'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {r.created_at ? new Date(r.created_at).toLocaleTimeString() : 'Завершён'}
                      </div>
                      <div className="mt-2 pt-2 border-t border-slate-100 text-right">
                        <span className="text-[11px] text-blue-600 font-semibold">
                          Открыть отчёт →
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── ВКЛАДКА: СВОДНЫЙ ОТЧЁТ И ВИТРИНА ── */}
        {activeTab === 'matrix' && (
          <div className="space-y-6">
            
            {/* 1. КАРТОЧКИ БИЗНЕС-МЕТРИК ПОРТФЕЛЯ */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
                <div className="text-xs font-medium text-slate-500 mb-1">Уровень одобрения (APPROVE)</div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold tracking-tight text-slate-900">{summaryMetrics.rateAfter}%</div>
                  <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                    {summaryMetrics.rateDiff}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  MASTER: {summaryMetrics.rateBefore}% • Портфель: {summaryMetrics.totalPortfolio} анкет
                </div>
              </div>

              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
                <div className="text-xs font-medium text-slate-500 mb-1">Смена решения (Flip)</div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold tracking-tight text-slate-900">{summaryMetrics.flippedApps}</div>
                  <span className="text-xs font-semibold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded">
                    DIFF=1
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Стабильное решение: {summaryMetrics.stableApps} клиентов
                </div>
              </div>

              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
                <div className="text-xs font-medium text-slate-500 mb-1">Загружено заявок в реестр</div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold tracking-tight text-blue-600">
                    {registeredAppList.length}
                  </div>
                  <span className="text-xs font-semibold text-blue-800 bg-blue-50 px-1.5 py-0.5 rounded">
                    из базы FastAPI
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Все ID доступны для открытия досье
                </div>
              </div>

              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
                <div className="text-xs font-medium text-slate-500 mb-1">Баланс перетока одобрений</div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold tracking-tight text-emerald-600">
                    +{transitionMatrix.approveGained} <span className="text-rose-600 text-lg">/ -{transitionMatrix.approveLost}</span>
                  </div>
                  <span className="text-xs font-semibold text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">
                    Приток / Отсев
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Чистая дельта: +{transitionMatrix.approveGained - transitionMatrix.approveLost} одобрений
                </div>
              </div>
            </div>

            {/* 2. ДИНАМИЧЕСКИЙ БЛОК АВТОПРОВЕРОК (QUALITY GATES) */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2">
                <div>
                  <h2 className="text-sm font-bold text-slate-800">Автоматические проверки стратегии (Quality Gates)</h2>
                  <p className="text-[11px] text-slate-500">
                    Кликните по названию или кнопке «Срез», чтобы развернуть детальную таблицу параметров
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                    PASS: {qualityGates.filter((g) => g.status === 'PASS').length}
                  </span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-rose-100 text-rose-800">
                    FAIL: {qualityGates.filter((g) => g.status === 'FAIL').length}
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-white text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-4 font-semibold">Контрольная проверка</th>
                      <th className="py-2.5 px-4 font-semibold">Модуль (CLASS)</th>
                      <th className="py-2.5 px-4 font-semibold">Порог политики</th>
                      <th className="py-2.5 px-4 font-semibold">Факт по витрине</th>
                      <th className="py-2.5 px-4 font-semibold text-center">Статус</th>
                      <th className="py-2.5 px-4 font-semibold text-right">Действия</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {qualityGates.map((gate) => {
                      const isSelected = selectedQualityGateId === gate.id;
                      const matchingBlock = groupedParameterBlocks.find(
                        (b) => b.className.toLowerCase().trim() === (gate.targetClass || '').toLowerCase().trim()
                      );

                      return (
                        <React.Fragment key={gate.id}>
                          <tr
                            onClick={() => setSelectedQualityGateId(isSelected ? null : gate.id)}
                            className={`cursor-pointer transition ${
                              isSelected ? 'bg-blue-50/70 font-semibold' : 'hover:bg-slate-50'
                            }`}
                          >
                            <td className="py-2.5 px-4 text-slate-800">
                              <span className="mr-1.5 text-slate-400 font-bold">{isSelected ? '▼' : '▶'}</span>
                              {gate.name}
                            </td>
                            <td className="py-2.5 px-4 font-mono text-slate-600">
                              <span className="bg-slate-100 px-2 py-0.5 rounded text-[11px] font-semibold">{gate.targetClass}</span>
                            </td>
                            <td className="py-2.5 px-4 text-slate-500 font-mono">{gate.threshold}</td>
                            <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">{gate.metric}</td>
                            <td className="py-2.5 px-4 text-center">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                gate.status === 'PASS'
                                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                  : 'bg-rose-100 text-rose-800 border border-rose-200'
                              }`}>
                                {gate.status}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openCodeModal(`Логика правила: ${gate.name}`, gate.codeSnippet || '# Код проверки\n', true);
                                  }}
                                  className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 rounded font-semibold transition cursor-pointer"
                                >
                                  Код ↗
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedQualityGateId(isSelected ? null : gate.id);
                                  }}
                                  className="text-[11px] text-blue-600 hover:underline font-semibold cursor-pointer"
                                >
                                  {isSelected ? 'Скрыть ▲' : 'Срез ▼'}
                                </button>
                                {gate.isCustom && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteCustomCheck(gate.id);
                                    }}
                                    className="text-[11px] text-rose-500 hover:text-rose-700 px-1 py-0.5 rounded font-bold cursor-pointer"
                                    title="Удалить пользовательское правило"
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>

                          {isSelected && (
                            <tr>
                              <td colSpan={6} className="p-4 bg-slate-50 border-y border-blue-200">
                                {matchingBlock ? (
                                  <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-2 shadow-xs">
                                    <div className="flex justify-between items-center">
                                      <span className="text-xs font-bold text-slate-800">
                                        Параметры модуля «{matchingBlock.className}» ({matchingBlock.rows.length} бакетов):
                                      </span>
                                      <button
                                        onClick={() => setSelectedQualityGateId(null)}
                                        className="text-xs text-slate-400 hover:text-slate-700 cursor-pointer"
                                      >
                                        ✕ Скрыть панель
                                      </button>
                                    </div>
                                    <table className="w-full text-left text-[11px] font-mono">
                                      <thead className="bg-slate-50 text-slate-500 font-sans">
                                        <tr>
                                          <th className="py-1.5 px-3">Параметр (KEY)</th>
                                          <th className="py-1.5 px-3">Бакет (VALUE)</th>
                                          <th className="py-1.5 px-3 text-center">DIFF=0 (Стабильно)</th>
                                          <th className="py-1.5 px-3 text-center text-rose-700">Ушло (BEFORE)</th>
                                          <th className="py-1.5 px-3 text-center text-emerald-700">Пришло (AFTER)</th>
                                          <th className="py-1.5 px-3 text-center">Чистый сдвиг (Δ)</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100">
                                        {matchingBlock.rows.map((r) => (
                                          <tr key={r.id} className={r.totalChanges > 0 ? 'bg-amber-50/40' : ''}>
                                            <td className="py-1.5 px-3 font-semibold text-slate-700">{r.arrayKey ? `${r.arrayKey}.${r.key}` : r.key || '—'}</td>
                                            <td className="py-1.5 px-3 font-bold text-slate-900">{r.value}</td>
                                            <td className="py-1.5 px-3 text-center text-slate-500">{r.stableCount}</td>
                                            <td className="py-1.5 px-3 text-center text-rose-600 font-bold">{r.leftCount > 0 ? `-${r.leftCount}` : '0'}</td>
                                            <td className="py-1.5 px-3 text-center text-emerald-600 font-bold">{r.arrivedCount > 0 ? `+${r.arrivedCount}` : '0'}</td>
                                            <td className="py-1.5 px-3 text-center font-bold">{r.netDelta > 0 ? `+${r.netDelta}` : r.netDelta}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <div className="bg-white rounded-xl border border-slate-200 p-4 text-xs text-slate-600 flex justify-between items-center">
                                    <span>
                                      Для модуля <b>{gate.targetClass}</b> в текущем отчёте не найдено записей с расхождениями.
                                    </span>
                                    <button
                                      onClick={() => setSelectedQualityGateId(null)}
                                      className="text-xs text-slate-400 hover:text-slate-700 cursor-pointer"
                                    >
                                      ✕ Закрыть
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 3. ТАБЛИЦА РЕШЕНИЙ С ИНЛАЙН MASTER-DETAIL */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
              <div className="px-5 py-3.5 bg-slate-900 text-white flex flex-wrap justify-between items-center gap-2">
                <div>
                  <h2 className="text-sm font-bold">Итоговые решения и сегменты модели</h2>
                  <p className="text-[11px] text-slate-300">
                    Клик по названию модуля или по кнопке перетока раскрывает параметры и заявки прямо под строкой
                  </p>
                </div>
                {expandedSegmentClass && (
                  <button
                    onClick={() => {
                      setExpandedSegmentClass(null);
                      setSelectedPivotFilter(null);
                    }}
                    className="text-xs bg-white/15 hover:bg-white/25 text-white px-2.5 py-1 rounded transition cursor-pointer"
                  >
                    ✕ Свернуть срез
                  </button>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-4 font-semibold">Модуль / Сегмент</th>
                      <th className="py-2.5 px-4 font-semibold">Исход (VALUE)</th>
                      <th className="py-2.5 px-4 font-semibold text-center">MASTER</th>
                      <th className="py-2.5 px-4 font-semibold text-center text-slate-500">DIFF=0 (Стабильно)</th>
                      <th className="py-2.5 px-4 font-semibold text-center text-rose-700 bg-rose-50/40">Ушло (BEFORE)</th>
                      <th className="py-2.5 px-4 font-semibold text-center text-emerald-700 bg-emerald-50/40">Пришло (AFTER)</th>
                      <th className="py-2.5 px-4 font-semibold text-center">BETA</th>
                      <th className="py-2.5 px-4 font-semibold text-center">Чистый итог (Δ)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {decisionSummaryRows.map((row) => {
                      const targetKey = `${row.class}__${row.value}`;
                      const isRowExpanded = expandedSegmentClass === targetKey;
                      const parentBlock = groupedParameterBlocks.find((b) => b.className === row.class);

                      return (
                        <React.Fragment key={row.id}>
                          <tr
                            onClick={() => {
                              if (expandedSegmentClass === targetKey) {
                                setExpandedSegmentClass(null);
                                setSelectedPivotFilter(null);
                              } else {
                                setExpandedSegmentClass(targetKey);
                                setSelectedPivotFilter({
                                  class: row.class,
                                  arrayKey: row.arrayKey,
                                  key: row.key,
                                  value: row.value,
                                  direction: 'ALL',
                                  expectedCount: row.leftCount + row.arrivedCount
                                });
                              }
                            }}
                            className={`cursor-pointer transition ${
                              isRowExpanded ? 'bg-blue-50/70 font-semibold' : 'hover:bg-slate-50'
                            }`}
                          >
                            <td className="py-2.5 px-4 font-sans font-medium text-slate-700">
                              <span className="inline-flex items-center gap-1.5 bg-slate-100 hover:bg-blue-100 text-slate-800 px-2.5 py-1 rounded text-[11px] font-semibold transition">
                                <span className="text-blue-600">{isRowExpanded ? '▼' : '▶'}</span>
                                {row.class}{row.arrayKey ? ` • ${row.arrayKey}` : ''}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 font-bold text-slate-900">{row.value}</td>
                            <td className="py-2.5 px-4 text-center text-slate-700 font-bold">{row.totalBefore}</td>
                            <td className="py-2.5 px-4 text-center text-slate-500">{row.stableCount}</td>

                            <td className="py-2.5 px-4 text-center bg-rose-50/20 font-sans" onClick={(e) => e.stopPropagation()}>
                              {row.leftCount > 0 ? (
                                <button
                                  onClick={() => handleDrillDown(row, 'LEFT')}
                                  className="px-2.5 py-0.5 rounded bg-rose-100 hover:bg-rose-600 hover:text-white text-rose-800 font-mono font-bold text-xs transition cursor-pointer"
                                >
                                  -{row.leftCount} ▼
                                </button>
                              ) : (
                                <span className="text-slate-300">0</span>
                              )}
                            </td>

                            <td className="py-2.5 px-4 text-center bg-emerald-50/20 font-sans" onClick={(e) => e.stopPropagation()}>
                              {row.arrivedCount > 0 ? (
                                <button
                                  onClick={() => handleDrillDown(row, 'ARRIVED')}
                                  className="px-2.5 py-0.5 rounded bg-emerald-100 hover:bg-emerald-600 hover:text-white text-emerald-800 font-mono font-bold text-xs transition cursor-pointer"
                                >
                                  +{row.arrivedCount} ▼
                                </button>
                              ) : (
                                <span className="text-slate-300">0</span>
                              )}
                            </td>

                            <td className="py-2.5 px-4 text-center text-slate-900 font-bold">{row.totalAfter}</td>
                            <td className="py-2.5 px-4 text-center font-sans font-bold">
                              {row.netDelta > 0 ? (
                                <span className="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">+{row.netDelta}</span>
                              ) : row.netDelta < 0 ? (
                                <span className="bg-rose-100 text-rose-800 px-1.5 py-0.5 rounded">{row.netDelta}</span>
                              ) : (
                                <span className="text-slate-400">0</span>
                              )}
                            </td>
                          </tr>

                          {isRowExpanded && (
                            <tr>
                              <td colSpan={8} className="p-4 bg-blue-50/30 border-y border-blue-200 font-sans">
                                <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-4 shadow-xs">
                                  <div className="flex flex-wrap justify-between items-center gap-2 border-b border-slate-100 pb-3">
                                    <div>
                                      <span className="text-xs font-bold uppercase tracking-wider text-blue-600">
                                        Активный фильтр среза
                                      </span>
                                      <h4 className="text-sm font-bold text-slate-800">
                                        {row.class} = {row.value}
                                        {selectedPivotFilter?.direction === 'LEFT' && ' (Только ушедшие)'}
                                        {selectedPivotFilter?.direction === 'ARRIVED' && ' (Только пришедшие)'}
                                      </h4>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={() => setActiveTab('registry')}
                                        className="px-3 py-1 bg-slate-900 hover:bg-blue-600 text-white rounded-lg text-xs font-semibold transition cursor-pointer"
                                      >
                                        Перейти в реестр ({filteredApps.length}) →
                                      </button>
                                      <button
                                        onClick={() => {
                                          setExpandedSegmentClass(null);
                                          setSelectedPivotFilter(null);
                                        }}
                                        className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs font-semibold cursor-pointer"
                                      >
                                        ✕ Закрыть
                                      </button>
                                    </div>
                                  </div>

                                  {parentBlock && (
                                    <div>
                                      <div className="text-xs font-semibold text-slate-600 mb-2">
                                        Параметры модуля «{row.class}» ({parentBlock.rows.length} бакетов):
                                      </div>
                                      <div className="overflow-x-auto border border-slate-200 rounded-lg">
                                        <table className="w-full text-left text-xs font-mono">
                                          <thead className="bg-slate-50 text-slate-500 font-sans border-b border-slate-200">
                                            <tr>
                                              <th className="py-1.5 px-3">Параметр (KEY)</th>
                                              <th className="py-1.5 px-3">Бакет</th>
                                              <th className="py-1.5 px-3 text-center">Стабильно</th>
                                              <th className="py-1.5 px-3 text-center text-rose-700">Ушло</th>
                                              <th className="py-1.5 px-3 text-center text-emerald-700">Пришло</th>
                                              <th className="py-1.5 px-3 text-center">Дельта</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-slate-100">
                                            {parentBlock.rows.map((subRow) => (
                                              <tr
                                                key={subRow.id}
                                                className={subRow.value === row.value ? 'bg-blue-50/60 font-bold' : ''}
                                              >
                                                <td className="py-1.5 px-3">{subRow.arrayKey ? `${subRow.arrayKey}.${subRow.key}` : subRow.key}</td>
                                                <td className="py-1.5 px-3">{subRow.value}</td>
                                                <td className="py-1.5 px-3 text-center text-slate-500">{subRow.stableCount}</td>
                                                <td className="py-1.5 px-3 text-center text-rose-600">-{subRow.leftCount}</td>
                                                <td className="py-1.5 px-3 text-center text-emerald-600">+{subRow.arrivedCount}</td>
                                                <td className="py-1.5 px-3 text-center">{subRow.netDelta > 0 ? `+${subRow.netDelta}` : subRow.netDelta}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  )}

                                  <div>
                                    <div className="text-xs font-semibold text-slate-600 mb-2">
                                      Заявки из базы, подходящие под статус {row.value}:
                                    </div>
                                    {filteredApps.length > 0 ? (
                                      <div className="flex flex-wrap gap-2">
                                        {filteredApps.slice(0, 10).map((app) => (
                                          <button
                                            key={app.id}
                                            onClick={() => handleOpenDossier(app.id)}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-blue-600 text-white text-xs font-mono font-semibold transition cursor-pointer shadow-xs"
                                          >
                                            <span>📄 {app.id}</span>
                                            <span className="text-[10px] bg-white/20 px-1 py-0.5 rounded font-sans font-normal">
                                              {app.afterDecision}
                                            </span>
                                          </button>
                                        ))}
                                      </div>
                                    ) : (
                                      <div className="text-xs text-slate-500 bg-slate-50 p-3 rounded-lg border border-slate-200">
                                        В текущей выборке нет заявок со статусом {row.value}.
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 4. БЛОКИ ПАРАМЕТРОВ МОДЕЛИ */}
            <div className="space-y-4">
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap justify-between items-center gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    placeholder="Поиск по модулю, атрибуту или значению..."
                    value={currentWorkspace.searchFilter}
                    onChange={(e) => updateCurrentWorkspace({ searchFilter: e.target.value })}
                    className="bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-1.5 text-xs outline-none focus:border-blue-500 w-72"
                  />
                  <button
                    onClick={() => updateCurrentWorkspace({ onlyDiffRows: !currentWorkspace.onlyDiffRows })}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                      currentWorkspace.onlyDiffRows
                        ? 'bg-amber-500 text-white border-amber-500'
                        : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {currentWorkspace.onlyDiffRows ? '● Только расхождения (DIFF=1)' : '○ Все бакеты'}
                  </button>
                  <button
                    onClick={() => updateCurrentWorkspace({ sortByImpact: !currentWorkspace.sortByImpact })}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                      currentWorkspace.sortByImpact
                        ? 'bg-slate-800 text-white border-slate-800'
                        : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {currentWorkspace.sortByImpact ? '↓ Сортировка по клиентам' : 'По порядку витрины'}
                  </button>
                </div>

                <div className="text-xs text-slate-500">
                  Модулей витрины: <b>{groupedParameterBlocks.length}</b>
                </div>
              </div>

              {displayedBlocks.map((block) => {
                const isCollapsed = !!collapsedClasses[block.className];
                return (
                  <div key={block.className} className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
                    <div
                      onClick={() => toggleClassCollapse(block.className)}
                      className="px-5 py-3 bg-slate-50/80 hover:bg-slate-100/80 border-b border-slate-200 flex flex-wrap justify-between items-center gap-2 cursor-pointer transition"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-bold text-slate-400">{isCollapsed ? '▶' : '▼'}</span>
                        <span className="font-bold text-sm text-slate-800">{block.className}</span>
                        <span className="text-xs text-slate-500">({block.rows.length} бакетов)</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-slate-600 bg-white border border-slate-200 px-2.5 py-0.5 rounded">
                          Изменилось: <b>{block.affectedParams} из {block.totalParams}</b> параметров
                        </span>
                        <span className={`text-xs font-bold px-2.5 py-0.5 rounded ${
                          block.maxAffectedClients > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'
                        }`}>
                          Макс. сдвиг: до {block.maxAffectedClients} клиентов
                        </span>
                      </div>
                    </div>

                    {!isCollapsed && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-white text-slate-500 border-b border-slate-100">
                            <tr>
                              <th className="py-2 px-4 font-semibold">Параметр (KEY)</th>
                              <th className="py-2 px-4 font-semibold">Бакет (VALUE)</th>
                              <th className="py-2 px-4 font-semibold text-center">DIFF=0</th>
                              <th className="py-2 px-4 font-semibold text-center text-rose-700">Ушло (BEFORE)</th>
                              <th className="py-2 px-4 font-semibold text-center text-emerald-700">Пришло (AFTER)</th>
                              <th className="py-2 px-4 font-semibold text-center">Дельта (Δ)</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 font-mono">
                            {block.rows.map((row) => {
                              const hasDiff = row.totalChanges > 0;

                              return (
                                <tr key={row.id} className={hasDiff ? 'bg-amber-50/20 hover:bg-amber-50/50' : 'hover:bg-slate-50'}>
                                  <td className="py-2 px-4 text-slate-700 font-medium">
                                    {row.arrayKey ? `${row.arrayKey}${row.key ? '.' + row.key : ''}` : row.key || '—'}
                                  </td>
                                  <td className="py-2 px-4 font-bold text-slate-900">{row.value}</td>
                                  <td className="py-2 px-4 text-center text-slate-500">{row.stableCount}</td>

                                  <td className="py-2 px-4 text-center font-sans">
                                    {row.leftCount > 0 ? (
                                      <button
                                        onClick={() => handleDrillDown(row, 'LEFT')}
                                        className="px-2 py-0.5 rounded bg-rose-50 hover:bg-rose-600 hover:text-white text-rose-700 border border-rose-200 font-mono font-bold transition cursor-pointer"
                                      >
                                        -{row.leftCount}
                                      </button>
                                    ) : (
                                      <span className="text-slate-300">0</span>
                                    )}
                                  </td>

                                  <td className="py-2 px-4 text-center font-sans">
                                    {row.arrivedCount > 0 ? (
                                      <button
                                        onClick={() => handleDrillDown(row, 'ARRIVED')}
                                        className="px-2 py-0.5 rounded bg-emerald-50 hover:bg-emerald-600 hover:text-white text-emerald-700 border border-emerald-200 font-mono font-bold transition cursor-pointer"
                                      >
                                        +{row.arrivedCount}
                                      </button>
                                    ) : (
                                      <span className="text-slate-300">0</span>
                                    )}
                                  </td>

                                  <td className="py-2 px-4 text-center font-sans font-bold">
                                    {row.netDelta > 0 ? (
                                      <span className="text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">+{row.netDelta}</span>
                                    ) : row.netDelta < 0 ? (
                                      <span className="text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded">{row.netDelta}</span>
                                    ) : (
                                      <span className="text-slate-400">0</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── ВКЛАДКА: РЕЕСТР И ПОИСК ЗАЯВОК ── */}
        {activeTab === 'registry' && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-base font-bold text-slate-800">Реестр заявок из базы FastAPI (Отчёт #{reportId})</h2>
                <p className="text-xs text-slate-500">
                  Всего получено из API: <b>{registeredAppList.length}</b> заявок.
                </p>
              </div>

              {selectedPivotFilter && (
                <button
                  onClick={() => setSelectedPivotFilter(null)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 rounded-xl border border-slate-300 transition cursor-pointer"
                >
                  ✕ Сбросить фильтр: {selectedPivotFilter.value}
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 bg-slate-50 p-4 rounded-xl border border-slate-200">
              <span className="text-xs font-medium text-slate-700">APP_ID:</span>
              <input
                type="text"
                placeholder="например: I32554354"
                value={manualAppInput}
                onChange={(e) => setManualAppInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleOpenDossier(manualAppInput)}
                className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs font-mono outline-none focus:border-blue-500 w-64"
              />
              <button
                onClick={() => handleOpenDossier(manualAppInput)}
                disabled={isDossierLoading}
                className="bg-slate-900 hover:bg-blue-600 text-white px-4 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer disabled:opacity-50"
              >
                {isDossierLoading ? 'Запрос...' : 'Открыть досье'}
              </button>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-xl">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3 font-semibold">ID заявки</th>
                    <th className="py-2.5 px-3 font-semibold">Решение в BETA (decision_after)</th>
                    <th className="py-2.5 px-3 font-semibold">Расхождений (diff_count)</th>
                    <th className="py-2.5 px-3 font-semibold text-center">Досье</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {filteredApps.map((app) => (
                    <tr
                      key={app.id}
                      onClick={() => handleOpenDossier(app.id)}
                      className="hover:bg-blue-50/40 cursor-pointer transition"
                    >
                      <td className="py-3 px-3 font-bold text-slate-900">{app.id}</td>
                      <td className="py-3 px-3">
                        <span className={`font-bold px-2 py-0.5 rounded text-xs ${
                          app.afterDecision === 'APPROVE' 
                            ? 'bg-emerald-100 text-emerald-800'
                            : app.afterDecision === 'REJECT'
                            ? 'bg-rose-100 text-rose-800'
                            : 'bg-slate-100 text-slate-700'
                        }`}>
                          {app.afterDecision}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-slate-700">
                        <span className="font-semibold text-amber-700">{app.diffCount}</span> шт.
                      </td>
                      <td className="py-3 px-3 text-center font-sans">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenDossier(app.id);
                          }}
                          className="text-xs bg-slate-900 hover:bg-blue-600 text-white px-2.5 py-1 rounded font-semibold transition cursor-pointer"
                        >
                          Поля diff →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </main>

      {/* ── БОКОВАЯ ШТОРКА (ПОАТРИБУТНЫЙ ДИФФ ЗАЯВКИ) ── */}
      {activeDossierApp && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs">
          <div className="bg-white w-full max-w-3xl h-full shadow-2xl flex flex-col p-6 overflow-hidden">
            <div className="flex justify-between items-start border-b border-slate-200 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-lg text-slate-800">Досье заявки: {activeDossierApp}</h3>
                  <span className="text-xs bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded">
                    Параметров: {dossierRows.length}
                  </span>
                  {isDossierLoading && (
                    <span className="text-xs text-blue-600 animate-pulse font-semibold">
                      Запрос к FastAPI...
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Сравнение параметров BEFORE (MASTER) и AFTER (BETA) из базы данных
                </p>
              </div>
              <button
                onClick={() => setActiveDossierApp(null)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold p-1 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto my-4">
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-2 px-3 font-semibold">Модуль (CLASS / PREFIX)</th>
                      <th className="py-2 px-3 font-semibold">Параметр (KEY)</th>
                      <th className="py-2 px-3 font-semibold text-rose-700">VALUE_BEFORE</th>
                      <th className="py-2 px-3 font-semibold text-emerald-700">VALUE_AFTER</th>
                      <th className="py-2 px-3 font-semibold">Статус</th>
                      <th className="py-2 px-3 font-semibold">Комментарий</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {dossierRows.map((row, idx) => {
                      const isDiff = Number(row.DIFF_FLAG ?? row.diff_flag) === 1;
                      const mod = row.CLASS || row.PREFIX || '—';
                      const key = row.ARRAY_KEY ? `${row.ARRAY_KEY}.${row.KEY}` : row.KEY || '(параметр)';
                      const valBefore = row.VALUE_BEFORE ?? row.value_before ?? '—';
                      const valAfter = row.VALUE_AFTER ?? row.value_after ?? '—';
                      const adjBefore = row.ADJUSTED_BEFORE ?? row.adjusted_before ?? '';
                      const adjAfter = row.ADJUSTED_AFTER ?? row.adjusted_after ?? '';
                      const comment = row.COMMENT || row.comment || '—';

                      return (
                        <tr key={idx} className={isDiff ? 'bg-amber-50/50' : 'hover:bg-slate-50'}>
                          <td className="py-2 px-3 font-sans text-slate-600">{mod}</td>
                          <td className="py-2 px-3 font-bold text-slate-800">{key}</td>
                          <td className="py-2 px-3 text-rose-600">
                            <div>{valBefore}</div>
                            {adjBefore && adjBefore !== valBefore && (
                              <div className="text-[10px] text-slate-400">бакет: {adjBefore}</div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-emerald-600 font-bold">
                            <div>{valAfter}</div>
                            {adjAfter && adjAfter !== valAfter && (
                              <div className="text-[10px] text-slate-400 font-normal">бакет: {adjAfter}</div>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-sans font-bold ${
                              isDiff ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-400'
                            }`}>
                              {isDiff ? 'DIFF=1' : 'MATCH'}
                            </span>
                          </td>
                          <td className="py-2 px-3 font-sans text-slate-600 text-[11px]">{comment}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-3 flex justify-end">
              <button
                onClick={() => setActiveDossierApp(null)}
                className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-semibold transition cursor-pointer"
              >
                Закрыть досье
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── МОДАЛЬНОЕ ОКНО CODEMIRROR ── */}
      {codeEditorModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-2xl w-full max-w-3xl overflow-hidden flex flex-col text-white">
            <div className="px-5 py-3.5 border-b border-slate-800 flex justify-between items-center">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-blue-400 font-bold">Python Code Viewer</span>
                <h3 className="font-bold text-sm text-slate-100">{codeEditorModal.title}</h3>
              </div>
              <button
                onClick={() => setCodeEditorModal({ ...codeEditorModal, isOpen: false })}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            <div className="p-3 bg-slate-950 font-mono text-xs">
              <CodeMirror
                value={codeEditorModal.code}
                height="320px"
                theme="dark"
                extensions={[python()]}
                readOnly={codeEditorModal.readOnly}
                onChange={(val) => {
                  if (!codeEditorModal.readOnly) {
                    setCodeEditorModal((prev) => ({ ...prev, code: val }));
                  }
                }}
              />
            </div>

            <div className="px-5 py-3 border-t border-slate-800 flex justify-between items-center bg-slate-900/80">
              <span className="text-[11px] text-slate-400">
                {codeEditorModal.readOnly ? 'Режим только для чтения' : 'Редактирование активно'}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setCodeEditorModal({ ...codeEditorModal, isOpen: false })}
                  className="px-3 py-1.5 text-xs text-slate-300 hover:text-white transition cursor-pointer"
                >
                  Закрыть
                </button>
                {!codeEditorModal.readOnly && (
                  <button
                    onClick={() => {
                      if (codeEditorModal.onSave) codeEditorModal.onSave(codeEditorModal.code);
                      setCodeEditorModal({ ...codeEditorModal, isOpen: false });
                    }}
                    className="px-4 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition cursor-pointer"
                  >
                    Сохранить изменения
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── МОДАЛЬНОЕ ОКНО СОЗДАНИЯ АВТОПРОВЕРКИ ── */}
      {isCheckModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs">
          <form onSubmit={handleAddCustomCheck} className="bg-white rounded-2xl p-6 w-full max-w-lg space-y-4 shadow-xl border border-slate-200">
            <h3 className="font-bold text-sm text-slate-800">Новая автопроверка риск-политики</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Название правила</label>
                <input
                  type="text"
                  required
                  placeholder="Контроль обнуления лимита при APPROVE"
                  value={newCheckName}
                  onChange={(e) => setNewCheckName(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Модуль (CLASS)</label>
                <input
                  type="text"
                  required
                  placeholder="limitResult"
                  value={newCheckClass}
                  onChange={(e) => setNewCheckClass(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 text-xs font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Проверяемый параметр</label>
                <input
                  type="text"
                  required
                  placeholder="limit"
                  value={newCheckArg}
                  onChange={(e) => setNewCheckArg(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Порог контроля</label>
                <input
                  type="text"
                  required
                  placeholder="0 обнулений лимита"
                  value={newCheckThreshold}
                  onChange={(e) => setNewCheckThreshold(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 text-xs"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Python-логика проверки (Live Code):</label>
              <div className="rounded-lg overflow-hidden border border-slate-300 text-xs">
                <CodeMirror
                  value={newCheckCode}
                  height="140px"
                  theme="dark"
                  extensions={[python()]}
                  onChange={(val) => setNewCheckCode(val)}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setIsCheckModalOpen(false)} className="px-3 py-1.5 text-xs text-slate-600 cursor-pointer">Отмена</button>
              <button type="submit" className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg cursor-pointer">Добавить проверку</button>
            </div>
          </form>
        </div>
      )}

      {/* Модалка добавления профиля аналитика */}
      {newUserModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={handleCreateUser} className="bg-white rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-xl border border-slate-200">
            <h3 className="font-bold text-sm text-slate-800">Создать профиль аналитика</h3>
            <input
              type="text"
              required
              placeholder="например: Аналитик 3 (Олег)"
              value={newUserName}
              onChange={(e) => setNewUserName(e.target.value)}
              className="w-full border border-slate-300 rounded-lg p-2 text-xs outline-none focus:border-blue-500"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setNewUserModalOpen(false)} className="px-3 py-1.5 text-xs text-slate-600 cursor-pointer">Отмена</button>
              <button type="submit" className="px-4 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-lg cursor-pointer">Создать профиль</button>
            </div>
          </form>
        </div>
      )}

    </div>
  );
}