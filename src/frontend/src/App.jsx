import React, { useState, useMemo } from 'react';

// 1. ИМПОРТ РЕАЛЬНОГО ФАЙЛА ВИТРИНЫ
import rawPivotFacts from './data/08_pivot_facts_demo.json';

// База диффа заявок для детального просмотра
const APPS_DATABASE = {
  'APP-1001': [
    { CLASS: 'decisionResult', KEY: 'decision', VALUE_BEFORE: 'APPROVE', VALUE_AFTER: 'VERIFICATION', DIFF_FLAG: '1', COMMENT: 'решение изменилось' },
    { CLASS: 'decisionResult', KEY: 'businessDecision', VALUE_BEFORE: 'OFFER', VALUE_AFTER: 'OFFER', DIFF_FLAG: '0', COMMENT: 'без изменений' },
    { CLASS: 'decisionResult', KEY: 'riskSegment', VALUE_BEFORE: '—', VALUE_AFTER: 'R2', DIFF_FLAG: '1', COMMENT: 'атрибут добавился в AFTER' },
    { CLASS: 'scoreCardResult', KEY: 'TAKEUP_RATE_IP (value)', VALUE_BEFORE: '0.42 (0.3 - 0.6]', VALUE_AFTER: '0.58 (0.3 - 0.6]', DIFF_FLAG: '1', COMMENT: 'значение изменилось, бакет тот же' },
    { CLASS: 'scoreCardResult', KEY: 'TAKEUP_RATE_IP (version)', VALUE_BEFORE: 'v3', VALUE_AFTER: 'v4', DIFF_FLAG: '1', COMMENT: 'перекатали скоркарту' },
    { CLASS: 'scoreCardResult', KEY: 'PD_RETAIL (value)', VALUE_BEFORE: '0.11 (0 - 0.3]', VALUE_AFTER: '0.11 (0 - 0.3]', DIFF_FLAG: '0', COMMENT: 'без изменений' },
    { CLASS: 'limitResult', KEY: 'limit', VALUE_BEFORE: '117 325 ₽ (100K - 250K]', VALUE_AFTER: '96 500 ₽ (0 - 100K]', DIFF_FLAG: '1', COMMENT: 'бакет лимита сдвинулся вниз' },
    { CLASS: 'rejectReasons', KEY: 'reason', VALUE_BEFORE: 'AGELOW@21, NOINCOME', VALUE_AFTER: 'AGELOW@21, NOINCOME, DOCS_EXPIRED', DIFF_FLAG: '1', COMMENT: 'новый стоп-фактор в AFTER' }
  ],
  'APP-1004': [
    { CLASS: 'decisionResult', KEY: 'decision', VALUE_BEFORE: 'REJECT', VALUE_AFTER: 'APPROVE', DIFF_FLAG: '1', COMMENT: 'пересмотр порога скоринга' },
    { CLASS: 'limitResult', KEY: 'limit', VALUE_BEFORE: '0 ₽', VALUE_AFTER: '150 000 ₽', DIFF_FLAG: '1', COMMENT: 'назначен начальный лимит' }
  ],
  'APP-1019': [
    { CLASS: 'decisionResult', KEY: 'decision', VALUE_BEFORE: 'APPROVE', VALUE_AFTER: 'REJECT', DIFF_FLAG: '1', COMMENT: 'отказ по новому правилу DTI' },
    { CLASS: 'rejectReasons', KEY: 'reason', VALUE_BEFORE: '—', VALUE_AFTER: 'DTI_HIGH', DIFF_FLAG: '1', COMMENT: 'сработал стоп-фактор' }
  ]
};

