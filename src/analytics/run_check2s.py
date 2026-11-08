# -*- coding: utf-8 -*-
"""
run_checks.py

Слой витрины (MartAPI) + сидинг + запуск автопроверок.
Файлы checks/check_*.py НЕ меняются — они реализуют контракт из README.md.
"""
import os
import glob
import json
import sqlite3
import importlib.util
from collections import defaultdict

import pandas as pd
from sqlalchemy import (
    create_engine, Column, Integer, String, Float, Text, Index
)
from sqlalchemy.orm import declarative_base, sessionmaker

# --- НАСТРОЙКА ПУТЕЙ ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.abspath(os.path.join(BASE_DIR, "..", "backend", "hackathon.db"))
DATA_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "data", "RUN-20260827-0001", "RESULTS"))
CHECKS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "checks"))

# --- МОДЕЛИ ---
Base = declarative_base()


class MartRow(Base):
    __tablename__ = "mart_rows"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(Integer, index=True, nullable=False)
    app_id = Column(String, index=True, nullable=False)
    path = Column(String, index=True)
    array_key = Column(String, nullable=True, index=True)
    prefix = Column(String, index=True)
    class_name = Column(String, index=True)
    suffix = Column(String, nullable=True)
    key = Column(String, index=True)
    value_before = Column(Text, nullable=True)
    value_after = Column(Text, nullable=True)
    adjusted_before = Column(Text, nullable=True)
    adjusted_after = Column(Text, nullable=True)
    diff_flag = Column(Integer, default=0, index=True)
    change_type = Column(String, index=True)

    __table_args__ = (
        Index("ix_mart_run_path", "run_id", "path"),
        Index("ix_mart_run_change", "run_id", "change_type"),
        Index("ix_mart_run_app", "run_id", "app_id"),
        Index("ix_mart_run_diff", "run_id", "diff_flag"),
    )


class Segment(Base):
    __tablename__ = "segments"
    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(Integer, index=True, nullable=False)
    app_id = Column(String, index=True, nullable=False)
    decision_before = Column(String, nullable=True)
    decision_after = Column(String, nullable=True)
    decision_changed = Column(Integer, default=0, index=True)
    products = Column(Text, nullable=True)          # "prod1;prod2"
    partner_type = Column(String, nullable=True)
    # --- поля, которые ждут проверки, но которых раньше не было ---
    pd_model_before = Column(String, nullable=True)
    pd_model_after = Column(String, nullable=True)
    cutoff_before = Column(String, nullable=True)
    cutoff_after = Column(String, nullable=True)

    __table_args__ = (
        Index("ix_seg_run_app", "run_id", "app_id"),
        Index("ix_seg_run_changed", "run_id", "decision_changed"),
    )


# --- MART API (реализация контракта из README.md) ---
def _norm(v):
    """Приводим значения к строкам так, как их ждут проверки."""
    if v is None:
        return None
    if isinstance(v, float) and pd.isna(v):
        return None
    return str(v)


