import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Camera,
    Circle,
    Eye,
    EyeOff,
    RefreshCw,
    ShieldAlert,
    Square,
    Video,
    VideoOff
} from 'lucide-react';

const CAPTURE_WIDTH = 640;
const FRAME_INTERVAL_MS = 1000 / 15;

const stopStream = (stream) => {
    stream?.getTracks().forEach((track) => track.stop());
};

const getCameraErrorMessage = (error) => {
    switch (error?.name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return '相機權限遭到拒絕。請在瀏覽器網址列或系統設定中允許相機後重試。';
        case 'NotFoundError':
            return '找不到可用的相機，請確認相機已連接。';
        case 'NotReadableError':
            return '相機正被其他程式使用，或作業系統不允許存取。';
        case 'OverconstrainedError':
            return '所選相機不支援目前的影像設定，請改選其他相機。';
        default:
            return error?.message || '無法啟用相機，請確認瀏覽器與系統權限。';
    }
};

const VideoFeed = ({
    cameraSocketUrl,
    onRecordStart,
    onRecordStop,
    isRecording,
    playbackUrl,
    isPlayback,
    onBackToLive,
    onPlaybackTimeUpdate
}) => {
    const liveVideoRef = useRef(null);
    const playbackVideoRef = useRef(null);
    const processedImageRef = useRef(null);
    const captureCanvasRef = useRef(null);
    const streamRef = useRef(null);
    const cameraSocketRef = useRef(null);
    const capturePendingRef = useRef(false);
    const awaitingProcessedFrameRef = useRef(false);
    const processedUrlRef = useRef(null);
    const previewEnabledRef = useRef(true);

    const [cameraStatus, setCameraStatus] = useState('idle');
    const [cameraError, setCameraError] = useState('');
    const [cameras, setCameras] = useState([]);
    const [selectedDeviceId, setSelectedDeviceId] = useState('');
    const [analysisStatus, setAnalysisStatus] = useState('offline');
    const [hasProcessedFrame, setHasProcessedFrame] = useState(false);
    const [isPreviewEnabled, setIsPreviewEnabled] = useState(true);

    const clearProcessedFrame = useCallback(() => {
        if (processedUrlRef.current) {
            URL.revokeObjectURL(processedUrlRef.current);
            processedUrlRef.current = null;
        }
        if (processedImageRef.current) {
            processedImageRef.current.removeAttribute('src');
        }
        setHasProcessedFrame(false);
    }, []);

    const handlePreviewToggle = useCallback(() => {
        const nextEnabled = !previewEnabledRef.current;
        previewEnabledRef.current = nextEnabled;
        setIsPreviewEnabled(nextEnabled);

        const socket = cameraSocketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'preview',
                enabled: nextEnabled
            }));
        }

        if (!nextEnabled) {
            clearProcessedFrame();
        }
    }, [clearProcessedFrame]);

    const releaseCamera = useCallback(() => {
        stopStream(streamRef.current);
        streamRef.current = null;
        if (liveVideoRef.current) {
            liveVideoRef.current.srcObject = null;
        }
        setCameraStatus('idle');
        setAnalysisStatus('offline');
        clearProcessedFrame();
    }, [clearProcessedFrame]);

    const refreshCameraList = useCallback(async (activeStream = streamRef.current) => {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter((device) => device.kind === 'videoinput');
        const activeDeviceId = activeStream?.getVideoTracks()[0]?.getSettings().deviceId || '';

        setCameras(videoInputs);
        setSelectedDeviceId(activeDeviceId);
    }, []);

    const startCamera = useCallback(async (deviceId = '') => {
        if (!navigator.mediaDevices?.getUserMedia) {
            setCameraStatus('error');
            setCameraError('目前環境不支援相機存取。請使用 HTTPS 或 localhost 開啟。');
            return;
        }

        setCameraStatus('requesting');
        setCameraError('');
        setAnalysisStatus('connecting');
        clearProcessedFrame();

        stopStream(streamRef.current);
        streamRef.current = null;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 15, max: 30 }
                }
            });

            streamRef.current = stream;
            if (liveVideoRef.current) {
                liveVideoRef.current.srcObject = stream;
                await liveVideoRef.current.play();
            }

            await refreshCameraList(stream);
            setCameraStatus('ready');
        } catch (error) {
            stopStream(streamRef.current);
            streamRef.current = null;
            setCameraStatus(error?.name === 'NotAllowedError' ? 'denied' : 'error');
            setCameraError(getCameraErrorMessage(error));
            setAnalysisStatus('offline');
        }
    }, [clearProcessedFrame, refreshCameraList]);

    const sendCurrentFrame = useCallback(() => {
        const socket = cameraSocketRef.current;
        const video = liveVideoRef.current;
        const canvas = captureCanvasRef.current;

        if (
            !socket ||
            socket.readyState !== WebSocket.OPEN ||
            socket.bufferedAmount > 0 ||
            !video ||
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            !video.videoWidth ||
            !canvas ||
            capturePendingRef.current ||
            awaitingProcessedFrameRef.current
        ) {
            return;
        }

        const scale = Math.min(1, CAPTURE_WIDTH / video.videoWidth);
        const width = Math.round(video.videoWidth * scale);
        const height = Math.round(video.videoHeight * scale);
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }

        const context = canvas.getContext('2d', { alpha: false });
        if (!context) return;

        context.drawImage(video, 0, 0, width, height);
        capturePendingRef.current = true;
        canvas.toBlob((blob) => {
            capturePendingRef.current = false;
            if (blob && socket.readyState === WebSocket.OPEN && socket.bufferedAmount === 0) {
                awaitingProcessedFrameRef.current = true;
                socket.send(blob);
            }
        }, 'image/jpeg', 0.78);
    }, []);

    useEffect(() => {
        if (cameraStatus !== 'ready' || isPlayback) return undefined;

        const socket = new WebSocket(cameraSocketUrl);
        socket.binaryType = 'blob';
        cameraSocketRef.current = socket;

        let captureTimer;
        socket.onopen = () => {
            awaitingProcessedFrameRef.current = false;
            setAnalysisStatus('online');

            socket.send(JSON.stringify({
                type: 'preview',
                enabled: previewEnabledRef.current
            }));

            captureTimer = window.setInterval(sendCurrentFrame, FRAME_INTERVAL_MS);
        };
        socket.onmessage = (event) => {
            awaitingProcessedFrameRef.current = false;

            // In analysis-only mode the backend sends a tiny text ACK instead
            // of a processed JPEG. This keeps frame pacing intact without
            // paying the preview rendering / JPEG-return cost.
            if (typeof event.data === 'string') {
                return;
            }

            if (!previewEnabledRef.current) return;

            const frameBlob = event.data instanceof Blob
                ? event.data
                : new Blob([event.data], { type: 'image/jpeg' });
            const nextUrl = URL.createObjectURL(frameBlob);
            const previousUrl = processedUrlRef.current;
            processedUrlRef.current = nextUrl;

            if (processedImageRef.current) {
                processedImageRef.current.src = nextUrl;
            }
            if (previousUrl) URL.revokeObjectURL(previousUrl);
            setHasProcessedFrame(true);
        };
        socket.onerror = () => {
            setAnalysisStatus('offline');
        };
        socket.onclose = () => {
            setAnalysisStatus('offline');
            setHasProcessedFrame(false);
        };

        return () => {
            if (captureTimer) window.clearInterval(captureTimer);
            capturePendingRef.current = false;
            awaitingProcessedFrameRef.current = false;
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close();
            }
            if (cameraSocketRef.current === socket) cameraSocketRef.current = null;
        };
    }, [cameraSocketUrl, cameraStatus, isPlayback, sendCurrentFrame, selectedDeviceId]);

    useEffect(() => {
        if (cameraStatus !== 'ready') return undefined;

        const handleDeviceChange = () => {
            refreshCameraList().catch(() => undefined);
        };
        navigator.mediaDevices.addEventListener?.('devicechange', handleDeviceChange);
        return () => {
            navigator.mediaDevices.removeEventListener?.('devicechange', handleDeviceChange);
        };
    }, [cameraStatus, refreshCameraList]);

    useEffect(() => {
        if (isPlayback && streamRef.current) releaseCamera();
    }, [isPlayback, releaseCamera]);

    useEffect(() => () => {
        stopStream(streamRef.current);
        if (processedUrlRef.current) URL.revokeObjectURL(processedUrlRef.current);
    }, []);

    const handleTimeUpdate = () => {
        if (playbackVideoRef.current && onPlaybackTimeUpdate) {
            onPlaybackTimeUpdate(playbackVideoRef.current.currentTime);
        }
    };

    const handleCameraChange = (event) => {
        const deviceId = event.target.value;
        setSelectedDeviceId(deviceId);
        startCamera(deviceId);
    };

    const cameraReady = cameraStatus === 'ready';
    const canRecord = cameraReady && analysisStatus === 'online';

    return (
        <div className="relative flex h-full min-h-[440px] w-full flex-col overflow-hidden rounded-2xl bg-slate-950 p-0">
            <div className="absolute left-4 top-4 z-30 flex flex-col items-start gap-2">
                {!isPlayback ? (
                    <div className={`badge flex items-center gap-2 border-white/20 text-white shadow-lg backdrop-blur-md ${cameraReady ? 'bg-emerald-600/80' : 'bg-slate-900/70'}`}>
                        <span className={`h-2 w-2 rounded-full ${cameraReady ? 'bg-emerald-300 animate-pulse' : 'bg-slate-400'}`} />
                        {cameraReady ? '相機已啟用' : '相機未啟用'}
                    </div>
                ) : (
                    <div className="badge flex items-center gap-2 border-white/20 bg-blue-500/80 text-white shadow-lg backdrop-blur-md">
                        <Video className="h-3 w-3" />
                        播放模式
                    </div>
                )}

                {cameraReady && !isPlayback && (
                    <div className={`badge flex items-center gap-2 border-white/10 text-white shadow-lg backdrop-blur-md ${analysisStatus === 'online' ? 'bg-blue-600/75' : 'bg-amber-600/80'}`}>
                        <span className={`h-2 w-2 rounded-full ${analysisStatus === 'online' ? 'bg-blue-200' : 'bg-amber-200'}`} />
                        {analysisStatus === 'online' ? '姿態分析中' : analysisStatus === 'connecting' ? '連接分析服務…' : '分析服務未連線'}
                    </div>
                )}

                {isRecording && (
                    <div className="badge flex items-center gap-2 border-white/20 bg-red-500/85 text-white shadow-lg backdrop-blur-md">
                        <Circle className="h-2 w-2 fill-current" />
                        錄影中
                    </div>
                )}
            </div>

            {!isPlayback && cameraReady && (
                <div className="absolute right-4 top-4 z-30 flex max-w-[58%] flex-col items-end gap-2">
                    <label className="flex max-w-full items-center gap-2 rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-xs font-medium text-white shadow-xl backdrop-blur-md">
                        <Camera className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="sr-only">選擇相機</span>
                        <select
                            value={selectedDeviceId}
                            onChange={handleCameraChange}
                            disabled={isRecording || cameras.length === 0}
                            aria-label="選擇相機"
                            className="min-w-0 cursor-pointer bg-transparent text-xs font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {cameras.map((camera, index) => (
                                <option key={camera.deviceId} value={camera.deviceId} className="text-slate-900">
                                    {camera.label || `相機 ${index + 1}`}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button
                        type="button"
                        onClick={handlePreviewToggle}
                        aria-pressed={isPreviewEnabled}
                        className="flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-[10px] font-semibold text-slate-200 shadow-lg backdrop-blur-md transition hover:bg-slate-800"
                    >
                        {isPreviewEnabled ? (
                            <Eye className="h-3 w-3" />
                        ) : (
                            <EyeOff className="h-3 w-3" />
                        )}
                        Preview {isPreviewEnabled ? 'ON' : 'OFF'}
                    </button>
                    <button
                        type="button"
                        onClick={releaseCamera}
                        disabled={isRecording}
                        className="flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-[10px] font-semibold text-slate-200 shadow-lg backdrop-blur-md transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <VideoOff className="h-3 w-3" />
                        停止相機
                    </button>
                </div>
            )}

            {isPlayback ? (
                <video
                    ref={playbackVideoRef}
                    src={playbackUrl}
                    controls
                    autoPlay
                    loop
                    onTimeUpdate={handleTimeUpdate}
                    className="h-full w-full object-contain"
                />
            ) : (
                <>
                    <video
                        ref={liveVideoRef}
                        autoPlay
                        muted
                        playsInline
                        className={`absolute inset-0 h-full w-full object-cover ${isPreviewEnabled ? 'visible' : 'invisible'}`}
                    />
                    <img
                        ref={processedImageRef}
                        alt="即時舞蹈姿態分析畫面"
                        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${isPreviewEnabled && hasProcessedFrame ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
                    />
                    {!isPreviewEnabled && cameraReady && (
                        <div className="absolute inset-0 flex items-center justify-center bg-slate-950">
                            <div className="text-center">
                                <EyeOff className="mx-auto mb-3 h-8 w-8 text-slate-500" />
                                <p className="text-sm font-semibold tracking-wide text-slate-300">ANALYSIS-ONLY MODE</p>
                                <p className="mt-1 text-xs text-slate-500">Camera capture, pose analysis, and metrics continue.</p>
                                <p className="mt-1 text-[11px] text-slate-600">Skeleton drawing and processed-video return are disabled.</p>
                            </div>
                        </div>
                    )}
                    <canvas ref={captureCanvasRef} className="hidden" aria-hidden="true" />
                </>
            )}

            {!isPlayback && !cameraReady && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 px-6 py-10">
                    <div className="w-full max-w-md text-center">
                        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-400/20 bg-blue-500/10 shadow-2xl shadow-blue-950">
                            {cameraStatus === 'denied' || cameraStatus === 'error' ? (
                                <ShieldAlert className="h-8 w-8 text-amber-300" />
                            ) : (
                                <Camera className="h-8 w-8 text-blue-300" />
                            )}
                        </div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-blue-300">即時動作分析</p>
                        <h2 className="mb-3 text-2xl font-bold text-white">先啟用攝影機</h2>
                        <p className="mx-auto mb-6 max-w-sm text-sm leading-6 text-slate-300">
                            點擊後瀏覽器會顯示相機權限。影像將傳送到本機分析服務，用於繪製骨架與計算動作指標。
                        </p>

                        {cameraError && (
                            <div role="alert" className="mb-5 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-left text-sm leading-5 text-amber-100">
                                {cameraError}
                            </div>
                        )}

                        <button
                            type="button"
                            onClick={() => startCamera()}
                            disabled={cameraStatus === 'requesting'}
                            className="inline-flex min-w-48 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-blue-950/50 transition hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-wait disabled:opacity-70"
                        >
                            {cameraStatus === 'requesting' ? (
                                <>
                                    <RefreshCw className="h-4 w-4 animate-spin" />
                                    等待相機權限…
                                </>
                            ) : (
                                <>
                                    <Camera className="h-4 w-4" />
                                    {cameraError ? '重新嘗試' : '啟用攝影機'}
                                </>
                            )}
                        </button>
                        <p className="mt-4 text-xs text-slate-500">若沒有相機，仍可從下方媒體庫播放既有錄影。</p>
                    </div>
                </div>
            )}

            <div className="absolute bottom-6 right-6 z-30 flex items-center gap-3">
                {isPlayback ? (
                    <button
                        type="button"
                        onClick={onBackToLive}
                        className="flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-white shadow-lg transition hover:bg-blue-500"
                    >
                        <Camera className="h-4 w-4" />
                        回到即時畫面
                    </button>
                ) : isRecording ? (
                    <button
                        type="button"
                        onClick={onRecordStop}
                        className="flex items-center gap-2 rounded-full border border-white/20 bg-slate-800 px-4 py-2 text-white shadow-lg transition hover:bg-slate-700"
                    >
                        <Square className="h-4 w-4 fill-current" />
                        停止錄影
                    </button>
                ) : cameraReady ? (
                    <button
                        type="button"
                        onClick={onRecordStart}
                        disabled={!canRecord}
                        title={canRecord ? '開始錄影' : '等待姿態分析服務連線'}
                        className="flex items-center gap-2 rounded-full bg-red-600 px-4 py-2 text-white shadow-lg transition hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                    >
                        <Video className="h-4 w-4" />
                        開始錄影
                    </button>
                ) : null}
            </div>
        </div>
    );
};

export default VideoFeed;
