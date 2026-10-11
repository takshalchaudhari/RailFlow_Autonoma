import React from "react";
import { Route, Routes } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import DashboardLayout from "./pages/DashboardLayout";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: "100vh",
            background: "#040b18",
            color: "#edf4ff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "32px",
            fontFamily: "Manrope, sans-serif",
          }}
        >
          <div
            style={{
              maxWidth: "640px",
              padding: "28px",
              background: "#0a172b",
              border: "1px solid #8a2c3b",
              borderRadius: "14px",
            }}
          >
            <h2 style={{ marginTop: 0, color: "#ff9da9" }}>
              UI Runtime Error Caught
            </h2>
            <pre
              style={{
                background: "#050d1a",
                padding: "14px",
                borderRadius: "8px",
                overflowX: "auto",
                fontSize: "12px",
                color: "#ffd0d7",
              }}
            >
              {this.state.error.message}
            </pre>
            <button
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
              style={{
                marginTop: "14px",
                padding: "10px 16px",
                background: "#2767f5",
                color: "#fff",
                border: "1px solid #5790ff",
                borderRadius: "8px",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              Reload Console
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/app" element={<DashboardLayout />} />
      </Routes>
    </ErrorBoundary>
  );
}