class MartAPI:
    """
    Реализация MartAPI поверх SQLite + pandas.
    Индексы строятся один раз в __init__ — проверки зовут mart многократно.
    """

    def __init__(self, db_path: str, run_id: int):
        self.run_id = run_id
        self.conn = sqlite3.connect(db_path)

        # Читаем только нужный прогон
        self.df_mart = pd.read_sql_query(
            "SELECT * FROM mart_rows WHERE run_id = ?",
            self.conn, params=(run_id,),
        )
        self.df_seg = pd.read_sql_query(
            "SELECT * FROM segments WHERE run_id = ?",
            self.conn, params=(run_id,),
        )

        # Нормализация типов
        if not self.df_mart.empty:
            self.df_mart["diff_flag"] = (
                pd.to_numeric(self.df_mart["diff_flag"], errors="coerce")
                .fillna(0).astype(int)
            )
            for col in ("value_before", "value_after",
                        "adjusted_before", "adjusted_after",
                        "array_key", "key", "prefix", "class_name", "suffix", "path"):
                if col in self.df_mart.columns:
                    self.df_mart[col] = self.df_mart[col].where(
                        self.df_mart[col].notna(), None
                    )

        if not self.df_seg.empty:
            self.df_seg["decision_changed"] = (
                pd.to_numeric(self.df_seg["decision_changed"], errors="coerce")
                .fillna(0).astype(int)
            )

        # Индексы для быстрых фильтров
        self._idx_by_path = {}
        self._idx_by_prefix = {}
        self._idx_by_change = {}
        self._idx_by_key = {}
        self._idx_by_array_key = {}
        self._idx_by_app = {}
        self._idx_by_diff = {}

        if not self.df_mart.empty:
            df = self.df_mart
            for path, g in df.groupby("path", dropna=False):
                self._idx_by_path[path] = g.index
            for ct, g in df.groupby("change_type", dropna=False):
                self._idx_by_change[ct] = g.index
            for k, g in df.groupby("key", dropna=False):
                self._idx_by_key[k] = g.index
            for ak, g in df.groupby("array_key", dropna=False):
                self._idx_by_array_key[ak] = g.index
            for aid, g in df.groupby("app_id", dropna=False):
                self._idx_by_app[aid] = g.index
            for fl, g in df.groupby("diff_flag", dropna=False):
                self._idx_by_diff[int(fl)] = g.index
            # prefix-индекс: по первому сегменту пути (до первой точки/скобки)
            pref = df["path"].fillna("").astype(str)
            for pfx in pref.unique():
                # не строим на каждый символ — только точные значения path,
                # а prefix-фильтр реализуем через startswith по колонке
                pass

        self._total_apps_cache = None

    # ---------- базовые методы ----------
    def total_apps(self) -> int:
        if self._total_apps_cache is None:
            if self.df_seg.empty:
                # fallback: если сегментов нет, считаем уникальные APP_ID в mart
                self._total_apps_cache = (
                    int(self.df_mart["app_id"].nunique())
                    if not self.df_mart.empty else 0
                )
            else:
                self._total_apps_cache = int(self.df_seg["app_id"].nunique())
        return self._total_apps_cache

    # ---------- фильтрация ----------
    def _apply_filters(self, df, path=None, path_prefix=None, key=None,
                       array_key=None, diff_flag=None, change_type=None,
                       value_before=None, value_after=None, app_ids=None):
        if df.empty:
            return df

        mask = pd.Series(True, index=df.index)

        if path is not None:
            paths = path if isinstance(path, (list, tuple, set)) else [path]
            mask &= df["path"].isin(list(paths))

        if path_prefix is not None:
            mask &= df["path"].fillna("").astype(str).str.startswith(path_prefix)

        if key is not None:
            keys = key if isinstance(key, (list, tuple, set)) else [key]
            mask &= df["key"].isin(list(keys))

        if array_key is not None:
            aks = array_key if isinstance(array_key, (list, tuple, set)) else [array_key]
            mask &= df["array_key"].isin(list(aks))

        if change_type is not None:
            cts = change_type if isinstance(change_type, (list, tuple, set)) else [change_type]
            mask &= df["change_type"].isin(list(cts))

        if diff_flag is not None:
            mask &= df["diff_flag"] == int(diff_flag)

        if value_before is not None:
            mask &= df["value_before"].astype(object) == value_before

        if value_after is not None:
            mask &= df["value_after"].astype(object) == value_after

        if app_ids is not None:
            mask &= df["app_id"].isin(list(app_ids))

        return df.loc[mask]

    # ---------- публичные методы контракта ----------
    def rows(self, **filters) -> list:
        df = self._apply_filters(self.df_mart, **filters)
        if df.empty:
            return []

        df = df.rename(columns={
            "app_id": "APP_ID",
            "value_before": "VALUE_BEFORE",
            "value_after": "VALUE_AFTER",
            "adjusted_before": "ADJUSTED_BEFORE",
            "adjusted_after": "ADJUSTED_AFTER",
            "path": "PATH",
            "array_key": "ARRAY_KEY",
            "key": "KEY",
            "prefix": "PREFIX",
            "class_name": "CLASS",
            "suffix": "SUFFIX",
            "change_type": "CHANGE_TYPE",
            "diff_flag": "DIFF_FLAG",
        })

        cols = ["APP_ID", "PATH", "ARRAY_KEY", "KEY", "PREFIX", "CLASS", "SUFFIX",
                "VALUE_BEFORE", "VALUE_AFTER", "ADJUSTED_BEFORE", "ADJUSTED_AFTER",
                "CHANGE_TYPE", "DIFF_FLAG"]
        cols = [c for c in cols if c in df.columns]
        return df[cols].to_dict(orient="records")

    def count(self, **filters) -> int:
        return len(self._apply_filters(self.df_mart, **filters))

    def app_ids(self, **filters) -> list:
        df = self._apply_filters(self.df_mart, **filters)
        if df.empty:
            return []
        return sorted(df["app_id"].dropna().unique().tolist())

    def segments(self) -> list:
        if self.df_seg.empty:
            return []
        df = self.df_seg.rename(columns={
            "app_id": "APP_ID",
            "decision_before": "DECISION_BEFORE",
            "decision_after": "DECISION_AFTER",
            "decision_changed": "DECISION_CHANGED",
            "products": "PRODUCTS",
            "partner_type": "PARTNER_TYPE",
            "pd_model_before": "PD_MODEL_BEFORE",
            "pd_model_after": "PD_MODEL_AFTER",
            "cutoff_before": "CUTOFF_BEFORE",
            "cutoff_after": "CUTOFF_AFTER",
        })
        # Проверки читают s.get("...") — оставим только нужные ключи
        keep = ["APP_ID", "DECISION_BEFORE", "DECISION_AFTER", "DECISION_CHANGED",
                "PRODUCTS", "PARTNER_TYPE",
                "PD_MODEL_BEFORE", "PD_MODEL_AFTER", "CUTOFF_BEFORE", "CUTOFF_AFTER"]
        keep = [c for c in keep if c in df.columns]
        return df[keep].to_dict(orient="records")

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass


