import { useState } from 'react'
import VoiceAgent from './VoiceAgent'
import Login from './Login'

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false)

  return (
    <div className="bg-slate-50 font-sans text-slate-900 min-h-screen selection:bg-blue-500/30">
      {isLoggedIn ? (
        <VoiceAgent onLogout={() => setIsLoggedIn(false)} />
      ) : (
        <Login onLogin={() => setIsLoggedIn(true)} />
      )}
    </div>
  )
}

export default App
