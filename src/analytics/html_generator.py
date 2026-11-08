"""
HTML-отчёт по запуску пайплайна.
"""

import os
import json
import glob
import sqlite3
from html import escape


def _get_db_path() -> str:
    """Ищем hackathon.db: env → типовые места → рекурсивный поиск."""
    env = os.getenv("HACKATHON_DB_PATH")
    if env and os.path.exists(env):
        return env

    here = os.path.dirname(os.path.abspath(__file__))
    for c in [
        os.path.join(here, "..", "backend", "hackathon.db"),
        os.path.join(here, "..", "backend", "app.db"),
        os.path.join(here, "..", "hackathon.db"),
        os.path.join(here, "hackathon.db"),
    ]:
        c = os.path.abspath(c)
        if os.path.exists(c):
            return c

    matches = glob.glob(os.path.join(here, "..", "**", "hackathon.db"), recursive=True)
    if matches:
        return os.path.abspath(matches[0])

    raise FileNotFoundError(
        "hackathon.db не найден. Задай HACKATHON_DB_PATH или положи файл рядом с src/backend/."
    )


def _e(v) -> str:
    """HTML-escape + None → пустая строка."""
    return "" if v is None else escape(str(v))

def _load_verdict(cur, run_id: int):
    """Читаем вердикт напрямую из БД (таблица verdicts)"""
    try:
        cur.execute("SELECT * FROM verdicts WHERE run_id = ?", (run_id,))
        row = cur.fetchone()
        if row:
            return dict(row), "База данных (таблица verdicts)"
    except Exception as e:
        print(f"Ошибка чтения вердикта из БД: {e}")
    
    return None, None