# --- ВСПОМОГАТЕЛЬНОЕ: сборка сегментов из диффа ---
def _collect_products(diff: pd.DataFrame) -> str:
    """PRODUCTS: разделитель ';', только непустые значения."""
    if diff.empty:
        return ""
    mask = diff["PATH"] == "decisionResult.available_offers.product_id"
    vals = diff.loc[mask, "VALUE_AFTER"].dropna().astype(str)
    # убираем дубликаты, сохраняя порядок
    seen, out = set(), []
    for v in vals:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return ";".join(out)


def _first_value(diff: pd.DataFrame, path: str, col: str):
    if diff.empty:
        return None
    m = diff["PATH"] == path
    if not m.any():
        return None
    vals = diff.loc[m, col].dropna()
    return str(vals.iloc[0]) if len(vals) else None


def _collect_target_model(diff: pd.DataFrame):
    """PD_MODEL_BEFORE/AFTER и CUTOFF_BEFORE/AFTER из диффа.

    Пробуем несколько типовых путей; если ничего не нашли — None.
    Подставьте реальные пути вашей витрины при необходимости.
    """
    model_paths = [
        "decisionResult.pd_model",
        "decisionResult.target_model",
        "decisionResult.scoring.pd_model",
    ]
    cutoff_paths = [
        "decisionResult.cutoff",
        "decisionResult.scoring.cutoff",
        "decisionResult.threshold",
    ]

    mb = ma = cb = ca = None
    for p in model_paths:
        mb = _first_value(diff, p, "VALUE_BEFORE")
        ma = _first_value(diff, p, "VALUE_AFTER")
        if mb is not None or ma is not None:
            break
    for p in cutoff_paths:
        cb = _first_value(diff, p, "VALUE_BEFORE")
        ca = _first_value(diff, p, "VALUE_AFTER")
        if cb is not None or ca is not None:
            break
    return mb, ma, cb, ca


def _decision_values(df_norm: pd.DataFrame) -> str:
    if df_norm.empty or "KEY" not in df_norm.columns:
        return ""
    m = df_norm["KEY"] == "decision"
    if not m.any():
        return ""
    vals = df_norm.loc[m, "VALUE"].dropna()
    return str(vals.iloc[0]) if len(vals) else ""


