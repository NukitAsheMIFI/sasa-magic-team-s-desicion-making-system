import React, { useState, useMemo, useEffect, useCallback } from 'react';

// Локальные демо-данные на случай, если FastAPI выключен
import fallbackPivotFacts from './data/08_pivot_facts_demo.json';
import fallbackComparisonCsv from './data/06_comparison_app1001.csv?raw';

// Парсер CSV с разделителем ";"
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

const DEFAULT_WORKSPACES = {
  'Аналитик 1 (Иван)': {
    onlyDiffRows: false,
    searchFilter: '',
    sortByImpact: true,
    customRules: [],
    pivotReviews: {},
    appReviews: {}
  },
  'Аналитик 2 (Мария)': {
    onlyDiffRows: true,
    searchFilter: '',
    sortByImpact: true,
    customRules: [],
    pivotReviews: {},
    appReviews: {}
  }
};

export default function App() {
  const [activeTab, setActiveTab] = useState('matrix');
  const [currentUser, setCurrentUser] = useState('Аналитик 1 (Иван)');

  // ── ПРЯМОЕ ПОДКЛЮЧЕНИЕ К БЭКЕНДУ БЕЗ ПРОКСИ ──
  const [backendUrl, setBackendUrl] = useState(() => {
    return localStorage.getItem('spr_backend_url') || 'http://localhost:8000';
  });
  const [reportId, setReportId] = useState('1');
  const [pivotFacts, setPivotFacts] = useState(fallbackPivotFacts);
  const [isLoadingApi, setIsLoadingApi] = useState(false);
  const [apiStatus, setApiStatus] = useState('init'); // 'connected' | 'fallback' | 'init'
  const [apiErrorText, setApiErrorText] = useState('');

  // Прямой запрос к FastAPI: http://localhost:8000/api/reports/1/pivot-facts
  const fetchPivotFactsDirect = useCallback(async (baseUrl, targetReportId) => {
    setIsLoadingApi(true);
    setApiErrorText('');
    const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, '');

    try {
      localStorage.setItem('spr_backend_url', cleanBaseUrl);
      const fullUrl = `${cleanBaseUrl}/api/reports/${targetReportId}/pivot-facts`;

      const response = await fetch(fullUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      if (!Array.isArray(json)) {
        throw new Error('Ответ не является массивом JSON');
      }

      console.log('Данные пришли напрямую с бэкенда:', json.length, 'строк');
      setPivotFacts(json);
      setApiStatus('connected');
    } catch (error) {
      console.warn('Ошибка прямого запроса к FastAPI, включён демо-файл:', error.message);
      setPivotFacts(fallbackPivotFacts);
      setApiStatus('fallback');
      setApiErrorText(error.message);
    } finally {
      setIsLoadingApi(false);
    }
  }, []);

  // Первичная загрузка при открытии страницы
  useEffect(() => {
    fetchPivotFactsDirect(backendUrl, reportId);
  }, []); // Загружаем при старте, дальше обновляем кнопкой «Подключить / ↻»

  // ── ПРОФИЛИ ПОЛЬЗОВАТЕЛЕЙ ──
  const [workspaces, setWorkspaces] = useState(() => {
    try {
      const saved = localStorage.getItem('spr_diff_workspaces_v4');
      return saved ? JSON.parse(saved) : DEFAULT_WORKSPACES;
    } catch {
      return DEFAULT_WORKSPACES;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('spr_diff_workspaces_v4', JSON.stringify(workspaces));
    } catch {
      // игнорируем переполнение localStorage
    }
  }, [workspaces]);

  const [collapsedClasses, setCollapsedClasses] = useState({});
  const [selectedPivotFilter, setSelectedPivotFilter] = useState(null);
  const [selectedTransitionFilter, setSelectedTransitionFilter] = useState('ALL');
  const [activeDossierApp, setActiveDossierApp] = useState(null);

  const [isRuleModalOpen, setIsRuleModalOpen] = useState(false);
  const [newRuleClass, setNewRuleClass] = useState('');
  const [newRuleKey, setNewRuleKey] = useState('');
  const [newUserModalOpen, setNewUserModalOpen] = useState(false);
  const [newUserName, setNewUserName] = useState('');

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

  // ── 1. ПАРСИНГ ДЕТАЛЬНОГО CSV ЗАЯВОК ──
  const parsedComparisonRows = useMemo(() => parseSemicolonCsv(fallbackComparisonCsv), []);

  const appsDatabase = useMemo(() => {
    const map = {};
    parsedComparisonRows.forEach((row) => {
      const rawId = row.APP_ID || 'UNKNOWN';
      const appId = rawId.startsWith('APP-') ? rawId : `APP-${rawId}`;
      if (!map[appId]) map[appId] = [];
      map[appId].push(row);
    });
    return map;
  }, [parsedComparisonRows]);

  const registeredAppList = useMemo(() => {
    return Object.keys(appsDatabase).map((appId) => {
      const rows = appsDatabase[appId];
      const decRow = rows.find((r) => r.KEY === 'decision') || rows[0];
      const limitRow = rows.find((r) => r.KEY === 'limit');
      const diffRows = rows.filter((r) => String(r.DIFF_FLAG) === '1');

      const beforeDec = decRow?.VALUE_BEFORE || '—';
      const afterDec = decRow?.VALUE_AFTER || '—';

      return {
        id: appId,
        rawRows: rows,
        beforeDecision: beforeDec,
        afterDecision: afterDec,
        transition: `${beforeDec} → ${afterDec}`,
        limitBefore: limitRow?.VALUE_BEFORE ? `${Number(limitRow.VALUE_BEFORE).toLocaleString('ru-RU')} ₽` : '—',
        limitAfter: limitRow?.VALUE_AFTER ? `${Number(limitRow.VALUE_AFTER).toLocaleString('ru-RU')} ₽` : '—',
        limitBucketBefore: limitRow?.ADJUSTED_BEFORE || '—',
        limitBucketAfter: limitRow?.ADJUSTED_AFTER || '—',
        diffCount: diffRows.length,
        driver: diffRows.map((r) => r.COMMENT).filter(Boolean).join('; ') || 'Без изменений'
      };
    });
  }, [appsDatabase]);

  // ── 2. АГРЕГАЦИЯ ДАННЫХ ОТ БЭКЕНДА В МАТРИЦУ ──
  const combinedPivotFacts = useMemo(() => {
    return [...pivotFacts, ...(currentWorkspace.customRules || [])];
  }, [pivotFacts, currentWorkspace.customRules]);

  const { decisionSummaryRows, groupedParameterBlocks, summaryMetrics } = useMemo(() => {
    const map = {};

    combinedPivotFacts.forEach((row) => {
      const cls = row.CLASS || 'Other';
      const arrKey = row.ARRAY_KEY || '';
      const key = row.KEY || '';
      const val = row.VALUE_ADJUSTED || '';
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
      const isDiff = String(row.DIFF_FLAG) === '1';
      const isBefore = (row.SOURCE || '').includes('BEFORE');

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
      return {
        ...r,
        totalBefore,
        totalAfter,
        netDelta,
        absDelta: Math.abs(netDelta),
        totalChanges
      };
    });

    const decRows = allRows.filter((r) => r.key === 'decision');
    const totalPortfolio = decRows.reduce((acc, r) => acc + r.totalBefore, 0);
    const stableApps = decRows.reduce((acc, r) => acc + r.stableCount, 0);
    const flippedApps = decRows.reduce((acc, r) => acc + r.leftCount, 0);

    const decisionTable = decRows.map((r) => ({
      ...r,
      shareBefore: totalPortfolio > 0 ? ((r.totalBefore / totalPortfolio) * 100).toFixed(1) : '0.0',
      shareAfter: totalPortfolio > 0 ? ((r.totalAfter / totalPortfolio) * 100).toFixed(1) : '0.0',
      shareDiff: totalPortfolio > 0 ? (((r.totalAfter - r.totalBefore) / totalPortfolio) * 100).toFixed(1) : '0.0'
    }));

    const groupsMap = {};
    allRows.forEach((row) => {
      if (!groupsMap[row.class]) {
        groupsMap[row.class] = {
          className: row.class,
          totalDiffEvents: 0,
          rowsCount: 0,
          rows: []
        };
      }
      groupsMap[row.class].rows.push(row);
      groupsMap[row.class].rowsCount += 1;
      groupsMap[row.class].totalDiffEvents += row.totalChanges;
    });

    const approveRow = decisionTable.find((r) => r.value === 'APPROVE') || { shareBefore: '0.0', shareAfter: '0.0', shareDiff: '0.0' };

    return {
      decisionSummaryRows: decisionTable,
      groupedParameterBlocks: Object.values(groupsMap),
      summaryMetrics: {
        totalPortfolio,
        stableApps,
        flippedApps,
        rateBefore: approveRow.shareBefore,
        rateAfter: approveRow.shareAfter,
        rateDiff: Number(approveRow.shareDiff) > 0 ? `+${approveRow.shareDiff}%` : `${approveRow.shareDiff}%`,
        totalRows: allRows.length
      }
    };
  }, [combinedPivotFacts]);

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
              row.value.toLowerCase().includes(q);
            if (!match) return false;
          }
          return true;
        });

        if (currentWorkspace.sortByImpact) {
          filteredRows = [...filteredRows].sort((a, b) => b.totalChanges - a.totalChanges || b.absDelta - a.absDelta);
        }

        return { ...block, rows: filteredRows };
      })
      .filter((block) => block.rows.length > 0);
  }, [groupedParameterBlocks, currentWorkspace.onlyDiffRows, currentWorkspace.searchFilter, currentWorkspace.sortByImpact]);

  // ── 3. СТРОГАЯ ФИЛЬТРАЦИЯ ЗАЯВОК ПО НАПРАВЛЕНИЮ («УШЛО» ИЛИ «ПРИШЛО») ──
  const filteredApps = useMemo(() => {
    return registeredAppList
      .map((app) => {
        if (selectedTransitionFilter !== 'ALL' && app.transition !== selectedTransitionFilter) {
          return null;
        }

        if (!selectedPivotFilter) {
          return { ...app, matchedContext: null };
        }

        const matchedRow = app.rawRows.find((r) => {
          if (r.CLASS !== selectedPivotFilter.class) return false;
          if (selectedPivotFilter.arrayKey && r.ARRAY_KEY !== selectedPivotFilter.arrayKey) return false;
          if (selectedPivotFilter.key && r.KEY !== selectedPivotFilter.key) return false;

          const isRowDiff = String(r.DIFF_FLAG) === '1';
          if (!isRowDiff) return false;

          const val = selectedPivotFilter.value;
          const beforeVal = r.ADJUSTED_BEFORE || r.VALUE_BEFORE || r.ARRAY_KEY || '';
          const afterVal = r.ADJUSTED_AFTER || r.VALUE_AFTER || r.ARRAY_KEY || '';

          if (selectedPivotFilter.direction === 'LEFT') {
            return beforeVal === val;
          }
          if (selectedPivotFilter.direction === 'ARRIVED') {
            return afterVal === val;
          }
          return beforeVal === val || afterVal === val;
        });

        if (!matchedRow) return null;

        const beforeVal = matchedRow.ADJUSTED_BEFORE || matchedRow.VALUE_BEFORE || '—';
        const afterVal = matchedRow.ADJUSTED_AFTER || matchedRow.VALUE_AFTER || '—';

        return {
          ...app,
          matchedContext: {
            path: matchedRow.ARRAY_KEY ? `${matchedRow.ARRAY_KEY}.${matchedRow.KEY}` : matchedRow.KEY || matchedRow.CLASS,
            before: beforeVal,
            after: afterVal,
            directionLabel:
              selectedPivotFilter.direction === 'LEFT'
                ? `Ушла из «${selectedPivotFilter.value}»`
                : `Пришла в «${selectedPivotFilter.value}»`
          }
        };
      })
      .filter(Boolean);
  }, [registeredAppList, selectedPivotFilter, selectedTransitionFilter]);

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
    setSelectedTransitionFilter('ALL');
    setActiveTab('registry');
  };

  const handleTogglePivotReview = (rowId, status) => {
    const current = currentWorkspace.pivotReviews || {};
    if (current[rowId]?.status === status) {
      const copy = { ...current };
      delete copy[rowId];
      updateCurrentWorkspace({ pivotReviews: copy });
      return;
    }
    updateCurrentWorkspace({
      pivotReviews: {
        ...current,
        [rowId]: { status, author: currentUser.split(' ')[2]?.replace(/[()]/g, '') || currentUser }
      }
    });
  };

  const handleToggleAppReview = (appId, status) => {
    const current = currentWorkspace.appReviews || {};
    if (current[appId]?.status === status) {
      const copy = { ...current };
      delete copy[appId];
      updateCurrentWorkspace({ appReviews: copy });
      return;
    }
    updateCurrentWorkspace({
      appReviews: {
        ...current,
        [appId]: {
          status,
          author: currentUser.split(' ')[2]?.replace(/[()]/g, '') || currentUser,
          time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        }
      }
    });
  };

  const toggleClassCollapse = (className) => {
    setCollapsedClasses((prev) => ({ ...prev, [className]: !prev[className] }));
  };

  const handleAddRule = (e) => {
    e.preventDefault();
    if (!newRuleClass.trim()) return;
    const rule = {
      PREFIX: 'company',
      CLASS: newRuleClass.trim(),
      ARRAY_KEY: 'CUSTOM',
      KEY: newRuleKey.trim() || 'rule_check',
      VALUE_ADJUSTED: 'TRIGGERED',
      DIFF_FLAG: '1',
      SOURCE: 'AFTER (BETA)',
      CNT: 5
    };
    updateCurrentWorkspace({
      customRules: [...(currentWorkspace.customRules || []), rule]
    });
    setNewRuleClass('');
    setNewRuleKey('');
    setIsRuleModalOpen(false);
  };

  const handleCreateUser = (e) => {
    e.preventDefault();
    if (!newUserName.trim()) return;
    const label = newUserName.trim();
    if (!workspaces[label]) {
      setWorkspaces((prev) => ({
        ...prev,
        [label]: { onlyDiffRows: false, searchFilter: '', sortByImpact: true, customRules: [], pivotReviews: {}, appReviews: {} }
      }));
    }
    setCurrentUser(label);
    setNewUserName('');
    setNewUserModalOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50/70 text-slate-900 font-sans flex flex-col">
      
      {/* ── ВЕРХНЯЯ ПАНЕЛЬ С ПРЯМОЙ НАСТРОЙКОЙ URL БЭКЕНДА ── */}
      <header className="border-b border-slate-200 bg-white px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-30 shadow-xs">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${apiStatus === 'connected' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></span>
            <span className="font-bold text-sm tracking-tight text-slate-800">СПР • Анализ стратегий</span>
          </div>

          <nav className="flex gap-1 bg-slate-100 p-1 rounded-lg">
            <button
              onClick={() => setActiveTab('matrix')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                activeTab === 'matrix' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Сводная витрина ({summaryMetrics.totalRows})
            </button>
            <button
              onClick={() => setActiveTab('registry')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                activeTab === 'registry' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Примеры заявок в CSV ({filteredApps.length}/{registeredAppList.length})
            </button>
          </nav>

          {/* Панель прямого подключения к FastAPI (без прокси) */}
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs">
            <span className="text-slate-400 font-medium">API:</span>
            <input
              type="text"
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
              placeholder="http://localhost:8000"
              className="bg-white border border-slate-300 rounded px-2 py-0.5 text-xs font-mono w-44 outline-none focus:border-blue-500"
              title="Адрес FastAPI сервера (например http://localhost:8000 или http://192.168.1.45:8000)"
            />
            <span className="text-slate-400">#</span>
            <input
              type="text"
              value={reportId}
              onChange={(e) => setReportId(e.target.value)}
              className="bg-white border border-slate-300 rounded px-1.5 py-0.5 text-xs font-mono w-8 text-center outline-none focus:border-blue-500"
              title="ID отчёта (/api/reports/{id}/pivot-facts)"
            />
            <button
              onClick={() => fetchPivotFactsDirect(backendUrl, reportId)}
              className="px-2 py-0.5 bg-slate-900 hover:bg-blue-600 text-white rounded font-semibold transition cursor-pointer"
              title="Загрузить данные напрямую с указанного сервера"
            >
              {isLoadingApi ? '...' : '↻'}
            </button>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
              apiStatus === 'connected'
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-amber-100 text-amber-800'
            }`}>
              {apiStatus === 'connected' ? 'ONLINE' : 'DEMO JSON'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5 bg-white border border-slate-300 rounded-lg px-2.5 py-1 text-xs shadow-xs">
            <span className="text-slate-400">👤</span>
            <select
              value={currentUser}
              onChange={(e) => setCurrentUser(e.target.value)}
              className="bg-transparent border-none outline-none font-medium text-slate-700 cursor-pointer"
            >
              {Object.keys(workspaces).map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>

          <button
            onClick={() => setNewUserModalOpen(true)}
            className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 transition"
          >
            + Аналитик
          </button>

          <button
            onClick={() => setIsRuleModalOpen(true)}
            className="px-3 py-1 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition shadow-xs"
          >
            + Своё правило
          </button>
        </div>
      </header>

      {/* ── ОСНОВНОЙ КОНТЕНТ ── */}
      <main className="flex-1 p-6 max-w-6xl w-full mx-auto space-y-6">
        
        {/* 1. СВОДНЫЙ БАЛАНС ПО ИТОГОВЫМ РЕШЕНИЯМ */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="px-5 py-3.5 bg-slate-900 text-white flex flex-wrap justify-between items-center gap-2">
            <div>
              <h2 className="text-sm font-bold">Сводный баланс портфеля по итоговым решениям (MASTER vs BETA)</h2>
              <p className="text-[11px] text-slate-300">
                Всего в выборке: {summaryMetrics.totalPortfolio} заявок • Стабильных (DIFF=0): {summaryMetrics.stableApps} • Изменили решение (Flip): {summaryMetrics.flippedApps}
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="bg-white/10 px-2.5 py-1 rounded-md">
                Одобрение: <b>{summaryMetrics.rateBefore}% → {summaryMetrics.rateAfter}%</b> ({summaryMetrics.rateDiff})
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">Итоговое решение</th>
                  <th className="py-2.5 px-4 font-semibold text-center">Было в MASTER</th>
                  <th className="py-2.5 px-4 font-semibold text-center text-slate-500">Сохранилось (DIFF=0)</th>
                  <th className="py-2.5 px-4 font-semibold text-center text-rose-700 bg-rose-50/40">Ушло из решения (Клик →)</th>
                  <th className="py-2.5 px-4 font-semibold text-center text-emerald-700 bg-emerald-50/40">Пришло в решение (Клик →)</th>
                  <th className="py-2.5 px-4 font-semibold text-center">Стало в BETA</th>
                  <th className="py-2.5 px-4 font-semibold text-center">Чистый итог (Δ)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {decisionSummaryRows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-4 font-bold text-slate-900">{row.value}</td>
                    <td className="py-2.5 px-4 text-center text-slate-700">
                      <b>{row.totalBefore}</b> <span className="text-slate-400">({row.shareBefore}%)</span>
                    </td>
                    <td className="py-2.5 px-4 text-center text-slate-500">{row.stableCount}</td>

                    <td className="py-2.5 px-4 text-center bg-rose-50/20 font-sans">
                      {row.leftCount > 0 ? (
                        <button
                          onClick={() => handleDrillDown(row, 'LEFT')}
                          className="px-2.5 py-1 rounded bg-rose-100 hover:bg-rose-600 hover:text-white text-rose-800 font-mono font-bold text-xs transition cursor-pointer shadow-2xs"
                        >
                          -{row.leftCount} →
                        </button>
                      ) : (
                        <span className="text-slate-300">0</span>
                      )}
                    </td>

                    <td className="py-2.5 px-4 text-center bg-emerald-50/20 font-sans">
                      {row.arrivedCount > 0 ? (
                        <button
                          onClick={() => handleDrillDown(row, 'ARRIVED')}
                          className="px-2.5 py-1 rounded bg-emerald-100 hover:bg-emerald-600 hover:text-white text-emerald-800 font-mono font-bold text-xs transition cursor-pointer shadow-2xs"
                        >
                          +{row.arrivedCount} →
                        </button>
                      ) : (
                        <span className="text-slate-300">0</span>
                      )}
                    </td>

                    <td className="py-2.5 px-4 text-center text-slate-900">
                      <b>{row.totalAfter}</b> <span className="text-slate-400">({row.shareAfter}%)</span>
                    </td>
                    <td className="py-2.5 px-4 text-center font-sans font-bold">
                      {row.netDelta > 0 ? (
                        <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">+{row.netDelta} ({row.shareDiff}%)</span>
                      ) : row.netDelta < 0 ? (
                        <span className="bg-rose-100 text-rose-800 px-2 py-0.5 rounded">{row.netDelta} ({row.shareDiff}%)</span>
                      ) : (
                        <span className="text-slate-400">0 (0.0%)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── ЭКРАН 1: СВОРАЧИВАЕМЫЕ БЛОКИ ПАРАМЕТРОВ ── */}
        {activeTab === 'matrix' && (
          <div className="space-y-4">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap justify-between items-center gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="Быстрый фильтр по классу, ключу или бакету..."
                  value={currentWorkspace.searchFilter}
                  onChange={(e) => updateCurrentWorkspace({ searchFilter: e.target.value })}
                  className="bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-1.5 text-xs outline-none focus:border-blue-500 w-72"
                />
                <button
                  onClick={() => updateCurrentWorkspace({ onlyDiffRows: !currentWorkspace.onlyDiffRows })}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
                    currentWorkspace.onlyDiffRows 
                      ? 'bg-amber-500 text-white border-amber-500' 
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {currentWorkspace.onlyDiffRows ? '● Только с расхождениями' : '○ Все бакеты'}
                </button>
                <button
                  onClick={() => updateCurrentWorkspace({ sortByImpact: !currentWorkspace.sortByImpact })}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
                    currentWorkspace.sortByImpact 
                      ? 'bg-slate-800 text-white border-slate-800' 
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {currentWorkspace.sortByImpact ? '↓ Сортировка по масштабу сдвига' : 'Сортировка по порядку'}
                </button>
              </div>

              <div className="text-xs text-slate-500">
                Проверено строк в профиле: <b>{Object.keys(currentWorkspace.pivotReviews || {}).length}</b>
              </div>
            </div>

            {displayedBlocks.map((block) => {
              const isCollapsed = !!collapsedClasses[block.className];
              return (
                <div key={block.className} className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
                  <div
                    onClick={() => toggleClassCollapse(block.className)}
                    className="px-5 py-3 bg-slate-50/80 hover:bg-slate-100/80 border-b border-slate-200 flex justify-between items-center cursor-pointer transition"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-bold text-slate-400">{isCollapsed ? '▶' : '▼'}</span>
                      <span className="font-bold text-sm text-slate-800">{block.className}</span>
                      <span className="text-xs text-slate-500">({block.rows.length} строк)</span>
                    </div>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                      block.totalDiffEvents > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'
                    }`}>
                      Событий DIFF=1: {block.totalDiffEvents}
                    </span>
                  </div>

                  {!isCollapsed && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-white text-slate-500 border-b border-slate-100">
                          <tr>
                            <th className="py-2 px-4 font-semibold">Параметр (ARRAY_KEY / KEY)</th>
                            <th className="py-2 px-4 font-semibold">Бакет (VALUE_ADJUSTED)</th>
                            <th className="py-2 px-4 font-semibold text-center">DIFF=0</th>
                            <th className="py-2 px-4 font-semibold text-center text-rose-700">Ушло (BEFORE)</th>
                            <th className="py-2 px-4 font-semibold text-center text-emerald-700">Пришло (AFTER)</th>
                            <th className="py-2 px-4 font-semibold text-center">Дельта (Δ)</th>
                            <th className="py-2 px-4 font-semibold">Вердикт по правилу</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-mono">
                          {block.rows.map((row) => {
                            const hasDiff = row.totalChanges > 0;
                            const ruleReview = (currentWorkspace.pivotReviews || {})[row.id];

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
                                      className="px-2 py-0.5 rounded bg-rose-50 hover:bg-rose-600 hover:text-white text-rose-700 border border-rose-200 font-mono font-bold transition"
                                    >
                                      -{row.leftCount} →
                                    </button>
                                  ) : (
                                    <span className="text-slate-300">0</span>
                                  )}
                                </td>

                                <td className="py-2 px-4 text-center font-sans">
                                  {row.arrivedCount > 0 ? (
                                    <button
                                      onClick={() => handleDrillDown(row, 'ARRIVED')}
                                      className="px-2 py-0.5 rounded bg-emerald-50 hover:bg-emerald-600 hover:text-white text-emerald-700 border border-emerald-200 font-mono font-bold transition"
                                    >
                                      +{row.arrivedCount} →
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
                                <td className="py-2 px-4 font-sans">
                                  {hasDiff ? (
                                    <div className="flex items-center gap-1">
                                      {['OK', 'Вопрос', 'Баг'].map((status) => {
                                        const isActive = ruleReview?.status === status;
                                        return (
                                          <button
                                            key={status}
                                            onClick={() => handleTogglePivotReview(row.id, status)}
                                            className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${
                                              isActive
                                                ? 'bg-blue-600 text-white border-blue-600'
                                                : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                                            }`}
                                          >
                                            {status}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <span className="text-[10px] text-slate-400">Стабильно</span>
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
        )}

        {/* ── ЭКРАН 2: РЕЕСТР ЗАЯВОК ── */}
        {activeTab === 'registry' && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-bold text-slate-800">Детальные примеры заявок</h2>
                  {selectedPivotFilter && (
                    <span className={`text-xs px-2.5 py-0.5 rounded-full font-semibold ${
                      selectedPivotFilter.direction === 'LEFT'
                        ? 'bg-rose-100 text-rose-800'
                        : 'bg-emerald-100 text-emerald-800'
                    }`}>
                      {selectedPivotFilter.direction === 'LEFT' ? 'Ушло из' : 'Пришло в'}: {selectedPivotFilter.class} → {selectedPivotFilter.value} (в витрине: {selectedPivotFilter.expectedCount} шт., в локальном CSV: {filteredApps.length} шт.)
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500">
                  Показывает конкретные заявки из подключённого файла сравнения (06_comparison_app1001.csv)
                </p>
              </div>

              {selectedPivotFilter && (
                <button
                  onClick={() => setSelectedPivotFilter(null)}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 rounded-xl border border-slate-300 transition"
                >
                  ✕ Показать все примеры в CSV ({registeredAppList.length})
                </button>
              )}
            </div>

            {filteredApps.length === 0 ? (
              <div className="p-6 bg-slate-50 border border-slate-200 rounded-xl text-center space-y-3">
                <div className="text-sm font-bold text-slate-800">
                  Для потока «{selectedPivotFilter?.direction === 'LEFT' ? 'Ушло из' : 'Пришло в'} {selectedPivotFilter?.value}» ({selectedPivotFilter?.expectedCount} заявок в прогоне) в демо-файле CSV нет примера
                </div>
                <p className="text-xs text-slate-500 max-w-lg mx-auto">
                  В демо-файле 06_comparison_app1001.csv приложена только заявка APP-1001 (её маршрут: ушла из APPROVE → пришла в VERIFICATION, лимит: ушла из (100K - 250K] → пришла в (0 - 100K]).
                </p>
                <button
                  onClick={() => setSelectedPivotFilter(null)}
                  className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-1.5 rounded-lg text-xs font-semibold transition"
                >
                  Сбросить фильтр и показать APP-1001
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3 font-semibold">ID заявки</th>
                      <th className="py-2.5 px-3 font-semibold">Переход решения (MASTER → BETA)</th>
                      <th className="py-2.5 px-3 font-semibold">Лимит (Сумма / Бакет)</th>
                      <th className="py-2.5 px-3 font-semibold">Сработавший поток и драйвер</th>
                      <th className="py-2.5 px-3 font-semibold">Статус заявки</th>
                      <th className="py-2.5 px-3 font-semibold text-center">Досье</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {filteredApps.map((app) => {
                      const appReview = (currentWorkspace.appReviews || {})[app.id];
                      return (
                        <tr
                          key={app.id}
                          onClick={() => setActiveDossierApp(app.id)}
                          className="hover:bg-blue-50/40 cursor-pointer transition"
                        >
                          <td className="py-3 px-3 font-bold text-slate-900">{app.id}</td>
                          <td className="py-3 px-3">
                            <span className="text-rose-600 font-bold">{app.beforeDecision}</span>
                            <span className="text-slate-400 mx-1.5">→</span>
                            <span className="text-emerald-600 font-bold">{app.afterDecision}</span>
                          </td>
                          <td className="py-3 px-3 text-slate-700">
                            <div>{app.limitBefore} → {app.limitAfter}</div>
                            <div className="text-[10px] text-slate-400">{app.limitBucketBefore} → {app.limitBucketAfter}</div>
                          </td>
                          <td className="py-3 px-3 font-sans text-[11px]">
                            {app.matchedContext ? (
                              <div>
                                <span className="bg-amber-100 text-amber-900 font-semibold px-1.5 py-0.5 rounded">
                                  {app.matchedContext.directionLabel}: {app.matchedContext.before} → {app.matchedContext.after}
                                </span>
                                <div className="text-slate-500 mt-0.5">{app.driver}</div>
                              </div>
                            ) : (
                              <span className="text-slate-600">{app.driver}</span>
                            )}
                          </td>
                          <td className="py-3 px-3 font-sans" onClick={(e) => e.stopPropagation()}>
                            <div className="flex gap-1">
                              {['Разобрана', 'Эталон', 'Аномалия'].map((label) => {
                                const isActive = appReview?.status === label;
                                return (
                                  <button
                                    key={label}
                                    onClick={() => handleToggleAppReview(app.id, label)}
                                    className={`px-2 py-0.5 rounded text-[10px] font-bold border transition ${
                                      isActive
                                        ? 'bg-blue-600 text-white border-blue-600'
                                        : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'
                                    }`}
                                  >
                                    {label}
                                  </button>
                                );
                              })}
                            </div>
                          </td>
                          <td className="py-3 px-3 text-center font-sans">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveDossierApp(app.id);
                              }}
                              className="text-[11px] bg-slate-900 hover:bg-blue-600 text-white px-2.5 py-1 rounded font-semibold transition"
                            >
                              Поля ({app.rawRows.length}) →
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

      </main>

      {/* ── БОКОВАЯ ШТОРКА (ДОСЬЕ ЗАЯВКИ) ── */}
      {activeDossierApp && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs">
          <div className="bg-white w-full max-w-3xl h-full shadow-2xl flex flex-col p-6 overflow-hidden">
            <div className="flex justify-between items-start border-b border-slate-200 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-lg text-slate-800">Досье заявки: {activeDossierApp}</h3>
                  <span className="text-xs bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded">
                    Параметров: {(appsDatabase[activeDossierApp] || []).length}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Поатрибутное сравнение сырых значений (VALUE) и бакетов (ADJUSTED)
                </p>
              </div>
              <button
                onClick={() => setActiveDossierApp(null)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold p-1 rounded-lg hover:bg-slate-100"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto my-4">
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-2 px-3 font-semibold">CLASS</th>
                      <th className="py-2 px-3 font-semibold">ARRAY_KEY / KEY</th>
                      <th className="py-2 px-3 font-semibold text-rose-700">BEFORE (Сырое / Бакет)</th>
                      <th className="py-2 px-3 font-semibold text-emerald-700">AFTER (Сырое / Бакет)</th>
                      <th className="py-2 px-3 font-semibold">Статус</th>
                      <th className="py-2 px-3 font-semibold">Комментарий</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {(appsDatabase[activeDossierApp] || []).map((row, idx) => {
                      const isDiff = String(row.DIFF_FLAG) === '1';
                      const keyPath = row.ARRAY_KEY
                        ? `${row.ARRAY_KEY}${row.KEY ? '.' + row.KEY : ''}`
                        : row.KEY || '(элемент массива)';

                      return (
                        <tr key={idx} className={isDiff ? 'bg-amber-50/50' : 'hover:bg-slate-50'}>
                          <td className="py-2 px-3 font-sans text-slate-500">{row.CLASS}</td>
                          <td className="py-2 px-3 font-bold text-slate-800">{keyPath}</td>
                          <td className="py-2 px-3 text-rose-600">
                            <div>{row.VALUE_BEFORE || '—'}</div>
                            {row.ADJUSTED_BEFORE && row.ADJUSTED_BEFORE !== row.VALUE_BEFORE && (
                              <div className="text-[10px] text-slate-400">бакет: {row.ADJUSTED_BEFORE}</div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-emerald-600 font-bold">
                            <div>{row.VALUE_AFTER || '—'}</div>
                            {row.ADJUSTED_AFTER && row.ADJUSTED_AFTER !== row.VALUE_AFTER && (
                              <div className="text-[10px] text-slate-400 font-normal">бакет: {row.ADJUSTED_AFTER}</div>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-sans font-bold ${
                              isDiff ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-400'
                            }`}>
                              {isDiff ? 'DIFF=1' : 'MATCH'}
                            </span>
                          </td>
                          <td className="py-2 px-3 font-sans text-slate-600 text-[11px]">{row.COMMENT || '—'}</td>
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
                className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-xl text-xs font-semibold transition"
              >
                Закрыть досье
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Модалки создания правила и пользователя */}
      {isRuleModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={handleAddRule} className="bg-white rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-xl border border-slate-200">
            <h3 className="font-bold text-sm text-slate-800">Новое правило для профиля: {currentUser}</h3>
            <input
              type="text"
              required
              placeholder="CLASS (например: antiFraudResult)"
              value={newRuleClass}
              onChange={(e) => setNewRuleClass(e.target.value)}
              className="w-full border border-slate-300 rounded-lg p-2 text-xs font-mono"
            />
            <input
              type="text"
              placeholder="KEY (например: velocity_check)"
              value={newRuleKey}
              onChange={(e) => setNewRuleKey(e.target.value)}
              className="w-full border border-slate-300 rounded-lg p-2 text-xs font-mono"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setIsRuleModalOpen(false)} className="px-3 py-1.5 text-xs text-slate-600">Отмена</button>
              <button type="submit" className="px-4 py-1.5 text-xs font-semibold bg-blue-600 text-white rounded-lg">Добавить</button>
            </div>
          </form>
        </div>
      )}

      {newUserModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={handleCreateUser} className="bg-white rounded-2xl p-6 w-full max-w-sm space-y-4 shadow-xl border border-slate-200">
            <h3 className="font-bold text-sm text-slate-800">Создать рабочее пространство аналитика</h3>
            <input
              type="text"
              required
              placeholder="например: Аналитик 3 (Олег)"
              value={newUserName}
              onChange={(e) => setNewUserName(e.target.value)}
              className="w-full border border-slate-300 rounded-lg p-2 text-xs"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setNewUserModalOpen(false)} className="px-3 py-1.5 text-xs text-slate-600">Отмена</button>
              <button type="submit" className="px-4 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-lg">Создать профиль</button>
            </div>
          </form>
        </div>
      )}

    </div>
  );
}