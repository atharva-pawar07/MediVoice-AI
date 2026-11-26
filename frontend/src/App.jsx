
import { useCallback, useEffect, useRef, useState } from "react";
import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import "./App.css";

const API_URL = "http://127.0.0.1:8000";
const MAX_TRANSCRIPT_MESSAGES = 100;
const PHONE_EXIT_DURATION = 450;

function getErrorMessage(error) {
  if (typeof error === "string") return error;

  return (
    error?.message ||
    error?.data?.message ||
    "An unexpected voice connection error occurred."
  );
}

function App() {
  const [callStatus, setCallStatus] = useState("disconnected");
  const [muted, setMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [callError, setCallError] = useState("");

  const [doctors, setDoctors] = useState([]);
  const [doctorsLoading, setDoctorsLoading] = useState(true);
  const [doctorsError, setDoctorsError] = useState("");

  const [appointments, setAppointments] = useState([]);
  const [appointmentsLoading, setAppointmentsLoading] = useState(true);
  const [appointmentsError, setAppointmentsError] = useState("");

  const [transcript, setTranscript] = useState([]);
  const [phonePanelMounted, setPhonePanelMounted] = useState(false);

  const clientRef = useRef(null);
  const callStartedAtRef = useRef(null);
  const isUnmountingRef = useRef(false);

  // --------------------------------------------------
  // TRANSCRIPT
  // --------------------------------------------------

  const addTranscriptMessage = useCallback(
    (role, text, segmentId = null) => {
      const cleanText = String(text || "").trim();

      if (!cleanText) return;

      setTranscript((previous) => {
        const updated = [...previous];
        const lastMessage = updated[updated.length - 1];

        if (
          role === "assistant" &&
          segmentId !== null &&
          lastMessage?.role === "assistant" &&
          lastMessage?.segmentId === segmentId
        ) {
          updated[updated.length - 1] = {
            ...lastMessage,
            text: lastMessage.text + cleanText,
          };

          return updated.slice(-MAX_TRANSCRIPT_MESSAGES);
        }

        updated.push({
          id: `${Date.now()}-${Math.random()}`,
          role,
          text: cleanText,
          segmentId,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        });

        return updated.slice(-MAX_TRANSCRIPT_MESSAGES);
      });
    },
    []
  );

  // --------------------------------------------------
  // BACKEND DATA
  // --------------------------------------------------

  const fetchDoctors = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/doctors`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data.success || !Array.isArray(data.doctors)) {
        throw new Error("Invalid doctor data.");
      }

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

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data.success || !Array.isArray(data.appointments)) {
        throw new Error("Invalid appointment data.");
      }

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

  // --------------------------------------------------
  // CALL TIMER
  // --------------------------------------------------

  useEffect(() => {
    if (callStatus !== "connected") return;

    const interval = setInterval(() => {
      if (callStartedAtRef.current) {
        setCallDuration(
          Math.floor((Date.now() - callStartedAtRef.current) / 1000)
        );
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [callStatus]);

  const formattedDuration = `${String(
    Math.floor(callDuration / 60)
  ).padStart(2, "0")}:${String(callDuration % 60).padStart(2, "0")}`;

  // --------------------------------------------------
  // PHONE PANEL ANIMATION
  // --------------------------------------------------

  const phoneInterfaceVisible = callStatus !== "disconnected";

  useEffect(() => {
    if (phoneInterfaceVisible) {
      setPhonePanelMounted(true);
      return;
    }

    const timeout = setTimeout(() => {
      setPhonePanelMounted(false);
    }, PHONE_EXIT_DURATION);

    return () => clearTimeout(timeout);
  }, [phoneInterfaceVisible]);

  // --------------------------------------------------
  // START CALL
  // --------------------------------------------------

  const startCall = async () => {
    if (clientRef.current) return;

    setCallError("");
    setTranscript([]);
    setCallDuration(0);
    setMuted(false);
    setCallStatus("connecting");

    callStartedAtRef.current = null;

    try {
      const transport = new SmallWebRTCTransport();

      let client;

      const markConnected = () => {
        if (isUnmountingRef.current) return;

        setCallStatus("connected");
        setCallError("");

        if (!callStartedAtRef.current) {
          callStartedAtRef.current = Date.now();
        }
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

            if (state === "connected" || state === "ready") {
              markConnected();
            }
          },

          onDisconnected: () => {
            console.log("MediVoice disconnected");

            if (clientRef.current === client) {
              clientRef.current = null;
            }

            callStartedAtRef.current = null;

            if (!isUnmountingRef.current) {
              setCallStatus("disconnected");
              setMuted(false);
              setCallDuration(0);
              fetchAppointments();
            }
          },

          onError: (error) => {
            console.error("Pipecat error:", error);

            if (!isUnmountingRef.current) {
              setCallError(getErrorMessage(error));
            }
          },

          onUserInput: (data) => {
            if (!data?.text || data.final === false) return;

            addTranscriptMessage("user", data.text);
          },

          onBotOutput: (data) => {
            if (!data?.text) return;

            addTranscriptMessage(
              "assistant",
              data.text,
              data.segment_id ?? null
            );
          },
        },
      });

      clientRef.current = client;

      await client.connect({
        webrtcRequestParams: {
          endpoint: `${API_URL}/api/offer`,
        },
      });

      if (
        !isUnmountingRef.current &&
        clientRef.current === client
      ) {
        markConnected();
      }
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

      if (client) {
        try {
          await client.disconnect();
        } catch (cleanupError) {
          console.error("Connection cleanup error:", cleanupError);
        }
      }
    }
  };

  // --------------------------------------------------
  // END CALL
  // --------------------------------------------------

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
      if (clientRef.current === client) {
        clientRef.current = null;
      }

      callStartedAtRef.current = null;
      setCallStatus("disconnected");
      setMuted(false);
      setCallDuration(0);

      fetchAppointments();
    }
  };

  // --------------------------------------------------
  // MICROPHONE
  // --------------------------------------------------

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

  // --------------------------------------------------
  // CLEANUP
  // --------------------------------------------------

  useEffect(() => {
    // React StrictMode runs an extra setup/cleanup cycle in development.
    // Reset this flag during setup so the simulated cleanup does not leave
    // the app permanently believing that it is unmounting.
    isUnmountingRef.current = false;

    return () => {
      isUnmountingRef.current = true;

      const client = clientRef.current;
      clientRef.current = null;

      if (client) {
        client.disconnect().catch((error) => {
          console.error("Voice cleanup error:", error);
        });
      }
    };
  }, []);

  // --------------------------------------------------
  // STATISTICS
  // --------------------------------------------------

  const activeAppointments = appointments.filter(
    (appointment) => appointment.status === "booked"
  );

  const cancelledAppointments = appointments.filter(
    (appointment) => appointment.status === "cancelled"
  );

  const callIsActive = callStatus === "connected";

  const statusLabel = {
    connected: "Connected",
    connecting: "Connecting",
    ending: "Ending",
    disconnected: "Offline",
  }[callStatus];

  // --------------------------------------------------
  // DASHBOARD
  // --------------------------------------------------

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">M</div>

          <div>
            <h1>MediVoice AI</h1>
            <p>Healthcare appointment assistant</p>
          </div>
        </div>

        <div className="system-status">
          <span className="status-dot"></span>
          System dashboard
        </div>
      </header>

      <main className="dashboard">
        <section className="welcome">
          <div>
            <p className="eyebrow">VOICE ASSISTANT DASHBOARD</p>
            <h2>Good day, Administrator</h2>
            <p>Manage doctor availability and voice appointments.</p>
          </div>

          <div className="date-label">
            <span>VOICE AI PLATFORM</span>
            <strong>MediVoice AI</strong>
          </div>
        </section>

        {/* STATISTICS */}

        <section className="stats">
          <div className="stat-card">
            <span>Total doctors</span>
            <strong>{doctorsLoading ? "..." : doctors.length}</strong>
            <small>Loaded from backend</small>
          </div>

          <div className="stat-card">
            <span>Active appointments</span>
            <strong>
              {appointmentsLoading ? "..." : activeAppointments.length}
            </strong>
            <small>Currently booked</small>
          </div>

          <div className="stat-card">
            <span>Call status</span>
            <strong className="stat-status">{statusLabel}</strong>
            <small>Pipecat voice session</small>
          </div>
        </section>

        {/* VOICE SESSION */}

        <section className="main-grid">
          <div className="panel call-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">VOICE SESSION</p>
                <h3>AI Receptionist</h3>
              </div>

              <span className={`call-badge ${callStatus}`}>
                {statusLabel}
              </span>
            </div>

            <div className="call-visual">
              <div className="avatar">M</div>

              <h3>MediVoice Assistant</h3>

              <p>
                {callIsActive
                  ? muted
                    ? "Your microphone is muted"
                    : "Your voice session is active"
                  : callStatus === "connecting"
                    ? "Establishing voice connection..."
                    : callStatus === "ending"
                      ? "Ending your voice session..."
                      : "Start a call to speak with the AI receptionist"}
              </p>

              <div className={`waveform ${callIsActive ? "active" : ""}`}>
                {Array.from({ length: 25 }, (_, index) => (
                  <span key={index} style={{ "--i": index }}></span>
                ))}
              </div>

              <div className="call-timer">{formattedDuration}</div>
            </div>

            <div className="call-controls">
              {callIsActive || callStatus === "ending" ? (
                <button
                  className="call-button"
                  onClick={endCall}
                  disabled={callStatus === "ending"}
                >
                  {callStatus === "ending" ? "Ending..." : "End call"}
                </button>
              ) : (
                <button
                  className="call-button"
                  onClick={startCall}
                  disabled={callStatus === "connecting"}
                >
                  {callStatus === "connecting" ? "Connecting..." : "Start call"}
                </button>
              )}

              <button
                className="secondary-button"
                onClick={toggleMute}
                disabled={!callIsActive}
              >
                {muted ? "Unmute" : "Mute"}
              </button>
            </div>

            {callError && (
              <div className="call-note" role="alert">
                {callError}
              </div>
            )}

            <p className="call-note">
              {callIsActive
                ? "Connected through Pipecat WebRTC."
                : "Voice connection status reflects the actual client connection."}
            </p>
          </div>

          {/* LIVE TRANSCRIPT */}

          <div className="panel transcript-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">CONVERSATION</p>
                <h3>Live transcript</h3>
              </div>

              <span className="live-label">
                {callIsActive ? "LIVE" : "STANDBY"}
              </span>
            </div>

            <div className="transcript-content" aria-live="polite">
              {transcript.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">◉</div>
                  <h4>No conversation yet</h4>
                  <p>
                    Caller and assistant messages will appear here when a
                    voice conversation begins.
                  </p>
                </div>
              ) : (
                transcript.map((item) => (
                  <div
                    className={`transcript-message ${
                      item.role === "user" ? "user-message" : "bot-message"
                    }`}
                    key={item.id}
                  >
                    <strong>
                      {item.role === "user" ? "Caller" : "MediVoice AI"}
                    </strong>

                    <p>{item.text}</p>
                    <small>{item.timestamp}</small>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* DOCTOR DIRECTORY */}

        <section className="panel doctors-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">MEDICAL DIRECTORY</p>
              <h3>Doctors and availability</h3>
            </div>

            <span className="count-label">
              {doctorsLoading ? "Loading..." : `${doctors.length} doctors`}
            </span>
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Doctor</th>
                  <th>Speciality</th>
                  <th>Doctor ID</th>
                  <th>Configured slots</th>
                </tr>
              </thead>

              <tbody>
                {doctorsLoading ? (
                  <tr>
                    <td colSpan="4">Loading doctors...</td>
                  </tr>
                ) : doctorsError ? (
                  <tr>
                    <td colSpan="4">{doctorsError}</td>
                  </tr>
                ) : (
                  doctors.map((doctor) => (
                    <tr key={doctor.doctor_id}>
                      <td className="doctor-name">{doctor.doctor_name}</td>
                      <td>{doctor.speciality}</td>
                      <td>{doctor.doctor_id}</td>
                      <td>
                        <div className="slot-list">
                          {doctor.slots.map((slot) => (
                            <span key={slot}>{slot}</span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* APPOINTMENTS */}

        <section className="panel appointments-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">BOOKING MANAGEMENT</p>
              <h3>Appointments</h3>
            </div>

            <span className="count-label">
              {appointments.length} total records
            </span>
          </div>

          {appointmentsLoading ? (
            <div className="empty-appointments">
              Loading appointments...
            </div>
          ) : appointmentsError ? (
            <div className="empty-appointments">{appointmentsError}</div>
          ) : appointments.length === 0 ? (
            <div className="empty-appointments">
              No appointments have been booked yet.
            </div>
          ) : (
            <>
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Doctor</th>
                      <th>Speciality</th>
                      <th>Date</th>
                      <th>Time</th>
                      <th>Phone number</th>
                      <th>Status</th>
                    </tr>
                  </thead>

                  <tbody>
                    {appointments.map((appointment) => (
                      <tr key={appointment.appointment_id}>
                        <td className="doctor-name">
                          {appointment.doctor_name}
                        </td>

                        <td>{appointment.speciality}</td>
                        <td>{appointment.date}</td>
                        <td>{appointment.time}</td>
                        <td>{appointment.phone_number}</td>

                        <td>
                          <span
                            className={
                              appointment.status === "booked"
                                ? "live-label"
                                : "count-label"
                            }
                          >
                            {appointment.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p>
                {activeAppointments.length} active ·{" "}
                {cancelledAppointments.length} cancelled
              </p>
            </>
          )}
        </section>

        <footer>
          MediVoice AI · Real-time doctor appointment assistant
        </footer>
      </main>

      {/* SLIDING SMARTPHONE INTERFACE */}

      {phonePanelMounted && (
        <section
          className={`phone-call-overlay ${
            phoneInterfaceVisible ? "is-open" : ""
          }`}
          role="dialog"
          aria-modal="true"
          aria-hidden={!phoneInterfaceVisible}
          aria-label="MediVoice phone call"
        >
          <div className="phone-call-card">
            <div className="phone-call-header">
              <div className="brand">
                <div className="brand-icon">M</div>

                <div>
                  <h1>MediVoice AI</h1>
                  <p>Healthcare appointment assistant</p>
                </div>
              </div>

              <span className={`call-badge ${callStatus}`}>
                {statusLabel}
              </span>
            </div>

            <div className="phone-call-body">
              <div className="phone-avatar">
                <span>M</span>
                {callIsActive && <div className="phone-avatar-pulse" />}
              </div>

              <h2>MediVoice Assistant</h2>

              <p className="phone-call-description">
                {callStatus === "connecting"
                  ? "Connecting your call..."
                  : callStatus === "ending"
                    ? "Ending your call..."
                    : muted
                      ? "Microphone muted"
                      : "You're connected. How can I help you?"}
              </p>

              <div className="phone-call-status">
                <span className={`phone-status-dot ${callStatus}`} />
                {statusLabel}
              </div>

              <div className="phone-call-timer">{formattedDuration}</div>

              <div className={`waveform ${callIsActive ? "active" : ""}`}>
                {Array.from({ length: 31 }, (_, index) => (
                  <span key={index} style={{ "--i": index }} />
                ))}
              </div>
            </div>

            <div className="phone-transcript">
              <div className="phone-transcript-heading">
                <div>
                  <span className="eyebrow">LIVE CONVERSATION</span>
                  <h3>Call transcript</h3>
                </div>

                <span className="live-label">
                  {callIsActive ? "LIVE" : "WAITING"}
                </span>
              </div>

              <div className="phone-transcript-messages" aria-live="polite">
                {transcript.length === 0 ? (
                  <div className="phone-transcript-empty">
                    {callStatus === "connecting"
                      ? "Waiting for the voice connection..."
                      : "Your conversation will appear here."}
                  </div>
                ) : (
                  transcript.map((item) => (
                    <div
                      key={item.id}
                      className={`phone-transcript-message ${
                        item.role === "user" ? "caller" : "assistant"
                      }`}
                    >
                      <strong>
                        {item.role === "user" ? "You" : "MediVoice AI"}
                      </strong>

                      <p>{item.text}</p>
                      <small>{item.timestamp}</small>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="phone-call-controls">
              <button
                type="button"
                className={`phone-control-button ${muted ? "muted" : ""}`}
                onClick={toggleMute}
                disabled={!callIsActive}
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              >
                <span>{muted ? "🔇" : "🎙️"}</span>
                <small>{muted ? "Unmute" : "Mute"}</small>
              </button>

              <button
                type="button"
                className="phone-end-button"
                onClick={endCall}
                disabled={callStatus === "ending"}
                aria-label="End call"
              >
                <span>✕</span>
                <small>
                  {callStatus === "ending" ? "Ending..." : "End call"}
                </small>
              </button>
            </div>

            {callError && (
              <div className="call-note" role="alert">
                {callError}
              </div>
            )}

            <p className="phone-security-note">
              Voice session powered by Pipecat
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

export default App;