# --- СИДИНГ БАЗЫ ---
def seed_database(force: bool = False):
    print("Инициализация базы данных...")
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    engine = create_engine(f"sqlite:///{DB_PATH}")
    Base.metadata.create_all(engine)

    Session = sessionmaker(bind=engine)
    session = Session()

    if force:
        session.query(MartRow).delete()
        session.query(Segment).delete()
        session.commit()
    elif session.query(MartRow).first():
        print("База уже содержит данные. Пропускаем (используйте force=True для пересборки).")
        session.close()
        return

    # импорт нормализаторов из проекта
    import sys
    sys.path.append(BASE_DIR)
    from normalize import normalize_file
    from compare import compare_dataframes

    before_dir = os.path.join(DATA_DIR, "BEFORE_MASTER")
    after_dir = os.path.join(DATA_DIR, "AFTER_BETA")
    before_files = sorted(glob.glob(os.path.join(before_dir, "*.json")))
    run_id = 1
    print(f"Начинаем обработку {len(before_files)} файлов...")

    BATCH = 500
    mart_batch, seg_batch = [], []
    processed = 0

    for idx, p_b in enumerate(before_files):
        fname = os.path.basename(p_b)
        app_id = os.path.splitext(fname)[0]
        p_a = os.path.join(after_dir, fname)
        if not os.path.exists(p_a):
            continue

        df_b = normalize_file(p_b, source="BEFORE")
        df_a = normalize_file(p_a, source="AFTER")
        df_b["APP_ID"] = app_id
        df_a["APP_ID"] = app_id

        diff = compare_dataframes(df_b, df_a)

        for r in diff.to_dict("records"):
            mart_batch.append(MartRow(
                run_id=run_id,
                app_id=str(r.get("APP_ID")),
                path=r.get("PATH"),
                array_key=r.get("ARRAY_KEY"),
                prefix=r.get("PREFIX"),
                class_name=r.get("CLASS"),
                suffix=r.get("SUFFIX"),
                key=r.get("KEY"),
                value_before=_norm(r.get("VALUE_BEFORE")),
                value_after=_norm(r.get("VALUE_AFTER")),
                adjusted_before=_norm(r.get("ADJUSTED_BEFORE")),
                adjusted_after=_norm(r.get("ADJUSTED_AFTER")),
                diff_flag=int(r.get("DIFF_FLAG") or 0),
                change_type=r.get("CHANGE_TYPE"),
            ))

        dec_b = _decision_values(df_b)
        dec_a = _decision_values(df_a)
        products = _collect_products(diff)
        mb, ma, cb, ca = _collect_target_model(diff)

        seg_batch.append(Segment(
            run_id=run_id,
            app_id=app_id,
            decision_before=dec_b or None,
            decision_after=dec_a or None,
            decision_changed=1 if (dec_b and dec_a and dec_b != dec_a) else 0,
            products=products or None,
            partner_type="CURRENT",
            pd_model_before=mb,
            pd_model_after=ma,
            cutoff_before=cb,
            cutoff_after=ca,
        ))

        processed += 1
        if len(mart_batch) >= 5000 or len(seg_batch) >= BATCH:
            session.bulk_save_objects(mart_batch)
            session.bulk_save_objects(seg_batch)
            session.commit()
            mart_batch, seg_batch = [], []
            print(f"Обработано: {processed} / {len(before_files)}")

    if mart_batch or seg_batch:
        session.bulk_save_objects(mart_batch)
        session.bulk_save_objects(seg_batch)
        session.commit()

    session.close()
    print(f"База данных успешно наполнена. Заявок: {processed}")


# --- ЗАПУСК ПРОВЕРОК ---
def run_all_checks(run_id: int = 1):
    mart = MartAPI(DB_PATH, run_id)
    try:
        check_files = sorted(glob.glob(os.path.join(CHECKS_DIR, "check_*.py")))
        all_results = []
        print(f"\nНайдено файлов проверок: {len(check_files)}")

        for file_path in check_files:
            module_name = os.path.basename(file_path)[:-3]
            try:
                spec = importlib.util.spec_from_file_location(module_name, file_path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            except Exception as e:
                print(f"[ERROR] {module_name}: не удалось импортировать: {e}")
                continue

            if not hasattr(module, "CHECK"):
                print(f"[SKIP] {module_name}: нет объекта CHECK")
                continue

            try:
                entrypoint = module.CHECK["entrypoint"]
                params = module.CHECK.get("params") or {}
                res = entrypoint(mart, params)
                # валидация полей контракта
                required = {"LABEL", "SOURCE", "ARGUMENT", "CNT", "TOTAL",
                            "METRIC", "APP_IDS", "RESULT", "CONFIDENCE"}
                for i, row in enumerate(res):
                    missing = required - set(row.keys())
                    if missing:
                        print(f"[WARN] {module_name}: строка {i} без полей {missing}")
                all_results.extend(res)
                print(f"[OK] {module_name}: {len(res)} строк")
            except Exception as e:
                print(f"[ERROR] {module_name}: упала: {e}")

        out_file = os.path.join(BASE_DIR, "checks_report.json")
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(all_results, f, ensure_ascii=False, indent=2)
        print(f"\nРезультат сохранен в {out_file} ({len(all_results)} строк)")
        return all_results
    finally:
        mart.close()


if __name__ == "__main__":
    import sys
    target_run = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    force = "--force" in sys.argv

    need_seed = force
    if not need_seed:
        if not os.path.exists(DB_PATH):
            need_seed = True
        else:
            conn = sqlite3.connect(DB_PATH)
            cur = conn.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='mart_rows';")
            has_table = bool(cur.fetchone())
            if has_table:
                cur.execute("SELECT COUNT(*) FROM mart_rows WHERE run_id = ?", (target_run,))
                need_seed = (cur.fetchone()[0] == 0)
            else:
                need_seed = True
            conn.close()

    if need_seed:
        seed_database(force=force)

    run_all_checks(target_run)