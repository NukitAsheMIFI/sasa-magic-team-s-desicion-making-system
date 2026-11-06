import React, { useState } from 'react';

export default function App() {
  // 1. ДАННЫЕ: список проверок (в реальности такой пришлёт бэкенд)
  const checks = [
    { id: 1, name: 'Проверка возраста (< 21)', status: 'FAIL', count: 41 },
    { id: 2, name: 'Проверка дохода', status: 'PASS', count: 0 },
    { id: 3, name: 'Скоркарта PD_RETAIL', status: 'FAIL', count: 128 },
  ];

  // 2. ПАМЯТЬ: какая проверка сейчас выбрана (в начале — ничего, то есть null)
  const [selected, setSelected] = useState(null);

  return (
    <div className="p-6 max-w-lg mx-auto font-sans">
      <h2 className="text-lg font-bold mb-4">Список проверок</h2>

      {/* 3. ТРАФАРЕТ: цикл .map() штампует строки из массива */}
      <div className="space-y-2">
        {checks.map((item) => (
          <div
            key={item.id}
            onClick={() => setSelected(item)} // при клике кладём выбранный пункт в память
            className={`p-3 border rounded-lg cursor-pointer transition flex justify-between items-center ${
              selected?.id === item.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <span>{item.name}</span>

            {/* Условие: красим статус в зелёный или красный */}
            <span className={`font-bold text-sm ${item.status === 'PASS' ? 'text-green-600' : 'text-red-600'}`}>
              {item.status} ({item.count})
            </span>
          </div>
        ))}
      </div>

      {/* 4. РЕАКЦИЯ: показываем детали только если в памяти что-то выбрано */}
      {selected && (
        <div className="mt-6 p-4 bg-gray-100 rounded-lg">
          <h3 className="font-bold text-gray-800">Детали проверки:</h3>
          <p className="text-sm mt-1">Название: {selected.name}</p>
          <p className="text-sm">Затронуто клиентов: {selected.count}</p>
        </div>
      )}
    </div>
  );
}