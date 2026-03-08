import { useState } from 'react'
import VoiceAgent from './VoiceAgent'
import Login from './Login'

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(!!localStorage.getItem('token'))

  const handleLogin = () => {
    setIsLoggedIn(true)
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    setIsLoggedIn(false)
  }

  return (
    <div className="bg-slate-50 font-sans text-slate-900 min-h-screen selection:bg-blue-500/30">
      {isLoggedIn ? (
        <VoiceAgent onLogout={handleLogout} />
      ) : (
        <Login onLogin={handleLogin} />
      )}
    </div>
  )
}

export default App
