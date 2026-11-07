import subprocess
import json
import os

def execute_python_script(script_path: str, input_args: dict) -> dict:
    # 1. Проверяем прямой путь или путь относительно папки backend
    if not os.path.exists(script_path):
        alt_path = os.path.join(os.path.dirname(__file__), "..", script_path)
        if os.path.exists(alt_path):
            script_path = os.path.abspath(alt_path)
        else:
            return {"success": False, "error": f"Script not found: {script_path}"}
    
    # 2. Создаем временную папку для результатов
    os.makedirs("temp", exist_ok=True)
    
    # ДОБАВЛЯЕМ ПУТЬ К ВЫХОДНОМУ ФАЙЛУ
    out_file = f"temp/out_{input_args.get('run_id', 'unknown')}.csv"
    input_args["out_file"] = out_file 
    env = os.environ.copy()
    backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    src_dir = os.path.abspath(os.path.join(backend_dir, ".."))
    
    extra_paths = [
        os.path.join(src_dir, "data"),
        os.path.join(src_dir, "analytics"),
        os.path.join(src_dir, "checks"),
        os.path.join(src_dir, "scripts"),
        backend_dir,
        src_dir,
        "/app"
    ]
    
    current_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join(extra_paths + ([current_pythonpath] if current_pythonpath else []))
    try:
        result = subprocess.run(
            ["python", script_path],
            input=json.dumps(input_args),
            text=True,
            capture_output=True,
            timeout=600 # 10 минут
        )
        
        if result.returncode != 0:
            return {"success": False, "error": result.stderr}
            
        return {"success": True, "out_file": out_file}
        
    except Exception as e:
        return {"success": False, "error": str(e)}