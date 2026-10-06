import os
import subprocess
import time
import sys
import urllib.request
import webbrowser


FRONTEND_DIR = "frontend"
FRONTEND_DIST_DIR = os.path.join(FRONTEND_DIR, "dist")
FRONTEND_BUILD_OUTPUT = os.path.join(FRONTEND_DIST_DIR, "index.html")
FRONTEND_NODE_MODULES = os.path.join(FRONTEND_DIR, "node_modules")
FRONTEND_INSTALL_STAMP = os.path.join(FRONTEND_NODE_MODULES, ".package-lock.json")

FRONTEND_BUILD_INPUTS = [
    os.path.join(FRONTEND_DIR, "src"),
    os.path.join(FRONTEND_DIR, "public"),
    os.path.join(FRONTEND_DIR, "index.html"),
    os.path.join(FRONTEND_DIR, "package.json"),
    os.path.join(FRONTEND_DIR, "package-lock.json"),
    os.path.join(FRONTEND_DIR, "vite.config.js"),
    os.path.join(FRONTEND_DIR, "tailwind.config.js"),
    os.path.join(FRONTEND_DIR, "postcss.config.js"),
]


def check_requirements():
    print("Checking backend dependencies...")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"]
    )


def ensure_model():
    model_path = "pose_landmarker_full.task"
    if not os.path.exists(model_path):
        print(f"Downloading {model_path} (approx. 10MB)...")
        url = (
            "https://storage.googleapis.com/mediapipe-models/"
            "pose_landmarker/pose_landmarker_full/float16/latest/"
            "pose_landmarker_full.task"
        )
        urllib.request.urlretrieve(url, model_path)
        print("Download complete.")


def start_backend():
    print("Starting FastAPI backend on http://127.0.0.1:8000 ...")
    env = os.environ.copy()
    backend_process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8000",
        ],
        cwd="backend",
        env=env,
    )
    return backend_process


def newest_mtime(path):
    if not os.path.exists(path):
        return 0.0

    if os.path.isfile(path):
        return os.path.getmtime(path)

    newest = os.path.getmtime(path)
    for root, _, files in os.walk(path):
        for filename in files:
            file_path = os.path.join(root, filename)
            try:
                newest = max(newest, os.path.getmtime(file_path))
            except OSError:
                continue
    return newest


def frontend_needs_build():
    if not os.path.exists(FRONTEND_BUILD_OUTPUT):
        return True

    build_time = os.path.getmtime(FRONTEND_BUILD_OUTPUT)
    newest_source_time = max(newest_mtime(path) for path in FRONTEND_BUILD_INPUTS)
    return newest_source_time > build_time


def frontend_dependencies_need_install():
    if not os.path.isdir(FRONTEND_NODE_MODULES):
        return True

    if not os.path.exists(FRONTEND_INSTALL_STAMP):
        return True

    install_time = os.path.getmtime(FRONTEND_INSTALL_STAMP)
    package_time = max(
        newest_mtime(os.path.join(FRONTEND_DIR, "package.json")),
        newest_mtime(os.path.join(FRONTEND_DIR, "package-lock.json")),
    )
    return package_time > install_time


def build_frontend_if_needed():
    if not frontend_needs_build():
        print("Frontend build is up to date.")
        return

    if frontend_dependencies_need_install():
        print("Installing frontend dependencies from package-lock.json ...")
        subprocess.check_call("npm ci", cwd=FRONTEND_DIR, shell=True)

    print("Frontend source changed; rebuilding frontend ...")
    subprocess.check_call("npm run build", cwd=FRONTEND_DIR, shell=True)


def serve_frontend_static():
    print("Preparing frontend...")
    build_frontend_if_needed()

    print("Serving static frontend files on http://127.0.0.1:5173 ...")
    frontend_process = subprocess.Popen(
        [sys.executable, "-m", "http.server", "5173"],
        cwd=FRONTEND_DIST_DIR,
    )
    return frontend_process


def wait_for_server(url, timeout=15):
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            with urllib.request.urlopen(url) as response:
                if response.getcode() == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def main():
    print("=== Realtime Dance Aesthetics Launcher ===")

    # 1. Environment Preparation
    check_requirements()
    ensure_model()

    # 2. Start Services
    backend = start_backend()
    frontend = serve_frontend_static()

    print("Waiting for servers to initialize...")
    if not wait_for_server("http://127.0.0.1:5173"):
        print("Error: Frontend server failed to start.")
        backend.terminate()
        frontend.terminate()
        sys.exit(1)

    # 3. Open in the system browser so camera permission is handled by the browser.
    try:
        app_url = "http://127.0.0.1:5173"
        print(f"Opening {app_url} in your default browser...")
        webbrowser.open(app_url)
        print("Press Ctrl+C here to stop the application.")
        while backend.poll() is None and frontend.poll() is None:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Stopping application...")
    finally:
        print("Shutting down servers...")
        backend.terminate()
        frontend.terminate()
        print("Goodbye!")


if __name__ == "__main__":
    main()