def generate_html_report(run_id: int, db_path: str = None) -> str:
    if not db_path:
        db_path = _get_db_path()
        
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # ---- Запуск + пользователь ----
    cur.execute("""
        SELECT r.id, r.status, r.config, r.created_at, u.username
        FROM runs r
        LEFT JOIN users u ON u.id = r.user_id
        WHERE r.id = ?
    """, (run_id,))
    run = cur.fetchone()

    if run is None:
        conn.close()
        return (
            "<!doctype html><html lang='ru'><meta charset='utf-8'>"
            f"<title>Отчёт #{run_id}</title>"
            "<body style='font-family:sans-serif;padding:24px'>"
            f"<h1>Отчёт по запуску #{run_id}</h1>"
            "<p>Запуск не найден.</p>"
            "<p><a href='http://localhost:8000/'>← Вернуться в приложение</a></p>"
            "</body></html>"
        )

    # ---- Шаги ----
    cur.execute(
        "SELECT name, status, started_at, finished_at, logs "
        "FROM run_steps WHERE run_id = ? ORDER BY id",
        (run_id,),
    )
    steps = cur.fetchall()

    # ---- Реестр заявок (агрегация по mart_rows) ----
    cur.execute("""
        SELECT app_id,
               COUNT(*) AS total_rows,
               SUM(CASE WHEN diff_flag = 1               THEN 1 ELSE 0 END) AS diff_rows,
               SUM(CASE WHEN change_type = 'VALUE_CHANGED' THEN 1 ELSE 0 END) AS changed_rows,
               SUM(CASE WHEN change_type = 'ATTRIBUTE_NEW' THEN 1 ELSE 0 END) AS new_rows,
               SUM(CASE WHEN change_type = 'ATTRIBUTE_LOST' THEN 1 ELSE 0 END) AS lost_rows
        FROM mart_rows
        WHERE run_id = ?
        GROUP BY app_id
        ORDER BY app_id
    """, (run_id,))
    apps = cur.fetchall()

    # ---- Строки "decision" (для fallback-расчёта AR) ----
    cur.execute("""
        SELECT app_id, value_before, value_after
        FROM mart_rows
        WHERE run_id = ? AND LOWER(key) = 'decision'
    """, (run_id,))
    decisions = cur.fetchall()

    # ---- Pivot facts ----
    cur.execute("""
        SELECT prefix, class_name, suffix, array_key, key, source,
               value_adjusted, diff_flag, cnt
        FROM pivot_facts
        WHERE run_id = ?
        ORDER BY prefix, class_name, array_key, key, source
    """, (run_id,))
    facts = cur.fetchall()

    # ---- Checks (если появятся в БД) ----
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('checks','check_results')")
    checks_table_row = cur.fetchone()
    checks = None
    if checks_table_row:
        try:
            tbl = checks_table_row["name"]
            cur.execute(f"SELECT * FROM {tbl} WHERE run_id = ? ORDER BY id", (run_id,))
            checks = cur.fetchall()
        except Exception:
            checks = None

    # Читаем вердикт из БД
    verdict, verdict_src = _load_verdict(cur, run_id)
    
    conn.close()

    verdict_is_approx = False

    if verdict is None and decisions:
        total = len(decisions)
        app_b = sum(1 for d in decisions if (d["value_before"] or "").upper() == "APPROVE")
        app_a = sum(1 for d in decisions if (d["value_after"] or "").upper() == "APPROVE")
        new_app = sum(
            1 for d in decisions
            if (d["value_before"] or "").upper() != "APPROVE"
            and (d["value_after"] or "").upper() == "APPROVE"
        )
        lost_app = sum(
            1 for d in decisions
            if (d["value_before"] or "").upper() == "APPROVE"
            and (d["value_after"] or "").upper() != "APPROVE"
        )
        net = new_app - lost_app
        verdict = {
            "total_apps": total,
            "ar_before": round(100.0 * app_b / total, 2) if total else 0.0,
            "ar_after": round(100.0 * app_a / total, 2) if total else 0.0,
            "new_approved": new_app,
            "lost_approved": lost_app,
            "net_impact": net,
            "summary": (
                "Ужесточение стратегии" if net < 0
                else "Экспансия портфеля" if net > 0
                else "Без изменений"
            ),
        }
        verdict_src = "рассчитано по mart_rows (key=decision)"
        verdict_is_approx = True

    if verdict is None:
        total = len(apps)
        if total == 0:
            verdict = {
                "total_apps": 0, "ar_before": 0.0, "ar_after": 0.0,
                "new_approved": 0, "lost_approved": 0, "net_impact": 0,
                "summary": "Нет данных",
            }
        else:
            clean = sum(1 for a in apps if (a["diff_rows"] or 0) == 0)
            lost = sum(1 for a in apps if (a["lost_rows"] or 0) > 0)
            fixable = sum(
                1 for a in apps
                if (a["diff_rows"] or 0) > 0 and (a["lost_rows"] or 0) == 0
            )
            verdict = {
                "total_apps": total,
                "ar_before": round(100.0 * clean / total, 2),
                "ar_after": round(100.0 * (clean + fixable) / total, 2),
                "new_approved": fixable,
                "lost_approved": lost,
                "net_impact": fixable - lost,
                "summary": "Аппроксимация по дифам",
            }
        verdict_src = "рассчитано по агрегатам mart_rows (verdict.json не найден)"
        verdict_is_approx = True

    ar_before = float(verdict.get("ar_before") or 0.0)
    ar_after = float(verdict.get("ar_after") or 0.0)
    delta = ar_after - ar_before
    delta_color = "#1a7f37" if delta > 0 else ("#cf222e" if delta < 0 else "#57606a")

    # ---- HTML: шаги ----
    steps_html = ""
    for s in steps:
        st = (s["status"] or "").lower()
        color = {"done": "#1a7f37", "failed": "#cf222e", "running": "#9a6700"}.get(st, "#57606a")
        steps_html += (
            "<tr>"
            f"<td>{_e(s['name'])}</td>"
            f"<td style='color:{color};font-weight:600'>{_e(s['status'])}</td>"
            f"<td>{_e(s['started_at']) or '—'}</td>"
            f"<td>{_e(s['finished_at']) or '—'}</td>"
            "<td><pre style='margin:0;max-width:380px;max-height:120px;overflow:auto;"
            f"white-space:pre-wrap;font-size:12px'>{_e(s['logs']) or '—'}</pre></td>"
            "</tr>"
        )
    if not steps_html:
        steps_html = "<tr><td colspan='5' style='text-align:center;color:#57606a'>Нет шагов</td></tr>"

    # ---- HTML: заявки ----
    apps_html = ""
    for a in apps:
        diff_cnt = a["diff_rows"] or 0
        lost_cnt = a["lost_rows"] or 0
        bg = "#fff8f8" if lost_cnt else ("#fffbf0" if diff_cnt else "#f6fff8")
        apps_html += (
            f"<tr style='background:{bg}'>"
            f"<td>{_e(a['app_id'])}</td>"
            f"<td style='text-align:right'>{a['total_rows']}</td>"
            f"<td style='text-align:right'>{diff_cnt}</td>"
            f"<td style='text-align:right'>{a['changed_rows'] or 0}</td>"
            f"<td style='text-align:right'>{a['new_rows'] or 0}</td>"
            f"<td style='text-align:right;color:{'#cf222e' if lost_cnt else '#57606a'};"
            f"font-weight:600'>{lost_cnt}</td>"
            "</tr>"
        )
    if not apps_html:
        apps_html = "<tr><td colspan='6' style='text-align:center;color:#57606a'>Нет данных</td></tr>"

    # ---- HTML: pivot ----
    facts_html = ""
    for f in facts:
        diff_color = "#cf222e" if f["diff_flag"] else "#57606a"
        facts_html += (
            "<tr>"
            f"<td>{_e(f['prefix'])}</td>"
            f"<td>{_e(f['class_name'])}</td>"
            f"<td>{_e(f['suffix'])}</td>"
            f"<td>{_e(f['array_key'])}</td>"
            f"<td>{_e(f['key'])}</td>"
            f"<td>{_e(f['source'])}</td>"
            f"<td>{_e(f['value_adjusted'])}</td>"
            f"<td style='text-align:right;color:{diff_color};font-weight:600'>"
            f"{'ДА' if f['diff_flag'] else '—'}</td>"
            f"<td style='text-align:right'>{f['cnt']}</td>"
            "</tr>"
        )
    if not facts_html:
        facts_html = "<tr><td colspan='9' style='text-align:center;color:#57606a'>Нет данных</td></tr>"

    # ---- HTML: checks ----
    checks_block = ""
    if checks is None:
        checks_block = (
            "<div class='section'><h2>Проверки</h2>"
            "<p style='color:#57606a;margin:0'>"
            "Проверки ещё не запущены (шаг <code>checks</code> в пайплайне пока не реализован)."
            "</p></div>"
        )
    elif len(checks) == 0:
        checks_block = (
            "<div class='section'><h2>Проверки</h2>"
            "<p style='color:#57606a;margin:0'>Для этого запуска проверок нет.</p></div>"
        )
    else:
        keys = list(checks[0].keys())
        if "id" in keys: keys.remove("id")
        if "run_id" in keys: keys.remove("run_id")

        header = "".join(f"<th>{_e(k)}</th>" for k in keys)
        
        # УМНАЯ ФУНКЦИЯ: Прячет 30000 строк в аккуратную подсказку
        def format_cell(k, v):
            if v is None: return ""
            if k == "app_ids":
                try:
                    lst = json.loads(v) if isinstance(v, str) and v.startswith("[") else v
                    if isinstance(lst, list):
                        # Показывает "273 заявок", а при наведении — первые 100
                        preview = ", ".join(map(str, lst[:100]))
                        return f"<span style='cursor:help; border-bottom: 1px dotted #0969da; color: #0969da' title='{_e(preview)}...'>{len(lst)} заявок</span>"
                except Exception:
                    pass
            return _e(v)

        body = "".join(
            "<tr>" + "".join(f"<td>{format_cell(k, c[k])}</td>" for k in keys) + "</tr>"
            for c in checks
        )
        checks_block = (
            "<div class='section'><h2>Проверки</h2>"
            f"<table><thead><tr>{header}</tr></thead><tbody>{body}</tbody></table></div>"
        )

    # ---- HTML: вердикт ----
    verdict_note = ""
    if verdict_src:
        note_color = "#9a6700" if verdict_is_approx else "#57606a"
        verdict_note = (
            f"<div class='sub' style='color:{note_color};margin-top:8px'>"
            f"Источник метрик: {_e(verdict_src)}</div>"
        )

    # ---- Итоговый HTML ----
    created = _e(run["created_at"]) or "—"
    status = _e(run["status"]) or "—"
    username = _e(run["username"]) or "—"
    total_apps_html = int(verdict.get("total_apps") or len(apps))
    new_app_html = int(verdict.get("new_approved") or 0)
    lost_app_html = int(verdict.get("lost_approved") or 0)
    net_html = int(verdict.get("net_impact") or 0)
    summary = _e(verdict.get("summary") or "—")

    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Отчёт по запуску #{run_id}</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
         background: #f6f8fa; margin: 0; padding: 24px; color: #24292f; }}
  .container {{ max-width: 1280px; margin: 0 auto; }}
  .header {{ background: #fff; padding: 20px 24px; border-radius: 8px;
             border: 1px solid #d0d7de; margin-bottom: 16px; }}
  .header h1 {{ margin: 0 0 8px; font-size: 24px; }}
  .meta {{ color: #57606a; font-size: 14px; }}
  .meta b {{ color: #24292f; }}
  .metrics {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
              gap: 12px; margin-bottom: 16px; }}
  .card {{ background: #fff; padding: 16px 20px; border-radius: 8px;
           border: 1px solid #d0d7de; }}
  .card .label {{ color: #57606a; font-size: 12px; text-transform: uppercase;
                  letter-spacing: 0.4px; font-weight: 600; }}
  .card .value {{ font-size: 28px; font-weight: 700; margin-top: 4px; }}
  .card.ar .value {{ font-size: 22px; }}
  .card .sub {{ font-size: 12px; color: #57606a; margin-top: 4px; }}
  .section {{ background: #fff; padding: 20px 24px; border-radius: 8px;
              border: 1px solid #d0d7de; margin-bottom: 16px; }}
  .section h2 {{ margin: 0 0 16px; font-size: 18px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  th, td {{ padding: 8px 10px; text-align: left;
            border-bottom: 1px solid #eaeef2; vertical-align: top; }}
  th {{ background: #f6f8fa; font-weight: 600; color: #24292f; }}
  tbody tr:hover td {{ background: rgba(9,105,218,0.04); }}
  .footer {{ background: #fff; padding: 16px 24px; border-radius: 8px;
             border: 1px solid #d0d7de; text-align: center; }}
  .footer a {{ display: inline-block; padding: 10px 20px; background: #0969da;
               color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600; }}
  .footer a:hover {{ background: #0757b8; }}
  code {{ background: #f6f8fa; padding: 2px 6px; border-radius: 4px; font-size: 13px; }}
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>Отчёт по запуску <code>#{run_id}</code></h1>
    <div class="meta">
      Пользователь: <b>{username}</b> &nbsp;·&nbsp;
      Статус запуска: <b>{status}</b> &nbsp;·&nbsp;
      Создан: <b>{created}</b>
    </div>
  </div>

  <div class="metrics">
    <div class="card">
      <div class="label">Всего заявок</div>
      <div class="value">{total_apps_html}</div>
    </div>
    <div class="card">
      <div class="label">Одобрено ДО</div>
      <div class="value" style="color:#57606a">{ar_before:.1f}%</div>
      <div class="sub">Approval Rate (MASTER)</div>
    </div>
    <div class="card">
      <div class="label">Одобрено ПОСЛЕ</div>
      <div class="value" style="color:{delta_color}">{ar_after:.1f}%</div>
      <div class="sub">Approval Rate (BETA)</div>
    </div>
    <div class="card ar">
      <div class="label">Net Impact</div>
      <div class="value" style="color:{delta_color}">
        {'+' if net_html >= 0 else ''}{net_html}
      </div>
      <div class="sub">+{new_app_html} новых / −{lost_app_html} потеряно</div>
    </div>
  </div>

  <div class="section">
    <h2>Бизнес-вердикт</h2>
    <div style="font-size:16px;font-weight:600">{summary}</div>
    {verdict_note}
  </div>

  <div class="section">
    <h2>Шаги пайплайна</h2>
    <table>
      <thead>
        <tr><th>Шаг</th><th>Статус</th><th>Начало</th><th>Конец</th><th>Логи</th></tr>
      </thead>
      <tbody>{steps_html}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>Реестр заявок</h2>
    <table>
      <thead>
        <tr>
          <th>APP_ID</th>
          <th style="text-align:right">Атрибутов</th>
          <th style="text-align:right">С дифами</th>
          <th style="text-align:right">VALUE_CHANGED</th>
          <th style="text-align:right">ATTRIBUTE_NEW</th>
          <th style="text-align:right">ATTRIBUTE_LOST</th>
        </tr>
      </thead>
      <tbody>{apps_html}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>Сводная таблица (pivot facts)</h2>
    <table>
      <thead>
        <tr>
          <th>PREFIX</th><th>CLASS</th><th>SUFFIX</th><th>ARRAY_KEY</th><th>KEY</th>
          <th>SOURCE</th><th>VALUE_ADJUSTED</th>
          <th style="text-align:right">DIFF</th>
          <th style="text-align:right">CNT</th>
        </tr>
      </thead>
      <tbody>{facts_html}</tbody>
    </table>
  </div>

  {checks_block}

  <div class="footer">
    <a href="http://localhost:8000/">← Вернуться в приложение</a>
  </div>

</div>
</body>
</html>"""


if __name__ == "__main__":
    import sys
    rid = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    print(generate_html_report(rid))