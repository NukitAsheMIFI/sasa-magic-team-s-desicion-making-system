# -*- coding: utf-8 -*-
"""
MartAPI — реализация контракта из checks/README.md.
run_all_checks(run_id) — прогоняет все checks/check_*.py и возвращает список строк.
Читает ту же backend/hackathon.db, что и database.py (read-only).
"""
import os
import glob
import json
import importlib.util
import sqlite3
import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# Ищем базу данных в папке backend (поднимаемся на уровень выше из analytics)
DB_PATH = os.path.abspath(os.path.join(BASE_DIR, "..", "backend", "hackathon.db"))
# Ищем проверки в папке src/checks
CHECKS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "checks"))


class MartAPI:
    """5 методов контракта: rows / count / app_ids / segments / total_apps."""

    def __init__(self, db_path: str, run_id: int):
        self.run_id = run_id
        self.conn = sqlite3.connect(db_path)
        self.df_mart = pd.read_sql_query(
            "SELECT * FROM mart_rows WHERE run_id = ?", self.conn, params=(run_id,)
        )
        self.df_seg = pd.read_sql_query(
            "SELECT * FROM segments WHERE run_id = ?", self.conn, params=(run_id,)
        )
        if not self.df_mart.empty:
            self.df_mart["diff_flag"] = (
                pd.to_numeric(self.df_mart["diff_flag"], errors="coerce")
                .fillna(0).astype(int)
            )
        if not self.df_seg.empty:
            self.df_seg["decision_changed"] = (
                pd.to_numeric(self.df_seg["decision_changed"], errors="coerce")
                .fillna(0).astype(int)
            )
        self._total_apps_cache = None

    # ---------- базовые ----------
    def total_apps(self) -> int:
        if self._total_apps_cache is None:
            if self.df_seg.empty:
                self._total_apps_cache = int(self.df_mart["app_id"].nunique()) if not self.df_mart.empty else 0
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

    # ---------- публичные ----------
    def rows(self, **filters) -> list:
        df = self._apply_filters(self.df_mart, **filters)
        if df.empty:
            return []
        df = df.rename(columns={
            "app_id": "APP_ID", "value_before": "VALUE_BEFORE",
            "value_after": "VALUE_AFTER", "adjusted_before": "ADJUSTED_BEFORE",
            "adjusted_after": "ADJUSTED_AFTER", "path": "PATH",
            "array_key": "ARRAY_KEY", "key": "KEY", "prefix": "PREFIX",
            "class_name": "CLASS", "suffix": "SUFFIX",
            "change_type": "CHANGE_TYPE", "diff_flag": "DIFF_FLAG",
        })
        cols = ["APP_ID", "PATH", "ARRAY_KEY", "KEY", "PREFIX", "CLASS",
                "SUFFIX", "VALUE_BEFORE", "VALUE_AFTER", "ADJUSTED_BEFORE",
                "ADJUSTED_AFTER", "CHANGE_TYPE", "DIFF_FLAG"]
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
        })
        keep = ["APP_ID", "DECISION_BEFORE", "DECISION_AFTER",
                "DECISION_CHANGED", "PRODUCTS", "PARTNER_TYPE"]
        keep = [c for c in keep if c in df.columns]
        return df[keep].to_dict(orient="records")

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass


def run_all_checks(run_id: int) -> list:
    """Прогнать все checks/check_*.py и вернуть объединённый список строк."""
    mart = MartAPI(DB_PATH, run_id)
    results = []
    try:
        files = sorted(glob.glob(os.path.join(CHECKS_DIR, "check_*.py")))
        print(f"[checks] найдено {len(files)} файлов")
        for fp in files:
            name = os.path.basename(fp)[:-3]
            try:
                spec = importlib.util.spec_from_file_location(name, fp)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
            except Exception as e:
                print(f"[checks][ERROR] {name}: import failed: {e}")
                continue
            if not hasattr(mod, "CHECK"):
                print(f"[checks][SKIP] {name}: no CHECK")
                continue
            try:
                res = mod.CHECK["entrypoint"](mart, mod.CHECK.get("params") or {})
                results.extend(res)
                print(f"[checks][OK] {name}: {len(res)} rows")
            except Exception as e:
                print(f"[checks][ERROR] {name}: run failed: {e}")
    finally:
        mart.close()
    return results