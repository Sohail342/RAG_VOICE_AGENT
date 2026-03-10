import { useState, useRef, useEffect, useCallback } from 'react';
import { LogOut, MessageSquare, Settings, Menu, Home, Volume2, Phone, Trash2, AlertTriangle, CheckCircle2, XCircle, FileText, CloudUpload, Search, File, AlertCircle } from 'lucide-react';

interface VoiceAgentProps {
    onLogout: () => void;
}

type SessionState = "INACTIVE" | "LISTENING" | "THINKING" | "SPEAKING";

export default function VoiceAgent({ onLogout }: VoiceAgentProps) {
    const [sessionState, setSessionState] = useState<SessionState>("INACTIVE");
    const [statusText, setStatusText] = useState("Tap microphone to start session");
    const [volumeLevel, setVolumeLevel] = useState(0);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);
    const [callSeconds, setCallSeconds] = useState(0);
    const [viewMode, setViewMode] = useState<'voice' | 'chat' | 'files'>('voice');
    const [useRag, setUseRag] = useState(true);
    const [isInitialConnecting, setIsInitialConnecting] = useState(false);
    const [selectedVoice, setSelectedVoice] = useState("hfc"); // Default voice

    // Chat State
    const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant', content: string }[]>([]);
    const [chatInput, setChatInput] = useState("");
    const [isTyping, setIsTyping] = useState(false);
    const chatEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    // Files State
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [uploadedFiles, setUploadedFiles] = useState<{ filename: string, chunks: number, uploaded_by: string }[]>([]);
    const [searchQuery, setSearchQuery] = useState("");

    // Modal & Toast State
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const [fileToDelete, setFileToDelete] = useState<string | null>(null);
    const [toast, setToast] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    const showToast = (message: string, type: 'success' | 'error' = 'success') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
    };

    useEffect(() => {
        if (viewMode === 'files') {
            const token = localStorage.getItem('token');
            fetch('/api/v1/files', {
                headers: { 'Authorization': `Bearer ${token}` }
            })
                .then(res => res.json())
                .then(data => {
                    if (data.status === 'success') {
                        setUploadedFiles(data.files);
                    }
                })
                .catch(err => console.error("Failed to fetch files", err));
        }
    }, [viewMode]);

    const handleUpload = async () => {
        if (!uploadFile) return;
        setIsUploading(true);
        setUploadStatus(null);

        try {
            const formData = new FormData();
            formData.append("file", uploadFile);
            const token = localStorage.getItem('token');

            const res = await fetch("/api/v1/files/upload", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${token}`
                },
                body: formData
            });

            if (res.ok) {
                const data = await res.json();
                showToast(`Successfully embedded ${data.chunks_embedded} chunks.`, 'success');
                setUploadFile(null);
                setUploadStatus(null);

                // Refresh list
                const t = localStorage.getItem('token');
                fetch('/api/v1/files', { headers: { 'Authorization': `Bearer ${t}` } })
                    .then(r => r.json())
                    .then(d => { if (d.status === 'success') setUploadedFiles(d.files); });
            } else {
                const err = await res.json();
                showToast(err.detail || "Upload failed.", 'error');
            }
        } catch (error) {
            showToast("Network error occurred.", 'error');
        } finally {
            setIsUploading(false);
        }
    };

    const handleDeleteFile = async (filename: string) => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/v1/files/${filename}`, {
                method: "DELETE",
                headers: {
                    "Authorization": `Bearer ${token}`
                }
            });

            if (res.ok) {
                showToast(`Successfully deleted ${filename}`, 'success');
                // Refresh list
                const t = localStorage.getItem('token');
                fetch('/api/v1/files', { headers: { 'Authorization': `Bearer ${t}` } })
                    .then(r => r.json())
                    .then(d => { if (d.status === 'success') setUploadedFiles(d.files); });
            } else {
                const err = await res.json();
                showToast(err.detail || "Deletion failed.", 'error');
            }
        } catch (error) {
            showToast("Network error occurred.", 'error');
        } finally {
            setIsDeleteModalOpen(false);
            setFileToDelete(null);
        }
    };

    useEffect(() => {
        if (viewMode === 'chat') scrollToBottom();
    }, [chatMessages, viewMode]);

    const sessionStateRef = useRef<SessionState>("INACTIVE");
    useEffect(() => {
        sessionStateRef.current = sessionState;
    }, [sessionState]);

    const socketRef = useRef<WebSocket | null>(null);
    const sessionIdRef = useRef<string>(globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Math.random().toString(36).substring(2, 15));
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const audioQueueRef = useRef<AudioBuffer[]>([]);

    // VAD Refs
    const analyserRef = useRef<AnalyserNode | null>(null);
    const silenceTimeoutRef = useRef<number | null>(null);
    const pollingIntervalRef = useRef<number | null>(null);
    const noSpeechTimeoutRef = useRef<any>(null); // Allow any for NodeJs.Timeout/number compat
    const isTimeoutStopRef = useRef<boolean>(false);

    // Playback debounce ref
    const doneSpeakingTimeoutRef = useRef<number | null>(null);
    const isPlayingRef = useRef<boolean>(false);
    const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
    const isAgentGeneratingRef = useRef<boolean>(false);

    // SILENCE THRESHOLDS
    const SILENCE_THRESHOLD = 100; // Increased to ignore ambient room noise without AGC amplification
    const BARGE_IN_THRESHOLD = 180; // High threshold required to interrupt the agent.
    const SILENCE_DURATION_MS = 1500;

    useEffect(() => {
        let interval: any = null;
        if (sessionState !== "INACTIVE") {
            interval = setInterval(() => {
                setCallSeconds(prev => prev + 1);
            }, 1000);
        } else {
            setCallSeconds(0);
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [sessionState]);

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    useEffect(() => {
        return () => {
            disconnect();
        }
    }, []);

    const initAudioContext = () => {
        if (!audioContextRef.current) {
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        if (audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume();
        }
    };

    const cleanupVADIntervals = () => {
        if (pollingIntervalRef.current) clearInterval(pollingIntervalRef.current);
        if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
        if (noSpeechTimeoutRef.current) clearTimeout(noSpeechTimeoutRef.current);
        pollingIntervalRef.current = null;
        silenceTimeoutRef.current = null;
        noSpeechTimeoutRef.current = null;
    };

    const cleanupAudioTracks = () => {
        cleanupVADIntervals();
        if (doneSpeakingTimeoutRef.current) clearTimeout(doneSpeakingTimeoutRef.current);

        if (analyserRef.current) {
            analyserRef.current.disconnect();
            analyserRef.current = null;
        }
        if (mediaRecorderRef.current && mediaRecorderRef.current.stream) {
            mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
        }
        audioQueueRef.current = [];
        if (activeSourceRef.current) {
            try { activeSourceRef.current.stop(); } catch (e) { }
            activeSourceRef.current = null;
        }
        isPlayingRef.current = false;
    };

    const playNextInQueue = useCallback(() => {
        if (!audioContextRef.current) return;

        if (doneSpeakingTimeoutRef.current) {
            clearTimeout(doneSpeakingTimeoutRef.current);
            doneSpeakingTimeoutRef.current = null;
        }

        if (audioQueueRef.current.length === 0) {
            isPlayingRef.current = false;
            doneSpeakingTimeoutRef.current = setTimeout(() => {
                if (sessionStateRef.current === "SPEAKING") {
                    handleAgentFinishedSpeaking();
                }
            }, 500);
            return;
        }

        isPlayingRef.current = true;
        const currentBuffer = audioQueueRef.current.shift()!;
        const source = audioContextRef.current.createBufferSource();
        source.buffer = currentBuffer;
        source.connect(audioContextRef.current.destination);
        activeSourceRef.current = source;

        source.onended = () => {
            activeSourceRef.current = null;
            playNextInQueue();
        };

        source.start(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const sendChatMessage = async () => {
        if (!chatInput.trim() || isTyping) return;

        const userMsg = chatInput;
        setChatInput("");
        setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
        setIsTyping(true);

        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/v1/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ message: userMsg, session_id: sessionIdRef.current, use_rag: useRag }),
            });

            if (!response.body) return;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let assistantMsg = "";

            setChatMessages(prev => [...prev, { role: 'assistant', content: "" }]);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                assistantMsg += chunk;

                setChatMessages(prev => {
                    const newMsgs = [...prev];
                    newMsgs[newMsgs.length - 1].content = assistantMsg;
                    return newMsgs;
                });
            }
        } catch (err) {
            console.error("Chat error:", err);
        } finally {
            setIsTyping(false);
        }
    };

    const connectAndWaitForSocket = (): Promise<void> => {
        return new Promise((resolve, reject) => {
            if (socketRef.current?.readyState === WebSocket.OPEN) {
                resolve();
                return;
            }

            initAudioContext();
            if (sessionStateRef.current === "INACTIVE" || statusText === "Waking agent up...") {
                setStatusText("Connecting...");
            }

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const token = localStorage.getItem('token');
            const wsUrl = `${protocol}//${window.location.host}/api/v1/voice${token ? `?token=${token}&` : '?'}session_id=${sessionIdRef.current}&voice_id=${selectedVoice}`;
            const ws = new WebSocket(wsUrl);
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                console.log("WebSocket connected successfully!");
                resolve();
            };

            ws.onmessage = async (event) => {
                // If user interrupted and is now listening, discard leftover agent thoughts
                if (sessionStateRef.current === "LISTENING") {
                    console.log("Ignored stale TTS chunk due to barge-in.");
                    return;
                }

                // Immediately clear any VAD timeout if we receive anything from agent
                cleanupVADIntervals();

                if (event.data instanceof ArrayBuffer) {
                    if (isInitialConnecting) {
                        setIsInitialConnecting(false);
                    }
                    setSessionState("SPEAKING");
                    setStatusText("Agent speaks...");

                    const arrayBuffer = event.data;
                    if (!audioContextRef.current) return;

                    try {
                        const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
                        audioQueueRef.current.push(audioBuffer);

                        if (!isPlayingRef.current) {
                            playNextInQueue();
                        }
                    } catch (err) {
                        console.error("Error decoding TTS audio:", err);
                    }
                } else {
                    // Handle JSON control messages
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === "end_of_turn") {
                            console.log("Backend signaled end of turn.");
                            isAgentGeneratingRef.current = false;
                            // If audio queue is already empty, trigger finished handler
                            if (!isPlayingRef.current && audioQueueRef.current.length === 0) {
                                handleAgentFinishedSpeaking();
                            }
                        }
                    } catch (e) {
                        console.warn("Received unknown text message from backend:", event.data);
                    }
                }
            };

            ws.onclose = () => {
                setSessionState("INACTIVE");
                cleanupAudioTracks();
                setStatusText("Tap microphone to start session");
            };

            ws.onerror = (error) => {
                setSessionState("INACTIVE");
                setStatusText("Connection Error");
                reject(error);
            };

            socketRef.current = ws;
        });
    };

    const disconnect = () => {
        if (socketRef.current) {
            socketRef.current.close();
            socketRef.current = null;
        }
        cleanupAudioTracks();
        setSessionState("INACTIVE");
        setStatusText("Tap microphone to start session");
    };

    const handleAgentFinishedSpeaking = () => {
        if (isAgentGeneratingRef.current) {
            console.log("Agent finished current audio segment, but backend is still generating sentences...");
            return;
        }

        console.log("Agent finished turn. Auto-restarting microphone for next turn.");
        setTimeout(() => {
            if (sessionStateRef.current !== "INACTIVE") {
                startListeningTurn();
            }
        }, 500);
    };

    const interruptAgent = () => {
        console.log("User interrupted agent! (Barge-in detected)");
        audioQueueRef.current = [];
        if (activeSourceRef.current) {
            try {
                activeSourceRef.current.onended = null;
                activeSourceRef.current.stop();
            } catch (e) { }
            activeSourceRef.current = null;
        }
        isPlayingRef.current = false;

        if (doneSpeakingTimeoutRef.current) {
            clearTimeout(doneSpeakingTimeoutRef.current);
            doneSpeakingTimeoutRef.current = null;
        }

        // Interrupt forces immediate jump to listening mode
        startListeningTurn();
    };

    useEffect(() => {
        // Run VAD during LISTENING, and ALSO during SPEAKING to detect interruptions!
        if (sessionState !== "LISTENING" && sessionState !== "SPEAKING") {
            cleanupVADIntervals();
            setVolumeLevel(0);
            return;
        }

        let hasSpoken = false;

        const checkVolume = () => {
            if (!analyserRef.current) return;
            // Only require recording state if we are LISTENING. 
            // If SPEAKING, we only monitor volume (since we already have a live track from MediaRecorder)
            if (sessionState === "LISTENING" && mediaRecorderRef.current?.state !== "recording") return;

            const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
            analyserRef.current.getByteFrequencyData(dataArray);

            const maxVolume = Math.max(...dataArray);
            setVolumeLevel(maxVolume);

            if (sessionState === "SPEAKING") {
                // If agent is speaking, ONLY loud intentional human speech (barge-in threshold) can interrupt
                if (maxVolume > BARGE_IN_THRESHOLD) {
                    interruptAgent();
                }
                return; // Do not process standard silence tracking while agent speaks
            }

            // Standard LISTENING state volume check
            if (maxVolume > SILENCE_THRESHOLD) {
                hasSpoken = true;
                setStatusText("Listening...");
                if (silenceTimeoutRef.current) {
                    clearTimeout(silenceTimeoutRef.current);
                    silenceTimeoutRef.current = null;
                }
                if (noSpeechTimeoutRef.current) {
                    clearTimeout(noSpeechTimeoutRef.current);
                    noSpeechTimeoutRef.current = null;
                }
            } else if (hasSpoken && sessionState === "LISTENING") {
                if (!silenceTimeoutRef.current) {
                    silenceTimeoutRef.current = setTimeout(() => {
                        console.log("Silence detected. Emitting audio chunk to LLM.");
                        if (mediaRecorderRef.current?.state === "recording") {
                            mediaRecorderRef.current.stop();
                        }
                    }, SILENCE_DURATION_MS);
                }
            } else if (!hasSpoken && sessionState === "LISTENING") {
                // The user hasn't spoken yet. Ensure there is a timeout to prevent infinite listening.
                if (!noSpeechTimeoutRef.current) {
                    noSpeechTimeoutRef.current = setTimeout(() => {
                        console.log("No speech detected for 3 seconds. Progressing conversation.");
                        isTimeoutStopRef.current = true;
                        if (mediaRecorderRef.current?.state === "recording") {
                            mediaRecorderRef.current.stop();
                        }
                    }, 3000); // 3 seconds absolute cutoff if no sound detected
                }
            }
        };

        pollingIntervalRef.current = setInterval(checkVolume, 50);

        return () => cleanupVADIntervals();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionState]);

    const startListeningTurn = async () => {
        cleanupVADIntervals();

        try {
            await connectAndWaitForSocket();

            if (!mediaRecorderRef.current || !mediaRecorderRef.current.stream.active) {
                return;
            }

            const mr = mediaRecorderRef.current;
            const localChunks: Blob[] = [];

            // Override handlers to ensure fresh closure scope
            mr.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    localChunks.push(e.data);
                }
            };

            mr.onstop = () => {
                const completeBlob = new Blob(localChunks, { type: mr.mimeType });
                console.log(`User turn complete. Blob: ${completeBlob.size} bytes. Timeout: ${isTimeoutStopRef.current}`);

                if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
                    if (isTimeoutStopRef.current) {
                        // Send text flag instead of silent audio to trigger proactive response explicitly without STT
                        socketRef.current.send("TIMEOUT");
                    } else {
                        // Send actual audio
                        socketRef.current.send(completeBlob);
                    }

                    setSessionState("THINKING");
                    setStatusText("Agent thinking...");
                    isAgentGeneratingRef.current = true;
                } else {
                    setSessionState("INACTIVE");
                    setStatusText("Connection lost.");
                }
            };

            if (mr.state === "inactive") {
                isTimeoutStopRef.current = false;
                mr.start();
                setSessionState("LISTENING");
                setStatusText("Listening...");
            }

        } catch (err) {
            console.error(err);
        }
    };

    const toggleSession = async () => {
        if (sessionState === "INACTIVE") {
            try {
                setStatusText("Connecting...");

                // IMPORTANT: Request optimized STT parameters (16kHz, Echo Cancellation, Noise Suppression)
                if (!mediaRecorderRef.current || !mediaRecorderRef.current.stream.active) {
                    setStatusText("Accessing microphone...");
                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            // autoGainControl is false because it artifically amplifies silence, breaking our volume-based VAD thresholds
                            autoGainControl: false,
                            sampleRate: 16000
                        }
                    });

                    initAudioContext();

                    if (audioContextRef.current) {
                        const source = audioContextRef.current.createMediaStreamSource(stream);
                        const analyser = audioContextRef.current.createAnalyser();
                        analyser.fftSize = 256;
                        source.connect(analyser);
                        analyserRef.current = analyser;
                    }
                    mediaRecorderRef.current = new MediaRecorder(stream);
                }

                setViewMode('voice'); // Ensure we are in voice view when calling
                // Triggers WebSocket open -> `voice.py` sends `generate_greeting` LLM payload -> we get `SPEAKING`.
                setIsInitialConnecting(true);
                isAgentGeneratingRef.current = true;
                await connectAndWaitForSocket();
            } catch (err) {
                console.error("Microphone access error:", err);
                setStatusText("Microphone permission denied.");
                setSessionState("INACTIVE");
            }
        } else {
            disconnect();
        }
    };

    return (
        <div className="h-screen flex bg-[#f4f4f4] relative overflow-hidden font-sans">

            {/* Sidebar */}
            <aside
                className={`relative z-30 flex flex-col bg-[#f8f9fc] border-r border-slate-200/60 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] shadow-[4px_0_24px_rgba(0,0,0,0.02)] overflow-x-hidden ${isSidebarOpen ? 'w-72' : 'w-22'}`}
            >
                {/* Branding Header */}
                <div className="pt-8 px-5 pb-6">
                    <div className="flex items-center justify-between mb-8">
                        <div className="flex items-center gap-3 group cursor-pointer">
                            <div className="relative">
                                <div className="absolute inset-0 bg-indigo-500 blur-md opacity-20 group-hover:opacity-40 transition-opacity rounded-full"></div>
                                <div className="relative w-9 h-9 bg-white rounded-xl shadow-sm border border-slate-100 flex items-center justify-center overflow-hidden">
                                    <img src="/logo-removebg.png" alt="Logo" className="w-6 h-6 object-contain group-hover:scale-110 transition-transform duration-500" />
                                </div>
                            </div>
                            {isSidebarOpen && (
                                <div className="flex flex-col animate-fade-in">
                                    <span className="font-black text-slate-900 leading-none tracking-tighter text-lg uppercase">Indus</span>
                                    <span className="font-bold text-indigo-500/80 text-[10px] leading-none uppercase tracking-[0.2em] mt-0.5">Voice Lab</span>
                                </div>
                            )}
                        </div>
                        {isSidebarOpen && (
                            <button
                                onClick={() => setIsSidebarOpen(false)}
                                className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-900 hover:bg-slate-200/50 rounded-lg transition-all"
                            >
                                <Menu className="w-4 h-4" />
                            </button>
                        )}
                    </div>

                    {!isSidebarOpen && (
                        <div className="flex flex-col items-center">
                            <button
                                onClick={() => setIsSidebarOpen(true)}
                                className="w-10 h-10 flex items-center justify-center bg-white border border-slate-200 text-slate-400 hover:text-indigo-600 rounded-xl shadow-sm transition-all hover:scale-105 active:scale-95 mb-4"
                            >
                                <Menu className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                </div>

                {/* Navigation Scroll Area */}
                <nav className="flex-1 px-4 flex flex-col gap-8 overflow-y-auto scrollbar-hide py-2">
                    {/* Main Section */}
                    <div className="flex flex-col gap-1.5">
                        {isSidebarOpen && <span className="px-3 text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Core System</span>}

                        <button
                            onClick={() => setViewMode('voice')}
                            className={`w-full group relative flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-300 ${viewMode === 'voice'
                                ? 'bg-white text-indigo-600 shadow-sm border border-slate-200/50'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/50'
                                }`}
                        >
                            {viewMode === 'voice' && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-indigo-600 rounded-r-full animate-fade-in" />}
                            <Home className={`w-4.5 h-4.5 shrink-0 transition-transform duration-300 group-hover:scale-110 ${viewMode === 'voice' ? 'text-indigo-600' : 'text-slate-400'}`} />
                            {isSidebarOpen && <span className="font-bold text-[13px] tracking-tight">Dashboard</span>}
                        </button>

                        <div className="flex flex-col gap-1">
                            <button
                                onClick={() => setViewMode('voice')}
                                className={`w-full group relative flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-300 ${viewMode === 'voice' && selectedVoice
                                    ? 'text-indigo-600'
                                    : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/50'
                                    }`}
                            >
                                <Volume2 className={`w-4.5 h-4.5 shrink-0 ${viewMode === 'voice' ? 'text-indigo-600' : 'text-slate-400'}`} />
                                {isSidebarOpen && <span className="font-bold text-[13px] tracking-tight">Voice Profiles</span>}
                            </button>

                            {isSidebarOpen && (
                                <div className="pl-10 pr-2 flex flex-col gap-1 animate-fade-in">
                                    {[
                                        { id: 'hfc', name: 'Elite Female', type: 'Premium' },
                                        { id: 'amy', name: 'Amy Neural', type: 'Fast' },
                                        { id: 'kristin', name: 'Kristin HD', type: 'Neural' },
                                        { id: 'ljspeech', name: 'LJ Speech', type: 'Studio' }
                                    ].map(voice => (
                                        <button
                                            key={voice.id}
                                            onClick={() => setSelectedVoice(voice.id)}
                                            className={`group/item flex items-center justify-between px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${selectedVoice === voice.id
                                                ? 'bg-indigo-50 text-indigo-700'
                                                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                                                }`}
                                        >
                                            <span>{voice.name}</span>
                                            {selectedVoice === voice.id && <div className="w-1 h-1 rounded-full bg-indigo-600 shadow-sm shadow-indigo-300"></div>}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <button
                            onClick={() => setViewMode('files')}
                            className={`w-full group relative flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-300 ${viewMode === 'files'
                                ? 'bg-white text-indigo-600 shadow-sm border border-slate-200/50'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/50'
                                }`}
                        >
                            {viewMode === 'files' && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-indigo-600 rounded-r-full animate-fade-in" />}
                            <FileText className={`w-4.5 h-4.5 shrink-0 transition-transform duration-300 group-hover:scale-110 ${viewMode === 'files' ? 'text-indigo-600' : 'text-slate-400'}`} />
                            {isSidebarOpen && (
                                <div className="flex flex-1 items-center justify-between">
                                    <span className="font-bold text-[13px] tracking-tight">Knowledge Base</span>
                                    <span className="text-[9px] font-black bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-md uppercase tracking-tighter">{uploadedFiles.length}</span>
                                </div>
                            )}
                        </button>
                    </div>

                    {/* AI Lab Section */}
                    <div className="flex flex-col gap-1.5">
                        {isSidebarOpen && <span className="px-3 text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 text-indigo-500/80">AI Interaction Lab</span>}

                        <button
                            onClick={() => { setViewMode('chat'); setUseRag(false); }}
                            className={`w-full group relative flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-300 ${viewMode === 'chat' && !useRag
                                ? 'bg-white text-indigo-600 shadow-sm border border-slate-200/50'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/50'
                                }`}
                        >
                            {viewMode === 'chat' && !useRag && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-indigo-600 rounded-r-full animate-fade-in" />}
                            <MessageSquare className={`w-4.5 h-4.5 shrink-0 transition-transform duration-300 group-hover:scale-110 ${viewMode === 'chat' && !useRag ? 'text-indigo-600' : 'text-slate-400'}`} />
                            {isSidebarOpen && <span className="font-bold text-[13px] tracking-tight">Direct Neural Reasoning</span>}
                        </button>

                        <button
                            onClick={() => { setViewMode('chat'); setUseRag(true); }}
                            className={`w-full group relative flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-300 ${viewMode === 'chat' && useRag
                                ? 'bg-white text-indigo-600 shadow-sm border border-slate-200/50'
                                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/50'
                                }`}
                        >
                            {viewMode === 'chat' && useRag && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-indigo-600 rounded-r-full animate-fade-in" />}
                            <div className="relative">
                                <MessageSquare className={`w-4.5 h-4.5 shrink-0 transition-transform duration-300 group-hover:scale-110 ${viewMode === 'chat' && useRag ? 'text-indigo-600' : 'text-slate-400'}`} />
                                <div className="absolute -top-1 -right-1 w-2 h-2 bg-indigo-500 rounded-full border-2 border-white"></div>
                            </div>
                            {isSidebarOpen && (
                                <div className="flex flex-1 items-center justify-between">
                                    <span className="font-bold text-[13px] tracking-tight">RAG Context Engine</span>
                                    <div className="px-1.5 py-0.5 bg-indigo-600 text-[8px] text-white rounded-md font-black uppercase tracking-widest">Active</div>
                                </div>
                            )}
                        </button>
                    </div>
                </nav>

                {/* Sidebar Footer */}
                <div className="p-4 mt-auto">
                    {isSidebarOpen ? (
                        <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm mb-4 animate-fade-in-down">
                            <div className="flex items-center gap-3 mb-3">
                                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-500 p-[1px]">
                                    <div className="w-full h-full rounded-xl bg-white flex items-center justify-center text-[14px] font-black text-indigo-600 uppercase tracking-tighter">IU</div>
                                </div>
                                <div className="flex flex-col overflow-hidden">
                                    <span className="font-bold text-slate-900 text-[13px] truncate tracking-tight">Indus University Admin</span>
                                    <div className="flex items-center gap-1.5">
                                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-sm shadow-green-200 animate-pulse"></div>
                                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Neural Core Online</span>
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={() => { disconnect(); onLogout(); }}
                                className="w-full group flex items-center justify-center gap-2 py-2 bg-slate-50 hover:bg-red-50 text-slate-500 hover:text-red-500 rounded-xl transition-all duration-300 border border-slate-100 hover:border-red-100 font-bold text-[12px]"
                            >
                                <LogOut className="w-3.5 h-3.5 transition-transform group-hover:-translate-x-0.5" />
                                Sign Out
                            </button>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-4">
                            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-[12px] font-black text-indigo-600 border border-indigo-100 shadow-sm">IU</div>
                            <button
                                onClick={() => { disconnect(); onLogout(); }}
                                className="w-10 h-10 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                            >
                                <LogOut className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                </div>
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 relative z-10 flex flex-col items-center bg-[#f4f4f4] overflow-hidden">
                {viewMode === 'voice' ? (
                    <div className="flex-1 w-full flex flex-col items-center justify-center p-8 animate-fade-in">
                        {/* Call Timer Pill */}
                        {sessionState !== "INACTIVE" && (
                            <div className="mb-8 flex items-center gap-2 px-4 py-1.5 bg-white/80 backdrop-blur-md rounded-full shadow-sm border border-slate-200 animate-fade-in-down">
                                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                                <span className="text-slate-600 font-mono font-medium text-sm tracking-wider">
                                    {formatTime(callSeconds)}
                                </span>
                            </div>
                        )}

                        {/* 3D Orb Section */}
                        <div className="relative flex items-center justify-center w-[300px] h-[300px] mb-20 group">
                            <div
                                className={`absolute w-full h-full rounded-full transition-transform duration-700 shadow-2xl
                                    ${sessionState === "LISTENING" || sessionState === "SPEAKING" ? "scale-105" : "scale-100"}
                                    ${sessionState === "THINKING" ? "animate-pulse" : ""}
                                `}
                                style={{
                                    background: "radial-gradient(circle at 30% 30%, #a2def2 0%, #3e8cd6 25%, #2a6857 60%, #153831 100%)",
                                    boxShadow: "inset -20px -20px 40px rgba(0,0,0,0.5), inset 20px 20px 30px rgba(255,255,255,0.7), 0 30px 50px rgba(0,0,0,0.1)",
                                    filter: "contrast(1.1) brightness(1.05)"
                                }}
                            >
                                <div className="absolute inset-0 rounded-full mix-blend-overlay opacity-30 pointer-events-none"
                                    style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg viewBox=\"0 0 200 200\" xmlns=\"http://www.w3.org/2000/svg\"%3E%3Cfilter id=\"noiseFilter\"%3E%3CfeTurbulence type=\"fractalNoise\" baseFrequency=\"0.85\" numOctaves=\"3\" stitchTiles=\"stitch\"/%3E%3C/filter%3E%3Crect width=\"100%25\" height=\"100%25\" filter=\"url(%23noiseFilter)\"/%3E%3C/svg%3E')" }}>
                                </div>
                            </div>

                            {(sessionState === "LISTENING" || sessionState === "SPEAKING") && (
                                <div
                                    className="absolute rounded-full border border-blue-400/50 bg-blue-100/10 transition-all duration-75 pointer-events-none"
                                    style={{
                                        width: `${300 + (volumeLevel * 1.5)}px`,
                                        height: `${300 + (volumeLevel * 1.5)}px`,
                                        opacity: Math.max(0.1, volumeLevel / 100)
                                    }}
                                ></div>
                            )}

                            {/* Status Bubble overlay */}
                            {(sessionState !== "INACTIVE" || ["Connecting...", "Accessing microphone..."].includes(statusText)) && (
                                <div className="absolute top-[5%] right-[-30%] z-30 animate-fade-in-up md:right-[-40%]">
                                    <div className="bg-white px-6 py-4 rounded-3xl rounded-bl-sm shadow-[0_10px_40px_rgba(0,0,0,0.08)] max-w-[240px]">
                                        <p className="text-slate-700 font-medium text-[15px] leading-snug">
                                            {statusText}
                                        </p>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Control Buttons */}
                        <div className="flex items-center gap-10 mt-12">
                            <div className="flex flex-col items-center gap-3">
                                <button
                                    onClick={toggleSession}
                                    className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 shadow-xl border-2
                                        ${sessionState === "INACTIVE"
                                            ? "bg-black text-white hover:scale-105 border-black"
                                            : "bg-red-500 text-white hover:bg-red-600 animate-pulse border-red-500"
                                        }
                                    `}
                                >
                                    <Phone className="w-8 h-8" fill="currentColor" strokeWidth={1} />
                                </button>
                                <span className="text-slate-500 font-medium text-sm">
                                    {sessionState === "INACTIVE" ? "Call Agent" : "End Call"}
                                </span>
                            </div>

                            <div className="flex flex-col items-center gap-3">
                                <button
                                    onClick={() => setViewMode('chat')}
                                    className="w-20 h-20 rounded-full bg-white text-black flex items-center justify-center transition-all duration-300 shadow-lg border border-slate-100 hover:scale-105"
                                >
                                    <MessageSquare className="w-8 h-8" fill="none" strokeWidth={1.5} />
                                </button>
                                <span className="text-slate-500 font-medium text-sm">Start Chat</span>
                            </div>
                        </div>
                    </div>
                ) : viewMode === 'chat' ? (
                    <div className="flex-1 w-full max-w-5xl my-2 md:my-6 mx-2 md:mx-auto flex flex-col bg-white/80 backdrop-blur-2xl shadow-[0_8px_30px_rgb(0,0,0,0.06)] rounded-3xl animate-fade-in min-h-0 border border-white relative overflow-hidden">
                        {/* Chat Header */}
                        <div className={`px-6 py-5 border-b flex items-center justify-between backdrop-blur-xl sticky top-0 z-20 ${useRag ? 'bg-indigo-50/80 border-indigo-100/50' : 'bg-white/40 border-slate-200/40'}`}>
                            <div className="flex items-center gap-4">
                                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white ${useRag ? 'bg-indigo-600 shadow-indigo-200 shadow-md' : 'bg-blue-600'}`}>
                                    {useRag ? <Settings className="w-5 h-5" /> : <MessageSquare className="w-5 h-5" />}
                                </div>
                                <div>
                                    <h2 className={`font-bold ${useRag ? 'text-indigo-900' : 'text-slate-800'}`}>
                                        {useRag ? 'Knowledge Base Agent' : 'Standard Agent'}
                                    </h2>
                                    <div className="flex items-center gap-1.5">
                                        <div className="w-2 h-2 rounded-full bg-green-500"></div>
                                        <span className={`text-xs font-medium uppercase tracking-wider ${useRag ? 'text-indigo-400' : 'text-slate-400'}`}>Online</span>
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={() => setViewMode('voice')}
                                className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all font-medium text-sm ${useRag ? 'text-indigo-500 hover:text-indigo-700 hover:bg-indigo-100/50' : 'text-slate-500 hover:text-blue-600 hover:bg-blue-50'}`}
                            >
                                <Home className="w-4 h-4" />
                                Back to Voice
                            </button>
                        </div>

                        {/* Chat Messages */}
                        <div className="flex-1 overflow-y-auto p-6 md:p-8 flex flex-col gap-6 scrollbar-hide relative z-10">
                            {chatMessages.length === 0 && (
                                <div className={`flex flex-col items-center justify-center h-full gap-5 opacity-80 animate-fade-in-up ${useRag ? 'text-indigo-300' : 'text-slate-400'}`}>
                                    <div className="relative">
                                        <div className={`absolute inset-0 blur-xl opacity-20 rounded-full ${useRag ? 'bg-indigo-400' : 'bg-blue-400'}`}></div>
                                        <div className={`w-20 h-20 rounded-[2rem] flex items-center justify-center shadow-sm border relative z-10 ${useRag ? 'bg-gradient-to-br from-indigo-50 to-white border-indigo-100' : 'bg-gradient-to-br from-white to-slate-50 border-slate-100'}`}>
                                            {useRag ? <Settings className="w-10 h-10 text-indigo-500 stroke-[1.5]" /> : <MessageSquare className="w-10 h-10 text-blue-500 stroke-[1.5]" />}
                                        </div>
                                    </div>
                                    <div className="text-center">
                                        <h3 className={`font-semibold text-base mb-1 ${useRag ? 'text-indigo-800' : 'text-slate-700'}`}>
                                            {useRag ? 'Search the Knowledge Base' : 'Start a Conversation'}
                                        </h3>
                                        <p className={`text-sm font-medium ${useRag ? 'text-indigo-500/80' : 'text-slate-500'}`}>
                                            {useRag ? 'Ask questions about your uploaded documents.' : 'Ask the agent anything to begin.'}
                                        </p>
                                    </div>
                                </div>
                            )}
                            {chatMessages.map((msg, i) => (
                                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in-up`} style={{ animationFillMode: 'both' }}>
                                    <div className={`max-w-[85%] md:max-w-[75%] px-6 py-4 rounded-3xl text-[15px] leading-relaxed
                                        ${msg.role === 'user'
                                            ? (useRag
                                                ? 'bg-gradient-to-tr from-indigo-600 to-indigo-500 text-white shadow-md shadow-indigo-500/20 rounded-br-sm'
                                                : 'bg-gradient-to-tr from-blue-600 to-blue-500 text-white shadow-md shadow-blue-500/20 rounded-br-sm')
                                            : 'bg-white text-slate-800 shadow-[0_2px_10px_rgba(0,0,0,0.02)] border border-slate-100/60 rounded-bl-sm'}
                                    `}>
                                        {msg.content}
                                    </div>
                                </div>
                            ))}
                            {isTyping && chatMessages[chatMessages.length - 1]?.role === 'assistant' && chatMessages[chatMessages.length - 1]?.content === "" && (
                                <div className="flex justify-start">
                                    <div className={`px-5 py-3.5 rounded-2xl rounded-bl-none shadow-sm flex gap-1 border ${useRag ? 'bg-indigo-50/50 border-indigo-100' : 'bg-slate-50 border-slate-100'}`}>
                                        <div className={`w-1.5 h-1.5 rounded-full animate-bounce ${useRag ? 'bg-indigo-300' : 'bg-slate-300'}`}></div>
                                        <div className={`w-1.5 h-1.5 rounded-full animate-bounce [animation-delay:0.2s] ${useRag ? 'bg-indigo-300' : 'bg-slate-300'}`}></div>
                                        <div className={`w-1.5 h-1.5 rounded-full animate-bounce [animation-delay:0.4s] ${useRag ? 'bg-indigo-300' : 'bg-slate-300'}`}></div>
                                    </div>
                                </div>
                            )}
                            <div ref={chatEndRef} />
                        </div>

                        {/* Chat Input Area */}
                        <div className="p-4 md:p-6 bg-transparent relative z-10 w-full">
                            <div className="relative max-w-4xl mx-auto flex flex-col gap-3">
                                <div className="flex-1 relative group w-full">
                                    <div className={`absolute inset-0 rounded-full blur-md opacity-0 group-focus-within:opacity-60 transition-opacity duration-500 ${useRag ? 'bg-gradient-to-r from-indigo-100 to-purple-100' : 'bg-gradient-to-r from-blue-100 to-indigo-100'}`}></div>
                                    <input
                                        type="text"
                                        value={chatInput}
                                        onChange={(e) => setChatInput(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()}
                                        placeholder={useRag ? "Ask about your documents..." : "Type your message..."}
                                        className={`w-full bg-white/95 backdrop-blur-sm border rounded-full px-8 py-4 pr-16 text-[15px] focus:outline-none focus:ring-4 transition-all shadow-[0_2px_15px_rgba(0,0,0,0.03)] relative z-10 ${useRag ? 'border-indigo-100 focus:border-indigo-400/50 focus:ring-indigo-500/10' : 'border-slate-200/80 focus:border-blue-500/50 focus:ring-blue-500/10'}`}
                                    />
                                    <button
                                        onClick={sendChatMessage}
                                        disabled={!chatInput.trim() || isTyping}
                                        className={`absolute right-2 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center text-white rounded-full transition-all disabled:opacity-50 active:scale-95 z-20 ${useRag ? 'bg-indigo-600 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/30 disabled:bg-slate-100 disabled:text-slate-400' : 'bg-blue-600 hover:bg-blue-700 hover:shadow-lg hover:shadow-blue-600/30 disabled:bg-slate-100 disabled:text-slate-400'}`}
                                    >
                                        <svg className="w-5 h-5 fill-current ml-0.5" viewBox="0 0 24 24">
                                            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                                        </svg>
                                    </button>
                                </div>
                                <p className="text-center text-[10px] text-slate-400/80 font-semibold uppercase tracking-widest">{useRag ? "Powered by ChromaDB & Ollama" : "Powered by Ollama"}</p>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 w-full max-w-5xl mx-auto flex flex-col p-6 md:p-10 animate-fade-in overflow-y-auto scrollbar-hide">
                        {/* Header Section */}
                        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-10 mt-6">
                            <div>
                                <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-2">Knowledge Base</h2>
                                <p className="text-slate-500 text-[15px] font-medium max-w-lg">
                                    Manage your custom documentation. Upload files to give the agent long-term memory and specific domain knowledge.
                                </p>
                            </div>
                            <div className="relative group w-full md:w-72">
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
                                <input
                                    type="text"
                                    placeholder="Search documents..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="w-full bg-white border border-slate-200 rounded-2xl pl-11 pr-4 py-3 text-[14px] focus:outline-none focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500/30 transition-all shadow-sm"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
                            {/* Upload Section */}
                            <div className="lg:col-span-5 flex flex-col gap-6">
                                <div className="bg-white rounded-3xl p-8 border border-slate-100 shadow-xl shadow-slate-200/40 relative overflow-hidden group">
                                    <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-indigo-500 to-purple-500"></div>
                                    <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center gap-2">
                                        <CloudUpload className="w-5 h-5 text-indigo-500" />
                                        Upload New File
                                    </h3>

                                    <div className="border-2 border-dashed border-slate-200 bg-slate-50/50 hover:bg-white hover:border-indigo-400/50 hover:shadow-inner transition-all rounded-2xl p-8 flex flex-col items-center justify-center cursor-pointer text-center relative mb-6 min-h-[180px]">
                                        <input
                                            type="file"
                                            accept=".txt, .md, .pdf"
                                            onChange={(e) => {
                                                if (e.target.files && e.target.files[0]) {
                                                    setUploadFile(e.target.files[0]);
                                                    setUploadStatus(null);
                                                }
                                            }}
                                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                                        />
                                        <div className="w-14 h-14 bg-indigo-50 rounded-2xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
                                            <FileText className="w-7 h-7 text-indigo-500" />
                                        </div>
                                        <h4 className="text-[15px] font-bold text-slate-700">Select Document</h4>
                                        <p className="text-xs text-slate-400 mt-2 font-medium">Supports PDF, TXT, or MD files</p>
                                    </div>

                                    {uploadFile && (
                                        <div className="flex flex-col gap-4 animate-fade-in">
                                            <div className="flex items-center gap-3 p-3.5 bg-indigo-50/50 border border-indigo-100 rounded-xl">
                                                <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center shadow-sm">
                                                    <File className="w-4 h-4 text-indigo-500" />
                                                </div>
                                                <span className="text-[14px] font-semibold text-slate-700 truncate flex-1">{uploadFile.name}</span>
                                                <button onClick={() => setUploadFile(null)} className="text-slate-400 hover:text-red-500 transition-colors">
                                                    <XCircle className="w-4 h-4" />
                                                </button>
                                            </div>
                                            <button
                                                onClick={handleUpload}
                                                disabled={isUploading}
                                                className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold transition-all shadow-lg shadow-indigo-200 disabled:opacity-50 active:scale-95 flex items-center justify-center gap-2"
                                            >
                                                {isUploading ? (
                                                    <>
                                                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                                                        Processing...
                                                    </>
                                                ) : (
                                                    <>
                                                        <CheckCircle2 className="w-4 h-4" />
                                                        Confirm & Embed
                                                    </>
                                                )}
                                            </button>
                                        </div>
                                    )}

                                    {uploadStatus && !isUploading && (
                                        <div className={`mt-4 p-4 rounded-xl text-[13px] font-bold flex items-center gap-2 animate-fade-in ${uploadStatus.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                                            {uploadStatus.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                                            {uploadStatus.message}
                                        </div>
                                    )}
                                </div>

                                <div className="bg-indigo-900 border border-indigo-800 rounded-3xl p-6 text-white overflow-hidden relative">
                                    <div className="absolute top-[-20%] right-[-10%] w-40 h-40 bg-indigo-500/20 rounded-full blur-3xl"></div>
                                    <h4 className="text-[13px] font-bold text-indigo-300 uppercase letter-tracking-wider mb-2">ChromaDB Stats</h4>
                                    <div className="flex items-end gap-3">
                                        <span className="text-4xl font-extrabold tracking-tight">{uploadedFiles.length}</span>
                                        <span className="text-[14px] font-medium text-indigo-200 mb-1.5 px-2">Total Verified Documents</span>
                                    </div>
                                </div>
                            </div>

                            {/* Files List Section */}
                            <div className="lg:col-span-7">
                                <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center gap-2">
                                    <div className="w-2 h-2 rounded-full bg-green-500"></div>
                                    Embedded Knowledge
                                </h3>

                                {uploadedFiles.length === 0 ? (
                                    <div className="bg-white border-2 border-dashed border-slate-200 rounded-3xl p-16 flex flex-col items-center justify-center text-center">
                                        <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-6">
                                            <FileText className="w-10 h-10 text-slate-300" />
                                        </div>
                                        <h4 className="text-lg font-bold text-slate-800">No documents found</h4>
                                        <p className="text-slate-400 text-[14px] mt-2 max-w-xs">Upload your first document to start training the agent's context.</p>
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-3.5">
                                        {uploadedFiles
                                            .filter(f => f.filename.toLowerCase().includes(searchQuery.toLowerCase()))
                                            .map((f, idx) => (
                                                <div key={idx} className="group bg-white rounded-2xl border border-slate-100 shadow-sm hover:shadow-md hover:border-indigo-100 p-4 transition-all duration-300 flex items-center justify-between">
                                                    <div className="flex items-center gap-4 overflow-hidden">
                                                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 transition-colors ${f.filename.endsWith('.pdf') ? 'bg-red-50 text-red-500 group-hover:bg-red-100' : 'bg-blue-50 text-blue-500 group-hover:bg-blue-100'
                                                            }`}>
                                                            {f.filename.endsWith('.pdf') ? <FileText className="w-6 h-6" /> : <File className="w-6 h-6" />}
                                                        </div>
                                                        <div className="overflow-hidden">
                                                            <h4 className="text-[15px] font-bold text-slate-800 truncate pr-4">{f.filename}</h4>
                                                            <div className="flex items-center gap-3 mt-1">
                                                                <div className="flex items-center gap-1.5 bg-slate-100 px-2.5 py-1 rounded-md">
                                                                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse"></div>
                                                                    <span className="text-[11px] font-bold text-slate-600 uppercase">{f.chunks} Chunks</span>
                                                                </div>
                                                                <span className="text-[12px] text-slate-400 font-medium">By {f.uploaded_by}</span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            onClick={() => { setFileToDelete(f.filename); setIsDeleteModalOpen(true); }}
                                                            className="w-10 h-10 flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                                                            title="Remove from memory"
                                                        >
                                                            <Trash2 className="w-4.5 h-4.5" />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )
                }
            </main >

            {/* Delete Confirmation Modal */}
            {
                isDeleteModalOpen && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in">
                        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden animate-scale-in">
                            <div className="p-8 flex flex-col items-center text-center">
                                <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center text-red-500 mb-4 border border-red-100">
                                    <AlertTriangle className="w-8 h-8" />
                                </div>
                                <h3 className="text-xl font-bold text-slate-900 mb-2">Delete Knowledge?</h3>
                                <p className="text-slate-500 text-[15px] leading-relaxed mb-6">
                                    This will permanently remove <span className="font-semibold text-slate-800">"{fileToDelete}"</span> and all its embedded context from the agent's memory. This action cannot be undone.
                                </p>
                                <div className="flex flex-col sm:flex-row gap-3 w-full">
                                    <button
                                        onClick={() => { setIsDeleteModalOpen(false); setFileToDelete(null); }}
                                        className="flex-1 px-6 py-2.5 border border-slate-200 text-slate-600 font-semibold rounded-xl hover:bg-slate-50 hover:text-slate-900 transition-all text-[14px]"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={() => fileToDelete && handleDeleteFile(fileToDelete)}
                                        className="flex-1 px-6 py-2.5 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 shadow-lg shadow-red-200/50 transition-all active:scale-95 text-[14px]"
                                    >
                                        Delete Forever
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Toast Notification */}
            {
                toast && (
                    <div className={`fixed bottom-8 right-8 z-[110] flex items-center gap-3 px-6 py-4 rounded-2xl shadow-xl border animate-slide-up-fade-in ${toast.type === 'success' ? 'bg-white border-green-100 text-slate-800' : 'bg-red-50 border-red-100 text-red-800'
                        }`}>
                        {toast.type === 'success' ? (
                            <CheckCircle2 className="w-5 h-5 text-green-500" />
                        ) : (
                            <AlertCircle className="w-5 h-5 text-red-500" />
                        )}
                        <span className="text-sm font-semibold">{toast.message}</span>
                        <button onClick={() => setToast(null)} className="ml-2 text-slate-400 hover:text-slate-600">
                            <XCircle className="w-4 h-4" />
                        </button>
                    </div>
                )
            }
        </div >
    );
}
