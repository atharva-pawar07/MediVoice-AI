import { useCallback, useEffect, useRef, useState } from "react";
import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import "./App.css";

const API_URL = "http://127.0.0.1:8000";
const MAX_TRANSCRIPT_MESSAGES = 100;

function getErrorMessage(error) {
  if (typeof error === "string") return error;
  return error?.message || error?.data?.message || "An unexpected voice connection error occurred.";
}

function maskPhoneNumber(value) {
  const phone = String(value ?? "").trim();
  if (!phone) return "Not provided";
  if (phone.length <= 4) return "*".repeat(phone.length);
  return `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}

function formatDuration(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function Transcript({ transcript, transcriptRef }) {
  return (
    <div className="transcript-list" ref={transcriptRef} aria-live="polite">
      {transcript.length === 0 ? (
        <div className="transcript-empty">
          <span className="empty-glyph">↗</span>
          <strong>Conversation will appear here</strong>
          <p>Caller and assistant messages are transcribed in real time.</p>
        </div>
      ) : transcript.map((item) => (
        <article className={`transcript-line ${item.role === "user" ? "from-caller" : "from-ai"}`} key={item.id}>
          <div className="transcript-line-top">
            <strong>{item.role === "user" ? "Caller" : "MediVoice AI"}</strong>
            <time>{item.timestamp}</time>
          </div>
          <p>{item.text}</p>
        </article>
      ))}
    </div>
  );
}

function App() {
  const [callStatus, setCallStatus] = useState("disconnected");
  const [muted, setMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [callError, setCallError] = useState("");
  const [audioDiagnostic, setAudioDiagnostic] = useState("Waiting for audio...");
  const [doctors, setDoctors] = useState([]);
  const [doctorsLoading, setDoctorsLoading] = useState(true);
  const [doctorsError, setDoctorsError] = useState("");
  const [appointments, setAppointments] = useState([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(true);
  const [appointmentsError, setAppointmentsError] = useState("");
  const [transcript, setTranscript] = useState([]);
  const [activeSection, setActiveSection] = useState(() => {
    const hash = window.location.hash.replace("#", "");
    return ["overview", "appointments", "doctors", "live-calls"].includes(hash) ? hash : "overview";
  });

  const clientRef = useRef(null);
  const callStartedAtRef = useRef(null);
  const isUnmountingRef = useRef(false);
  const transcriptRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteAudioTrackRef = useRef(null);

  const addTranscriptMessage = useCallback((role, text, segmentId = null) => {
    const cleanText = String(text || "").trim();
    if (!cleanText) return;
    const newMessage = {
      id: `${Date.now()}-${Math.random()}`,
      role,
      text: cleanText,
      segmentId,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setTranscript((previous) => {
      if (segmentId !== null) {
        const existingIndex = previous.findIndex(
          (message) => message.role === role && message.segmentId === segmentId
        );
        if (existingIndex !== -1) {
          if (previous[existingIndex].text === cleanText) return previous;
          const updated = [...previous];
          updated[existingIndex] = { ...updated[existingIndex], text: cleanText };
          return updated;
        }
      }
      return [...previous, newMessage].slice(-MAX_TRANSCRIPT_MESSAGES);
    });
  }, []);

  const attachRemoteAudio = useCallback((track) => {
    const element = remoteAudioRef.current;
    if (!element || !track || remoteAudioTrackRef.current === track) return;
    remoteAudioTrackRef.current = track;
    element.srcObject = new MediaStream([track]);
    element.muted = false;
    element.volume = 1;
    element.play().catch((error) => {
      console.error("AI audio playback was blocked:", error);
      setAudioDiagnostic("The browser blocked AI audio playback. Click the page, then speak again.");
    });
  }, []);

  const detachRemoteAudio = useCallback(() => {
    const element = remoteAudioRef.current;
    remoteAudioTrackRef.current = null;
    if (element) {
      element.pause();
      element.srcObject = null;
    }
  }, []);

  const fetchDoctors = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/doctors`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.success || !Array.isArray(data.doctors)) throw new Error("Invalid doctor data.");
      setDoctors(data.doctors);
      setDoctorsError("");
    } catch (error) {
      console.error("Doctor fetch error:", error);
      setDoctorsError("Unable to load doctors. Check the backend.");
    } finally {
      setDoctorsLoading(false);
    }
  }, []);

  const fetchAppointments = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/appointments`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.success || !Array.isArray(data.appointments)) throw new Error("Invalid appointment data.");
      setAppointments(data.appointments);
      setAppointmentsError("");
    } catch (error) {
      console.error("Appointment fetch error:", error);
      setAppointmentsError("Unable to load appointments. Check the backend.");
    } finally {
      setAppointmentsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDoctors();
    fetchAppointments();
    const interval = setInterval(fetchAppointments, 5000);
    return () => clearInterval(interval);
  }, [fetchDoctors, fetchAppointments]);

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace("#", "");
      if (["overview", "appointments", "doctors", "live-calls"].includes(hash)) {
        setActiveSection(hash);
      }
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [transcript]);

  useEffect(() => {
    if (callStatus !== "connected") return;
    const interval = setInterval(() => {
      if (callStartedAtRef.current) {
        setCallDuration(Math.floor((Date.now() - callStartedAtRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [callStatus]);

  useEffect(() => {
    isUnmountingRef.current = false;
    return () => {
      isUnmountingRef.current = true;
      const client = clientRef.current;
      clientRef.current = null;
      detachRemoteAudio();
      if (client) client.disconnect().catch((error) => console.error("Voice cleanup error:", error));
    };
  }, [detachRemoteAudio]);

  const navigateTo = (section) => {
    setActiveSection(section);
    window.history.replaceState(null, "", `#${section}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const startCall = async () => {
    if (clientRef.current) return;
    navigateTo("live-calls");
    setCallError("");
    setTranscript([]);
    setCallDuration(0);
    setMuted(false);
    setCallStatus("connecting");
    setAudioDiagnostic("Waiting for remote audio track...");
    detachRemoteAudio();
    callStartedAtRef.current = null;

    try {
      const transport = new SmallWebRTCTransport();
      let client;
      const markConnected = () => {
        if (isUnmountingRef.current) return;
        setCallStatus("connected");
        setCallError("");
        if (!callStartedAtRef.current) callStartedAtRef.current = Date.now();
      };

      client = new PipecatClient({
        transport,
        enableMic: true,
        enableCam: false,
        callbacks: {
          onConnected: () => {
            console.log("MediVoice connected");
            markConnected();
          },
          onTransportStateChanged: (state) => {
            console.log("Transport state:", state);
            if (state === "connected" || state === "ready") markConnected();
          },
          onDisconnected: () => {
            console.log("MediVoice disconnected");
            if (clientRef.current === client) clientRef.current = null;
            callStartedAtRef.current = null;
            detachRemoteAudio();
            if (!isUnmountingRef.current) {
              setCallStatus("disconnected");
              setMuted(false);
              setCallDuration(0);
              setAudioDiagnostic("Call ended.");
              fetchAppointments();
            }
          },
          onError: (error) => {
            console.error("Pipecat error:", error);
            if (!isUnmountingRef.current) setCallError(getErrorMessage(error));
          },
          onTrackStarted: (track, participant) => {
            console.log("Pipecat track started:", {
              kind: track.kind,
              readyState: track.readyState,
              enabled: track.enabled,
              muted: track.muted,
              local: participant?.local === true,
            });
            if (track.kind !== "audio" || participant?.local === true) return;
            attachRemoteAudio(track);
            if (!isUnmountingRef.current) setAudioDiagnostic("AI audio connected. Waiting for the AI to speak...");
          },
          onTrackStopped: (track, participant) => {
            console.log("Pipecat track stopped:", {
              kind: track.kind,
              readyState: track.readyState,
              local: participant?.local === true,
            });
            if (track.kind === "audio" && participant?.local !== true && !isUnmountingRef.current) {
              setAudioDiagnostic("AI audio is paused (no audio arriving).");
            }
          },
          onBotStartedSpeaking: () => console.log("AI started speaking."),
          onBotStoppedSpeaking: () => console.log("AI stopped speaking."),
          onUserInput: (data) => {
            if (!data?.text || data.final === false) return;
            addTranscriptMessage("user", data.text);
          },
          onBotOutput: (data) => {
            if (!data?.text) return;
            if (data.spoken_status === "in-progress" || data.spoken_status === "completed") return;
            addTranscriptMessage("assistant", data.text, data.segment_id ?? null);
          },
        },
      });
      clientRef.current = client;
      await client.connect({ webrtcRequestParams: { endpoint: `${API_URL}/api/offer` } });
      if (!isUnmountingRef.current && clientRef.current === client) markConnected();
    } catch (error) {
      console.error("Voice connection failed:", error);
      if (!isUnmountingRef.current) {
        setCallError(getErrorMessage(error));
        setCallStatus("disconnected");
      }
      callStartedAtRef.current = null;
      setMuted(false);
      setCallDuration(0);
      const client = clientRef.current;
      clientRef.current = null;
      detachRemoteAudio();
      if (client) {
        try {
          await client.disconnect();
        } catch (cleanupError) {
          console.error("Connection cleanup error:", cleanupError);
        }
      }
    }
  };

  const endCall = async () => {
    const client = clientRef.current;
    if (!client) {
      setCallStatus("disconnected");
      return;
    }
    setCallStatus("ending");
    try {
      await client.disconnect();
    } catch (error) {
      console.error("Disconnect error:", error);
      setCallError(getErrorMessage(error));
    } finally {
      if (clientRef.current === client) clientRef.current = null;
      detachRemoteAudio();
      callStartedAtRef.current = null;
      setCallStatus("disconnected");
      setMuted(false);
      setCallDuration(0);
      setAudioDiagnostic("Call ended.");
      fetchAppointments();
    }
  };

  const toggleMute = () => {
    const client = clientRef.current;
    if (!client || callStatus !== "connected") return;
    const nextMuted = !muted;
    try {
      client.enableMic(!nextMuted);
      setMuted(nextMuted);
    } catch (error) {
      console.error("Microphone error:", error);
      setCallError(getErrorMessage(error));
    }
  };

  const activeAppointments = appointments.filter((item) => item.status === "booked");
  const cancelledAppointments = appointments.filter((item) => item.status === "cancelled");
  const callIsActive = callStatus === "connected";
  const statusLabel = {
    connected: "Connected",
    connecting: "Connecting",
    ending: "Ending",
    disconnected: "Offline",
  }[callStatus];
  const duration = formatDuration(callDuration);
  const pageTitle = {
    overview: "Overview",
    appointments: "Appointments",
    doctors: "Care team",
    "live-calls": "Live call",
  }[activeSection];

  return (
    <div className="app-shell">
      <audio
        ref={remoteAudioRef}
        autoPlay
        playsInline
        onPlaying={() => setAudioDiagnostic("AI audio is playing through your browser.")}
        onError={() => setAudioDiagnostic("The browser reported an audio playback error.")}
      />

      <aside className="sidebar">
        <a className="sidebar-brand" href="#overview" onClick={() => navigateTo("overview")}>
          <span className="brand-mark">M</span>
          <span><strong>MediVoice</strong><small>CLINIC INTELLIGENCE</small></span>
        </a>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <a href="#overview" className={activeSection === "overview" ? "nav-link active" : "nav-link"} onClick={() => navigateTo("overview")}><span className="nav-symbol">▦</span><span>Overview</span></a>
          <a href="#appointments" className={activeSection === "appointments" ? "nav-link active" : "nav-link"} onClick={() => navigateTo("appointments")}><span className="nav-symbol">▤</span><span>Appointments</span><span className="nav-count">{activeAppointments.length}</span></a>
          <a href="#doctors" className={activeSection === "doctors" ? "nav-link active" : "nav-link"} onClick={() => navigateTo("doctors")}><span className="nav-symbol">✚</span><span>Care team</span></a>
          <a href="#live-calls" className={activeSection === "live-calls" ? "nav-link active" : "nav-link"} onClick={() => navigateTo("live-calls")}><span className="nav-symbol">◉</span><span>Live calls</span><span className={`nav-live-dot ${callIsActive ? "online" : ""}`} /></a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-status"><span className={`status-light ${callIsActive ? "online" : ""}`} /><div><strong>Voice service</strong><small>{statusLabel}</small></div></div>
          <div className="sidebar-footer">MEDIVOICE PLATFORM <span>v1.0</span></div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-title"><span className="topbar-kicker">CLINIC WORKSPACE</span><strong>{pageTitle}</strong></div>
          <div className="topbar-actions">
            <span className={`system-chip ${callIsActive ? "online" : ""}`}><i />{callIsActive ? "Voice system live" : "Voice system offline"}</span>
            <span className="avatar">AD</span>
          </div>
        </header>

        <main className="page-content">
          {activeSection === "overview" && (
            <section className="page-view">
              <div className="page-intro">
                <div><span className="section-kicker">MONDAY — CLINIC OPERATIONS</span><h1>Your clinic, at a glance.</h1><p>Monitor patient scheduling, your care team and AI receptionist activity.</p></div>
                <button className="primary-button" onClick={startCall} disabled={callStatus === "connecting" || callIsActive}> <span>＋</span> Start a voice session</button>
              </div>

              <div className="overview-banner">
                <div className="banner-copy"><span className="banner-label"><i /> MEDIVOICE ASSISTANT</span><h2>{callIsActive ? "Your receptionist is on a call." : "Your front desk, always ready."}</h2><p>{callIsActive ? "A voice session is active. You can monitor the conversation live." : "Your AI receptionist can help callers book, review and cancel appointments."}</p><button className="banner-link" onClick={() => navigateTo("live-calls")}>Open live call workspace <span>→</span></button></div>
                <div className="banner-graphic" aria-hidden="true"><div className="graphic-ring ring-a" /><div className="graphic-ring ring-b" /><div className="graphic-core">M</div><div className="graphic-wave"><i /><i /><i /><i /><i /><i /><i /></div></div>
              </div>

              <div className="section-heading-row"><div><span className="section-kicker">AT A GLANCE</span><h2>Clinic overview</h2></div><span className="updated-label"><i /> Refreshes automatically</span></div>
              <div className="overview-metrics">
                <article className="overview-metric"><span className="metric-icon blue">✚</span><div><small>Care team</small><strong>{doctorsLoading ? "—" : doctors.length}</strong><span>Registered doctors</span></div><span className="metric-arrow">↗</span></article>
                <article className="overview-metric"><span className="metric-icon green">▤</span><div><small>Booked appointments</small><strong>{appointmentsLoading ? "—" : activeAppointments.length}</strong><span>Confirmed bookings</span></div><span className="metric-arrow">↗</span></article>
                <article className="overview-metric"><span className="metric-icon amber">↘</span><div><small>Cancelled</small><strong>{appointmentsLoading ? "—" : cancelledAppointments.length}</strong><span>Cancelled records</span></div><span className="metric-arrow">↗</span></article>
                <article className="overview-metric"><span className="metric-icon slate">◉</span><div><small>Receptionist</small><strong className={`metric-state ${callStatus}`}>{statusLabel}</strong><span>Current voice status</span></div><span className="metric-arrow">↗</span></article>
              </div>

              <div className="overview-lower">
                <section className="content-panel recent-panel">
                  <div className="panel-heading"><div><span className="section-kicker">SCHEDULING</span><h2>Recent appointments</h2></div><button className="text-button" onClick={() => navigateTo("appointments")}>View all <span>→</span></button></div>
                  {appointmentsLoading ? <div className="inline-state">Loading appointments…</div> : appointmentsError ? <div className="inline-state error">{appointmentsError}</div> : appointments.length === 0 ? <div className="inline-state">No appointments have been booked yet.</div> : (
                    <div className="recent-list">{appointments.slice(0, 5).map((item) => <div className="recent-row" key={item.appointment_id}><div className="patient-monogram">{String(item.doctor_name || "D").charAt(0)}</div><div className="recent-main"><strong>{item.doctor_name}</strong><small>{item.speciality} · {item.date} · {item.time}</small></div><span className={`table-status ${item.status === "booked" ? "booked" : "cancelled"}`}>{item.status}</span></div>)}</div>
                  )}
                </section>
                <section className="content-panel team-preview">
                  <div className="panel-heading"><div><span className="section-kicker">YOUR PEOPLE</span><h2>Care team</h2></div><button className="text-button" onClick={() => navigateTo("doctors")}>Directory <span>→</span></button></div>
                  {doctorsLoading ? <div className="inline-state">Loading care team…</div> : doctorsError ? <div className="inline-state error">{doctorsError}</div> : doctors.slice(0, 4).map((doctor, index) => <div className="team-row" key={doctor.doctor_id}><span className={`team-avatar avatar-${index % 4}`}>{String(doctor.doctor_name || "D").split(" ").slice(-1)[0].charAt(0)}</span><div><strong>{doctor.doctor_name}</strong><small>{doctor.speciality}</small></div><span className="team-arrow">↗</span></div>)}
                </section>
              </div>
              <footer className="page-footer">MediVoice AI <span>·</span> Intelligent clinic operations</footer>
            </section>
          )}

          {activeSection === "appointments" && (
            <section className="page-view">
              <div className="page-intro"><div><span className="section-kicker">PATIENT SCHEDULING</span><h1>Appointments</h1><p>Review bookings created through your AI receptionist.</p></div><div className="page-total"><strong>{appointments.length}</strong><span>Total records</span></div></div>
              <div className="appointment-summary"><div><span className="summary-mark green">✓</span><div><small>Confirmed</small><strong>{activeAppointments.length}</strong></div></div><div><span className="summary-mark red">×</span><div><small>Cancelled</small><strong>{cancelledAppointments.length}</strong></div></div><div><span className="summary-mark blue">↻</span><div><small>Auto refresh</small><strong>5 sec</strong></div></div></div>
              <section className="content-panel directory-panel"><div className="panel-heading"><div><span className="section-kicker">APPOINTMENT REGISTER</span><h2>All appointments</h2></div><span className="record-count">{appointments.length} records</span></div>
                {appointmentsLoading ? <div className="inline-state">Loading appointments…</div> : appointmentsError ? <div className="inline-state error">{appointmentsError}</div> : appointments.length === 0 ? <div className="inline-state">No appointments have been booked yet.</div> : <div className="table-scroll"><table className="data-table"><thead><tr><th>DOCTOR</th><th>SPECIALITY</th><th>DATE</th><th>TIME</th><th>PHONE</th><th>STATUS</th></tr></thead><tbody>{appointments.map((item) => <tr key={item.appointment_id}><td><strong>{item.doctor_name}</strong></td><td>{item.speciality}</td><td>{item.date}</td><td>{item.time}</td><td>{maskPhoneNumber(item.phone_number)}</td><td><span className={`table-status ${item.status === "booked" ? "booked" : "cancelled"}`}>{item.status}</span></td></tr>)}</tbody></table></div>}
              </section>
              <footer className="page-footer">Patient information is displayed with phone numbers masked for privacy.</footer>
            </section>
          )}

          {activeSection === "doctors" && (
            <section className="page-view">
              <div className="page-intro"><div><span className="section-kicker">CLINICAL DIRECTORY</span><h1>Your care team</h1><p>Doctors and appointment slots configured for your clinic.</p></div><div className="page-total"><strong>{doctors.length}</strong><span>Team members</span></div></div>
              {doctorsLoading ? <div className="content-panel inline-state">Loading doctors…</div> : doctorsError ? <div className="content-panel inline-state error">{doctorsError}</div> : doctors.length === 0 ? <div className="content-panel inline-state">No doctors found.</div> : <div className="doctor-grid">{doctors.map((doctor, index) => <article className="doctor-card" key={doctor.doctor_id}><div className="doctor-card-top"><span className={`doctor-avatar avatar-${index % 4}`}>{String(doctor.doctor_name || "D").split(" ").slice(-1)[0].charAt(0)}</span><span className="doctor-id">{doctor.doctor_id}</span></div><h2>{doctor.doctor_name}</h2><p>{doctor.speciality}</p><div className="doctor-card-divider" /><div className="slots-heading"><strong>Available slots</strong><span>{(doctor.slots || []).length} slots</span></div><div className="doctor-slots">{(doctor.slots || []).map((slot) => <span key={slot}>{slot}</span>)}</div></article>)}</div>}
              <footer className="page-footer">Availability reflects the slots configured in the backend.</footer>
            </section>
          )}

          {activeSection === "live-calls" && (
            <section className="page-view call-page">
              <div className="page-intro call-page-intro"><div><span className="section-kicker">VOICE OPERATIONS / REAL-TIME</span><h1>Live call workspace</h1><p>Connect to the AI receptionist and monitor the conversation as it happens.</p></div><span className={`call-state-chip ${callStatus}`}><i />{statusLabel}</span></div>
              <div className="call-workspace-grid">
                <section className="call-console">
                  <div className="console-topline"><span>MEDIVOICE VOICE CHANNEL</span><span className="encrypted-label">⌑ SECURE SESSION</span></div>
                  <div className={`call-visual ${callIsActive ? "active" : ""}`}>
                    <div className="visual-halo halo-one" /><div className="visual-halo halo-two" /><div className="visual-core"><span>M</span></div>
                  </div>
                  <span className="call-overline">{callStatus === "connected" ? "VOICE SESSION IN PROGRESS" : callStatus === "connecting" ? "ESTABLISHING CONNECTION" : callStatus === "ending" ? "CLOSING SESSION" : "AI RECEPTIONIST"}</span>
                  <h2>MediVoice Assistant</h2>
                  <p className="call-prompt">{callIsActive ? (muted ? "Your microphone is muted. Unmute when you're ready to speak." : "The assistant is listening. Speak naturally to continue.") : callStatus === "connecting" ? "Requesting a secure connection to your assistant…" : "Start a voice session to speak with your AI receptionist."}</p>
                  <div className="call-wave" aria-label={callIsActive ? "Voice session active" : "Voice session inactive"}>{Array.from({ length: 31 }, (_, i) => <i key={i} style={{ "--bar": i }} />)}</div>
                  <div className="call-clock">{duration}</div>
                  <div className="console-controls">
                    <button className={`round-control ${muted ? "is-muted" : ""}`} onClick={toggleMute} disabled={!callIsActive} aria-label={muted ? "Unmute microphone" : "Mute microphone"}><span>{muted ? "◌" : "⌁"}</span><small>{muted ? "Unmute" : "Mute"}</small></button>
                    {callStatus === "disconnected" ? <button className="start-session-button" onClick={startCall}><span>▶</span> Start session</button> : <button className="end-session-button" onClick={endCall} disabled={callStatus === "ending"}><span>■</span> {callStatus === "ending" ? "Ending…" : "End session"}</button>}
                    <button className="round-control" onClick={() => setTranscript([])} disabled={transcript.length === 0} aria-label="Clear transcript"><span>⌫</span><small>Clear</small></button>
                  </div>
                  {callError && <div className="call-error" role="alert">{callError}</div>}
                  <div className="audio-status"><i className={callIsActive ? "online" : ""} />{audioDiagnostic}</div>
                </section>
                <section className="conversation-panel">
                  <div className="conversation-heading"><div><span className="section-kicker">LIVE CAPTIONS</span><h2>Conversation</h2><p>Caller and assistant messages appear here.</p></div><span className={`live-indicator ${callIsActive ? "active" : ""}`}><i />{callIsActive ? "LIVE" : "STANDBY"}</span></div>
                  <Transcript transcript={transcript} transcriptRef={transcriptRef} />
                  <div className="conversation-foot"><span><i /> End-to-end voice transport</span><span>{transcript.length} messages</span></div>
                </section>
              </div>
              <footer className="page-footer">Voice connection powered by Pipecat WebRTC. Keep this page open during the session.</footer>
            </section>
          )}
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <button className={activeSection === "overview" ? "mobile-nav-item active" : "mobile-nav-item"} onClick={() => navigateTo("overview")}><span>▦</span><small>Home</small></button>
        <button className={activeSection === "appointments" ? "mobile-nav-item active" : "mobile-nav-item"} onClick={() => navigateTo("appointments")}><span>▤</span><small>Bookings</small></button>
        <button className={activeSection === "doctors" ? "mobile-nav-item active" : "mobile-nav-item"} onClick={() => navigateTo("doctors")}><span>✚</span><small>Team</small></button>
        <button className={activeSection === "live-calls" ? "mobile-nav-item active" : "mobile-nav-item"} onClick={() => navigateTo("live-calls")}><span>◉</span><small>Calls</small></button>
      </nav>
    </div>
  );
}

export default App;
