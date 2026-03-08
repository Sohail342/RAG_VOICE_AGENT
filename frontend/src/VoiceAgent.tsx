import { useState, useRef, useEffect, useCallback } from 'react';
import { LogOut, MessageSquare, Settings, Menu, Home, Volume2, Phone } from 'lucide-react';

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
                setUploadStatus({ type: 'success', message: `${data.message} - embedded ${data.chunks_embedded} chunks.` });
                setUploadFile(null);

                // Refresh list
                const t = localStorage.getItem('token');
                fetch('/api/v1/files', { headers: { 'Authorization': `Bearer ${t}` } })
                    .then(r => r.json())
                    .then(d => { if (d.status === 'success') setUploadedFiles(d.files); });
            } else {
                const err = await res.json();
                setUploadStatus({ type: 'error', message: err.detail || "Upload failed." });
            }
        } catch (error) {
            setUploadStatus({ type: 'error', message: "Network error occurred." });
        } finally {
            setIsUploading(false);
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
            }, 800);
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
            const wsUrl = `${protocol}//${window.location.host}/api/v1/voice${token ? `?token=${token}&` : '?'}session_id=${sessionIdRef.current}&use_rag=${useRag}`;
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
        console.log("Agent finished speaking. Auto-restarting microphone for next turn.");
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

            {/* Collapsible Sidebar */}
            <aside
                className={`relative z-20 flex flex-col bg-[#f9f9fb] border-r border-slate-200/60 transition-all duration-500 ease-in-out shadow-[4px_0_24px_rgba(0,0,0,0.02)] overflow-x-hidden ${isSidebarOpen ? 'w-72' : 'w-20'}`}
            >
                {/* Sidebar Header - ElevenLabs Style Branding */}
                <div className="pt-6 px-4 pb-2 relative group">
                    <div className="flex items-center justify-between mb-6 px-1">
                        <div className="flex items-center gap-2">
                            <img src="/logo-removebg.png" alt="Logo" className="w-6 h-6 object-contain" />
                            {isSidebarOpen && (
                                <span className="font-bold text-slate-900 tracking-tight text-lg">IndusVoiceLab</span>
                            )}
                        </div>
                        {isSidebarOpen && (
                            <button
                                onClick={() => setIsSidebarOpen(false)}
                                className="p-1.5 text-slate-400 hover:text-slate-900 hover:bg-slate-200/50 rounded-md transition-all opacity-0 group-hover:opacity-100"
                            >
                                <Menu className="w-4 h-4" />
                            </button>
                        )}
                    </div>

                    {!isSidebarOpen && (
                        <button
                            onClick={() => setIsSidebarOpen(true)}
                            className="absolute -right-3 top-7 w-6 h-6 bg-white border border-slate-200 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-900 shadow-sm z-30 transition-all hover:scale-110"
                        >
                            <Menu className="w-3 h-3" />
                        </button>
                    )}

                    {/* Workspace Switcher Component */}
                    <div className={`flex items-center justify-between p-2 rounded-xl bg-white border border-slate-200 shadow-sm transition-all duration-300 ${isSidebarOpen ? 'opacity-100' : 'opacity-0 h-0 p-0 overflow-hidden'}`}>
                        <div className="flex items-center gap-2 overflow-hidden">
                            <div className="w-6 h-6 rounded-md bg-orange-100 flex items-center justify-center shrink-0">
                                <Volume2 className="w-3.5 h-3.5 text-orange-600" />
                            </div>
                            <span className="text-xs font-semibold text-slate-700 truncate">IndusVoiceLab</span>
                        </div>
                        <div className="flex flex-col gap-0.5 opacity-40">
                            <div className="w-2 hs-[1px] bg-slate-900"></div>
                            <div className="w-2 hs-[1px] bg-slate-900"></div>
                        </div>
                    </div>
                </div>

                {/* Sidebar Navigation - ElevenLabs Style Navigation */}
                <nav className="flex-1 px-3 py-4 flex flex-col gap-6 overflow-y-auto overflow-x-hidden scrollbar-hide">

                    {/* Common Section */}
                    <div className="flex flex-col gap-1">
                        <button
                            onClick={() => setViewMode('voice')}
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group relative
                            ${viewMode === 'voice' ? 'bg-white text-slate-900 shadow-sm border border-slate-200/50' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/30'}
                        `}
                        >
                            <Home className={`w-4 h-4 shrink-0 ${viewMode === 'voice' ? 'text-slate-950' : ''}`} />
                            {isSidebarOpen && <span className="font-medium text-[13px]">Home</span>}
                        </button>

                        <button className="flex items-center gap-3 px-3 py-2 text-slate-500 hover:text-slate-900 hover:bg-slate-200/30 rounded-lg transition-all group shrink-0">
                            <Volume2 className="w-4 h-4 shrink-0" />
                            {isSidebarOpen && <span className="font-medium text-[13px]">Voices</span>}
                        </button>

                        <button
                            onClick={() => setViewMode('files')}
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group relative
                            ${viewMode === 'files' ? 'bg-white text-slate-900 shadow-sm border border-slate-200/50' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/30'}
                        `}>
                            <Settings className={`w-4 h-4 shrink-0 ${viewMode === 'files' ? 'text-slate-950' : ''}`} />
                            {isSidebarOpen && <span className="font-medium text-[13px]">Files</span>}
                        </button>
                    </div>

                    {/* Playground Section */}
                    <div className="flex flex-col gap-1 pt-2">
                        {isSidebarOpen && <span className="px-3 text-[11px] font-semibold text-slate-400/80 mb-1">Playground</span>}

                        <button
                            onClick={() => { setViewMode('chat'); setUseRag(false); }}
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group relative
                            ${viewMode === 'chat' && !useRag ? 'bg-white text-slate-900 shadow-sm border border-slate-200/50' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/30'}
                        `}
                        >
                            <MessageSquare className={`w-4 h-4 shrink-0 ${viewMode === 'chat' && !useRag ? 'text-slate-950' : ''}`} />
                            {isSidebarOpen && <span className="font-medium text-[13px]">Standard Chat</span>}
                        </button>

                        <button
                            onClick={() => { setViewMode('chat'); setUseRag(true); }}
                            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group relative
                            ${viewMode === 'chat' && useRag ? 'bg-white text-slate-900 shadow-sm border border-slate-200/50' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/30'}
                        `}
                        >
                            <MessageSquare className={`w-4 h-4 shrink-0 ${viewMode === 'chat' && useRag ? 'text-slate-950' : ''}`} />
                            {isSidebarOpen && <span className="font-medium text-[13px]">RAG Chat</span>}
                        </button>
                    </div>

                    {/* Product Section */}
                    <div className="flex flex-col gap-1 pt-2">
                        {isSidebarOpen && <span className="px-3 text-[11px] font-semibold text-slate-400/80 mb-1">Products</span>}
                        <button className="flex items-center justify-between px-3 py-2 text-slate-500 hover:text-slate-900 hover:bg-slate-200/30 rounded-lg transition-all group shrink-0">
                            <div className="flex items-center gap-3">
                                <Settings className="w-4 h-4" />
                                {isSidebarOpen && <span className="font-medium text-[13px]">Studio</span>}
                            </div>
                        </button>
                        <button className="flex items-center justify-between px-3 py-2 text-slate-500 hover:text-slate-900 hover:bg-slate-200/30 rounded-lg transition-all group shrink-0">
                            <div className="flex items-center gap-3">
                                <Volume2 className="w-4 h-4" />
                                {isSidebarOpen && <span className="font-medium text-[13px]">Audiobooks</span>}
                            </div>
                            {isSidebarOpen && <span className="text-[9px] px-1.5 py-0.5 bg-slate-100 rounded text-slate-500 font-bold uppercase tracking-tighter">New</span>}
                        </button>
                    </div>
                </nav>

                {/* Sidebar Footer - Clean Logout */}
                <div className="p-3 border-t border-slate-200/60 bg-white/50">
                    <button
                        onClick={() => {
                            disconnect();
                            onLogout();
                        }}
                        className={`flex items-center gap-3 px-3 py-2 text-slate-500 hover:text-red-600 hover:bg-red-50/50 rounded-lg transition-all w-full group relative
                        ${!isSidebarOpen && 'justify-center'}
                    `}
                    >
                        <LogOut className="w-4 h-4 shrink-0 transition-transform group-hover:-translate-x-1" />
                        {isSidebarOpen && <span className="font-medium text-[13px]">Sign Out</span>}
                        {!isSidebarOpen && <span className="absolute left-16 bg-slate-900 text-white text-[10px] px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 whitespace-nowrap z-50 transition-all font-bold tracking-tight">Sign Out</span>}
                    </button>
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
                        <div className="px-6 py-5 border-b border-slate-200/40 flex items-center justify-between bg-white/40 backdrop-blur-xl sticky top-0 z-20">
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white">
                                    <MessageSquare className="w-5 h-5" />
                                </div>
                                <div>
                                    <h2 className="font-bold text-slate-800">Agent Messenger</h2>
                                    <div className="flex items-center gap-1.5">
                                        <div className="w-2 h-2 rounded-full bg-green-500"></div>
                                        <span className="text-xs text-slate-400 font-medium uppercase tracking-wider">Online</span>
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={() => setViewMode('voice')}
                                className="flex items-center gap-2 px-4 py-2 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-all font-medium text-sm"
                            >
                                <Home className="w-4 h-4" />
                                Back to Voice
                            </button>
                        </div>

                        {/* Chat Messages */}
                        <div className="flex-1 overflow-y-auto p-6 md:p-8 flex flex-col gap-6 scrollbar-hide relative z-10">
                            {chatMessages.length === 0 && (
                                <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-5 opacity-80 animate-fade-in-up">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-blue-400 blur-xl opacity-20 rounded-full"></div>
                                        <div className="w-20 h-20 rounded-[2rem] bg-gradient-to-br from-white to-slate-50 flex items-center justify-center shadow-sm border border-slate-100 relative z-10">
                                            <MessageSquare className="w-10 h-10 text-blue-500 stroke-[1.5]" />
                                        </div>
                                    </div>
                                    <div className="text-center">
                                        <h3 className="text-slate-700 font-semibold text-base mb-1">Start a Conversation</h3>
                                        <p className="text-sm font-medium text-slate-500">Ask the agent anything to begin.</p>
                                    </div>
                                </div>
                            )}
                            {chatMessages.map((msg, i) => (
                                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in-up`} style={{ animationFillMode: 'both' }}>
                                    <div className={`max-w-[85%] md:max-w-[75%] px-6 py-4 rounded-3xl text-[15px] leading-relaxed
                                        ${msg.role === 'user'
                                            ? 'bg-gradient-to-tr from-blue-600 to-blue-500 text-white shadow-md shadow-blue-500/20 rounded-br-sm'
                                            : 'bg-white text-slate-800 shadow-[0_2px_10px_rgba(0,0,0,0.02)] border border-slate-100/60 rounded-bl-sm'}
                                    `}>
                                        {msg.content}
                                    </div>
                                </div>
                            ))}
                            {isTyping && chatMessages[chatMessages.length - 1]?.role === 'assistant' && chatMessages[chatMessages.length - 1]?.content === "" && (
                                <div className="flex justify-start">
                                    <div className="bg-slate-50 px-5 py-3.5 rounded-2xl rounded-bl-none shadow-sm flex gap-1 border border-slate-100">
                                        <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce"></div>
                                        <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                                        <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                                    </div>
                                </div>
                            )}
                            <div ref={chatEndRef} />
                        </div>

                        {/* Chat Input Area */}
                        <div className="p-4 md:p-6 bg-transparent relative z-10 w-full">
                            <div className="relative max-w-4xl mx-auto flex flex-col gap-3">
                                <div className="flex-1 relative group w-full">
                                    <div className="absolute inset-0 bg-gradient-to-r from-blue-100 to-indigo-100 rounded-full blur-md opacity-0 group-focus-within:opacity-60 transition-opacity duration-500"></div>
                                    <input
                                        type="text"
                                        value={chatInput}
                                        onChange={(e) => setChatInput(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()}
                                        placeholder="Type your message..."
                                        className="w-full bg-white/95 backdrop-blur-sm border border-slate-200/80 rounded-full px-8 py-4 pr-16 text-[15px] focus:outline-none focus:border-blue-500/50 focus:ring-4 focus:ring-blue-500/10 transition-all shadow-[0_2px_15px_rgba(0,0,0,0.03)] relative z-10"
                                    />
                                    <button
                                        onClick={sendChatMessage}
                                        disabled={!chatInput.trim() || isTyping}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center bg-blue-600 text-white rounded-full hover:bg-blue-700 hover:shadow-lg hover:shadow-blue-600/30 disabled:bg-slate-100 disabled:text-slate-400 transition-all disabled:opacity-50 active:scale-95 z-20"
                                    >
                                        <svg className="w-5 h-5 fill-current ml-0.5" viewBox="0 0 24 24">
                                            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                                        </svg>
                                    </button>
                                </div>
                                <p className="text-center text-[10px] text-slate-400/80 font-semibold uppercase tracking-widest">Powered by Ollama • Built by Indus Students</p>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 w-full max-w-4xl my-auto mx-auto flex flex-col p-8 animate-fade-in">
                        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 p-10 mt-10">
                            <h2 className="text-2xl font-bold text-slate-800 mb-2">Knowledge Base</h2>
                            <p className="text-slate-500 mb-8">Upload text or PDF files to inject custom context into the agent's long-term memory via Qdrant Vector DB.</p>

                            <div className="border-2 border-dashed border-slate-300 bg-slate-50 hover:bg-slate-100 transition-colors rounded-2xl p-10 flex flex-col items-center justify-center cursor-pointer text-center relative">
                                <input
                                    type="file"
                                    accept=".txt, .md, .pdf"
                                    onChange={(e) => {
                                        if (e.target.files && e.target.files[0]) {
                                            setUploadFile(e.target.files[0]);
                                            setUploadStatus(null);
                                        }
                                    }}
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                    title="Choose a file to upload"
                                />
                                <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4 border border-blue-200">
                                    <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                    </svg>
                                </div>
                                <h3 className="text-lg font-semibold text-slate-700">Drag & drop files here</h3>
                                <p className="text-sm text-slate-400 mt-2">Supports .txt, .md, .pdf</p>
                            </div>

                            {uploadFile && (
                                <div className="mt-6 flex items-center justify-between p-4 bg-slate-50 border border-slate-200 rounded-xl">
                                    <span className="text-[15px] font-medium text-slate-700 truncate">{uploadFile.name}</span>
                                    <button
                                        onClick={handleUpload}
                                        disabled={isUploading}
                                        className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
                                    >
                                        {isUploading ? "Embedding..." : "Upload to Qdrant"}
                                    </button>
                                </div>
                            )}

                            {uploadStatus && (
                                <div className={`mt-4 p-4 rounded-xl text-[14px] font-medium ${uploadStatus.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                                    {uploadStatus.message}
                                </div>
                            )}

                            {/* Display Uploaded Files */}
                            <div className="mt-12">
                                <h3 className="text-xl font-bold text-slate-800 mb-4">Embedded Knowledge</h3>
                                {uploadedFiles.length === 0 ? (
                                    <p className="text-slate-500 text-sm">No documents embedded yet.</p>
                                ) : (
                                    <div className="flex flex-col gap-3">
                                        {uploadedFiles.map((f, idx) => (
                                            <div key={idx} className="flex items-center justify-between p-4 bg-white border border-slate-200 rounded-xl shadow-sm hover:shadow-md transition-shadow">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center text-blue-600">
                                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                                        </svg>
                                                    </div>
                                                    <div>
                                                        <h4 className="text-[15px] font-semibold text-slate-800">{f.filename}</h4>
                                                        <p className="text-xs text-slate-500">Embedded Chunks: {f.chunks}</p>
                                                    </div>
                                                </div>
                                                <div className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-[11px] font-bold tracking-wider uppercase">
                                                    {f.uploaded_by}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}
