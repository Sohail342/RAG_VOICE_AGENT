import React, { useState } from 'react';
import { Mail, ArrowRight, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';

interface LoginProps {
    onLogin: () => void;
}

export default function Login({ onLogin }: LoginProps) {
    const [isRegistering, setIsRegistering] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Form States
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);
        setSuccess(null);

        try {
            if (isRegistering) {
                // Registration Logic (JSON)
                const response = await fetch('/api/v1/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email,
                        password,
                        first_name: firstName,
                        last_name: lastName,
                    }),
                });

                if (!response.ok) {
                    const data = await response.json();
                    throw new Error(data.detail || 'Registration failed. Please try again.');
                }

                setSuccess('Account created successfully! You can now log in.');
                setIsRegistering(false);
            } else {
                // Login Logic (x-www-form-urlencoded)
                const params = new URLSearchParams();
                params.append('username', email); // FASTAPI-Users uses 'username' field for email
                params.append('password', password);

                const response = await fetch('/api/v1/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params,
                });

                if (!response.ok) {
                    throw new Error('Invalid email or password.');
                }

                const data = await response.json();
                if (data.access_token) {
                    localStorage.setItem('token', data.access_token);
                }

                // If success, trigger the app login state
                onLogin();
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen relative flex items-center justify-center p-6 overflow-hidden bg-slate-50 font-sans">

            {/* Soft Radial Glows for Light Theme */}
            <div className="absolute inset-0 z-0">
                <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] rounded-full bg-blue-100/50 blur-[150px]"></div>
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-indigo-50/50 blur-[120px]"></div>
            </div>

            <div className="max-w-6xl w-full grid lg:grid-cols-2 gap-16 items-center relative z-10">

                {/* Left Side: Branding & Features (Light Mode) */}
                <div className="hidden lg:flex flex-col text-slate-900">
                    <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-100/50 border border-blue-200 text-blue-600 text-xs font-bold uppercase tracking-widest mb-8 w-fit">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></div>
                        Intelligence Redefined
                    </div>

                    <h1 className="text-6xl font-extrabold tracking-tight leading-[1.1] mb-8 text-slate-900">
                        Neural Conversational<br />
                        <span className="text-blue-600">Intelligence</span>
                    </h1>

                    <div className="space-y-10 max-w-lg">
                        <div className="flex gap-6 group">
                            <div className="w-14 h-14 rounded-2xl bg-white shadow-md border border-slate-100 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform duration-300">
                                <ArrowRight className="w-6 h-6 text-blue-600" />
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-slate-800 mb-2">Knowledge-Driven Chat (RAG)</h3>
                                <p className="text-slate-500 text-sm leading-relaxed">Dynamic Retrieval Augmented Generation allows your agent to speak with the authority of your entire local knowledge base.</p>
                            </div>
                        </div>
                        <div className="flex gap-6 group">
                            <div className="w-14 h-14 rounded-2xl bg-white shadow-md border border-slate-100 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform duration-300">
                                <Loader2 className="w-6 h-6 text-blue-600" />
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-slate-800 mb-2">Low-Latency Voice</h3>
                                <p className="text-slate-500 text-sm leading-relaxed">Stutter-free neural pipeline ensuring near-instant response times for fluid, human-like conversations.</p>
                            </div>
                        </div>
                        <div className="flex gap-6 group">
                            <div className="w-14 h-14 rounded-2xl bg-white shadow-md border border-slate-100 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform duration-300">
                                <Mail className="w-6 h-6 text-blue-600" />
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-slate-800 mb-2">Private by Design</h3>
                                <p className="text-slate-500 text-sm leading-relaxed">Local-first processing ensures that your proprietary data and conversations never leave your infrastructure.</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Side: Auth Card (Light Mode - Premium White) */}
                <div className="w-full max-w-lg mx-auto lg:mx-0">
                    <div className="bg-white border border-slate-200/60 rounded-[40px] p-10 shadow-[0_20px_50px_rgba(0,0,0,0.04)] relative overflow-hidden">

                        {/* Card Header */}
                        <div className="mb-10 text-center lg:text-left flex flex-col items-center lg:items-start">
                            <div className="w-16 h-16 rounded-2xl bg-white shadow-lg border border-slate-100 flex items-center justify-center mb-6 overflow-hidden">
                                <img src="/logo-removebg.png" alt="Logo" className="w-12 h-12 object-contain" />
                            </div>
                            <h2 className="text-3xl font-bold text-slate-900 mb-2 tracking-tight">
                                {isRegistering ? 'Create Identity' : 'Welcome back'}
                            </h2>
                            <p className="text-slate-500 text-sm">
                                {isRegistering ? 'Join the next generation of voice intelligence.' : 'Enter your credentials to securely access your account'}
                            </p>
                        </div>

                        {/* Status Messages */}
                        {error && (
                            <div className="mb-6 flex items-center gap-3 p-4 rounded-2xl bg-red-50 border border-red-100 text-red-600 text-sm animate-shake">
                                <AlertCircle className="w-5 h-5 shrink-0" />
                                {error}
                            </div>
                        )}
                        {success && (
                            <div className="mb-6 flex items-center gap-3 p-4 rounded-2xl bg-green-50 border border-green-100 text-green-600 text-sm animate-fade-in">
                                <CheckCircle2 className="w-5 h-5 shrink-0" />
                                {success}
                            </div>
                        )}

                        <form onSubmit={handleAuth} className="space-y-6">
                            {isRegistering && (
                                <div className="grid grid-cols-2 gap-4 animate-fade-in-up">
                                    <div className="space-y-2">
                                        <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest ml-1">FIRST NAME</label>
                                        <input
                                            type="text"
                                            required
                                            value={firstName}
                                            onChange={e => setFirstName(e.target.value)}
                                            className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-5 py-3.5 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-slate-300"
                                            placeholder="John"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest ml-1">LAST NAME</label>
                                        <input
                                            type="text"
                                            required
                                            value={lastName}
                                            onChange={e => setLastName(e.target.value)}
                                            className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-5 py-3.5 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-slate-300"
                                            placeholder="Doe"
                                        />
                                    </div>
                                </div>
                            )}

                            <div className="space-y-2">
                                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest ml-1">USERNAME</label>
                                <div className="relative">
                                    <input
                                        type="email"
                                        required
                                        value={email}
                                        onChange={e => setEmail(e.target.value)}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-5 py-3.5 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-slate-300"
                                        placeholder="Enter your email"
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest ml-1">PASSWORD</label>
                                <div className="relative">
                                    <input
                                        type="password"
                                        required
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-5 py-3.5 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-slate-300"
                                        placeholder="Enter your password"
                                    />
                                </div>
                            </div>

                            <button
                                type="submit"
                                disabled={isLoading}
                                className="w-full py-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-bold rounded-2xl shadow-lg shadow-blue-600/20 transition-all flex items-center justify-center gap-3 active:scale-[0.98]"
                            >
                                {isLoading ? (
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                ) : (
                                    <>{isRegistering ? 'Create Account' : 'Sign In'}</>
                                )}
                            </button>
                        </form>

                        <div className="mt-8 pt-8 border-t border-slate-100 text-center">
                            <p className="text-slate-500 text-sm">
                                {isRegistering ? 'Already have an identity?' : "Don't have an identity yet?"}
                                <button
                                    onClick={() => {
                                        setIsRegistering(!isRegistering);
                                        setError(null);
                                        setSuccess(null);
                                    }}
                                    className="ml-2 text-blue-600 font-bold hover:text-blue-700 transition-colors uppercase text-xs tracking-widest"
                                >
                                    {isRegistering ? 'Sign In' : 'Create Identity'}
                                </button>
                            </p>
                        </div>
                    </div>

                    <p className="mt-8 text-center text-[11px] text-slate-400 font-bold uppercase tracking-[0.3em]">
                        RAG Voice Intelligence • Indus University
                    </p>
                </div>
            </div>
        </div>
    );
}
