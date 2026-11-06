import React, { useState } from 'react';

export default function App() {
  const [tab, setTab] = useState('report');
  const [selected, setSelected] = useState(null);
  const [selectedApp, setSelectedApp] = useState(null);
  const [onlyFails, setOnlyFails] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState('Аналитик 1 (Иван)');
  const [isRunning, setIsRunning] = useState(false);

  // 1. МЕТРИКИ ДЛЯ КАЖДОГО АНАЛИТИКА
  const userMetrics = {
    'Аналитик 1 (Иван)': {
      approvalBefore: '64.0%',
      approvalAfter: '58.2%',
      approvalDiff: '-5.8%',
      isNegative: true,
      flippedCount: 31,
      flippedPercent: '6.2%',
      avgScoreBefore: '0.045',
      avgScoreAfter: '0.039',
      scoreDiff: '-0.006 (риск ниже)',
    },
    'Аналитик 2 (Мария)': {
      approvalBefore: '70.5%',
      approvalAfter: '73.0%',
      approvalDiff: '+2.5%',
      isNegative: false,
      flippedCount: 14,
      flippedPercent: '2.8%',
      avgScoreBefore: '0.052',
      avgScoreAfter: '0.050',
      scoreDiff: '-0.002 (риск ниже)',
    },
  };

  const [userChecks, setUserChecks] = useState({
    'Аналитик 1 (Иван)': [
      { 
        id: 1, 
        name: 'Проверка возраста (< 21)', 
        status: 'FAIL', 
        count: 2,
        apps: [
          { id: 'APP-100293', before: 'Отказ (AGELOW)', after: 'Одобрено' },
          { id: 'APP-100341', before: 'Отказ (AGELOW)', after: 'Одобрено' },
        ]
      },
      { id: 2, name: 'Проверка дохода', status: 'PASS', count: 0, apps: [] },
      { 
        id: 3, 
        name: 'Скоркарта PD_RETAIL', 
        status: 'FAIL', 
        count: 1,
        apps: [
          { id: 'APP-100550', before: 'Порог 0.55 (Одобрено)', after: 'Порог 0.58 (Отказ)' }
        ]
      },
    ],
    'Аналитик 2 (Мария)': [
      { id: 101, name: 'Проверка региона (Северный Кавказ)', status: 'PASS', count: 0, apps: [] },
      { 
        id: 102, 
        name: 'Долговая нагрузка DTI (> 50%)', 
        status: 'FAIL', 
        count: 1,
        apps: [
          { id: 'APP-200114', before: 'Одобрено (DTI=48%)', after: 'Отказ (DTI=52%)' }
        ]
      },
      { 
        id: 103, 
        name: 'Скоркарта PD_CORPORATE', 
        status: 'FAIL', 
        count: 1,
        apps: [
          { id: 'APP-200980', before: 'Одобрено', after: 'Ручная проверка' }
        ]
      },
    ]
  });

  const currentChecks = userChecks[currentUser] || [];
  const currentMetrics = userMetrics[currentUser];
  const displayedChecks = currentChecks.filter((item) => (onlyFails ? item.status === 'FAIL' : true));

  const handleStartAnalysis = () => {
    setIsRunning(true);
    setTimeout(() => {
      setIsRunning(false);
      setTab('report');
    }, 2000);
  };

  const handleAddDummyCheck = () => {
    const newCheck = {
      id: Date.now(),
      name: `Новая гипотеза (${currentUser.split(' ')[2] || 'User'})`,
      status: 'PASS',
      count: 0,
      apps: []
    };

    setUserChecks({
      ...userChecks,
      [currentUser]: [...currentChecks, newCheck]
    });
    setIsModalOpen(false);
  };

  const handleUserChange = (newUser) => {
    setCurrentUser(newUser);
    setSelected(null);
    setSelectedApp(null);
  };

  return (
    <div className="min-h-screen bg-slate-50/50 text-gray-900 font-sans flex flex-col">
      
      {/* Шапка */}
      <header className="border-b border-gray-200 bg-white/90 px-6 py-2.5 flex items-center justify-between sticky top-0 z-40 backdrop-blur">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="font-bold text-sm tracking-tight text-gray-800">СПР • Анализ изменений</span>
          </div>

          <nav className="flex gap-1 bg-gray-100 p-1 rounded-lg">
            <button
              onClick={() => setTab('report')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                tab === 'report' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Сводный отчёт
            </button>
            <button
              onClick={() => setTab('run')}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition ${
                tab === 'run' ? 'bg-white text-gray-900 shadow-xs' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Запуск бэктеста
            </button>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 bg-white border border-gray-300 rounded-lg px-2.5 py-1 text-xs shadow-xs">
            <span className="text-gray-400">👤</span>
            <select
              value={currentUser}
              onChange={(e) => handleUserChange(e.target.value)}
              className="bg-transparent border-none outline-none font-medium text-gray-700 cursor-pointer"
            >
              <option value="Аналитик 1 (Иван)">Аналитик 1 (Иван)</option>
              <option value="Аналитик 2 (Мария)">Аналитик 2 (Мария)</option>
            </select>
          </div>

          <button
            onClick={() => alert(`Экспорт отчёта для: ${currentUser}`)}
            className="bg-gray-900 hover:bg-gray-800 text-white px-3 py-1 rounded-lg text-xs font-medium transition shadow-xs"
          >
            Скачать HTML
          </button>
        </div>
      </header>

      {/* Основной контейнер */}
      <main className="flex-1 p-6 max-w-3xl w-full mx-auto space-y-6">
        
        {tab === 'report' && (
          <>
            {/* ── 2. БЛОК СВОДНЫХ МЕТРИК (KPI) ── */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              
              {/* Карточка 1: Одобряемость */}
              <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-xs">
                <div className="text-xs font-medium text-gray-500 mb-1">Уровень одобрения</div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold tracking-tight text-gray-900">
                    {currentMetrics.approvalAfter}
                  </div>
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                    currentMetrics.isNegative 
                      ? 'bg-amber-100 text-amber-800' 
                      : 'bg-emerald-100 text-emerald-800'
                  }`}>
                    {currentMetrics.approvalDiff}
                  </span>
                </div>
                <div className="text-[11px] text-gray-400 mt-1">
                  Было в проде: <span className="font-medium text-gray-600">{currentMetrics.approvalBefore}</span>
                </div>
              </div>

              {/* Карточка 2: Спорные заявки (Flipped) */}
              <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-xs">
                <div className="text-xs font-medium text-gray-500 mb-1">Расхождения в решении</div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold tracking-tight text-gray-900">
                    {currentMetrics.flippedCount}
                  </div>
                  <span className="text-xs font-semibold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                    {currentMetrics.flippedPercent}
                  </span>
                </div>
                <div className="text-[11px] text-gray-400 mt-1">
                  Заявок изменили исход (Flip)
                </div>
              </div>

              {/* Карточка 3: Средний скор риска */}
              <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-xs">
                <div className="text-xs font-medium text-gray-500 mb-1">Средний PD (риск)</div>
                <div className="flex items-baseline justify-between">
                  <div className="text-2xl font-bold tracking-tight text-gray-900">
                    {currentMetrics.avgScoreAfter}
                  </div>
                  <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                    {currentMetrics.scoreDiff}
                  </span>
                </div>
                <div className="text-[11px] text-gray-400 mt-1">
                  Было: <span className="font-medium text-gray-600">{currentMetrics.avgScoreBefore}</span>
                </div>
              </div>

            </div>

            {/* ── СПИСОК ПРОВЕРОК ── */}
            <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-xs space-y-4">
              <div className="flex justify-between items-center">
                <div>
                  <h2 className="text-base font-bold">Список проверок стратегии</h2>
                  <p className="text-xs text-gray-500">Профиль: {currentUser}</p>
                </div>
                
                <div className="flex gap-2">
                  <button
                    onClick={() => setOnlyFails(!onlyFails)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                      onlyFails
                        ? 'bg-red-50 text-red-700 border-red-300'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {onlyFails ? '● Только FAIL' : '○ Только FAIL'}
                  </button>

                  <button
                    onClick={() => setIsModalOpen(true)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition shadow-sm"
                  >
                    + Добавить
                  </button>
                </div>
              </div>
              
              <div className="space-y-2">
                {displayedChecks.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => { setSelected(item); setSelectedApp(null); }}
                    className={`p-3 border rounded-lg cursor-pointer transition flex justify-between items-center ${
                      selected?.id === item.id ? 'border-blue-500 bg-blue-50/60' : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <span className="font-medium text-sm">{item.name}</span>
                    <span className={`font-bold text-sm ${item.status === 'PASS' ? 'text-green-600' : 'text-red-600'}`}>
                      {item.status} ({item.count})
                    </span>
                  </div>
                ))}
              </div>

              {/* Drill-down блок */}
              {selected && (
                <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl space-y-3">
                  <h3 className="font-semibold text-xs text-gray-700 uppercase tracking-wider">
                    Затронутые заявки: {selected.name}
                  </h3>

                  {selected.apps.length === 0 ? (
                    <p className="text-xs text-gray-400">Нарушений нет, список заявок пуст.</p>
                  ) : (
                    <div className="flex gap-2">
                      {selected.apps.map((app) => (
                        <button
                          key={app.id}
                          onClick={() => setSelectedApp(app)}
                          className={`px-3 py-1.5 rounded text-xs font-mono border transition ${
                            selectedApp?.id === app.id
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-gray-800 border-gray-300 hover:bg-gray-100'
                          }`}
                        >
                          {app.id}
                        </button>
                      ))}
                    </div>
                  )}

                  {selectedApp && (
                    <div className="mt-3 p-3 bg-white border border-blue-200 rounded-lg text-xs space-y-1.5 shadow-xs">
                      <div className="font-bold text-gray-700">Результат для {selectedApp.id}:</div>
                      <div className="flex justify-between text-red-600">
                        <span>BEFORE (Прод):</span>
                        <span className="font-mono">{selectedApp.before}</span>
                      </div>
                      <div className="flex justify-between text-green-600">
                        <span>AFTER (Новая версия):</span>
                        <span className="font-mono">{selectedApp.after}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* ВКЛАДКА ЗАПУСКА */}
        {tab === 'run' && (
          <div className="bg-white p-6 border border-gray-200 rounded-xl space-y-4 shadow-xs">
            <h2 className="text-base font-bold">Настройка параметров запуска</h2>
            <p className="text-xs text-gray-500">Запуск от имени: <span className="font-semibold text-gray-800">{currentUser}</span></p>
            
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Выбор тестового датасета</label>
              <select className="w-full bg-white border border-gray-300 rounded-lg p-2 text-sm text-gray-700">
                <option>RUN-20260827-0001 (500 заявок • Ипотека)</option>
                <option>RUN-20260901-0042 (1200 заявок • Потребы)</option>
              </select>
            </div>

            <button 
              disabled={isRunning}
              onClick={handleStartAnalysis}
              className={`w-full py-2.5 rounded-lg text-sm font-semibold transition flex items-center justify-center gap-2 ${
                isRunning 
                  ? 'bg-gray-400 cursor-not-allowed text-white' 
                  : 'bg-green-600 hover:bg-green-700 text-white'
              }`}
            >
              {isRunning ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                  <span>Выполняется расчёт стратегии...</span>
                </>
              ) : (
                'Старт анализа'
              )}
            </button>
          </div>
        )}

      </main>

      {/* Модальное окно */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs">
          <div className="bg-white rounded-xl shadow-xl border border-gray-200 p-6 w-full max-w-sm mx-4 space-y-4 animate-in fade-in">
            <div className="flex justify-between items-center border-b pb-2">
              <h3 className="font-bold text-gray-800">Новая проверка для {currentUser.split(' ')[2] || currentUser}</h3>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>
            
            <p className="text-xs text-gray-500">
              Это правило будет добавлено в конфигурацию стратегии текущего аналитика.
            </p>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg transition"
              >
                Отмена
              </button>
              <button
                onClick={handleAddDummyCheck}
                className="px-4 py-1.5 text-xs font-semibold bg-green-600 hover:bg-green-700 text-white rounded-lg transition"
              >
                Создать
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}