export default function App() {
  const [tab, setTab] = useState('report');
  const [currentUser, setCurrentUser] = useState('Аналитик 1 (Иван)');
  const [selectedClass, setSelectedClass] = useState(null);
  const [selectedApp, setSelectedApp] = useState('APP-1001');
  const [filterOnlyDiff, setFilterOnlyDiff] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newCheckName, setNewCheckName] = useState('');

  // 2. ИСПОЛЬЗУЕМ ИМПОРТИРОВАННЫЙ JSON КАК СТАРТОВОЕ СОСТОЯНИЕ
  const [pivotFacts, setPivotFacts] = useState(rawPivotFacts);

  // Далее весь код useMemo и рендеринга остаётся прежним...

  // ── 1. ДИНАМИЧЕСКИЙ АНАЛИЗ СТРУКТУРЫ (SCHEMA-AGNOSTIC) ──
  const { discoveredGroups, globalStats } = useMemo(() => {
    const groupsMap = {};
    let totalDifferences = 0;
    let totalFactsCount = 0;

    let beforeApprovals = 0;
    let afterApprovals = 0;
    let totalBeforeDecisions = 0;
    let totalAfterDecisions = 0;
    let flippedDecisions = 0;

    pivotFacts.forEach((row) => {
      const groupName = row.CLASS || 'Общие параметры';
      const isDiff = String(row.DIFF_FLAG) === '1';
      const count = Number(row.CNT) || 0;

      totalFactsCount += count;
      if (isDiff) totalDifferences += count;

      if (!groupsMap[groupName]) {
        groupsMap[groupName] = {
          name: groupName,
          diffCount: 0,
          totalCount: 0,
          attributes: new Set(),
        };
      }

      groupsMap[groupName].totalCount += count;
      if (isDiff) groupsMap[groupName].diffCount += count;

      if (row.KEY) {
        const fullKey = row.ARRAY_KEY ? `${row.ARRAY_KEY}.${row.KEY}` : row.KEY;
        groupsMap[groupName].attributes.add(fullKey);
      }

      // Подсчет метрик по решениям (decisionResult)
      if (row.CLASS === 'decisionResult' && row.KEY === 'decision') {
        if (row.SOURCE === 'BEFORE (MASTER)') totalBeforeDecisions += count;
        if (row.SOURCE === 'AFTER (BETA)') totalAfterDecisions += count;

        if (row.VALUE_ADJUSTED === 'APPROVE') {
          if (row.SOURCE === 'BEFORE (MASTER)') beforeApprovals += count;
          if (row.SOURCE === 'AFTER (BETA)') afterApprovals += count;
        }
        if (isDiff && row.SOURCE === 'AFTER (BETA)') {
          flippedDecisions += count;
        }
      }
    });

    const groupsArray = Object.values(groupsMap).map((g) => ({
      ...g,
      uniqueKeysCount: g.attributes.size,
      attributesList: Array.from(g.attributes)
    }));

    const appBeforeRate = totalBeforeDecisions > 0 ? (beforeApprovals / totalBeforeDecisions) * 100 : 0;
    const appAfterRate = totalAfterDecisions > 0 ? (afterApprovals / totalAfterDecisions) * 100 : 0;

    return {
      discoveredGroups: groupsArray,
      globalStats: {
        totalClasses: groupsArray.length,
        totalDifferences,
        totalFactsCount,
        approvalBefore: appBeforeRate.toFixed(1),
        approvalAfter: appAfterRate.toFixed(1),
        approvalDiff: (appAfterRate - appBeforeRate).toFixed(1),
        flippedDecisions
      }
    };
  }, [pivotFacts]);

  // Фильтрация карточек классов
  const displayedGroups = discoveredGroups.filter((g) => {
    if (filterOnlyDiff && g.diffCount === 0) return false;
    if (searchTerm && !g.name.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  // Строки сравнения для выбранной заявки
  const currentAppRows = APPS_DATABASE[selectedApp] || [];
  const filteredAppRows = useMemo(() => {
    if (!selectedClass) return currentAppRows;
    return currentAppRows.filter((row) => row.CLASS === selectedClass);
  }, [selectedClass, currentAppRows]);

  // Запуск бэктеста
  const handleStartAnalysis = () => {
    setIsRunning(true);
    setTimeout(() => {
      setIsRunning(false);
      setTab('report');
    }, 1800);
  };

  // Добавление новой проверки
  const handleAddCustomRule = (e) => {
    e.preventDefault();
    if (!newCheckName.trim()) return;

    const newFact = {
      PREFIX: "company",
      CLASS: newCheckName.trim(),
      KEY: "rule_eval",
      VALUE_ADJUSTED: "PASS",
      DIFF_FLAG: "0",
      SOURCE: "AFTER (BETA)",
      CNT: 1
    };

    setPivotFacts([...pivotFacts, newFact]);
    setNewCheckName('');
    setIsModalOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col">
      
      {/* ── ВЕРХНЯЯ ПАНЕЛЬ (HEADER) ── */}
      <header className="border-b border-slate-200 bg-white/95 px-6 py-2.5 flex items-center justify-between sticky top-0 z-40 backdrop-blur shadow-xs">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="font-bold text-sm tracking-tight text-slate-800">СПР • Анализ расхождений стратегий</span>
          </div>

          <nav className="flex gap-1 bg-slate-100 p-1 rounded-lg">
            <button
              onClick={() => setTab('report')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                tab === 'report' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Сводная витрина
            </button>
            <button
              onClick={() => setTab('run')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                tab === 'run' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Запуск сравнения
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 bg-white border border-slate-300 rounded-lg px-2.5 py-1 text-xs shadow-xs">
            <span className="text-slate-400">👤</span>
            <select
              value={currentUser}
              onChange={(e) => setCurrentUser(e.target.value)}
              className="bg-transparent border-none outline-none font-medium text-slate-700 cursor-pointer"
            >
              <option value="Аналитик 1 (Иван)">Аналитик 1 (Иван)</option>
              <option value="Аналитик 2 (Мария)">Аналитик 2 (Мария)</option>
            </select>
          </div>

          <button
            onClick={() => alert(`Экспорт отчёта для: ${currentUser}`)}
            className="bg-slate-900 hover:bg-slate-800 text-white px-3 py-1 rounded-lg text-xs font-medium transition shadow-xs"
          >
            Экспорт Excel
          </button>
        </div>
      </header>

      {/* ── ОСНОВНОЙ КОНТЕНТ ── */}
      <main className="flex-1 p-6 max-w-5xl w-full mx-auto space-y-6">
        
        {/* ВКЛАДКА 1: СВОДНАЯ ВИТРИНА */}
        {tab === 'report' && (
          <>
            {/* Блок KPI-метрик (рассчитан динамически по выборке) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
                <div className="text-xs font-medium text-slate-500 mb-1">Уровень одобрения (APPROVE)</div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold tracking-tight text-slate-900">
                    {globalStats.approvalAfter}%
                  </div>
                  <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">
                    +{globalStats.approvalDiff}%
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Прод (MASTER): <span className="font-medium text-slate-600">{globalStats.approvalBefore}%</span>
                </div>
              </div>

              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
                <div className="text-xs font-medium text-slate-500 mb-1">Расхождения решений (Flip)</div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold tracking-tight text-slate-900">
                    {globalStats.flippedDecisions} <span className="text-sm font-normal text-slate-500">заявок</span>
                  </div>
                  <span className="text-xs font-semibold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded">
                    BETA ≠ MASTER
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Изменили финальный исход в новой стратегии
                </div>
              </div>

              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
                <div className="text-xs font-medium text-slate-500 mb-1">Всего расхождений (DIFF=1)</div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold tracking-tight text-slate-900">
                    {globalStats.totalDifferences}
                  </div>
                  <span className="text-xs font-semibold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
                    по {globalStats.totalClasses} классам
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 mt-1">
                  Обработано фактов: {globalStats.totalFactsCount}
                </div>
              </div>
            </div>

            {/* Фильтры и поиск */}
            <div className="flex flex-col sm:flex-row gap-3 justify-between items-center">
              <input
                type="text"
                placeholder="Поиск по классам или параметрам стратегии..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full sm:w-80 bg-white border border-slate-300 rounded-xl px-3.5 py-2 text-xs outline-none focus:border-blue-500 transition shadow-xs"
              />

              <div className="flex gap-2 w-full sm:w-auto">
                <button
                  onClick={() => setFilterOnlyDiff(!filterOnlyDiff)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
                    filterOnlyDiff 
                      ? 'bg-amber-500 text-white border-amber-500 shadow-xs' 
                      : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {filterOnlyDiff ? '● Только расхождения' : '○ Все блоки'}
                </button>

                <button
                  onClick={() => setIsModalOpen(true)}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition shadow-xs"
                >
                  + Новое правило
                </button>
              </div>
            </div>

            {/* Автоматически обнаруженные классы стратегии */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {displayedGroups.map((group) => {
                const isSelected = selectedClass === group.name;
                return (
                  <div
                    key={group.name}
                    onClick={() => setSelectedClass(isSelected ? null : group.name)}
                    className={`p-3.5 rounded-xl border cursor-pointer transition flex flex-col justify-between ${
                      isSelected 
                        ? 'border-blue-600 bg-blue-50/70 shadow-xs ring-1 ring-blue-600' 
                        : 'bg-white border-slate-200 hover:border-slate-300 shadow-xs'
                    }`}
                  >
                    <div>
                      <div className="flex justify-between items-start gap-2">
                        <span className="font-bold text-xs text-slate-800 break-all">{group.name}</span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${
                          group.diffCount > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'
                        }`}>
                          DIFF: {group.diffCount}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1.5">
                        Параметров: {group.uniqueKeysCount}
                      </div>
                    </div>
                    <div className="mt-2.5 pt-2 border-t border-slate-100 text-[10px] text-slate-500 truncate">
                      {group.attributesList.join(', ') || 'Общий блок'}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Drill-Down: выбор заявки и поатрибутное сравнение */}
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs space-y-3 p-4">
              <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2 border-b border-slate-100 pb-3">
                <div>
                  <h3 className="font-bold text-sm text-slate-800">
                    Детальный анализ заявки (Drill-Down)
                  </h3>
                  <p className="text-xs text-slate-500">
                    {selectedClass ? `Фильтр по классу: ${selectedClass}` : 'Все атрибуты заявки'}
                  </p>
                </div>

                {/* Селектор номера заявки */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 font-medium">Заявка:</span>
                  <div className="flex gap-1">
                    {Object.keys(APPS_DATABASE).map((appId) => (
                      <button
                        key={appId}
                        onClick={() => setSelectedApp(appId)}
                        className={`px-2.5 py-1 rounded-md text-xs font-mono font-semibold transition border ${
                          selectedApp === appId
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                        }`}
                      >
                        {appId}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Таблица сравнения полей */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3 font-semibold">Класс / Блок</th>
                      <th className="py-2.5 px-3 font-semibold">Атрибут (KEY)</th>
                      <th className="py-2.5 px-3 font-semibold text-rose-700">BEFORE (MASTER)</th>
                      <th className="py-2.5 px-3 font-semibold text-emerald-700">AFTER (BETA)</th>
                      <th className="py-2.5 px-3 font-semibold">Статус</th>
                      <th className="py-2.5 px-3 font-semibold">Комментарий</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {filteredAppRows.length === 0 ? (
                      <tr>
                        <td colSpan="6" className="py-4 text-center text-slate-400 font-sans">
                          Для выбранного фильтра атрибуты отсутствуют
                        </td>
                      </tr>
                    ) : (
                      filteredAppRows.map((row, idx) => {
                        const isDiff = String(row.DIFF_FLAG) === '1';
                        return (
                          <tr key={idx} className={isDiff ? 'bg-amber-50/40 hover:bg-amber-50/70' : 'hover:bg-slate-50'}>
                            <td className="py-2 px-3 text-slate-500 font-sans font-medium">{row.CLASS}</td>
                            <td className="py-2 px-3 font-semibold text-slate-800">{row.KEY}</td>
                            <td className="py-2 px-3 text-rose-600">{row.VALUE_BEFORE}</td>
                            <td className="py-2 px-3 text-emerald-600 font-bold">{row.VALUE_AFTER}</td>
                            <td className="py-2 px-3">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-sans font-bold ${
                                isDiff ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'
                              }`}>
                                {isDiff ? 'DIFF' : 'MATCH'}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-slate-600 font-sans text-[11px]">{row.COMMENT || '—'}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* ВКЛАДКА 2: ПАРАМЕТРЫ ЗАПУСКА */}
        {tab === 'run' && (
          <div className="bg-white p-6 border border-slate-200 rounded-2xl space-y-4 shadow-xs">
            <div>
              <h2 className="text-base font-bold text-slate-800">Параметры прогона Diff-анализа</h2>
              <p className="text-xs text-slate-500">
                Рабочее пространство: <span className="font-semibold text-slate-700">{currentUser}</span>
              </p>
            </div>
            
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Базовый датасет (MASTER / Прод)</label>
                <input 
                  disabled 
                  value="01_response_BEFORE_MASTER.json (465 заявок)" 
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-xs text-slate-700 font-mono" 
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Сравниваемый датасет (BETA / Тест)</label>
                <input 
                  disabled 
                  value="02_response_AFTER_BETA.json (465 заявок)" 
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 text-xs text-slate-700 font-mono" 
                />
              </div>
            </div>

            <button 
              disabled={isRunning}
              onClick={handleStartAnalysis}
              className={`w-full py-2.5 rounded-lg text-sm font-semibold transition flex items-center justify-center gap-2 ${
                isRunning 
                  ? 'bg-slate-400 cursor-not-allowed text-white' 
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
              }`}
            >
              {isRunning ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                  <span>Нормализация и расчёт матрицы расхождений...</span>
                </>
              ) : (
                'Запустить расчёт DIFF (MASTER vs BETA)'
              )}
            </button>
          </div>
        )}

      </main>

      {/* ── МОДАЛЬНОЕ ОКНО СОЗДАНИЯ ПРАВИЛА ── */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
          <form 
            onSubmit={handleAddCustomRule}
            className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 w-full max-w-sm space-y-4"
          >
            <div className="flex justify-between items-center border-b border-slate-100 pb-2">
              <h3 className="font-bold text-slate-800 text-sm">Добавить проверку стратегии</h3>
              <button 
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>
            
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Название правила или класса</label>
              <input
                type="text"
                required
                placeholder="например: dtiThresholdCheck"
                value={newCheckName}
                onChange={(e) => setNewCheckName(e.target.value)}
                className="w-full bg-white border border-slate-300 rounded-lg p-2 text-xs outline-none focus:border-blue-500 font-mono"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                Отмена
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition"
              >
                Создать
              </button>
            </div>
          </form>
        </div>
      )}

    </div>
  );
}