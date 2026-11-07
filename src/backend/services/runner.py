import subprocess
import json
import os

def execute_python_script(script_path: str, input_args: dict) -> dict:
    if not os.path.exists(script_path):
        return {"success": False, "error": f"Script not found: {script_path}"}
    
    # Создаем временную папку для результатов
    os.makedirs("temp", exist_ok=True)
    
    # ДОБАВЛЯЕМ ПУТЬ К ВЫХОДНОМУ ФАЙЛУ
    out_file = f"temp/out_{input_args.get('run_id', 'unknown')}.csv"
    input_args["out_file"] = out_file 

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