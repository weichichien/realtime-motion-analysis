import asyncio
import cv2
import numpy as np
import time
import json
import os
import threading
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi import HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pose_engine import PoseEngine

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global states
pose_engine = None
pose_engine_lock = threading.Lock()
latest_metrics = {}
camera_stream_active = False
camera_stream_lock = threading.Lock()
recording_lock = threading.Lock()
RECORDING_FPS = 15.0
recording_state = {
    "is_recording": False,
    "writer": None,
    "filename": None,
    "metrics_buffer": []
}

# Ensure recordings directory exists
RECORDINGS_DIR = "recordings"
if not os.path.exists(RECORDINGS_DIR):
    os.makedirs(RECORDINGS_DIR)

connected_clients = []

def init_pose_engine():
    global pose_engine
    with pose_engine_lock:
        if pose_engine is None:
            model_path = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "pose_landmarker_full.task")
            )
            pose_engine = PoseEngine(model_path=model_path)
        return pose_engine


def process_pose_frame(frame, timestamp_ms, draw_landmarks=True):
    engine = init_pose_engine()
    with pose_engine_lock:
        return engine.process_frame(
            frame,
            timestamp_ms,
            draw_landmarks=draw_landmarks,
        )


def is_recording_active():
    with recording_lock:
        return recording_state["is_recording"]


def create_video_writer(filepath, width, height):
    for codec in ("avc1", "mp4v"):
        writer = cv2.VideoWriter(
            filepath,
            cv2.VideoWriter_fourcc(*codec),
            RECORDING_FPS,
            (width, height),
        )
        if writer.isOpened():
            return writer
        writer.release()
    return None


def append_recording_frame(processed_frame, metrics, timestamp_ms):
    with recording_lock:
        if not recording_state["is_recording"]:
            return

        if recording_state["writer"] is None:
            height, width = processed_frame.shape[:2]
            filepath = os.path.join(RECORDINGS_DIR, recording_state["filename"])
            recording_state["writer"] = create_video_writer(filepath, width, height)

        if recording_state["writer"] is None:
            return

        recording_state["writer"].write(processed_frame)
        metrics_with_time = metrics.copy()
        metrics_with_time["time"] = timestamp_ms
        recording_state["metrics_buffer"].append(metrics_with_time)


def finalize_recording():
    with recording_lock:
        if not recording_state["is_recording"]:
            return None

        recording_state["is_recording"] = False
        if recording_state["writer"] is not None:
            recording_state["writer"].release()
            recording_state["writer"] = None

        filename = recording_state["filename"]
        metrics_buffer = recording_state["metrics_buffer"]
        recording_state["filename"] = None
        recording_state["metrics_buffer"] = []

    if filename:
        json_filename = filename.replace(".mp4", ".json")
        json_path = os.path.join(RECORDINGS_DIR, json_filename)
        with open(json_path, 'w') as f:
            json.dump(metrics_buffer, f)

    return filename


@app.websocket("/ws/camera")
async def camera_frames(websocket: WebSocket):
    global camera_stream_active, latest_metrics

    await websocket.accept()
    stream_is_busy = False
    with camera_stream_lock:
        if camera_stream_active:
            stream_is_busy = True
        else:
            camera_stream_active = True

    if stream_is_busy:
        await websocket.close(code=1013, reason="Another camera stream is active")
        return

    preview_enabled = True

    try:
        while True:
            message = await websocket.receive()

            if message["type"] == "websocket.disconnect":
                break

            control_text = message.get("text")
            if control_text is not None:
                try:
                    control = json.loads(control_text)
                except json.JSONDecodeError:
                    continue

                if control.get("type") == "preview":
                    preview_enabled = bool(control.get("enabled", True))
                continue

            frame_bytes = message.get("bytes")
            if frame_bytes is None:
                continue

            encoded_frame = np.frombuffer(frame_bytes, dtype=np.uint8)
            frame = cv2.imdecode(encoded_frame, cv2.IMREAD_COLOR)
            if frame is None:
                await websocket.send_text(json.dumps({"type": "frame_ack"}))
                continue

            timestamp_ms = int(time.time() * 1000)
            recording_active = is_recording_active()
            draw_landmarks = preview_enabled or recording_active

            processed_frame, metrics = await asyncio.to_thread(
                process_pose_frame,
                frame,
                timestamp_ms,
                draw_landmarks,
            )
            latest_metrics = metrics
            append_recording_frame(processed_frame, metrics, timestamp_ms)

            if preview_enabled:
                encoded, buffer = cv2.imencode(
                    ".jpg",
                    processed_frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 82],
                )
                if encoded:
                    await websocket.send_bytes(buffer.tobytes())
                else:
                    await websocket.send_text(json.dumps({"type": "frame_ack"}))
            else:
                await websocket.send_text(json.dumps({"type": "frame_ack"}))
    except WebSocketDisconnect:
        pass
    finally:
        finalize_recording()
        latest_metrics = {}
        with camera_stream_lock:
            camera_stream_active = False

@app.on_event("shutdown")
def shutdown_event():
    global pose_engine, recording_state
    finalize_recording()
    if pose_engine is not None:
        pose_engine.close()

# Recording Endpoints
@app.post("/record/start")
async def start_recording():
    with camera_stream_lock:
        if not camera_stream_active:
            raise HTTPException(status_code=503, detail="Enable the browser camera first")

    with recording_lock:
        if recording_state["is_recording"]:
            return {"status": "already_recording"}

        timestamp = time.strftime("%Y%m%d-%H%M%S")
        filename = f"dance_{timestamp}.mp4"
        recording_state["writer"] = None
        recording_state["filename"] = filename
        recording_state["is_recording"] = True
        recording_state["metrics_buffer"] = []
    
    return {"status": "started", "filename": filename}

@app.post("/record/stop")
async def stop_recording():
    filename = finalize_recording()
    if filename is None:
        return {"status": "not_recording"}

    return {"status": "stopped", "filename": filename}

@app.get("/recordings")
async def list_recordings():
    files = sorted(os.listdir(RECORDINGS_DIR), reverse=True)
    return {"recordings": [f for f in files if f.endswith('.mp4')]}

@app.get("/recordings/{filename}")
async def get_recording(filename: str):
    filepath = os.path.join(RECORDINGS_DIR, filename)
    if not os.path.exists(filepath):
        return {"error": "file_not_found"}
    return FileResponse(filepath, media_type="video/mp4")

@app.get("/recordings/{filename}/metrics")
async def get_recording_metrics(filename: str):
    json_filename = filename.replace(".mp4", ".json")
    json_path = os.path.join(RECORDINGS_DIR, json_filename)
    if not os.path.exists(json_path):
        return {"error": "metrics_not_found"}
    with open(json_path, 'r') as f:
        data = json.load(f)
    return data


# Background task to broadcast metrics
async def broadcast_metrics():
    while True:
        if connected_clients and latest_metrics:
            disconnected = []
            message = json.dumps(latest_metrics)
            for client in connected_clients:
                try:
                    await client.send_text(message)
                except Exception:
                    disconnected.append(client)
            for d in disconnected:
                connected_clients.remove(d)
        await asyncio.sleep(1/30) # Map to ~30 FPS broadcast

@app.websocket("/ws/metrics")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.append(websocket)
    try:
        while True:
            # We don't really expect client to send much, just keep alive
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        if websocket in connected_clients:
            connected_clients.remove(websocket)

# Start background broadcasting task
@app.on_event("startup")
async def start_broadcaster():
    asyncio.create_task(broadcast_metrics())

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
