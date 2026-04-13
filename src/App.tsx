/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  doc, 
  setDoc, 
  onSnapshot, 
  collection, 
  query, 
  where, 
  addDoc, 
  deleteDoc, 
  serverTimestamp,
  User 
} from './lib/firebase';
import { 
  Monitor, 
  Camera, 
  Mic, 
  Smartphone, 
  LayoutDashboard, 
  LogOut, 
  Shield, 
  Activity,
  Settings,
  AlertCircle,
  CheckCircle2,
  Play,
  Square
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';

// --- Types ---
type Role = 'dashboard' | 'agent' | null;

interface Device {
  id: string;
  name: string;
  role: Role;
  status: 'online' | 'offline';
  ownerEmail: string;
}

interface Signal {
  id: string;
  from: string;
  to: string;
  type: 'offer' | 'answer' | 'candidate';
  data: string;
}

// --- Components ---

const Button = ({ 
  children, 
  onClick, 
  className, 
  variant = 'primary',
  disabled = false 
}: { 
  children: React.ReactNode; 
  onClick?: () => void; 
  className?: string;
  variant?: 'primary' | 'secondary' | 'outline' | 'danger';
  disabled?: boolean;
}) => {
  const variants = {
    primary: 'bg-orange-600 hover:bg-orange-700 text-white shadow-lg shadow-orange-900/20',
    secondary: 'bg-yellow-600 hover:bg-yellow-700 text-white shadow-lg shadow-yellow-900/20',
    outline: 'border-2 border-orange-600 text-orange-600 hover:bg-orange-50',
    danger: 'bg-red-600 hover:bg-red-700 text-white',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'px-6 py-3 rounded-xl font-semibold transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2',
        variants[variant],
        className
      )}
    >
      {children}
    </button>
  );
};

const Card = ({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) => (
  <div 
    onClick={onClick}
    className={cn('bg-white/80 backdrop-blur-md border border-orange-100 rounded-3xl p-6 shadow-xl', className)}
  >
    {children}
  </div>
);

// --- Main App ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [activePeer, setActivePeer] = useState<string | null>(null);
  
  const peerConnection = useRef<RTCPeerConnection | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) return;

    // Listen for devices owned by this user
    const q = query(collection(db, 'devices'), where('ownerEmail', '==', user.email));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const devList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Device));
      setDevices(devList);
      
      // Check if this device already has a role
      const currentDevice = devList.find(d => d.id === user.uid);
      if (currentDevice) {
        setRole(currentDevice.role);
      }
    });

    return unsubscribe;
  }, [user]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  const selectRole = async (selectedRole: Role) => {
    if (!user) return;
    const deviceRef = doc(db, 'devices', user.uid);
    await setDoc(deviceRef, {
      id: user.uid,
      name: user.displayName || 'Unnamed Device',
      role: selectedRole,
      status: 'online',
      ownerEmail: user.email,
      lastSeen: serverTimestamp()
    });
    setRole(selectedRole);
  };

  const logout = () => {
    if (user) {
      const deviceRef = doc(db, 'devices', user.uid);
      setDoc(deviceRef, { status: 'offline' }, { merge: true });
    }
    auth.signOut();
    setRole(null);
  };

  // --- WebRTC Logic ---

  const initPeerConnection = (targetId: string) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && user) {
        addDoc(collection(db, `devices/${targetId}/signals`), {
          from: user.uid,
          to: targetId,
          type: 'candidate',
          data: JSON.stringify(event.candidate),
          timestamp: serverTimestamp()
        });
      }
    };

    pc.ontrack = (event) => {
      setRemoteStream(event.streams[0]);
    };

    peerConnection.current = pc;
    return pc;
  };

  const startCall = async (targetId: string) => {
    const pc = initPeerConnection(targetId);
    setActivePeer(targetId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (user) {
      await addDoc(collection(db, `devices/${targetId}/signals`), {
        from: user.uid,
        to: targetId,
        type: 'offer',
        data: JSON.stringify(offer),
        timestamp: serverTimestamp()
      });
    }
  };

  useEffect(() => {
    if (!user || !role) return;

    // Listen for incoming signals
    const q = query(collection(db, `devices/${user.uid}/signals`));
    const unsubscribe = onSnapshot(q, async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added') {
          const signal = change.doc.data() as Signal;
          if (signal.to !== user.uid) continue;

          if (signal.type === 'offer') {
            const pc = initPeerConnection(signal.from);
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(signal.data)));
            
            // Agent automatically shares camera/mic/screen on offer
            if (role === 'agent') {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                setLocalStream(stream);
                stream.getTracks().forEach(track => pc.addTrack(track, stream));
              } catch (e) {
                console.error("Camera access denied", e);
              }
            }

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            await addDoc(collection(db, `devices/${signal.from}/signals`), {
              from: user.uid,
              to: signal.from,
              type: 'answer',
              data: JSON.stringify(answer),
              timestamp: serverTimestamp()
            });
          } else if (signal.type === 'answer' && peerConnection.current) {
            await peerConnection.current.setRemoteDescription(new RTCSessionDescription(JSON.parse(signal.data)));
          } else if (signal.type === 'candidate' && peerConnection.current) {
            await peerConnection.current.addIceCandidate(new RTCIceCandidate(JSON.parse(signal.data)));
          }

          // Clean up signal
          await deleteDoc(change.doc.ref);
        }
      }
    });

    return unsubscribe;
  }, [user, role]);

  if (loading) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center">
        <motion.div 
          animate={{ rotate: 360 }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        >
          <Activity className="w-12 h-12 text-orange-600" />
        </motion.div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-500 via-yellow-500 to-yellow-600 flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center space-y-8">
          <div className="flex justify-center">
            <div className="w-20 h-20 bg-white rounded-2xl flex items-center justify-center shadow-lg">
              <Shield className="w-12 h-12 text-orange-600" />
            </div>
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-black text-gray-900 tracking-tight">AIRFISA</h1>
            <p className="text-gray-600">Secure Remote Monitoring & Control</p>
          </div>
          <Button onClick={handleLogin} className="w-full">
            Sign in with Google
          </Button>
          <p className="text-xs text-gray-400">
            By signing in, you agree to our terms of service and privacy policy.
          </p>
        </Card>
      </div>
    );
  }

  if (!role) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full space-y-8">
          <div className="text-center space-y-2">
            <h2 className="text-3xl font-bold text-gray-900">Configure Device</h2>
            <p className="text-gray-600">Choose how you want to use this device</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <motion.div whileHover={{ y: -5 }} onClick={() => selectRole('dashboard')}>
              <Card className="cursor-pointer hover:border-orange-500 transition-colors h-full flex flex-col items-center text-center space-y-4">
                <div className="w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center">
                  <LayoutDashboard className="w-8 h-8 text-orange-600" />
                </div>
                <h3 className="text-xl font-bold">Dashboard</h3>
                <p className="text-sm text-gray-500">
                  Control and monitor other devices. View camera feeds, listen to audio, and manage agents.
                </p>
              </Card>
            </motion.div>
            <motion.div whileHover={{ y: -5 }} onClick={() => selectRole('agent')}>
              <Card className="cursor-pointer hover:border-yellow-500 transition-colors h-full flex flex-col items-center text-center space-y-4">
                <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center">
                  <Smartphone className="w-8 h-8 text-yellow-600" />
                </div>
                <h3 className="text-xl font-bold">Agent Device</h3>
                <p className="text-sm text-gray-500">
                  This device will act as a sensor. It will stream its camera, mic, and screen when requested.
                </p>
              </Card>
            </motion.div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-orange-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-orange-100 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Shield className="w-8 h-8 text-orange-600" />
          <span className="text-xl font-black tracking-tighter">AIRFISA</span>
          <span className={cn(
            "px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest",
            role === 'dashboard' ? "bg-orange-100 text-orange-700" : "bg-yellow-100 text-yellow-700"
          )}>
            {role}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:block text-right">
            <p className="text-sm font-bold">{user.displayName}</p>
            <p className="text-[10px] text-gray-400">{user.email}</p>
          </div>
          <button onClick={logout} className="p-2 hover:bg-red-50 text-red-600 rounded-lg transition-colors">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {role === 'dashboard' ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Sidebar: Device List */}
            <div className="lg:col-span-1 space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  <Smartphone className="w-5 h-5 text-orange-600" />
                  Agents
                </h2>
                <span className="text-xs text-gray-400">{devices.filter(d => d.role === 'agent').length} total</span>
              </div>
              <div className="space-y-3">
                {devices.filter(d => d.role === 'agent').map((device) => (
                  <motion.div key={device.id} layout>
                    <Card className={cn(
                      "p-4 cursor-pointer transition-all",
                      activePeer === device.id ? "border-orange-500 ring-2 ring-orange-200" : "hover:border-orange-300"
                    )} onClick={() => startCall(device.id)}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            "w-2 h-2 rounded-full",
                            device.status === 'online' ? "bg-green-500 animate-pulse" : "bg-gray-300"
                          )} />
                          <div>
                            <p className="font-bold text-sm">{device.name}</p>
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">{device.id.slice(0, 8)}</p>
                          </div>
                        </div>
                        <Play className="w-4 h-4 text-orange-600" />
                      </div>
                    </Card>
                  </motion.div>
                ))}
                {devices.filter(d => d.role === 'agent').length === 0 && (
                  <div className="text-center py-12 border-2 border-dashed border-orange-200 rounded-3xl">
                    <Smartphone className="w-12 h-12 text-orange-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">No agents found</p>
                  </div>
                )}
              </div>
            </div>

            {/* Main: Stream View */}
            <div className="lg:col-span-2 space-y-6">
              <Card className="aspect-video bg-gray-900 overflow-hidden relative flex items-center justify-center">
                {remoteStream ? (
                  <video 
                    autoPlay 
                    playsInline 
                    ref={video => { if (video) video.srcObject = remoteStream; }}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="text-center space-y-4">
                    <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center mx-auto">
                      <Monitor className="w-10 h-10 text-gray-600" />
                    </div>
                    <p className="text-gray-500 font-medium">Select an agent to start monitoring</p>
                  </div>
                )}
                
                {remoteStream && (
                  <div className="absolute bottom-6 left-6 right-6 flex items-center justify-between">
                    <div className="flex items-center gap-2 bg-black/50 backdrop-blur-md px-4 py-2 rounded-full">
                      <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                      <span className="text-white text-xs font-bold uppercase tracking-widest">Live Feed</span>
                    </div>
                    <div className="flex gap-2">
                      <button className="p-3 bg-white/10 hover:bg-white/20 backdrop-blur-md rounded-full text-white transition-colors">
                        <Camera className="w-5 h-5" />
                      </button>
                      <button className="p-3 bg-white/10 hover:bg-white/20 backdrop-blur-md rounded-full text-white transition-colors">
                        <Mic className="w-5 h-5" />
                      </button>
                      <button 
                        onClick={() => {
                          setRemoteStream(null);
                          setActivePeer(null);
                          if (peerConnection.current) {
                            peerConnection.current.close();
                            peerConnection.current = null;
                          }
                        }}
                        className="p-3 bg-red-600 hover:bg-red-700 rounded-full text-white transition-colors"
                      >
                        <Square className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                )}
              </Card>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className="p-4 flex flex-col items-center text-center gap-2">
                  <Activity className="w-5 h-5 text-orange-600" />
                  <p className="text-[10px] text-gray-400 uppercase font-bold">Latency</p>
                  <p className="font-bold">42ms</p>
                </Card>
                <Card className="p-4 flex flex-col items-center text-center gap-2">
                  <Shield className="w-5 h-5 text-green-600" />
                  <p className="text-[10px] text-gray-400 uppercase font-bold">Security</p>
                  <p className="font-bold">E2EE</p>
                </Card>
                <Card className="p-4 flex flex-col items-center text-center gap-2">
                  <Settings className="w-5 h-5 text-yellow-600" />
                  <p className="text-[10px] text-gray-400 uppercase font-bold">Resolution</p>
                  <p className="font-bold">1080p</p>
                </Card>
                <Card className="p-4 flex flex-col items-center text-center gap-2">
                  <AlertCircle className="w-5 h-5 text-blue-600" />
                  <p className="text-[10px] text-gray-400 uppercase font-bold">Uptime</p>
                  <p className="font-bold">99.9%</p>
                </Card>
              </div>
            </div>
          </div>
        ) : (
          <div className="max-w-xl mx-auto space-y-8">
            <Card className="text-center py-12 space-y-6">
              <div className="relative inline-block">
                <div className="w-32 h-32 bg-yellow-100 rounded-full flex items-center justify-center mx-auto">
                  <Smartphone className="w-16 h-16 text-yellow-600" />
                </div>
                <div className="absolute top-0 right-0 w-8 h-8 bg-green-500 border-4 border-white rounded-full animate-pulse" />
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl font-bold">Agent Active</h2>
                <p className="text-gray-500">This device is ready to be monitored by your dashboard.</p>
              </div>
              
              <div className="bg-orange-50 rounded-2xl p-6 text-left space-y-4">
                <h4 className="text-sm font-bold uppercase tracking-wider text-orange-800">Status Monitor</h4>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Connection</span>
                    <span className="text-sm font-bold text-green-600 flex items-center gap-1">
                      <CheckCircle2 className="w-4 h-4" /> Stable
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Camera</span>
                    <span className="text-sm font-bold text-gray-400">Idle</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600">Microphone</span>
                    <span className="text-sm font-bold text-gray-400">Idle</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <Button variant="outline" onClick={() => selectRole(null)}>
                  Change Device Role
                </Button>
                <p className="text-[10px] text-gray-400">
                  Device ID: {user.uid}
                </p>
              </div>
            </Card>

            <div className="grid grid-cols-2 gap-4">
              <Card className="p-4 flex items-center gap-3">
                <div className="w-10 h-10 bg-orange-100 rounded-xl flex items-center justify-center">
                  <Camera className="w-5 h-5 text-orange-600" />
                </div>
                <div>
                  <p className="text-xs font-bold">Camera</p>
                  <p className="text-[10px] text-gray-400">Ready</p>
                </div>
              </Card>
              <Card className="p-4 flex items-center gap-3">
                <div className="w-10 h-10 bg-yellow-100 rounded-xl flex items-center justify-center">
                  <Mic className="w-5 h-5 text-yellow-600" />
                </div>
                <div>
                  <p className="text-xs font-bold">Mic</p>
                  <p className="text-[10px] text-gray-400">Ready</p>
                </div>
              </Card>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-orange-100 px-6 py-4 text-center">
        <p className="text-[10px] text-gray-400 uppercase tracking-[0.2em] font-bold">
          &copy; 2024 AIRFISA SECURITY SYSTEMS . ALL RIGHTS RESERVED
        </p>
      </footer>
    </div>
  );
}
